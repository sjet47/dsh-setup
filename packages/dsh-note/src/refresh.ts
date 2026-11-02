// Detecting and announcing MEMORY.md changes.
//
// The system-prompt block keeps a byte-stable MEMORY.md snapshot, which is what
// makes the prompt prefix cacheable. That snapshot is frozen for the session, so
// a memory another agent writes mid-session is invisible to this one. This
// module supplies the other half: probe the file cheaply, notice when its
// content really changed, and render one `<system-reminder>` message that names
// the file and shows the new content.
//
// Two independent inputs decide whether a change is real:
// 1. mtime/size, the fast path — unchanged metadata means no read at all;
// 2. the content digest, so a `touch` (or a byte-identical rewrite) announces
//    nothing. mtime alone is too eager: editors rewrite files without edits.
//
// Pure fs + crypto, no Cordis imports, so it can be exercised against throwaway
// directories.

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

/** Producer `kind` this plugin publishes for its own context messages. */
export const MEMORY_REFRESH_KIND = 'dsh-note'

/** Change list published on the message source; Chat renders it as file rows. */
export interface MemoryRefreshChange {
  readonly action: 'set' | 'replace' | 'remove'
  readonly path: string
  readonly digest?: string
}

/** Wire shape of the `source` on one refresh message. */
export interface MemoryRefreshSource {
  readonly kind: typeof MEMORY_REFRESH_KIND
  readonly form: 'instructions'
  readonly changes: readonly MemoryRefreshChange[]
}

/** A rendered refresh message: model-facing text plus the source that describes it. */
export interface MemoryRefresh {
  readonly text: string
  readonly source: MemoryRefreshSource
}

/** MEMORY.md as last read: content plus the metadata that identifies that read. */
export interface PresentIndex {
  readonly kind: 'present'
  /** Full-precision mtime; bigint so two writes in one millisecond still differ. */
  readonly mtimeNs: bigint
  readonly size: number
  readonly digest: string
  readonly content: string
}

/** MEMORY.md is not there (deleted mid-session, or never created). */
export interface MissingIndex {
  readonly kind: 'missing'
}

/** One stable observation of MEMORY.md. */
export type IndexSnapshot = PresentIndex | MissingIndex

/** The probe saw the file change while reading it; try again next turn. */
export interface UnstableIndex {
  readonly kind: 'unstable'
}

/** Outcome of one probe, including the "not now" case. */
export type IndexProbe = IndexSnapshot | UnstableIndex

/**
 * The baseline that matches a snapshot already handed to the model.
 *
 * Pass the stat taken under that read when it is known. Without one the mtime
 * records a value no real file can have, which forces the next probe to read
 * and compare content — slower once, but never wrong.
 * @param snapshot - content the model was given.
 * @param stat - metadata of the file under that read, when it was stable.
 * @returns the present snapshot describing exactly those bytes.
 */
export function baselineFromSnapshot(snapshot: string, stat?: { mtimeNs: bigint; size: number }): PresentIndex {
  return {
    kind: 'present',
    mtimeNs: stat?.mtimeNs ?? -1n,
    size: stat?.size ?? -1,
    digest: indexDigest(snapshot),
    content: snapshot,
  }
}

/** Longest content copied into one refresh message; the tail is replaced by a note. */
export const DEFAULT_REFRESH_MAX_CHARS = 16_000

/** Longest entry list (added or removed) spelled out before the rest is summarised. */
const MAX_DIFF_LINES = 20

/** Longest single index line copied into the diff; a long hook is cut, not followed. */
const MAX_DIFF_LINE_CHARS = 160

/** SHA-1 of the exact UTF-8 content, the identity compared across probes. */
export function indexDigest(content: string): string {
  return createHash('sha1').update(content).digest('hex')
}

