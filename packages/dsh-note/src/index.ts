/**
 * dsh-note — project-level file-based memory shared with Claude Code and pi,
 * plus a per-session scratchpad directory.
 *
 * Memory lives in Claude Code's auto-memory directory
 * (`$CLAUDE_CONFIG_DIR` or `~/.claude`)/projects/<claude-slug>/memory, so a
 * project's memories are the same files whichever agent wrote them, in Claude
 * Code's file format. The slug is derived from the git main worktree, the same
 * key Claude Code uses, which keeps every worktree of one repository on one
 * directory.
 *
 * The session's directory is read from the `workingDirectory` service when the
 * composition provides it, so memory follows a Session that moved.
 *
 * Ported from pi-note (pi-setup); the browser overlay became an authenticated
 * HTTP route plus a Web client panel.
 * @module dsh-note
 */
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { buildTopics, splitFrontmatter, type MemoryTopic } from './memory-index.js'
import { deleteTopic, loadTopics, readTopicBody, resolveInside } from './memory-store.js'
import { memoryRootFor } from './git-root.js'
import { MEMORY_INDEX_NAME, memoryDirFor, memoryRootLabel, scratchpadDirFor, scratchpadRoot } from './paths.js'
import { resolveClaudeMemoryConfig } from './claude-memory.js'
import { prepareSession } from './prepare.js'
import { buildPromptAppend } from './prompt.js'
import { buildMemoryRefresh, baselineFromSnapshot, DEFAULT_REFRESH_MAX_CHARS, probeIndex, sameIndex, type IndexSnapshot } from './refresh.js'

export const name = 'note'
export const inject = ['commands', 'connection', 'sessions'] as const

/** Environment variable exported to shell calls for the session scratchpad. */
export const SCRATCH_SHELL_VAR = 'DSH_NOTE_SCRATCHPAD_DIR'

export interface Config {
  /** Keep the plugin loaded but stop injecting memory and serving routes. */
  enabled: boolean
  /** Longest MEMORY.md snapshot placed in the system prompt. */
  snapshotMaxChars: number
  /** Largest memory file the browser may read in one request. */
  maxBodyBytes: number
  /** Announce MEMORY.md changes at the start of the turn after they happen. */
  memoryRefresh: boolean
  /** Longest MEMORY.md content copied into one refresh message. */
  memoryRefreshMaxChars: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  snapshotMaxChars: z.number().default(16_000),
  maxBodyBytes: z.number().default(1024 * 1024),
  memoryRefresh: z.boolean().default(true),
  memoryRefreshMaxChars: z.number().min(1).default(DEFAULT_REFRESH_MAX_CHARS),
})

