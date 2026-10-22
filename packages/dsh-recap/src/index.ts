/**
 * dsh-recap — one-line session recap, on demand, on resume, or after five
 * idle minutes.
 *
 * Ported from pi-recap. Generation reuses the recap system prompt and the
 * sanitizer unchanged; the surrounding state machine is rebuilt on dsh's
 * session log, where each recap is a durable `plugin:` record so it survives
 * restart and resume without entering model context.
 * @module dsh-recap
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Message } from '@deepseek-ai/dsh-llm'
import { sanitizeRecapText } from './sanitize.js'

export const name = 'recap'
export const inject = ['commands', 'connection', 'sessions', 'llm'] as const

const RECAP_MAX_TOKENS = 2_048
const RECAP_TIMEOUT_MS = 30_000
const AWAY_RECAP_DELAY_MS = 5 * 60 * 1_000
/** Durable recap record. `seq` is the session log length when it was written. */
interface RecapRecord {
  version: 1
  text: string
  seq: number
}

const RECAP_SYSTEM_PROMPT = `You write compact recaps for an AI coding-agent session.

Given the current session context, produce one plain-text sentence for the user to resume later.
Start with the user's goal or reason for the session, inferred from user messages. Do not start with the assistant's answer.
Then include the current outcome, important decision, touched file, blocker, or likely next action only if it helps resume.
Prefer: Goal/purpose. Current state. Next action.
Target about 160 characters. Stay under 240 characters.
Do not add a label or prefix. Do not use markdown. Do not mention yourself as "the assistant".

Good: Deciding whether pi-inline-skills should switch from $skill to /skill. Recommendation is / only with commands winning; next decide whether leading /skill should expand.
Bad: Feasible; I'd default to / and skip config. Extension commands win first; next decide whether leading /skill tokens should expand.`

interface ModelOverride {
  provider: string
  model: string
}

interface RecapState {
  text: string
  seq: number
  visible: boolean
  stale: boolean
  generating: boolean
  timer: ReturnType<typeof setTimeout> | undefined
}

/** Wire state served to the client panel and used by the commands. */
interface StateWire {
  text: string
  visible: boolean
  stale: boolean
  generating: boolean
  current: boolean
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

/**
 * Recap records live beside the plugin config rather than in the session log:
 * a third-party bundle resolves its own copy of `@deepseek-ai/dsh-session`, so
 * the private-brand `appendPluginRecord` entry point cannot operate on the
 * runtime's Session instance.
 */
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
    const record = value as { text?: unknown; seq?: unknown; version?: unknown }
    if (record.version !== 1 || typeof record.text !== 'string' || typeof record.seq !== 'number') return undefined
    return { version: 1, text: record.text, seq: record.seq }
  } catch {
    return undefined
  }
}

