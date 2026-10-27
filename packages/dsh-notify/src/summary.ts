/**
 * Turning one finished run into notification text: pure functions, so the
 * wording and the gating rules are unit-testable without a bus or a Session.
 * @module dsh-notify/summary
 */

/** Normal urgency; see {@link CompletionNotice.urgency}. */
const NORMAL = 1

/** Why a turn ended, mirroring `TurnEndReason` kinds from the session log. */
export type CompletionReason = 'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens' | 'interrupted' | 'forked'

/** A notification's text, ready to post. */
export interface CompletionNotice {
  readonly summary: string
  readonly body: string
  /**
   * 0 low, 1 normal, 2 critical. Always `1`: quickshell keeps critical
   * notifications on screen until dismissed, which is wrong for a routine
   * "answer ready" notice, and an error case still carries its own marker.
   */
  readonly urgency: number
}

/** Everything one completed run contributes to its notification. */
export interface CompletionInput {
  /** Session title, or the working directory's name when it has none. */
  readonly title: string
  /** The last turn's end reason. */
  readonly reason: CompletionReason | undefined
  /** Assistant text of the last reply. */
  readonly text: string | undefined
  /** Provider failure message for an errored turn. */
  readonly errorMessage: string | undefined
  /** Longest preview, in characters. */
  readonly previewChars: number
  /** Whether a user-cancelled run still deserves a notification. */
  readonly notifyOnAbort: boolean
}

/**
 * Collapse a reply into one preview line.
 *
 * Replies are Markdown with code fences and hard wrapping; a notification body
 * is a single line, so runs of whitespace become one space.
 * @param text - raw assistant text.
 * @param max - longest accepted preview, in characters.
 * @returns the collapsed preview, `''` when there is nothing to show.
 */
export function collapsePreview(text: string | undefined, max: number): string {
  if (text === undefined) return ''
  const collapsed = text.replaceAll('\r', '').replace(/\s+/g, ' ').trim()
  if (collapsed === '' || max <= 0) return ''
  if (collapsed.length <= max) return collapsed
  const cut = collapsed.slice(0, max)
  // Prefer a word boundary unless that would throw most of the preview away.
  const boundary = cut.lastIndexOf(' ')
  const trimmed = boundary >= Math.floor(max * 0.6) ? cut.slice(0, boundary) : cut
  return `${trimmed.trimEnd()}…`
}

/**
 * Decide whether a finished run notifies, and with what text.
 * @param input - the run's title, end reason, and last reply text.
 * @returns the notification to post, or undefined when this run stays silent.
 */
export function completionNotice(input: CompletionInput): CompletionNotice | undefined {
  const title = input.title === '' ? 'DSH' : input.title
  const preview = collapsePreview(input.text, input.previewChars)
  switch (input.reason) {
    case 'forked':
      // A fork is a navigation step, not a finished answer.
      return undefined
    case 'aborted':
      if (!input.notifyOnAbort) return undefined
      return { summary: `⏹ ${title}`, body: preview, urgency: NORMAL }
    case 'interrupted':
      return { summary: `⏹ ${title}`, body: preview, urgency: NORMAL }
    case 'error':
      return {
        summary: `⚠ ${title}`,
        body: collapsePreview(input.errorMessage, input.previewChars) || preview,
        urgency: NORMAL,
      }
    case 'max-tokens':
      return { summary: `… ${title}`, body: preview, urgency: NORMAL }
    case 'blocked':
      return { summary: `⚠ ${title}`, body: preview, urgency: NORMAL }
    case 'completed':
    case undefined:
      return { summary: title, body: preview, urgency: NORMAL }
  }
}
