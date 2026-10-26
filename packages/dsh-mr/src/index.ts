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
  gitlabApiPath,
  gitlabCommitPath,
  normalizeGithub,
  normalizeGitlab,
  parseRemoteUrls,
  type Forge,
  type MrInfo,
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

/**
 * Install the plugin: one `/mr` command, one authenticated status route, and a
 * per-session cache shared by both.
 * @param ctx - plugin context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config = Config()): void {
  const cache = new Map<string, { branch: string; at: number; status: MrStatus }>()
  const inflight = new Map<string, Promise<MrStatus>>()
  const forgeCache = new Map<string, { at: number; value: Promise<Forge | undefined> }>()

  /**
   * Resolve the forge once per working directory. The promise itself is cached
   * (not a boolean flag) so concurrent first readers await the same lookup
   * instead of observing a half-initialized state; a rejected lookup is
   * dropped so the next call retries.
   */
  function resolveForge(cwd: string): Promise<Forge | undefined> {
    const now = Date.now()
    const cached = forgeCache.get(cwd)
    if (cached !== undefined && now - cached.at < FORGE_TTL_MS) return cached.value
    const value = (async (): Promise<Forge | undefined> => {
      const res = await run('git', ['config', '--get-regexp', '^remote\\..*\\.url$'], cwd, GIT_TIMEOUT_MS)
      if (res.code !== 0) return undefined
      return detectForge(parseRemoteUrls(res.stdout))
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

  async function queryForge(cwd: string, forge: Forge, branch: string): Promise<MrInfo | undefined> {
    if (forge === 'gitlab') {
      const res = await run('glab', ['api', gitlabApiPath(branch)], cwd, CLI_TIMEOUT_MS)
      if (res.code !== 0) throw new Error(res.stderr.trim() || `glab exited ${res.code}`)
      const info = normalizeGitlab(parseJson(res.stdout))
      if (info !== undefined && info.ci === 'none') await fillGitlabCi(cwd, info)
      return info
    }
    const res = await run(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '5', '--json', GITHUB_PR_FIELDS],
      cwd,
      CLI_TIMEOUT_MS,
    )
    if (res.code !== 0) throw new Error(res.stderr.trim() || `gh exited ${res.code}`)
    return normalizeGithub(parseJson(res.stdout))
  }

  /** Refresh one session's status, coalescing concurrent readers. */
  async function refresh(cwd: string, key: string, branch: string): Promise<MrStatus> {
    const existing = inflight.get(key)
    if (existing !== undefined) return existing
    const task = (async (): Promise<MrStatus> => {
      const status: MrStatus = { cwd, branch, forge: null, info: null, fetchedAt: Date.now() }
      const forge = await resolveForge(cwd)
      if (forge === undefined) return status
      status.forge = forge
      try {
        status.info = (await queryForge(cwd, forge, branch)) ?? null
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