interface NoteRecord {
  memoryDir: string
  memoryIndex: string
  scratchDir: string
  label: string
  snapshot: string
  /**
   * MEMORY.md as this session last saw it. Undefined until the first successful
   * probe, so a file that could not be read at session start is adopted as the
   * baseline silently instead of being announced as a change.
   */
  trackedIndex?: IndexSnapshot
  /**
   * A rendered refresh waiting to be logged. The baseline only advances once the
   * message is in the session log (`session/event`), so a step that is abandoned
   * between pre-step and the append announces the change again later instead of
   * losing it.
   */
  pendingRefresh?: { messageId: string; next: IndexSnapshot }
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
 * The directory this Session actually works in: the committed working
 * directory when the service is present, else the Session header's initial
 * cwd. Optional because a minimal composition may omit the service.
 */
function sessionCwd(ctx: Context, session: Session): string | undefined {
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
 * Build the durable user message that announces a memory-index change. It
 * enters through `agent/pre-step`, so it becomes an ordinary logged
 * `user/message`: it replays, compacts and resumes like the workspace
 * instruction messages do.
 * @param refresh - rendered text and its source descriptor.
 * @returns the message to insert into the next step.
 */
function refreshMessage(refresh: ReturnType<typeof buildMemoryRefresh>): UserMessage {
  return {
    id: randomUUID() as unknown as MessageId,
    role: 'user',
    content: [{ type: 'text', text: refresh.text }],
    source: refresh.source,
  } as unknown as UserMessage
}

/**
 * Install the memory injection, the scratchpad environment, the `/memory`
 * command, and the browser routes.
 * @param ctx - plugin context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config = Config()): void {
  const records = new Map<string, NoteRecord>()

  /** Build (but do not prepare) the paths for one session. */
  function pathsFor(sessionId: string): { memoryDir: string; memoryIndex: string; scratchDir: string; label: string } | undefined {
    const session = ctx.sessions.get(sessionId as SessionId)
    if (session === undefined) return undefined
    const cwd = sessionCwd(ctx, session)
    if (cwd === undefined) return undefined
    const root = memoryRootFor(cwd)
    // Claude Code's auto-memory dir, resolved every session start: the env var
    // and Claude Code's settings may change between sessions.
    const memoryDir = memoryDirFor(resolveClaudeMemoryConfig(process.env), root)
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
    if (!config.enabled) return undefined
    const existing = records.get(sessionId)
    if (existing !== undefined) return existing
    const paths = pathsFor(sessionId)
    if (paths === undefined) return undefined
    try {
      const prepared = prepareSession(paths.memoryDir, paths.scratchDir)
      // The baseline is the snapshot itself, not a second read: the model gets
      // `prepared.snapshot`, so anything that differs from it afterwards is a
      // real change worth announcing.
      const record: NoteRecord = {
        ...paths,
        snapshot: prepared.snapshot,
        ...(config.memoryRefresh ? { trackedIndex: baselineFromSnapshot(prepared.snapshot, prepared.stat) } : {}),
      }
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
    if (record === undefined) return undefined
    const block = buildPromptAppend(record.memoryDir, record.scratchDir, record.snapshot, config.snapshotMaxChars)
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

  // Agent-scoped registrations are not disposed by unloading the plugin alone:
  // keep their disposers here so an unload/HMR removes every prompt section.
  ctx.effect(() => () => {
    for (const record of records.values()) {
      if (record.fiber !== undefined) void record.fiber.dispose()
    }
    records.clear()
  })

  // The baseline advances at the end of a turn, not when the announcement is
  // made: the window this feature watches is "the end of the previous turn to
  // the start of the next one", so everything this session wrote during its own
  // turn is absorbed into that baseline and needs no write tracking at all.
  // A pending announcement suppresses the update, so a step abandoned before the
  // message was logged re-announces the change next turn instead of losing it.
  ctx.on('session/event', (session, event) => {
    if (event.type === 'user/message') {
      const messageId = String(event.data.id)
      for (const record of records.values()) {
        const pending = record.pendingRefresh
        if (pending === undefined || pending.messageId !== messageId) continue
        delete record.pendingRefresh
        return
      }
      return
    }
    if (event.type !== 'turn/end') return
    const record = records.get(String(session.id))
    if (record === undefined || !config.memoryRefresh) return
    try {
      if (record.pendingRefresh !== undefined) {
        // The refresh never reached the log; keep the old baseline so the next
        // turn still sees the change.
        delete record.pendingRefresh
        return
      }
      const probe = probeIndex(record.memoryIndex)
      if (probe.kind !== 'unstable') record.trackedIndex = probe
    } catch (error) {
      ctx.logger.warn(`dsh-note: cannot re-baseline the memory index: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // MEMORY.md is frozen into the system prompt at session start, so a memory
  // another agent writes while this session is idle would stay invisible. At the
  // first pre-step of a turn, compare against the snapshot taken when the last
  // turn ended and hand any change over as one logged user message. mtime/size
  // make the check a single stat; the digest keeps a `touch` quiet.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!config.enabled || !config.memoryRefresh) return decision
    if (decision.kind === 'reject' || payload.step !== 1) return decision
    // The loop skips an empty first step; entering ours would make the agent
    // answer without being asked. Keep the baseline, announce on the next turn.
    if (payload.messages.length === 0) return decision
    try {
      const sessionId = String(payload.agent.id)
      // After an unload/HMR the records are gone while the agent lives on.
      const record = records.get(sessionId) ?? ensureRecord(sessionId)
      if (record === undefined) return decision
      const probe = probeIndex(record.memoryIndex, record.trackedIndex)
      if (probe.kind === 'unstable') return decision
      const previous = record.trackedIndex
      if (previous === undefined || sameIndex(previous, probe)) {
        // Nothing changed while idle, or the same memory under a new mtime.
        record.trackedIndex = probe
        return decision
      }
      const refresh = buildMemoryRefresh({
        indexPath: record.memoryIndex,
        previous,
        current: probe,
        maxChars: config.memoryRefreshMaxChars,
      })
      const message = refreshMessage(refresh)
      // Enter the refresh right after the claimed input, exactly where another
      // pre-step contributor's injected context sits. Match by id: a listener
      // that replaced the claimed messages with copies keeps their ids.
      const claimed = new Set(payload.messages.map((entry) => String(entry.id)))
      let insertAt = payload.messages.length
      for (let index = decision.messages.length - 1; index >= 0; index -= 1) {
        if (claimed.has(String(decision.messages[index].id))) {
          insertAt = index + 1
          break
        }
      }
      const messages = [...decision.messages.slice(0, insertAt), message, ...decision.messages.slice(insertAt)]
      record.pendingRefresh = { messageId: String(message.id), next: probe }
      return { ...decision, messages }
    } catch (error) {
      ctx.logger.warn(`dsh-note: cannot refresh the memory index: ${error instanceof Error ? error.message : String(error)}`)
      return decision
    }
  })

  // Shell-call scratchpad variable. Registered through a nested inject so a
  // composition without dsh-shell-env still loads this plugin.
  ctx.inject(['shellEnv'], (scoped) => {
    scoped.shellEnv.register({
      name: 'dsh-note',
      variables: { [SCRATCH_SHELL_VAR]: { description: 'Per-session scratch directory for dsh-note.' } },
      resolve: (execution) => {
        if (!config.enabled) return {}
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
        if (!config.enabled) return { kind: 'success', text: 'dsh-note is disabled in this profile.' }
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
        if (!config.enabled) return json({ enabled: false, label: '', memoryDir: '', topics: [] })
        const sessionId = new URL(request.url).searchParams.get('session') ?? ''
        const record = ensureRecord(sessionId)
        if (record === undefined) return json({ error: 'unknown session' }, 404)
        const topics = loadTopics(record.memoryDir).map(toWire)
        return json({
          enabled: true,
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
        if (!config.enabled) return json({ error: 'disabled' }, 404)
        const url = new URL(request.url)
        const sessionId = url.searchParams.get('session') ?? ''
        const file = url.searchParams.get('file') ?? ''
        const record = ensureRecord(sessionId)
        if (record === undefined) return json({ error: 'unknown session' }, 404)
        if (file === '') return json({ error: 'missing file' }, 400)
        const target = resolveInside(record.memoryDir, file)
        if (target === undefined) return json({ error: 'unsafe path in MEMORY.md' }, 400)
        let size: number
        try {
          size = statSync(target).size
        } catch {
          return json({ error: 'file is missing' }, 404)
        }
        // Bound what one request can pull into memory: these files are
        // agent-written content, not Host assets.
        if (size > config.maxBodyBytes) {
          return json({ error: `file is larger than ${config.maxBodyBytes} bytes` }, 413)
        }
        const body = readTopicBody(record.memoryDir, file)
        if (!body.ok) return json({ error: body.error }, 404)
        if (Buffer.byteLength(body.text, 'utf8') > config.maxBodyBytes) {
          return json({ error: `file is larger than ${config.maxBodyBytes} bytes` }, 413)
        }
        // Strip Claude Code's frontmatter before shipping the body: it is recall
        // metadata, not content. The path stays available for the editor.
        return json({ file, text: splitFrontmatter(body.text).body, path: join(record.memoryDir, file) })
      },
    }),
  )

  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: '/api/dsh-note/delete',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request): Promise<Response> => {
        if (!config.enabled) return json({ error: 'disabled' }, 404)
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
