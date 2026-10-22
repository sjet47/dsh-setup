/**
 * dsh-note — project-level file-based memory shared with pi-note, plus a
 * per-session scratchpad directory.
 *
 * Memory lives in pi's own agent directory (`$PI_CODING_AGENT_DIR` or
 * `~/.pi/agent`) under `pi-note/<project slug>/`, so a project's memories are
 * the same files whichever agent wrote them. The slug is derived from the git
 * main worktree exactly like pi-note, which keeps every worktree of one
 * repository on one directory.
 *
 * Ported from pi-note (pi-setup); the browser overlay became an authenticated
 * HTTP route plus a Web client panel.
 * @module dsh-note
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-shell-env'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { buildTopics, type MemoryTopic } from './memory-index.js'
import { deleteTopic, loadTopics, readTopicBody } from './memory-store.js'
import { memoryRootFor } from './git-root.js'
import { MEMORY_DIR_NAME, MEMORY_INDEX_NAME, memoryDirFor, memoryRootLabel, scratchpadDirFor, scratchpadRoot } from './paths.js'
import { prepareSession } from './prepare.js'
import { buildPromptAppend } from './prompt.js'

export const name = 'note'
export const inject = ['commands', 'connection', 'sessions'] as const

/** Environment variable exported to shell calls for the session scratchpad. */
export const SCRATCH_SHELL_VAR = 'DSH_NOTE_SCRATCHPAD_DIR'

/** Pi's own agent directory, so both agents read the same memories. */
function piAgentDir(): string {
  const configured = process.env['PI_CODING_AGENT_DIR']
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.pi', 'agent')
}

interface NoteRecord {
  memoryDir: string
  memoryIndex: string
  scratchDir: string
  label: string
  snapshot: string
  fiber?: Fiber
}

/** Wire shape of one listed memory. */
interface TopicWire {
  title: string
  file: string
  hook: string
  indexed: boolean
  exists: boolean
  size?: number
  mtimeMs?: number
}

