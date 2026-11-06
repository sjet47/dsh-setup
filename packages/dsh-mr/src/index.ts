/**
 * dsh-mr — show the current branch's merge request (GitLab) or pull request
 * (GitHub) in the dsh Web session header, and print it on `/mr`.
 *
 * Data comes from `glab` on GitLab remotes and `gh` on GitHub remotes, so the
 * CLIs' own auth is reused and no tokens live here. The browser chip reads the
 * status through an authenticated exact Fetch route; the `/mr` command renders
 * the same value as text.
 *
 * The session's effective directory comes from the `workingDirectory` service
 * when the composition provides it, so a Session that moved with the
 * `working_directory` tool is looked up in the directory it actually uses.
 *
 * Ported from pi-mr (pi-setup), keeping its forge layer unchanged.
 * @module dsh-mr
 */
import { execFile } from 'node:child_process'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-client-connection'
import {
  ciFromGitlabCommit,
  detectForge,
  GITHUB_PR_FIELDS,
  GITHUB_REPO_FIELDS,
  githubLogin,
  githubRemoteRepos,
  githubRepoInfo,
  gitlabApiPath,
  gitlabCommitPath,
  GITLAB_PROJECT_PATH,
  gitlabRepoInfo,
  normalizeGithub,
  normalizeGitlab,
  parseRemoteUrls,
  type CheckoutInfo,
  type Forge,
  type MrInfo,
  type RepoInfo,
} from './forge.js'
import { renderMrDetail } from './format.js'

export const name = 'mr'
export const inject = ['commands', 'connection', 'sessions'] as const

export interface Config {
  /** How long one fetched request stays fresh before the chip re-queries. */
  refreshMs: number
  /** Whether a request lookup is attempted at all. */
  enabled: boolean
}

export const Config: z<Config> = z.object({
  refreshMs: z.number().default(60_000),
  enabled: z.boolean().default(true),
})

const GIT_TIMEOUT_MS = 5_000
const CLI_TIMEOUT_MS = 20_000
/** Re-detect the forge after this long, so a newly added remote is noticed. */
const FORGE_TTL_MS = 10 * 60_000

interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

