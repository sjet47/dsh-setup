/**
 * dsh-recap — one-line session recap, on demand, on resume, or after a few
 * idle minutes.
 *
 * Ported from pi-recap. Generation reuses the recap system prompt and the
 * sanitizer unchanged; the surrounding state machine is rebuilt on dsh's
 * session log and on a small per-session record file under `$DSH_HOME`.
 *
 * A recap is plugin-owned data, not session history: a third-party bundle
 * resolves its own copy of `@deepseek-ai/dsh-session`, so the private-brand
 * `appendPluginRecord` entry point cannot write to the runtime's Session.
 * @module dsh-recap
 */
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Message } from '@deepseek-ai/dsh-llm'
import { sanitizeRecapText } from './sanitize.js'

export const name = 'recap'
export const inject = ['commands', 'connection', 'sessions', 'llm'] as const

/** Durable recap record. `seq` is the session log length it reflects. */
interface RecapRecord {
  version: 1
  text: string
  seq: number
  /** Dismissed by the user; restored hidden instead of popping back up. */
  hidden?: boolean
}

const RECAP_SYSTEM_PROMPT = `You write compact recaps for an AI coding-agent session.

Given the current session context, produce one plain-text sentence for the user to resume later.
Write it in the main language of the user's messages: a Chinese session recaps in Chinese, an English session in English. Never fall back to English when the user writes Chinese. Keep code identifiers, file paths, and command names exactly as they appear.
Start with the user's goal or reason for the session, inferred from user messages. Do not start with the assistant's answer.
Then include the current outcome, important decision, touched file, blocker, or likely next action only if it helps resume.
Prefer: Goal/purpose. Current state. Next action.
Length: about 160 characters in English, or about 80 characters in Chinese. Stay under 240 characters (120 in Chinese).
Do not add a label or prefix. Do not use markdown. Do not mention yourself as "the assistant".

Good (zh): 在定 pi-inline-skills 该不该从 $skill 换成 /skill；倾向只留 / 且命令优先，下一步决定开头的 /skill 是否展开。
Bad (zh): 可行；我会默认用 / 并跳过配置。扩展命令优先，下一步决定开头 /skill token 是否展开。
Good (en): Deciding whether pi-inline-skills should switch from $skill to /skill. Recommendation is / only with commands winning; next decide whether leading /skill should expand.
Bad (en): Feasible; I'd default to / and skip config. Extension commands win first; next decide whether leading /skill tokens should expand.`

export interface Config {
  /** Generate recaps at all; commands still report state when false. */
  enabled: boolean
  /** Idle delay after a turn before an automatic recap; 0 disables it. */
  idleMs: number
  /** Output token budget for one recap request. */
  maxTokens: number
  /** Abort one recap request after this long. */
  timeoutMs: number
  /** Keep a restored but stale recap visible on resume. */
  showStale: boolean
  /** Also recap child subagent sessions automatically. */
  subagents: boolean
  /** Delete recap files not touched for this many days; 0 keeps them. */
  retentionDays: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  idleMs: z.number().default(5 * 60 * 1000),
  maxTokens: z.number().default(2_048),
  timeoutMs: z.number().default(30_000),
  showStale: z.boolean().default(true),
  subagents: z.boolean().default(false),
  retentionDays: z.number().default(30),
})

interface ModelOverride {
  provider: string
  model: string
}

/** One selectable model, as the Plugins page renders it. */
interface ModelOption {
  id: string
  name: string
}

/** One registered provider route and the models its adapter advertises. */
interface ProviderOption {
  id: string
  name: string
  models: ModelOption[]
  /** Present when this provider's catalog could not be read. */
  error?: string
}

/** How long a provider catalog stays fresh before the page re-queries it. */
const CATALOG_TTL_MS = 60_000
/** One provider's catalog read must not hold the configuration page open. */
const CATALOG_TIMEOUT_MS = 5_000

/**
 * Bound an adapter call that takes no cancellation signal.
 * @param promise - the catalog read.
 * @param ms - budget in milliseconds.
 * @returns the value, or a rejection naming the timeout.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

interface RecapState {
  text: string
  seq: number
  visible: boolean
  hidden: boolean
  generating: boolean
  timer: ReturnType<typeof setTimeout> | undefined
  controller: AbortController | undefined
  /** Incremented by a human turn and by any operation that supersedes a run. */
  run: number
}

/**
 * A generation that a newer user action (dismiss, clear, unload) made
 * irrelevant. The caller reports success with the current state: the user's
 * intent already stands, so surfacing a failure would only be noise.
 */