/** Whether an fs error means "nothing at this path" rather than "cannot tell". */
function isMissingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Observe MEMORY.md once.
 *
 * A baseline whose mtime and size still match is returned unchanged without
 * reading the file, which makes the per-turn check one `stat`. Otherwise the
 * content is read and the metadata re-checked: a file that changed under the
 * read is reported `unstable` instead of half-read, and the caller retries on a
 * later turn.
 * @param indexPath - absolute path of the memory index.
 * @param baseline - last known snapshot, used for the no-read fast path.
 * @returns the observation, or `unstable` when the file moved under the read.
 */
export function probeIndex(indexPath: string, baseline?: IndexSnapshot): IndexProbe {
  let first: ReturnType<typeof statSync>
  try {
    first = statSync(indexPath, { bigint: true })
  } catch (error) {
    return isMissingError(error) ? { kind: 'missing' } : { kind: 'unstable' }
  }
  if (!first.isFile()) return { kind: 'unstable' }
  const size = Number(first.size)
  if (baseline?.kind === 'present' && baseline.mtimeNs === first.mtimeNs && baseline.size === size) return baseline
  let content: string
  try {
    content = readFileSync(indexPath, 'utf8')
  } catch (error) {
    return isMissingError(error) ? { kind: 'missing' } : { kind: 'unstable' }
  }
  let second: ReturnType<typeof statSync>
  try {
    second = statSync(indexPath, { bigint: true })
  } catch {
    return { kind: 'unstable' }
  }
  if (second.mtimeNs !== first.mtimeNs || Number(second.size) !== size) return { kind: 'unstable' }
  return { kind: 'present', mtimeNs: first.mtimeNs, size, digest: indexDigest(content), content }
}

/**
 * Whether two snapshots hold the same memory. Content decides: a rewrite that
 * only touched the mtime keeps the same digest and is not a change.
 * @param left - earlier snapshot.
 * @param right - later snapshot.
 * @returns true when the model-visible memory is unchanged.
 */
export function sameIndex(left: IndexSnapshot, right: IndexSnapshot): boolean {
  if (left.kind === 'missing' && right.kind === 'missing') return true
  if (left.kind === 'present' && right.kind === 'present') return left.digest === right.digest
  return false
}

/** One bounded side of the index-line diff. */
export interface IndexLineDiff {
  readonly added: readonly string[]
  readonly removed: readonly string[]
  /** How many added lines were not listed. */
  readonly addedHidden: number
  /** How many removed lines were not listed. */
  readonly removedHidden: number
}

/** Entry lines of a memory index: one `- [Title](file.md) — hook` per memory. */
function indexEntries(content: string): string[] {
  const entries: string[] = []
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('- [')) entries.push(line)
  }
  return entries
}

/** Cut one index line to the diff budget, marking the cut. */
function boundEntryLine(line: string): string {
  return line.length <= MAX_DIFF_LINE_CHARS ? line : `${line.slice(0, MAX_DIFF_LINE_CHARS - 1)}…`
}

/**
 * Which index entries appeared or disappeared between two contents, preserving
 * file order and bounded so one pathological index cannot flood the message.
 * @param previous - index content before the change ("" when it did not exist).
 * @param next - index content after the change.
 * @param maxLines - most lines reported per side.
 * @returns the bounded entry diff.
 */
export function diffIndexLines(previous: string, next: string, maxLines = MAX_DIFF_LINES): IndexLineDiff {
  const before = indexEntries(previous)
  const after = indexEntries(next)
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  const added = after.filter((line) => !beforeSet.has(line))
  const removed = before.filter((line) => !afterSet.has(line))
  return {
    added: added.slice(0, maxLines).map(boundEntryLine),
    removed: removed.slice(0, maxLines).map(boundEntryLine),
    addedHidden: Math.max(0, added.length - maxLines),
    removedHidden: Math.max(0, removed.length - maxLines),
  }
}