function run(command: string, args: readonly string[], cwd: string, timeout: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(command, [...args], { cwd, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? 1 : 0
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Normalized status served to the client and the command. */
export interface MrStatus {
  cwd: string
  branch: string | null
  forge: Forge | null
  info: MrInfo | null
  /** Present only for an unexpected failure; "no request" is not an error. */
  error?: string
  fetchedAt: number
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

/**
 * The directory this Session actually works in: the committed working
 * directory when the service is present, else the Session header's initial
 * cwd. Optional because a minimal composition may omit the service.
 */
function sessionCwd(ctx: Context, sessionId: string): string | undefined {
  const session = ctx.sessions.get(sessionId as SessionId)
  if (session === undefined) return undefined
  try {
    const service = (ctx as unknown as { get?(name: string): unknown }).get?.('workingDirectory') as
      | { get(session: Session): string }
      | undefined
    const cwd = service?.get(session)
    if (typeof cwd === 'string' && cwd !== '') return cwd
  } catch {
    // Fall through to the header value.
  }
  return session.header.cwd
}

/** Facts about the checkout that a by-branch request lookup cannot carry. */
interface RepositoryFacts extends RepoInfo {
  /** `owner/name` of every GitHub remote, lowercased. */
  repos?: string[]
}

/** Cached forge detection, plus the repository facts the request lookup needs. */
interface ForgeLookup extends RepositoryFacts {
  forge: Forge
}

/**
 * Install the plugin: one `/mr` command, one authenticated status route, and a
 * per-session cache shared by both.
 * @param ctx - plugin context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config = Config()): void {
  const cache = new Map<string, { branch: string; at: number; status: MrStatus }>()
  const inflight = new Map<string, Promise<MrStatus>>()
  const forgeCache = new Map<string, { at: number; value: Promise<ForgeLookup | undefined> }>()

  /**
   * Probe the repository-level facts a by-branch lookup cannot express: the
   * default branch, and on GitHub which repositories this checkout may push to.
   * Best effort — an unanswered probe only costs the suppression rules, so the
   * request itself is still shown.
   */
  async function describeRepository(cwd: string, forge: Forge, urls: string[]): Promise<RepositoryFacts> {
    if (forge === 'gitlab') {
      const res = await run('glab', ['api', GITLAB_PROJECT_PATH], cwd, CLI_TIMEOUT_MS)
      return res.code === 0 ? gitlabRepoInfo(parseJson(res.stdout)) : {}
    }
    const [repoRes, loginRes] = await Promise.all([
      run('gh', ['repo', 'view', '--json', GITHUB_REPO_FIELDS], cwd, CLI_TIMEOUT_MS),
      // A local config read, so it costs a fork of the process rather than a
      // network round trip. The login is how an own-fork pull request is told
      // apart from a stranger's fork of the same branch name.
      run('gh', ['config', 'get', '-h', 'github.com', 'user'], cwd, GIT_TIMEOUT_MS),
    ])
    return {
      repos: githubRemoteRepos(urls),
      ...(repoRes.code === 0 ? githubRepoInfo(parseJson(repoRes.stdout)) : {}),
      ...(loginRes.code === 0 ? { login: githubLogin(loginRes.stdout) } : {}),
    }
  }

  /**
   * Resolve the forge once per working directory. The promise itself is cached
   * (not a boolean flag) so concurrent first readers await the same lookup
   * instead of observing a half-initialized state; a rejected lookup is
   * dropped so the next call retries.
   */
  function resolveForge(cwd: string): Promise<ForgeLookup | undefined> {
    const now = Date.now()
    const cached = forgeCache.get(cwd)
    if (cached !== undefined && now - cached.at < FORGE_TTL_MS) return cached.value
    const value = (async (): Promise<ForgeLookup | undefined> => {
      const res = await run('git', ['config', '--get-regexp', '^remote\\..*\\.url$'], cwd, GIT_TIMEOUT_MS)
      if (res.code !== 0) return undefined
      const urls = parseRemoteUrls(res.stdout)
      const forge = detectForge(urls)
      if (forge === undefined) return undefined
      return { forge, ...(await describeRepository(cwd, forge, urls)) }
    })()
    forgeCache.set(cwd, { at: now, value })
    value.catch(() => {
      if (forgeCache.get(cwd)?.value === value) forgeCache.delete(cwd)
    })
    return value
  }

  async function fillGitlabCi(cwd: string, info: MrInfo): Promise<void> {
    if (info.sha === undefined) return
    const res = await run('glab', ['api', gitlabCommitPath(info.sha)], cwd, CLI_TIMEOUT_MS)
    if (res.code === 0) info.ci = ciFromGitlabCommit(parseJson(res.stdout))
  }

  async function queryForge(cwd: string, forge: Forge, checkout: CheckoutInfo): Promise<MrInfo | undefined> {
    if (forge === 'gitlab') {
      const res = await run('glab', ['api', gitlabApiPath(checkout.branch)], cwd, CLI_TIMEOUT_MS)
      if (res.code !== 0) throw new Error(res.stderr.trim() || `glab exited ${res.code}`)
      const info = normalizeGitlab(parseJson(res.stdout), checkout)
      if (info !== undefined && info.ci === 'none') await fillGitlabCi(cwd, info)
      return info
    }
    const res = await run(
      'gh',
      ['pr', 'list', '--head', checkout.branch, '--state', 'all', '--limit', '5', '--json', GITHUB_PR_FIELDS],
      cwd,
      CLI_TIMEOUT_MS,
    )
    if (res.code !== 0) throw new Error(res.stderr.trim() || `gh exited ${res.code}`)
    return normalizeGithub(parseJson(res.stdout), checkout)
  }

  /** Refresh one session's status, coalescing concurrent readers. */
  async function refresh(cwd: string, key: string, branch: string): Promise<MrStatus> {
    const existing = inflight.get(key)
    if (existing !== undefined) return existing
    const task = (async (): Promise<MrStatus> => {
      const status: MrStatus = { cwd, branch, forge: null, info: null, fetchedAt: Date.now() }
      const lookup = await resolveForge(cwd)
      if (lookup === undefined) return status
      status.forge = lookup.forge
      const checkout: CheckoutInfo = {
        branch,
        defaultBranch: lookup.defaultBranch,
        repos: lookup.repos,
        login: lookup.login,
      }
      try {
        status.info = (await queryForge(cwd, lookup.forge, checkout)) ?? null
      } catch (error) {
        status.error = error instanceof Error ? error.message : String(error)
      }
      return status
    })()
    inflight.set(key, task)
    try {
      const status = await task
      cache.set(key, { branch, at: Date.now(), status })
      return status
    } finally {
      inflight.delete(key)
    }
  }

  /**
   * Read (or refresh) the status for one session.
   * @param sessionId - the calling session.
   * @param force - bypass the freshness window (used by `/mr`).
   * @returns the status, or undefined when the session or its cwd is unknown.
   */
  async function statusFor(sessionId: string, force = false): Promise<MrStatus | undefined> {
    const cwd = sessionCwd(ctx, sessionId)
    if (cwd === undefined) return undefined
    const branchRes = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd, GIT_TIMEOUT_MS)
    const branch = branchRes.code === 0 ? branchRes.stdout.trim() : ''
    if (branch === '' || branch === 'HEAD') {
      return { cwd, branch: null, forge: null, info: null, fetchedAt: Date.now() }
    }
    const cached = cache.get(sessionId)
    if (!force && cached !== undefined && cached.branch === branch && Date.now() - cached.at < config.refreshMs) {
      return cached.status
    }
    return refresh(cwd, sessionId, branch)
  }

  ctx.effect(() =>
    ctx.commands.register({
      name: 'mr',
      description: "Show this branch's merge request or pull request",
      handler: async (invocation) => {
        if (!config.enabled) return { kind: 'success', text: 'dsh-mr is disabled in this profile.' }
        const raw = invocation.rawInput.trim()
        if (raw !== '' && raw !== 'status') return { kind: 'error', text: 'Usage: /mr [status]' }
        const status = await statusFor(String(invocation.agent.id), raw === '')
        if (status === undefined) return { kind: 'error', text: 'No session working directory.' }
        if (status.info === null) {
          return { kind: 'success', text: status.error ?? `No merge request for ${status.branch ?? 'this checkout'}.` }
        }
        return { kind: 'success', text: renderMrDetail(status.info) }
      },
    }),
  )

  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: '/api/dsh-mr/status',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request: Request): Promise<Response> => {
        if (!config.enabled) {
          return json({ enabled: false, cwd: '', branch: null, forge: null, info: null, fetchedAt: Date.now(), refreshMs: config.refreshMs })
        }
        const url = new URL(request.url)
        const sessionId = url.searchParams.get('session')
        if (sessionId === null || sessionId === '') return json({ error: 'missing session' }, 400)
        const status = await statusFor(sessionId)
        return json({
          enabled: true,
          refreshMs: config.refreshMs,
          ...(status ?? { cwd: '', branch: null, forge: null, info: null, fetchedAt: Date.now() }),
        })
      },
    }),
  )

  // Per-session caches live as long as their session; drop them with it.
  ctx.on('session/disposed', (session: Session) => {
    const key = String(session.id)
    cache.delete(key)
    inflight.delete(key)
  })

  ctx.logger.debug('dsh-mr loaded')
}

export { renderMrLine } from './format.js'