function writeRecord(sessionId: string, record: RecapRecord): void {
  mkdirSync(recapDir(), { recursive: true })
  writeFileSync(recapPath(sessionId), JSON.stringify(record) + '\n', 'utf8')
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
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value ?? {}, null, 2) + '\n', 'utf8')
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
 * Install recap generation, its commands, and the browser routes.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  const states = new Map<string, RecapState>()

  function sessionFor(sessionId: string): Session | undefined {
    return ctx.sessions.get(sessionId as SessionId)
  }

  /** Restore one session's saved recap. */
  function restore(session: Session): { text: string; seq: number } | undefined {
    const record = readRecord(String(session.id))
    return record === undefined ? undefined : { text: record.text, seq: record.seq }
  }

  function stateFor(sessionId: string): RecapState | undefined {
    const existing = states.get(sessionId)
    if (existing !== undefined) return existing
    const session = sessionFor(sessionId)
    if (session === undefined) return undefined
    const restored = restore(session)
    const state: RecapState = {
      text: restored?.text ?? '',
      seq: restored?.seq ?? -1,
      visible: restored !== undefined && restored.seq === Number(session.seq),
      stale: restored !== undefined && restored.seq !== session.seq,
      generating: false,
      timer: undefined,
    }
    states.set(sessionId, state)
    return state
  }

  function current(state: RecapState, session: Session): boolean {
    return state.seq === Number(session.seq)
  }

  function wire(sessionId: string, state: RecapState, session: Session): StateWire {
    const route = readOverride() ?? session.requestContext()
    const isCurrent = current(state, session)
    return {
      text: state.text,
      visible: state.visible,
      stale: state.text !== '' && !isCurrent,
      generating: state.generating,
      current: isCurrent,
      ...(route === undefined ? {} : { provider: route.provider, model: route.model }),
    }
  }

  function clearTimer(state: RecapState): void {
    if (state.timer !== undefined) clearTimeout(state.timer)
    state.timer = undefined
  }

  /**
   * Generate one recap and persist it as a plugin record.
   * @param session - owning session.
   * @param state - in-memory state.
   * @param manual - whether a human asked (errors surface as thrown text).
   * @returns the recap text.
   */
  async function generate(session: Session, state: RecapState, manual: boolean): Promise<string> {
    if (state.generating) throw new Error('A recap is already being generated.')
    const route = readOverride() ?? session.requestContext()
    if (route === undefined) throw new Error('No model route for this session yet; send one message first.')
    const messages = session.deriveMessages()
    if (messages.length === 0) throw new Error('No conversation to recap yet.')
    const conversation = serializeConversation(messages)

    state.generating = true
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('recap request timed out')), RECAP_TIMEOUT_MS)
    let text = ''
    let finish: string | undefined
    try {
      for await (const chunk of ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        system: RECAP_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: `## Current Session Context\n${conversation}` }] }],
        maxTokens: RECAP_MAX_TOKENS,
        signal: controller.signal,
        sessionId: session.id,
      })) {
        if (chunk.type === 'text-delta') text += chunk.text
        if (chunk.type === 'finish') finish = chunk.reason.kind
      }
    } finally {
      clearTimeout(timeout)
      state.generating = false
    }

    if (finish !== undefined && finish !== 'stop') {
      throw new Error(
        finish === 'max-tokens'
          ? `output token limit reached (${RECAP_MAX_TOKENS} tokens, including reasoning)`
          : `model stopped with ${finish}`,
      )
    }
    const recap = sanitizeRecapText(text)
    if (recap === '') throw new Error('Recap generation returned empty text.')

    // Store the current log length so a recap is "current" until anything
    // else is appended.
    state.text = recap
    state.seq = Number(session.seq)
    writeRecord(String(session.id), { version: 1, text: recap, seq: state.seq })
    state.visible = true
    state.stale = false
    clearTimer(state)
    return recap
  }

  ctx.on('session/event', (session: Session, event) => {
    const sessionId = String(session.id)
    const state = stateFor(sessionId)
    if (state === undefined) return

    if (event.type === 'user/message' && event.data.source?.kind === 'user') {
      // A new human turn hides the old recap and cancels a pending auto-recaps.
      state.visible = false
      clearTimer(state)
      return
    }
    if (event.type === 'turn/end') {
      state.stale = true
      clearTimer(state)
      state.timer = setTimeout(() => {
        state.timer = undefined
        if (state.visible || state.generating) return
        void generate(session, state, false).catch((error: unknown) => {
          ctx.logger.debug(`dsh-recap: automatic recap failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      }, AWAY_RECAP_DELAY_MS)
    }
  })

  ctx.on('session/disposed', (session: Session) => {
    const state = states.get(String(session.id))
    if (state !== undefined) clearTimer(state)
    states.delete(String(session.id))
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
            text: ['/recap — generate a fresh recap', '/recap status — model and freshness', '/recap config <provider>/<model> — pin the recap model', '/recap config reset — follow the session route', '/recap clear — forget the current recap'].join('\n'),
          }
        }
        if (raw === 'status') {
          const view = wire(sessionId, state, session)
          return {
            kind: 'success',
            text: [
              `model: ${view.provider ?? '?'}/${view.model ?? '?'}`,
              `recap: ${view.text === '' ? '(none)' : view.text}`,
              `freshness: ${view.current ? 'current' : 'stale'}${view.visible ? '' : ' · hidden'}`,
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
          writeOverride({ provider, model })
          return { kind: 'success', text: `Recap model pinned to ${provider}/${model}.` }
        }
        if (raw === 'clear') {
          state.text = ''
          state.visible = false
          state.stale = false
          return { kind: 'success', text: 'Recap cleared.' }
        }
        if (raw !== '') return { kind: 'error', text: 'Usage: /recap [status|config|clear|help]' }
        try {
          const recap = await generate(session, state, true)
          return { kind: 'success', text: recap }
        } catch (error) {
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
        return Response.json(wire(sessionId, state, session), { headers: { 'cache-control': 'no-store' } })
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
          return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
        }
        return Response.json(wire(sessionId, state, session), { headers: { 'cache-control': 'no-store' } })
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
        state.visible = false
        return Response.json(wire(sessionId, state, session), { headers: { 'cache-control': 'no-store' } })
      },
    }),
  )

  ctx.logger.debug('dsh-recap loaded')
}

export { RECAP_SYSTEM_PROMPT }