class RecapCancelled extends Error {
  constructor() {
    super('Recap was cancelled.')
    this.name = 'RecapCancelled'
  }
}

/** Wire state served to the client panel and used by the commands. */
interface StateWire {
  text: string
  visible: boolean
  stale: boolean
  generating: boolean
  current: boolean
  enabled: boolean
  idleMs: number
  provider?: string
  model?: string
}

function dshHome(): string {
  const configured = process.env['DSH_HOME']
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')
}

function configPath(): string {
  return join(dshHome(), 'dsh-recap.json')
}

function recapDir(): string {
  return join(dshHome(), 'dsh-recap')
}

function recapPath(sessionId: string): string {
  return join(recapDir(), `${encodeURIComponent(sessionId)}.json`)
}

function readRecord(sessionId: string): RecapRecord | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(recapPath(sessionId), 'utf8'))
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as { text?: unknown; seq?: unknown; version?: unknown; hidden?: unknown }
    if (record.version !== 1 || typeof record.text !== 'string' || typeof record.seq !== 'number') return undefined
    return { version: 1, text: record.text, seq: record.seq, ...(record.hidden === true ? { hidden: true } : {}) }
  } catch {
    return undefined
  }
}

/**
 * Write one record atomically and privately: the recap names files and
 * decisions from the session, so it must not be world-readable, and a crash
 * mid-write must not leave a truncated JSON file behind.
 */
function writeRecord(sessionId: string, record: RecapRecord): void {
  const dir = recapDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(dir, 0o700)
  } catch {
    // Best effort on filesystems that do not model POSIX modes.
  }
  const path = recapPath(sessionId)
  const temp = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(temp, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

function deleteRecord(sessionId: string): void {
  rmSync(recapPath(sessionId), { force: true })
}

function readOverride(): ModelOverride | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(configPath(), 'utf8'))
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as { provider?: unknown; model?: unknown }
    if (typeof record.provider !== 'string' || typeof record.model !== 'string') return undefined
    return { provider: record.provider, model: record.model }
  } catch {
    return undefined
  }
}

