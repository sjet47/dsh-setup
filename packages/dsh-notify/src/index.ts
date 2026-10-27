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
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
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
  /** Make the notification clickable, revealing its session in every open DSH UI. */
  revealOnClick: boolean
  /** Command run to raise the DSH window before revealing; empty auto-detects. */
  focusCommand: string
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  appName: z.string().default('DSH'),
  icon: z.string().default(''),
  previewChars: z.number().default(160),
  expireTimeoutMs: z.number().default(-1),
  notifySubagents: z.boolean().default(false),
  notifyOnAbort: z.boolean().default(false),
  revealOnClick: z.boolean().default(true),
  focusCommand: z.string().default(''),
})

/**
 * Notification artwork shipped with the package.
 *
 * The SVG rather than the PNG beside it: the daemon rasterizes an SVG at the
 * exact logical size it needs, while a fixed-size PNG is resampled down and
 * loses detail at the card's 40px icon slot. Measured on quickshell, the same
 * slot scores a Laplacian variance of 2544 from the SVG against 1768 from the
 * 256px PNG. `icon.png` stays in the package for daemons built without SVG
 * image support; point `icon` at it in that case.
 */
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

/** One JSON response for the claim route; no caching, it is a one-shot read. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

/**
 * How long a clicked notification stays claimable by a UI.
 *
 * A click is worthless if it lands minutes later on a client that just
 * opened: the user asked for that session then, not now.
 */
const PENDING_TTL_MS = 60_000

/**
 * Pick the command that raises the DSH window on this desktop.
 *
 * Wayland gives a background process no way to raise another window, so this
 * is delegated to the compositor that owns the policy. Auto-detection covers
 * the two compositors whose CLI can address the window; every other desktop
 * keeps the session switch and skips the raise.
 * @param env - environment to inspect, defaulting to this process's.
 * @returns a shell command, or `''` when raising is unsupported here.
 */
export function detectFocusCommand(env: NodeJS.ProcessEnv = process.env): string {
  if (env['HYPRLAND_INSTANCE_SIGNATURE'] !== undefined && env['HYPRLAND_INSTANCE_SIGNATURE'] !== '') {
    // Hyprland 0.56 moved dispatch to Lua; older releases still take the
    // classic form, which the new one accepts silently without focusing. Run
    // both: whichever release is installed ignores the other.
    return [
      'hyprctl dispatch focuswindow class:deepseek-harness >/dev/null 2>&1',
      `hyprctl dispatch 'hl.dsp.focus({ window = "class:deepseek-harness" })' >/dev/null 2>&1`,
    ].join('; ')
  }
  if (env['SWAYSOCK'] !== undefined && env['SWAYSOCK'] !== '') {
    return 'swaymsg [app_id="deepseek-harness"] focus'
  }
  return ''
}

/** Run one fire-and-forget shell command, ignoring both its output and exit. */
function runDetached(command: string, logger: { warn(message: string): void }): void {
  if (command === '') return
  try {
    // A shell keeps multi-word commands configurable as one string, which is
    // what a config value has to be.
    const child = spawn('/bin/sh', ['-c', command], { detached: true, stdio: 'ignore' })
    child.on('error', (error: Error) => logger.warn(`dsh-notify: focus command failed: ${error.message}`))
    child.unref()
  } catch (error) {
    logger.warn(`dsh-notify: focus command failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Install the notification forwarder.
 *
 * Contained on purpose: the Desktop refuses to start when a profile entry does
 * not reach `active`, so a bug in this plugin must cost notifications, not the
 * application. Failures above this line (Config validation) stay visible.
 * @param ctx - plugin context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config = Config()): void {
  try {
    install(ctx, config)
  } catch (error) {
    ctx.logger.warn(`dsh-notify: disabled itself after a setup failure: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * The actual wiring, kept separate so {@link apply} can contain it.
 * @param ctx - plugin context.
 * @param config - resolved plugin configuration.
 */
function install(ctx: Context, config: Config): void {
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
  const focusCommand = config.focusCommand !== '' ? config.focusCommand : detectFocusCommand()
  /** Daemon notification id → the session that posted it, for click routing. */
  const owners = new Map<number, string>()
  /** Session a click asked to reveal, until an open UI claims it. */
  let pending: { sessionId: string; at: number } | undefined
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
      const previous = state.notificationId
      const id = await notifier.notify({
        appName: config.appName,
        replacesId: previous ?? 0,
        summary: notice.summary,
        body: notice.body,
        appIcon: icon,
        urgency: notice.urgency,
        expireTimeoutMs: config.expireTimeoutMs,
        actions: config.revealOnClick ? ['default', 'Open session'] : [],
      })
      state.notificationId = id
      // The daemon keeps the id of a replaced notification, so overwrite the
      // owner rather than accumulating stale ids.
      if (previous !== undefined) owners.delete(previous)
      owners.set(id, sessionId)
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
    const sessionId = String(session.id)
    const state = states.get(sessionId)
    if (state?.notificationId !== undefined) owners.delete(state.notificationId)
    states.delete(sessionId)
  })

  /** Mirror a click into the UIs: remember the target, then try to raise DSH. */
  const reveal = (sessionId: string): void => {
    pending = { sessionId, at: Date.now() }
    runDetached(focusCommand, ctx.logger)
  }

  ctx.effect(() => {
    const offAction = config.revealOnClick
      ? notifier.onActionInvoked((id, action) => {
          if (action !== 'default') return
          const sessionId = owners.get(id)
          if (sessionId !== undefined) reveal(sessionId)
        })
      : () => {}
    const offClosed = notifier.onClosed((id) => {
      owners.delete(id)
    })
    return () => {
      offAction()
      offClosed()
    }
  })

  // The click happens on the Host; switching the visible session happens in
  // the browser. A short claim route is the bridge, and it needs the web
  // transport, so a profile without it keeps notifications without clicking.
  ctx.inject(['connection'], (scoped) => {
    scoped.effect(() =>
      scoped.connection.fetch.register({
        path: '/api/dsh-notify/claim',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (): Promise<Response> => {
          const claim = pending
          pending = undefined
          if (claim === undefined || Date.now() - claim.at > PENDING_TTL_MS) {
            return json({ sessionId: null })
          }
          return json({ sessionId: claim.sessionId })
        },
      }),
    )
  })

  ctx.effect(() => () => {
    notifier.close()
    states.clear()
    owners.clear()
    pending = undefined
  })

  ctx.logger.debug(`dsh-notify: listening on ${target.path ?? target.abstract ?? 'the session bus'}`)
}
