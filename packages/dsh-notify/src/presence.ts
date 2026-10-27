/**
 * Deciding whether a finished run still deserves a notification.
 *
 * Only a browser knows which session is on screen and whether anyone is looking
 * at it, so the Client half reports that and the Host decides here. The rule is
 * deliberately narrow: silence requires all three facts — a fresh report, an
 * active page, and the same session. Anything unknown notifies, because a
 * redundant notification is a far smaller annoyance than a missing one.
 * @module dsh-notify/presence
 */

/** What one browser says it is looking at, and when it said so. */
export interface PresenceReport {
  /** Session shown in the main view, or null when no session is shown. */
  readonly sessionId: string | null
  /** Whether the page is visible and its window focused. */
  readonly active: boolean
  /** Report time, epoch milliseconds. */
  readonly at: number
}

/**
 * Whether the user is already looking at the session that just finished.
 *
 * The report expires: a closed tab leaves its last report behind, and treating
 * that as "still watching" would silence every later notification.
 * @param report - the browser's last report, or undefined when none arrived.
 * @param sessionId - the session whose run just finished.
 * @param now - current time, epoch milliseconds.
 * @param ttlMs - how long one report stays trustworthy.
 * @returns true only when silence is justified.
 */
export function watchingSession(
  report: PresenceReport | undefined,
  sessionId: string,
  now: number,
  ttlMs: number,
): boolean {
  if (report === undefined) return false
  if (report.sessionId === null || report.sessionId !== sessionId) return false
  if (!report.active) return false
  return now - report.at <= ttlMs
}
