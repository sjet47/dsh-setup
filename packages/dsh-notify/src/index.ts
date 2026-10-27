/**
 * dsh-notify — desktop notification when a dsh session finishes answering.
 *
 * dsh itself only marks another session's sidebar row as completed. This plugin
 * posts a real notification over the D-Bus session bus, which on this desktop
 * means the quickshell OSD, and keeps one notification per session updated in
 * place instead of stacking one per turn.
 *
 * Only Linux is wired: the notification is `org.freedesktop.Notifications`,
 * spoken directly instead of through `notify-send`.
 * @module dsh-notify
 */
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { resolveBusTarget, SessionBus } from './dbus.js'
import { Notifier } from './notifier.js'
import { completionNotice, type CompletionReason } from './summary.js'

export const name = 'notify'
export const inject = [] as const

export interface Config {
  /** Post notifications at all. */
  enabled: boolean
  /** Application name the notification daemon shows. */
  appName: string
  /** Application icon: an absolute path, an icon-theme name, or empty for none. */
  icon: string
  /** Longest reply preview, in characters; 0 drops the preview. */
  previewChars: number
  /** How long the daemon keeps the notification, in milliseconds; -1 uses its default. */
  expireTimeoutMs: number
  /** Also notify when a child subagent session finishes. */
  notifySubagents: boolean
  /** Notify when you cancelled the run yourself. */
  notifyOnAbort: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  appName: z.string().default('DSH'),
  icon: z.string().default(''),
  previewChars: z.number().default(160),
  expireTimeoutMs: z.number().default(-1),
  notifySubagents: z.boolean().default(false),
  notifyOnAbort: z.boolean().default(false),
})

/** Notification artwork shipped with the package. */
const DEFAULT_ICON = fileURLToPath(new URL('../icon.svg', import.meta.url))

/** What this plugin remembers about one session between events. */
interface SessionState {
  /** Whether the last observed agent status was `running`. */
  running?: boolean
  /** Assistant text of the newest reply. */
  text?: string
  /** End reason of the newest turn. */
  reason?: CompletionReason
  /** Provider failure message of the newest errored turn. */
  errorMessage?: string
  /** Daemon id of this session's visible notification, for in-place replacement. */
  notificationId?: number
}

/**
 * The text of one assistant message, ignoring reasoning and tool blocks.
 * @param message - assistant message from the session log.
 * @returns the joined text blocks, `''` when the reply carries no prose.
 */
export function assistantText(message: Message): string {
  if (message.role !== 'assistant') return ''
  return message.content
    .filter((block: ContentBlock): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/**
 * The session's display title, falling back to its working directory's name.
 * @param ctx - plugin context, used to look the optional title service up.
 * @param session - the session that finished.
 * @returns a non-empty title for the notification.
 */
function titleOf(ctx: Context, session: Session): string {
  try {
    const service = (ctx as unknown as { get?(name: string): unknown }).get?.('sessionTitle') as
      | { get(session: Session): { title: string } | undefined }
      | undefined
    const snapshot = service?.get(session)
    if (snapshot !== undefined && snapshot.title !== '') return snapshot.title
  } catch {
    // Fall through to the directory name.
  }
  const cwd = session.header.cwd
  if (cwd !== undefined && cwd !== '') {
    const segments = cwd.split(/[\\/]/).filter((segment) => segment !== '')
    const last = segments[segments.length - 1]
    if (last !== undefined) return last
  }
  return 'DSH'
}

/**
 * Install the notification forwarder.
 * @param ctx - plugin context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config = Config()): void {
  if (!config.enabled) return
  if (process.platform !== 'linux') {
    ctx.logger.info('dsh-notify: desktop notifications need the Linux D-Bus session bus; staying idle')
    return
  }
  const target = resolveBusTarget()
  if (target === undefined) {
    ctx.logger.warn('dsh-notify: no D-Bus session bus address; notifications stay off')
    return
  }

  const notifier = new Notifier(new SessionBus(target))
  const states = new Map<string, SessionState>()
  const stateOf = (sessionId: string): SessionState => {
    let state = states.get(sessionId)
    if (state === undefined) {
      state = {}
      states.set(sessionId, state)
    }
    return state
  }

  const watched = (session: Session): boolean => config.notifySubagents || session.header.origin !== 'subagent'

  const announce = async (session: Session): Promise<void> => {
    const sessionId = String(session.id)
    const state = stateOf(sessionId)
    const notice = completionNotice({
      title: titleOf(ctx, session),
      reason: state.reason,
      text: state.text,
      errorMessage: state.errorMessage,
      previewChars: config.previewChars,
      notifyOnAbort: config.notifyOnAbort,
    })
    if (notice === undefined) {
      state.reason = undefined
      state.errorMessage = undefined
      return
    }
    const icon = config.icon !== '' ? config.icon : DEFAULT_ICON
    try {
      state.notificationId = await notifier.notify({
        appName: config.appName,
        replacesId: state.notificationId ?? 0,
        summary: notice.summary,
        body: notice.body,
        appIcon: icon,
        urgency: notice.urgency,
        expireTimeoutMs: config.expireTimeoutMs,
      })
    } catch (error) {
      ctx.logger.warn(`dsh-notify: cannot post a notification: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      state.reason = undefined
      state.errorMessage = undefined
    }
  }

  // Cache what the notification needs while the run is still going: reading it
  // from the log at idle would fold the whole session for one line of text.
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (!watched(session)) return
    const state = stateOf(String(session.id))
    switch (event.type) {
      case 'assistant/message': {
        const text = assistantText(event.data.message)
        if (text !== '') state.text = text
        return
      }
      case 'turn/end': {
        const reason = event.data.reason
        state.reason = reason.kind
        state.errorMessage = reason.kind === 'error' ? reason.error.message : undefined
        return
      }
      default:
        return
    }
  })

  // One notification per finished run, not per turn: a goal round or a steering
  // message opens another turn without the agent ever going idle.
  ctx.on('agent/status', (payload: { agent: Agent; status: 'idle' | 'running' }) => {
    const session = payload.agent.session
    if (!watched(session)) return
    const state = stateOf(String(session.id))
    const running = payload.status === 'running'
    const wasRunning = state.running === true
    state.running = running
    if (running || !wasRunning) return
    void announce(session)
  })

  ctx.on('session/disposed', (session: Session) => {
    states.delete(String(session.id))
  })

  ctx.effect(() => () => {
    notifier.close()
    states.clear()
  })

  ctx.logger.debug(`dsh-notify: listening on ${target.path ?? target.abstract ?? 'the session bus'}`)
}