function writeOverride(value: ModelOverride | undefined): void {
  const path = configPath()
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const temp = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(temp, JSON.stringify(value ?? {}, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

/** Flatten one message to text for the recap request; non-text blocks are named. */
function messageText(message: Message): string {
  const parts: string[] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        parts.push(block.text)
        break
      case 'tool-call':
        parts.push(`[tool ${block.name}]`)
        break
      case 'image':
        parts.push('[image]')
        break
      case 'file':
        parts.push('[file]')
        break
      default:
        break
    }
  }
  return parts.join('\n').trim()
}

/**
 * Serialize the derived conversation into one bounded context block.
 * @param messages - model-visible history.
 * @returns the conversation text.
 */
function serializeConversation(messages: readonly Message[]): string {
  const recent = messages.slice(-120)
  const lines: string[] = []
  for (const message of recent) {
    const text = messageText(message)
    if (text === '') continue
    const role = message.role === 'assistant' ? 'Assistant' : message.role === 'user' ? 'User' : message.role
    lines.push(`### ${role}\n${text}`)
  }
  const joined = lines.join('\n\n')
  return joined.length > 80_000 ? joined.slice(joined.length - 80_000) : joined
}

/**
 * Drop recap files that have not been touched for the retention window. A
 * disposed Session is not a deleted one (the user can reopen it later), so
 * age — not Session lifetime — decides when a record goes away.
 * @param days - retention window; 0 or less keeps everything.
 * @param ctx - plugin context for logging.
 */
function pruneRecords(days: number, ctx: Context): void {
  if (days <= 0) return
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  let names: string[]
  try {
    names = readdirSync(recapDir())
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const path = join(recapDir(), name)
    try {
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true })
    } catch (error) {
      ctx.logger.debug(`dsh-recap: cannot prune ${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * Install recap generation, its commands, and the browser routes.
 * @param ctx - plugin context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config = Config()): void {
  const states = new Map<string, RecapState>()
  pruneRecords(config.retentionDays, ctx)

  function sessionFor(sessionId: string): Session | undefined {
    return ctx.sessions.get(sessionId as SessionId)
  }

  function stateFor(sessionId: string): RecapState | undefined {
    const existing = states.get(sessionId)
    if (existing !== undefined) return existing
    const session = sessionFor(sessionId)
    if (session === undefined) return undefined
    const restored = readRecord(sessionId)
    const current = restored !== undefined && restored.seq === Number(session.seq)
    const state: RecapState = {
      text: restored?.text ?? '',
      seq: restored?.seq ?? -1,
      visible: restored !== undefined && restored.hidden !== true && (current || config.showStale),
      hidden: restored?.hidden === true,
      generating: false,
      timer: undefined,
      controller: undefined,
      run: 0,
    }
    states.set(sessionId, state)
    return state
  }

  function current(state: RecapState, session: Session): boolean {
    return state.seq === Number(session.seq)
  }

  function wire(state: RecapState, session: Session): StateWire {
    const route = readOverride() ?? session.requestContext()
    const fresh = current(state, session)
    return {
      text: state.text,
      visible: state.visible,
      stale: state.text !== '' && !fresh,
      generating: state.generating,
      current: fresh,
      enabled: config.enabled,
      idleMs: config.idleMs,
      ...(route === undefined ? {} : { provider: route.provider, model: route.model }),
    }
  }

  function clearTimer(state: RecapState): void {
    if (state.timer !== undefined) clearTimeout(state.timer)
    state.timer = undefined
  }

  /** Abort any in-flight request for this state and invalidate its result. */
  function supersede(state: RecapState): void {
    state.run += 1
    state.controller?.abort()
    state.controller = undefined
  }

  /**
   * Generate one recap and persist it.
   * @param session - owning session.
   * @param state - in-memory state.
   * @param show - whether a human asked, so the result should surface even when
   *   the log moved on while streaming.
   * @returns the recap text.
   */
  async function generate(session: Session, state: RecapState, show: boolean): Promise<string> {
    if (state.generating) throw new Error('A recap is already being generated.')
    if (!config.enabled) throw new Error('dsh-recap is disabled in this profile.')
    const route = readOverride() ?? session.requestContext()
    if (route === undefined) throw new Error('No model route for this session yet; send one message first.')
    const messages = session.deriveMessages()
    if (messages.length === 0) throw new Error('No conversation to recap yet.')
    const conversation = serializeConversation(messages)

    const run = ++state.run
    const startSeq = Number(session.seq)
    state.generating = true
    const controller = new AbortController()
    state.controller = controller
    const timeout = setTimeout(() => controller.abort(new Error('recap request timed out')), config.timeoutMs)
    let text = ''
    let finish: string | undefined
    try {
      for await (const chunk of ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        system: RECAP_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: `## Current Session Context\n${conversation}` }] }],
        maxTokens: config.maxTokens,
        signal: controller.signal,
        sessionId: session.id,
      })) {
        if (chunk.type === 'text-delta') text += chunk.text
        if (chunk.type === 'finish') finish = chunk.reason.kind
      }
    } finally {
      clearTimeout(timeout)
      if (state.controller === controller) state.controller = undefined
      state.generating = false
    }

    if (run !== state.run) throw new RecapCancelled()
    if (finish !== undefined && finish !== 'stop') {
      throw new Error(
        finish === 'max-tokens'
          ? `output token limit reached (${config.maxTokens} tokens, including reasoning)`
          : `model stopped with ${finish}`,
      )
    }
    const recap = sanitizeRecapText(text)
    if (recap === '') throw new Error('Recap generation returned empty text.')

    // Events that arrived while streaming make the recap describe an older
    // state: anchor it at the length it started from, so it reads as stale
    // instead of claiming to include what it never saw.
    const movedOn = Number(session.seq) !== startSeq
    state.text = recap
    state.seq = movedOn ? startSeq : Number(session.seq)
    state.visible = show || !movedOn
    state.hidden = !state.visible
    writeRecord(String(session.id), {
      version: 1,
      text: recap,
      seq: state.seq,
      ...(state.visible ? {} : { hidden: true }),
    })
    clearTimer(state)
    return recap
  }

  ctx.on('session/event', (session: Session, event) => {
    const sessionId = String(session.id)
    const state = stateFor(sessionId)
    if (state === undefined) return

    if (event.type === 'user/message' && event.data.source?.kind === 'user') {
      // A new human turn hides the old recap and cancels a pending automatic
      // one. An in-flight request is left to finish: it lands stale (anchored
      // at the log length it started from), which is more useful than losing
      // an answer the user asked for.
      state.visible = false
      clearTimer(state)
      return
    }
    if (event.type === 'turn/end') {
      clearTimer(state)
      if (!config.enabled || config.idleMs <= 0) return
      if (session.header.origin === 'subagent' && !config.subagents) return
      state.timer = setTimeout(() => {
        state.timer = undefined
        if (state.visible || state.generating) return
        void generate(session, state, false).catch((error: unknown) => {
          if (error instanceof RecapCancelled) return
          ctx.logger.debug(`dsh-recap: automatic recap failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      }, config.idleMs)
      return
    }
  })

  ctx.on('session/disposed', (session: Session) => {
    const sessionId = String(session.id)
    const state = states.get(sessionId)
    if (state !== undefined) {
      clearTimer(state)
      supersede(state)
    }
    states.delete(sessionId)
  })

  // Unloading the plugin must stop every pending timer and request; a timer
  // that survives the context would call into a disposed service.
  ctx.effect(() => () => {
    for (const state of states.values()) {
      clearTimer(state)
      supersede(state)
    }
    states.clear()
  })

  ctx.effect(() =>
    ctx.commands.register({
      name: 'recap',
      description: 'Generate a one-line recap of this session',
      handler: async (invocation) => {
        const sessionId = String(invocation.agent.id)
        const session = sessionFor(sessionId)
        const state = stateFor(sessionId)
        if (session === undefined || state === undefined) return { kind: 'error', text: 'No session.' }
        const raw = invocation.rawInput.trim()

        if (raw === 'help') {
          return {
            kind: 'success',
            text: [
              '/recap — generate a fresh recap',
              '/recap status — model and freshness',
              '/recap config <provider>/<model> — pin the recap model',
              '/recap config reset — follow the session route',
              '/recap clear — forget the current recap',
            ].join('\n'),
          }
        }
        if (raw === 'status') {
          const view = wire(state, session)
          return {
            kind: 'success',
            text: [
              `model: ${view.provider ?? '?'}/${view.model ?? '?'}`,
              `recap: ${view.text === '' ? '(none)' : view.text}`,
              `freshness: ${view.current ? 'current' : 'stale'}${view.visible ? '' : ' · hidden'}`,
              `automatic: ${view.enabled && view.idleMs > 0 ? `after ${Math.round(view.idleMs / 60_000)} min idle` : 'off'}`,
            ].join('\n'),
          }
        }
        if (raw.startsWith('config')) {
          const argument = raw.slice('config'.length).trim()
          if (argument === 'reset') {
            writeOverride(undefined)
            return { kind: 'success', text: 'Recap model follows the session route again.' }
          }
          if (argument === '') {
            const route = readOverride()
            const sessionRoute = session.requestContext()
            const lines = [
              route === undefined
                ? `following the session route: ${sessionRoute?.provider ?? '?'}/${sessionRoute?.model ?? '?'}`
                : `pinned: ${route.provider}/${route.model}`,
              `providers: ${ctx.llm.listProviders().map((provider) => provider.id).join(', ') || '(none)'}`,
              'usage: /recap config <provider>/<model> | /recap config reset',
            ]
            return { kind: 'success', text: lines.join('\n') }
          }
          const slash = argument.indexOf('/')
          if (slash <= 0 || slash === argument.length - 1) {
            return { kind: 'error', text: 'Usage: /recap config <provider>/<model>' }
          }
          const provider = argument.slice(0, slash)
          const model = argument.slice(slash + 1)
          const known = ctx.llm.listProviders().map((entry) => entry.id)
          if (!known.includes(provider)) {
            return {
              kind: 'error',
              text: `Unknown provider "${provider}". Registered providers: ${known.join(', ') || '(none)'}.`,
            }
          }
          writeOverride({ provider, model })
          return { kind: 'success', text: `Recap model pinned to ${provider}/${model}.` }
        }
        if (raw === 'clear') {
          clearTimer(state)
          supersede(state)
          deleteRecord(sessionId)
          state.text = ''
          state.seq = -1
          state.visible = false
          state.hidden = false
          return { kind: 'success', text: 'Recap cleared.' }
        }
        if (raw !== '') return { kind: 'error', text: 'Usage: /recap [status|config|clear|help]' }
        try {
          const recap = await generate(session, state, true)
          return { kind: 'success', text: recap }
        } catch (error) {
          if (error instanceof RecapCancelled) return { kind: 'success', text: 'Recap cancelled.' }
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: '/api/dsh-recap/state',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request: Request): Promise<Response> => {
        const sessionId = new URL(request.url).searchParams.get('session') ?? ''
        const session = sessionFor(sessionId)
        const state = stateFor(sessionId)
        if (session === undefined || state === undefined) {
          return Response.json({ error: 'unknown session' }, { status: 404 })
        }
        return Response.json(wire(state, session), { headers: { 'cache-control': 'no-store' } })
      },
    }),
  )

  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: '/api/dsh-recap/generate',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request): Promise<Response> => {
        const sessionId = new URL(request.url).searchParams.get('session') ?? ''
        const session = sessionFor(sessionId)
        const state = stateFor(sessionId)
        if (session === undefined || state === undefined) {
          return Response.json({ error: 'unknown session' }, { status: 404 })
        }
        try {
          await generate(session, state, true)
        } catch (error) {
          if (!(error instanceof RecapCancelled)) {
            return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
          }
        }
        return Response.json(wire(state, session), { headers: { 'cache-control': 'no-store' } })
      },
    }),
  )

  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: '/api/dsh-recap/dismiss',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request): Promise<Response> => {
        const sessionId = new URL(request.url).searchParams.get('session') ?? ''
        const session = sessionFor(sessionId)
        const state = stateFor(sessionId)
        if (session === undefined || state === undefined) {
          return Response.json({ error: 'unknown session' }, { status: 404 })
        }
        // Dismissing while a request streams must also stop that request from
        // re-showing the recap when it lands.
        if (state.generating) supersede(state)
        state.visible = false
        state.hidden = true
        if (state.text !== '') {
          try {
            writeRecord(sessionId, { version: 1, text: state.text, seq: state.seq, hidden: true })
          } catch (error) {
            return Response.json(
              { error: error instanceof Error ? error.message : String(error) },
              { status: 500 },
            )
          }
        }
        return Response.json(wire(state, session), { headers: { 'cache-control': 'no-store' } })
      },
    }),
  )

  /** Cached provider/model catalog for the configuration page. */
  let catalog: { at: number; value: ProviderOption[] } | undefined
  let catalogInflight: Promise<ProviderOption[]> | undefined

  /**
   * Read every registered provider's advertised models. A provider whose
   * catalog fails still appears, carrying its error, so the page can show the
   * provider and explain why its model list is empty.
   * @param force - bypass the freshness window.
   * @returns the catalog in provider registration order.
   */
  async function providerCatalog(force = false): Promise<ProviderOption[]> {
    if (!force && catalog !== undefined && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog.value
    if (catalogInflight !== undefined) return catalogInflight
    const task = (async (): Promise<ProviderOption[]> => {
      const providers = ctx.llm.listProviders()
      return await Promise.all(
        providers.map(async (provider): Promise<ProviderOption> => {
          try {
            const models = await withTimeout(ctx.llm.listModels(provider.id), CATALOG_TIMEOUT_MS)
            return {
              id: provider.id,
              name: provider.name,
              models: models.map((model) => ({ id: model.id, name: model.name })),
            }
          } catch (error) {
            return {
              id: provider.id,
              name: provider.name,
              models: [],
              error: error instanceof Error ? error.message : String(error),
            }
          }
        }),
      )
    })()
    catalogInflight = task
    try {
      const value = await task
      catalog = { at: Date.now(), value }
      return value
    } finally {
      catalogInflight = undefined
    }
  }

  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: '/api/dsh-recap/models',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request: Request): Promise<Response> => {
        const force = new URL(request.url).searchParams.get('refresh') === '1'
        let providers: ProviderOption[]
        try {
          providers = await providerCatalog(force)
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 500, headers: { 'cache-control': 'no-store' } },
          )
        }
        const pinned = readOverride()
        return Response.json(
          { ...(pinned === undefined ? {} : { current: pinned }), providers },
          { headers: { 'cache-control': 'no-store' } },
        )
      },
    }),
  )

  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: '/api/dsh-recap/config',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request): Promise<Response> => {
        let body: { provider?: unknown; model?: unknown; reset?: unknown }
        try {
          body = (await request.json()) as typeof body
        } catch {
          return Response.json({ error: 'invalid body' }, { status: 400 })
        }
        if (body.reset === true) {
          writeOverride(undefined)
          catalog = undefined
          return Response.json({ current: null }, { headers: { 'cache-control': 'no-store' } })
        }
        const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
        const model = typeof body.model === 'string' ? body.model.trim() : ''
        if (provider === '' || model === '') {
          return Response.json({ error: 'provider and model are required' }, { status: 400 })
        }
        const known = ctx.llm.listProviders().map((entry) => entry.id)
        if (!known.includes(provider)) {
          return Response.json(
            { error: `Unknown provider "${provider}". Registered providers: ${known.join(', ') || '(none)'}.` },
            { status: 400 },
          )
        }
        try {
          writeOverride({ provider, model })
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 500 },
          )
        }
        catalog = undefined
        return Response.json({ current: { provider, model } }, { headers: { 'cache-control': 'no-store' } })
      },
    }),
  )

  ctx.logger.debug('dsh-recap loaded')
}

export { RECAP_SYSTEM_PROMPT as SYSTEM_PROMPT }
