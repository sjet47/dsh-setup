/**
 * dsh-wakatime — track dsh sessions, tool activity and AI line changes with
 * WakaTime.
 *
 * Ported from pi-wakatime: the heartbeat tracker, CLI discovery/upgrade, option
 * parsing and logging are reused unchanged; only this wiring layer is new,
 * because dsh's event-sourced session log replaces pi's extension hooks.
 * @module dsh-wakatime
 */
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { Dependencies } from './dependencies.js'
import { estimateEditLineChanges, HeartbeatTracker, shouldTrackTool } from './heartbeat.js'
import { logger, LogLevel } from './logger.js'
import { Options } from './options.js'
import type { ClaudeLikeHookEvent, HeartbeatRequest } from './types.js'
import { estimateWriteLineChanges } from './utils.js'

export const name = 'wakatime'
export const inject = [] as const

const PLUGIN = `dsh/0.2.1 dsh-wakatime/0.1.0`

/** A tool call remembered between its `tool/call` and `tool/result` events. */
interface PendingCall {
  name: string
  args: Record<string, unknown>
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw === '') return {}
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Build the session-scoped heartbeat shared by every activity mapping.
 * @param session - the session that produced the event.
 * @param sourceEvent - the WakaTime activity this maps onto.
 * @returns the heartbeat request for the tracker.
 */
export function sessionHeartbeat(session: Session, sourceEvent: ClaudeLikeHookEvent, cwd: string): HeartbeatRequest {
  return {
    type: 'session',
    entity: path.join(cwd, '.dsh-session'),
    projectFolder: cwd,
    category: 'coding',
    stateKey: String(session.id),
    sourceEvent,
  }
}

/**
 * Build one file heartbeat for an fs tool call, or undefined when the call does
 * not touch a file. dsh's fs tools use snake_case parameters (`file_path`,
 * `content`, `old_string`/`new_string`).
 * @param toolName - recorded tool name.
 * @param args - parsed call arguments.
 * @param cwd - session working directory used to resolve relative paths.
 * @returns the heartbeat request, or undefined.
 */
export function fileHeartbeat(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): HeartbeatRequest | undefined {
  const rawPath = typeof args.file_path === 'string' ? args.file_path : undefined
  if (rawPath === undefined || rawPath === '') return undefined
  const entity = path.resolve(cwd, rawPath)

  if (toolName === 'read' || toolName === 'read_image') {
    return { type: 'file', entity, projectFolder: cwd, category: 'coding', sourceEvent: 'PostToolUse' }
  }
  if (toolName === 'write') {
    return {
      type: 'file',
      entity,
      projectFolder: cwd,
      category: 'coding',
      isWrite: true,
      lineChanges: estimateWriteLineChanges(typeof args.content === 'string' ? args.content : ''),
      sourceEvent: 'PostToolUse',
    }
  }
  if (toolName === 'edit') {
    const oldText = typeof args.old_string === 'string' ? args.old_string : ''
    const newText = typeof args.new_string === 'string' ? args.new_string : ''
    return {
      type: 'file',
      entity,
      projectFolder: cwd,
      category: 'coding',
      isWrite: true,
      lineChanges: estimateEditLineChanges([{ oldText, newText }]),
      sourceEvent: 'PostToolUse',
    }
  }
  return undefined
}

/**
 * Install the tracker and map dsh session events onto WakaTime heartbeats.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  const options = new Options()
  logger.setLevel(options.getSetting('settings', 'debug') === 'true' ? LogLevel.DEBUG : LogLevel.INFO)

  const dependencies = new Dependencies(options, logger)
  const tracker = new HeartbeatTracker({ dependencies, plugin: PLUGIN })
  const initPromise = tracker.init().catch((error: unknown) => {
    logger.errorException(error)
    throw error
  })

  let ready: Promise<boolean> | undefined
  const ensureInitialized = (): Promise<boolean> => {
    ready ??= initPromise.then(
      () => true,
      () => false,
    )
    return ready
  }

  /** Per-session pending tool calls, keyed by call id. */
  const pending = new Map<string, Map<string, PendingCall>>()
  const callsFor = (sessionId: string): Map<string, PendingCall> => {
    let map = pending.get(sessionId)
    if (map === undefined) {
      map = new Map()
      pending.set(sessionId, map)
    }
    return map
  }

  const track = async (request: HeartbeatRequest): Promise<void> => {
    if (!(await ensureInitialized())) return
    tracker.track(request)
  }

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    const cwd = session.header.cwd ?? process.cwd()
    const sessionId = String(session.id)

    switch (event.type) {
      case 'user/message': {
        // Only a human prompt counts; injected context and skill bodies don't.
        if (event.data.source?.kind === 'user') {
          void track(sessionHeartbeat(session, 'UserPromptSubmit', cwd))
        }
        return
      }
      case 'tool/call': {
        callsFor(sessionId).set(String(event.data.callId), {
          name: event.data.name,
          args: parseArgs(event.data.arguments),
        })
        void track(sessionHeartbeat(session, 'PreToolUse', cwd))
        return
      }
      case 'tool/result': {
        const calls = callsFor(sessionId)
        const callId = String(event.data.message.toolCallId)
        const call = calls.get(callId)
        calls.delete(callId)
        void track(sessionHeartbeat(session, 'PostToolUse', cwd))
        if (call === undefined || event.data.message.isError === true) return
        if (!shouldTrackTool(call.name)) return
        const request = fileHeartbeat(call.name, call.args, cwd)
        if (request !== undefined) void track(request)
        return
      }
      default:
        return
    }
  })

  ctx.on('session/disposed', (session: Session) => {
    const cwd = session.header.cwd ?? process.cwd()
    pending.delete(String(session.id))
    void track(sessionHeartbeat(session, 'SessionEnd', cwd))
  })

  logger.debug(`dsh-wakatime loaded with plugin ${PLUGIN}`)
}