function toWire(topic: MemoryTopic): TopicWire {
  return {
    title: topic.title,
    file: topic.file,
    hook: topic.hook,
    indexed: topic.indexed,
    exists: topic.exists,
    ...(topic.size === undefined ? {} : { size: topic.size }),
    ...(topic.mtimeMs === undefined ? {} : { mtimeMs: topic.mtimeMs }),
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

/**
 * Install the memory injection, the scratchpad environment, the `/memory`
 * command, and the browser routes.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  const records = new Map<string, NoteRecord>()

  /** Build (but do not prepare) the paths for one session. */
  function pathsFor(sessionId: string): { memoryDir: string; memoryIndex: string; scratchDir: string; label: string } | undefined {
    const session = ctx.sessions.get(sessionId as SessionId)
    const cwd = session?.header.cwd
    if (cwd === undefined) return undefined
    const root = memoryRootFor(cwd)
    const memoryDir = memoryDirFor(piAgentDir(), root)
    return {
      memoryDir,
      memoryIndex: join(memoryDir, MEMORY_INDEX_NAME),
      scratchDir: scratchpadDirFor(sessionId, scratchpadRoot()),
      label: memoryRootLabel(root),
    }
  }

  /**
   * Prepare one session's dirs and snapshot. Idempotent; a failure degrades to
   * "no memory" for that session instead of failing plugin load.
   * @param sessionId - owning session.
   * @returns the record, or undefined when the session has no cwd.
   */
  function ensureRecord(sessionId: string): NoteRecord | undefined {
    const existing = records.get(sessionId)
    if (existing !== undefined) return existing
    const paths = pathsFor(sessionId)
    if (paths === undefined) return undefined
    try {
      const prepared = prepareSession(paths.memoryDir, paths.scratchDir)
      const record: NoteRecord = { ...paths, snapshot: prepared.snapshot }
      records.set(sessionId, record)
      return record
    } catch (error) {
      ctx.logger.warn(`dsh-note: cannot prepare memory dir: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  ctx.on('agent/created', (payload: { agent: Agent }) => {
    const sessionId = String(payload.agent.id)
    const record = ensureRecord(sessionId)
    if (record === undefined) return
    const block = buildPromptAppend(record.memoryDir, record.scratchDir, record.snapshot)
    record.fiber = payload.agent.ctx.inject(['systemPrompt'], (scoped) => {
      scoped.systemPrompt.section({
        name: 'dsh-note:memory',
        order: 850,
        text: () => block,
        interpolate: false,
      })
    })
    return undefined
  })

  ctx.on('agent/disposed', (payload: { agent: Agent }) => {
    const sessionId = String(payload.agent.id)
    const record = records.get(sessionId)
    if (record?.fiber !== undefined) void record.fiber.dispose()
    records.delete(sessionId)
  })

  // Shell-call scratchpad variable. Registered through a nested inject so a
  // composition without dsh-shell-env still loads this plugin.
  ctx.inject(['shellEnv'], (scoped) => {
    scoped.shellEnv.register({
      name: 'dsh-note',
      variables: { [SCRATCH_SHELL_VAR]: { description: 'Per-session scratch directory for dsh-note.' } },
      resolve: (execution) => {
        const agent = execution.agent
        if (agent === undefined) return {}
        const record = records.get(String(agent.id)) ?? ensureRecord(String(agent.id))
        return record === undefined ? {} : { [SCRATCH_SHELL_VAR]: record.scratchDir }
      },
    })
  })

  ctx.effect(() =>
    ctx.commands.register({
      name: 'memory',
      description: "Open this project's memory browser (shared with pi)",
      handler: (invocation) => {
        const sessionId = String(invocation.agent.id)
        const record = ensureRecord(sessionId)
        if (record === undefined) return { kind: 'error', text: 'No working directory for this session.' }
        const raw = invocation.rawInput.trim()
        if (raw === 'path') {
          return { kind: 'success', text: `${record.memoryDir}\nscratchpad: ${record.scratchDir}` }
        }
        const topics = loadTopics(record.memoryDir)
        if (topics.length === 0) {
          return { kind: 'success', text: `No memories yet in ${record.label}. Ask the agent to remember something, or open /memory in the Web header.` }
        }
        const lines = topics.map((topic) => {
          const status = topic.exists ? '' : ' (missing)'
          const indexed = topic.indexed ? '' : ' (unindexed)'
          return `- ${topic.title}${status}${indexed} — ${topic.file}${topic.hook === '' ? '' : `: ${topic.hook}`}`
        })
        return { kind: 'success', text: `${record.label} · ${topics.length} topics\n${lines.join('\n')}` }
      },
    }),
  )

  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: '/api/dsh-note/list',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request: Request): Promise<Response> => {
        const sessionId = new URL(request.url).searchParams.get('session') ?? ''
        const record = ensureRecord(sessionId)
        if (record === undefined) return json({ error: 'unknown session' }, 404)
        const topics = loadTopics(record.memoryDir).map(toWire)
        return json({
          label: record.label,
          memoryDir: record.memoryDir,
          memoryIndex: record.memoryIndex,
          scratchDir: record.scratchDir,
          topics,
        })
      },
    }),
  )

  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: '/api/dsh-note/body',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request: Request): Promise<Response> => {
        const url = new URL(request.url)
        const sessionId = url.searchParams.get('session') ?? ''
        const file = url.searchParams.get('file') ?? ''
        const record = ensureRecord(sessionId)
        if (record === undefined) return json({ error: 'unknown session' }, 404)
        if (file === '') return json({ error: 'missing file' }, 400)
        const body = readTopicBody(record.memoryDir, file)
        if (!body.ok) return json({ error: body.error }, 404)
        return json({ file, text: body.text, path: join(record.memoryDir, file) })
      },
    }),
  )

  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: '/api/dsh-note/delete',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request): Promise<Response> => {
        const sessionId = new URL(request.url).searchParams.get('session') ?? ''
        const record = ensureRecord(sessionId)
        if (record === undefined) return json({ error: 'unknown session' }, 404)
        let file = ''
        try {
          const payload = (await request.json()) as { file?: unknown }
          if (typeof payload.file === 'string') file = payload.file
        } catch {
          return json({ error: 'invalid body' }, 400)
        }
        if (file === '') return json({ error: 'missing file' }, 400)
        const topic = loadTopics(record.memoryDir).find((candidate) => candidate.file === file)
        if (topic === undefined) return json({ error: 'not a memory' }, 404)
        const result = deleteTopic(record.memoryDir, topic)
        return result.ok ? json({ ok: true }) : json({ error: result.error }, 500)
      },
    }),
  )

  ctx.logger.debug('dsh-note loaded')
}

export { buildTopics }
