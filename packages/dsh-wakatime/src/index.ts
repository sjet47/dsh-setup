/**
 * dsh-wakatime — track dsh sessions, tool activity and AI line changes with
 * WakaTime.
 *
 * Ported from pi-wakatime: heartbeat construction, CLI discovery/upgrade,
 * option parsing and logging are reused; only this wiring layer is new, because
 * dsh's event-sourced session log replaces pi's extension hooks.
 *
 * dsh keeps its own throttle state and log under `~/.wakatime/`, so enabling
 * this plugin never rewrites the pi plugin's files.
 * @module dsh-wakatime
 */
import { join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { Dependencies } from './dependencies.js'
import {
  defaultStateDir,
  estimateEditLineChanges,
  HeartbeatTracker,
  pruneStateFiles,
  shouldTrackTool,
} from './heartbeat.js'
import { logger, LogLevel } from './logger.js'
import { Options } from './options.js'
import type { ClaudeLikeHookEvent, HeartbeatRequest } from './types.js'
import { estimateWriteLineChanges, getPackageVersion } from './utils.js'

export const name = 'wakatime'
export const inject = [] as const

export interface Config {
  /** Send heartbeats at all. */
  enabled: boolean
  /** Throttle window for one Session's heartbeats. */
  sessionHeartbeatIntervalMs: number
  /** Delete throttle records older than this many days; 0 keeps them. */
  retentionDays: number
  /** State directory; empty uses `~/.wakatime/dsh-wakatime-state`. */
  stateDir: string
  /** Also report child subagent Sessions. */
  trackSubagents: boolean
  /** Force debug logging to the diagnostic log. */
  debug: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  sessionHeartbeatIntervalMs: z.number().default(60_000),
  retentionDays: z.number().default(30),
  stateDir: z.string().default(''),
  trackSubagents: z.boolean().default(false),
  debug: z.boolean().default(false),
})

/**
 * The directory this Session actually works in: the committed working
 * directory when the service is present, else the Session header's initial
 * cwd. Optional because this plugin injects no services.
 * @param ctx - plugin context.
 * @param session - the Session that produced the event.
 * @returns an absolute-working-directory candidate.
 */
function sessionCwd(ctx: Context, session: Session): string {
  try {
    const service = (ctx as unknown as { get?(name: string): unknown }).get?.('workingDirectory') as
      | { get(session: Session): string }
      | undefined
    const cwd = service?.get(session)
    if (typeof cwd === 'string' && cwd !== '') return cwd
  } catch {
    // Fall through to the header value.
  }
  return session.header.cwd ?? process.cwd()
}

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
    entity: join(cwd, '.dsh-session'),
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
  const entity = resolve(cwd, rawPath)

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
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config = Config()): void {
  const options = new Options()
  const debug = config.debug || options.getSetting('settings', 'debug') === 'true'
  logger.setLevel(debug ? LogLevel.DEBUG : LogLevel.INFO)
  logger.setFile(options.getLogFile())

  const stateDir = config.stateDir !== '' ? config.stateDir : defaultStateDir()
  const dependencies = new Dependencies(options, logger)
  const plugin = `dsh/${getPackageVersion('@deepseek-ai/dsh')} dsh-wakatime/${getPackageVersion('dsh-wakatime')}`
  const tracker = new HeartbeatTracker({
    dependencies,
    plugin,
    stateDir,
    sessionIntervalMs: config.sessionHeartbeatIntervalMs,
  })

  // Keep the rejection observed even when no session event ever arrives: an
  // unhandled rejection here would fail the whole process.
  const initPromise = tracker.init().then(
    (location) => {
      const removed = pruneStateFiles(stateDir, config.retentionDays)
      if (removed > 0) logger.debug(`Pruned ${removed} stale heartbeat state file(s) in ${stateDir}.`)
      return location
    },
    (error: unknown) => {
      logger.errorException(error)
      ctx.logger.warn(`dsh-wakatime: wakatime-cli is unavailable: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    },
  )
  void initPromise.catch(() => {})

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
    if (!config.enabled) return
    if (!(await ensureInitialized())) return
    tracker.track(request)
  }

  const skipSession = (session: Session): boolean =>
    !config.enabled || (session.header.origin === 'subagent' && !config.trackSubagents)

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (skipSession(session)) return
    const cwd = sessionCwd(ctx, session)
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
    if (skipSession(session)) return
    const cwd = sessionCwd(ctx, session)
    pending.delete(String(session.id))
    void track(sessionHeartbeat(session, 'SessionEnd', cwd))
  })

  logger.debug(`dsh-wakatime loaded as ${plugin}`)
}