/**
 * Escape text so repository-controlled content cannot close the plugin-owned
 * `<system-reminder>` frame.
 * @param text - agent-written content.
 * @returns the same text with a literal close tag neutralised.
 */
export function escapeFrameBody(text: string): string {
  return text.split('</system-reminder>').join('<\\/system-reminder>')
}

/** Input for one refresh message. */
export interface MemoryRefreshInput {
  /** Absolute path of the memory index, as the model should see it. */
  readonly indexPath: string
  /** Snapshot the session was given at session start (or a previous refresh). */
  readonly previous: IndexSnapshot
  /** Snapshot observed now. */
  readonly current: IndexSnapshot
  /** Cap on the copied `MEMORY.md` content, in characters. */
  readonly maxChars?: number
}

/** Render one line list, or nothing when the side is empty. */
function lineBlock(title: string, lines: readonly string[], hidden: number): string[] {
  if (lines.length === 0) return []
  const block = [title, ...lines]
  if (hidden > 0) block.push(`… and ${hidden} more`)
  return [...block, '']
}

/**
 * Build the model-facing text and the source that describes one MEMORY.md
 * change: an update (replace), a first appearance (set), or a deletion
 * (remove). The text always names the file, says what the frozen snapshot means
 * now, and — for present content — carries the new index so the model can act
 * without another read.
 * @param input - observed transitions and the content budget.
 * @returns the rendered refresh.
 */
export function buildMemoryRefresh(input: MemoryRefreshInput): MemoryRefresh {
  const { indexPath, previous, current } = input
  const maxChars = Math.max(1, input.maxChars ?? DEFAULT_REFRESH_MAX_CHARS)
  const lines: string[] = ['<system-reminder>']

  if (current.kind === 'missing') {
    lines.push(
      `Memory index removed: ${indexPath}`,
      '',
      'This file was deleted after this session started, so the snapshot in your system prompt is the last content it had. Read the memory directory if you need the current state; do not recreate the index unless the user asks.',
    )
    return {
      text: escapeFrameBody(lines.join('\n')) + '\n</system-reminder>',
      source: { kind: MEMORY_REFRESH_KIND, form: 'instructions', changes: [{ action: 'remove', path: indexPath }] },
    }
  }

  const created = previous.kind !== 'present'
  if (created) {
    lines.push(
      `Memory index created: ${indexPath}`,
      '',
      'There was no memory index to follow before; there is one now. Use the content below.',
    )
  } else {
    lines.push(
      `Updated memory: ${indexPath}`,
      '',
      'This file changed since this session last saw it, so any earlier copy is stale — including the Memory index snapshot in your system prompt. Use the content below instead.',
    )
    const diff = diffIndexLines(previous.content, current.content)
    lines.push('', ...lineBlock('Added index lines:', diff.added, diff.addedHidden))
    if (diff.added.length === 0 && diff.removed.length === 0) {
      lines.push('No index lines were added or removed; the wording changed in place.', '')
    } else {
      lines.push(...lineBlock('Removed index lines:', diff.removed, diff.removedHidden))
    }
  }

  const body = current.content
  if (lines[lines.length - 1] !== '') lines.push('')
  if (body.trim() === '') {
    lines.push(`Current MEMORY.md at ${indexPath}:`, '', '(the index is empty)')
  } else if (body.length > maxChars) {
    lines.push(
      `Current MEMORY.md at ${indexPath}:`,
      '',
      body.slice(0, Math.max(0, maxChars)),
      '',
      `(index truncated at ${maxChars} characters; read ${indexPath} for the rest)`,
    )
  } else {
    lines.push(`Current MEMORY.md at ${indexPath}:`, '', body)
  }

  return {
    text: escapeFrameBody(lines.join('\n')) + '\n</system-reminder>',
    source: {
      kind: MEMORY_REFRESH_KIND,
      form: 'instructions',
      changes: [{ action: created ? 'set' : 'replace', path: indexPath, digest: current.digest }],
    },
  }
}
