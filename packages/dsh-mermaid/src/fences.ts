/**
 * Mermaid fence extraction shared by the Host renderer and the browser half.
 *
 * Assistant Markdown keeps Mermaid source inside GFM fences, so a diagram is
 * found by scanning the message text for ```mermaid blocks rather than by
 * inspecting rendered DOM. The scan is deliberately line-based and tolerant:
 * an unterminated fence still yields its partial source so a streaming message
 * can show the diagram that is still being written.
 * @module fences
 */

/** One ` ```mermaid ` fence found in a Markdown document. */
export interface MermaidFence {
  /** Source inside the fence, with the surrounding blank lines trimmed. */
  readonly source: string
  /** 1-based line where the fence opens, for stable keys and labels. */
  readonly line: number
  /** Fence info string as written after the backticks (`mermaid`, `Mermaid`). */
  readonly info: string
}

/** Fence info strings accepted as Mermaid, case-insensitively. */
const INFO = /^mermaid(?:\s|$)/i

/**
 * Collect every Mermaid fence in a Markdown document.
 *
 * Fences inside other fences are not possible in GFM — an opening fence of
 * three or more backticks is closed only by a fence of at least the same
 * length — so the scan tracks the opening run instead of counting nesting.
 * @param text - Markdown source, typically one assistant message.
 * @param options - `maxDiagrams` stops the scan once that many fences are found.
 * @returns Fences in document order; an empty list when the text has none.
 */
export function parseMermaidFences(text: string, options: { maxDiagrams?: number } = {}): MermaidFence[] {
  const limit = options.maxDiagrams ?? Number.POSITIVE_INFINITY
  if (text === '') return []
  const lines = text.split('\n')
  const fences: MermaidFence[] = []
  let index = 0
  while (index < lines.length) {
    if (fences.length >= limit) break
    const line = lines[index] ?? ''
    const open = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line)
    if (open === null) {
      index += 1
      continue
    }
    const indent = open[1] ?? ''
    const marker = open[2] ?? ''
    const info = (open[3] ?? '').trim()
    const fenceChar = marker.charAt(0)
    const fenceLength = marker.length
    const closePattern = new RegExp(`^\\s*${fenceChar === '`' ? '`' : '~'}{${fenceLength},}\\s*$`)
    const startLine = index + 1
    const body: string[] = []
    index += 1
    let closed = false
    while (index < lines.length) {
      const candidate = lines[index] ?? ''
      if (closePattern.test(candidate)) {
        closed = true
        index += 1
        break
      }
      body.push(indent === '' ? candidate : candidate.startsWith(indent) ? candidate.slice(indent.length) : candidate)
      index += 1
    }
    // An unterminated fence at the end of a streaming message is still a
    // diagram in progress; a fence that is not Mermaid is skipped entirely.
    if (!INFO.test(info)) continue
    if (!closed && body.length === 0) continue
    const source = trimBlankEdges(body).join('\n')
    if (source === '') continue
    fences.push({ source, line: startLine, info })
  }
  return fences
}

/** Drop leading and trailing blank lines without touching interior ones. */
function trimBlankEdges(lines: readonly string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && (lines[start] ?? '').trim() === '') start += 1
  while (end > start && (lines[end - 1] ?? '').trim() === '') end -= 1
  return lines.slice(start, end)
}

/**
 * Join the text blocks of one assistant message into the Markdown it rendered.
 * Tool calls and reasoning are not part of the visible answer, so they are
 * skipped: a Mermaid fence in reasoning never rendered as a diagram.
 * @param blocks - Assistant blocks in model order.
 * @returns Concatenated text, empty when the message has no text.
 */
export function assistantText(blocks: readonly { kind: string; text?: string }[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.kind === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n\n')
}
