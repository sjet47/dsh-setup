/**
 * Browser half of dsh-notify: turn a notification click into a session switch.
 *
 * The click itself happens on the Host (D-Bus `ActionInvoked`), but only a
 * connected UI can change what the user is looking at. The Host parks the
 * clicked session behind a one-shot claim route and this module polls it, then
 * hands the id to `uiWorkspace.openSession`. Polling rather than a pushed event
 * keeps the plugin independent of the Host's remote-event declarations, which
 * are generated rather than authorable from a plain-JS bundle.
 *
 * There is no UI of its own: everything visible already belongs to the host
 * (sidebar, conversation), and a decoration would add noise for a feature that
 * only runs on a click.
 * @module dsh-notify/client
 */
import type { Context } from '@deepseek-ai/cordis'

export const inject = ['uiWorkspace'] as const

/** The one shot claim route registered by the Host half. */
const CLAIM_PATH = '/api/dsh-notify/claim'

/** Poll cadence; the payload is a few bytes and the route is one-shot. */
const POLL_MS = 2000

/** Slower cadence while the route is missing, i.e. the Host half is disabled. */
const IDLE_POLL_MS = 15_000

/** Attempts to open a session the client has not loaded yet. */
const OPEN_ATTEMPTS = 5

/** Delay before retrying an id the session list does not know yet. */
const RETRY_MS = 400

/**
 * The slice of the workspace commands this plugin uses.
 *
 * Declared locally instead of importing `@deepseek-ai/dsh-client-ui-workspace`:
 * that package is a Host bundle, not a dependency of a plain-JS plugin, and its
 * type surface changes without notice.
 */
interface WorkspaceCommands {
  openSession(sessionId: string): void
}

/** The session list, read only to decide whether a reveal can succeed yet. */
interface SessionCatalog {
  readonly list?: { getSnapshot(): { byId: Record<string, unknown> } }
}

/** Whether the client already knows this session, so a reveal can take effect. */
function known(sessions: SessionCatalog | undefined, sessionId: string): boolean {
  try {
    return sessions?.list?.getSnapshot().byId[sessionId] !== undefined
  } catch {
    return false
  }
}

/**
 * Reveal one session, waiting for the session list to know it.
 *
 * A click can beat the client's session list — a notification for a session
 * created moments ago, or a client that just reconnected — and switching to an
 * unknown id does nothing. Switch once the list has it, and retry only while it
 * does not: repeating `openSession` on a session already shown would fight the
 * user's own navigation.
 * @param workspace - the workspace command surface.
 * @param sessions - the session catalog used to tell "not yet" from "ready".
 * @param sessionId - the session the user clicked.
 * @param isDisposed - stops the retry chain when the plugin unloads.
 * @param schedule - timer helper owned by the caller.
 * @param attempt - retries spent so far.
 */
function reveal(
  workspace: WorkspaceCommands,
  sessions: SessionCatalog | undefined,
  sessionId: string,
  isDisposed: () => boolean,
  schedule: (run: () => void, delay: number) => void,
  attempt = 0,
): void {
  if (isDisposed()) return
  // Without a catalog the plugin cannot tell "not yet" from "ready", so it
  // falls back to the first attempt and lets the host's own restore win.
  if (sessions !== undefined && !known(sessions, sessionId)) {
    if (attempt + 1 >= OPEN_ATTEMPTS) return
    schedule(() => reveal(workspace, sessions, sessionId, isDisposed, schedule, attempt + 1), RETRY_MS)
    return
  }
  try {
    workspace.openSession(sessionId)
  } catch {
    // A rejected switch must not break the poller; the next click retries.
  }
}

/**
 * Install the claim poller.
 *
 * Every failure here is contained: the Desktop treats a Client entry that does
 * not reach `active` as a fatal start-up error, and takes the whole window down
 * with it. A notification nicety must never be able to do that, so a bug in
 * this half degrades to "the click only raises the window".
 * @param ctx - client plugin context; `uiWorkspace` is injected.
 */
export function apply(ctx: Context): void {
  try {
    start(ctx)
  } catch (error) {
    console.warn('dsh-notify: the reveal poller is unavailable', error)
  }
}

/** The actual registration, kept separate so {@link apply} can contain it. */
function start(ctx: Context): void {
  const scoped = ctx as unknown as {
    uiWorkspace?: WorkspaceCommands
    /** Optional service access; reading `ctx.sessions` directly throws. */
    get?(name: string): unknown
  }
  const workspace = scoped.uiWorkspace
  if (workspace === undefined) return
  // Read through `get` rather than `ctx.sessions`: the session catalog is used
  // only to decide whether a reveal can land, so it must stay optional instead
  // of turning into a hard dependency this composition might not satisfy.
  const sessions = scoped.get?.('sessions') as SessionCatalog | undefined

  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let polling = false

  const schedule = (run: () => void, delay: number): void => {
    if (disposed) return
    timer = setTimeout(run, delay)
  }

  const poll = async (): Promise<void> => {
    if (disposed || polling) return
    polling = true
    let delay = POLL_MS
    try {
      const response = await fetch(CLAIM_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      if (response.ok) {
        const value: unknown = await response.json()
        const sessionId = (value as { sessionId?: unknown }).sessionId
        if (typeof sessionId === 'string' && sessionId !== '') {
          reveal(workspace, sessions, sessionId, () => disposed, schedule)
        }
        delay = POLL_MS
      } else {
        // 401/404 means the Host half is not there, so there is nothing to
        // claim; keep looking, but stop asking every two seconds.
        delay = IDLE_POLL_MS
      }
    } catch {
      // The Host may be restarting; the next tick simply tries again.
      delay = IDLE_POLL_MS
    } finally {
      polling = false
      schedule(() => void poll(), delay)
    }
  }

  // A tab woken from the background may have missed a click while its timers
  // were throttled, so coming back into view is worth an immediate poll.
  const onWake = (): void => {
    if (document.visibilityState !== 'visible') return
    if (timer !== undefined) clearTimeout(timer)
    void poll()
  }

  document.addEventListener('visibilitychange', onWake)
  window.addEventListener('focus', onWake)
  void poll()

  ctx.effect(() => () => {
    disposed = true
    if (timer !== undefined) clearTimeout(timer)
    document.removeEventListener('visibilitychange', onWake)
    window.removeEventListener('focus', onWake)
  })
}
