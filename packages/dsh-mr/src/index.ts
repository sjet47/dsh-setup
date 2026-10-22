/**
 * dsh-mr — show the current branch's merge request (GitLab) or pull request
 * (GitHub) in the dsh Web session header, and print it on `/mr`.
 *
 * Data comes from `glab` on GitLab remotes and `gh` on GitHub remotes, so the
 * CLIs' own auth is reused and no tokens live here. The browser chip reads the
 * status through an authenticated exact Fetch route; the `/mr` command renders
 * the same value as text.
 *
 * Ported from pi-mr (pi-setup), keeping its forge layer unchanged.
 * @module dsh-mr
 */
import { execFile } from 'node:child_process'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
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
import { renderMrDetail, renderMrLine } from './format.js'

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

interface CacheEntry {
  /** Branch the cached status belongs to. */
  branch: string
  at: number
  status: MrStatus
}

interface CwdState {
  forgeResolved: boolean
  forge?: Forge
}

function statusJson(status: MrStatus): string {
  return JSON.stringify(status)
}

/**
 * Install the plugin: one `/mr` command, one authenticated status route, and a
 * per-session cache shared by both.
 * @param ctx - plugin context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const cwdState = new Map<string, CwdState>()
  const cache = new Map<string, CacheEntry>()
  const inflight = new Map<string, Promise<MrStatus>>()

  function stateFor(cwd: string): CwdState {
    let state = cwdState.get(cwd)
    if (state === undefined) {
      state = { forgeResolved: false }
      cwdState.set(cwd, state)
    }
    return state
  }

  function sessionCwd(sessionId: string): string | undefined {
    const session = ctx.sessions.get(sessionId as SessionId)
    return session?.header.cwd
  }

  async function resolveForge(cwd: string): Promise<Forge | undefined> {
    const state = stateFor(cwd)
    if (state.forgeResolved) return state.forge
    state.forgeResolved = true
    const res = await run('git', ['config', '--get-regexp', '^remote\\..*\\.url$'], cwd, GIT_TIMEOUT_MS)
    if (res.code === 0) state.forge = detectForge(parseRemoteUrls(res.stdout))
    return state.forge
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
    const cwd = sessionCwd(sessionId)
    if (cwd === undefined) return undefined
    const branchRes = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd, GIT_TIMEOUT_MS)
    const branch = branchRes.code === 0 ? branchRes.stdout.trim() : ''
    if (branch === '' || branch === 'HEAD') {
      return { cwd, branch: null, forge: null, info: null, fetchedAt: Date.now() }
    }
    const key = `${sessionId}`
    const cached = cache.get(key)
    if (!force && cached !== undefined && cached.branch === branch && Date.now() - cached.at < config.refreshMs) {
      return cached.status
    }
    return refresh(cwd, key, branch)
  }

  ctx.effect(() =>
    ctx.commands.register({
      name: 'mr',
      description: "Show this branch's merge request or pull request",
      handler: async (invocation) => {
        const raw = invocation.rawInput.trim()
        if (raw === 'status') {
          const status = await statusFor(String(invocation.agent.id))
          if (status === undefined) return { kind: 'error', text: 'No session working directory.' }
          if (status.info === null) {
            return { kind: 'success', text: status.error ?? `No merge request for ${status.branch ?? 'this checkout'}.` }
          }
          return { kind: 'success', text: renderMrDetail(status.info) }
        }
        const status = await statusFor(String(invocation.agent.id), true)
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
        if (!config.enabled) return Response.json({ info: null })
        const url = new URL(request.url)
        const sessionId = url.searchParams.get('session')
        if (sessionId === null || sessionId === '') {
          return Response.json({ error: 'missing session' }, { status: 400 })
        }
        const status = await statusFor(sessionId)
        return new Response(statusJson(status ?? { cwd: '', branch: null, forge: null, info: null, fetchedAt: Date.now() }), {
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        })
      },
    }),
  )

  ctx.logger.debug('dsh-mr loaded')
}

export { renderMrLine }
