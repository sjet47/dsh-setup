/**
 * Host-side Mermaid rendering on top of `beautiful-mermaid`.
 *
 * Rendering runs in the Host rather than the browser half on purpose: the
 * renderer (with its ELK layout engine) is ~1.5 MB of JavaScript, and a client
 * bundle would pay that parse cost on every page load. The Host imports it
 * lazily on the first diagram request instead, and the browser half receives
 * finished SVG markup.
 *
 * Colours are the Host's theme tokens as CSS variables, so one rendered SVG
 * follows light/dark switches and font-size changes in the page without a
 * second request. The renderer only emits `svg`, `style`, `defs`, `marker`,
 * `polygon`, `polyline`, `g`, `rect`, and `text` elements and escapes label
 * text, so the markup is safe to insert as HTML.
 * @module render
 */
import type { RenderOptions } from 'beautiful-mermaid'

/** Diagram grammars this renderer can draw. */
export type DiagramFamily = 'flowchart' | 'sequence' | 'class' | 'er' | 'state' | 'xychart'

/** Outcome of one source: drawn markup, or why it was not drawn. */
export type RenderOutcome =
  | { readonly ok: true; readonly family: DiagramFamily; readonly svg: string }
  | {
      readonly ok: false
      readonly family: DiagramFamily | 'unsupported'
      readonly reason: 'unsupported' | 'invalid' | 'too-large'
      readonly message: string
    }

/** Limits applied to one request, mirrored from the plugin Config. */
export interface RenderLimits {
  /** Longest single source accepted, in characters. */
  readonly maxSourceChars: number
  /** Longest error message echoed back to the browser. */
  readonly maxMessageChars: number
}

/** Elements the renderer emits; anything else means the markup is not a drawing. */
const SAFE_ELEMENTS = new Set([
  'svg', 'style', 'defs', 'marker', 'g', 'rect', 'text', 'tspan', 'title', 'desc',
  'polygon', 'polyline', 'path', 'line', 'circle', 'ellipse', 'stop', 'linearGradient', 'radialGradient',
])

/** Theme tokens handed to the renderer as CSS variables. */
const COLORS: RenderOptions = {
  // Matches the card the viewer draws the diagram on, so `color-mix` derivations
  // and node fills agree with the surrounding surface. Must be the same opaque
  // token the panel uses: a mid-grey base flattens every derived contrast.
  bg: 'var(--dsw-alias-bg-layer-1)',
  fg: 'var(--dsw-alias-label-primary)',
  muted: 'var(--dsw-alias-label-secondary)',
  accent: 'var(--dsw-alias-brand-primary)',
  line: 'var(--dsw-alias-border-l2)',
  // The renderer's default node stroke is `fg` at 20%, which all but disappears
  // on a dark plate; a named mix keeps the node outline readable in both themes.
  border: 'color-mix(in srgb, var(--dsw-alias-label-primary) 28%, var(--dsw-alias-bg-layer-1))',
  // The viewer draws on the card, so the drawing itself carries no plate; the
  // colours above stay the derivation basis for node fills and strokes.
  transparent: true,
}

/** The renderer injects a Google Fonts import; the page keeps its own font. */
const FONT_STACK = "system-ui, -apple-system, 'Segoe UI', 'Noto Sans CJK SC', sans-serif"
const FONT_IMPORT = /@import url\('https:\/\/fonts\.googleapis\.com\/[^']*'\);\s*/g
const FONT_DECLARATION = /font-family:\s*'Inter',\s*system-ui,\s*sans-serif;/g

/** Lazily imported renderer; a failed import is retried on the next request. */
let renderer: Promise<typeof import('beautiful-mermaid')> | undefined

function loadRenderer(): Promise<typeof import('beautiful-mermaid')> {
  renderer ??= import('beautiful-mermaid').catch((error: unknown) => {
    renderer = undefined
    throw error
  })
  return renderer
}

/**
 * Identify the diagram grammar from the opening directive.
 *
 * `beautiful-mermaid` silently treats anything it does not recognise as a
 * flowchart, which turns a pie chart into a parse error or an empty drawing.
 * Classifying here keeps the browser honest about what it cannot draw.
 * @param source - Mermaid source, first non-blank line significant.
 * @returns The supported family, or `unsupported` for grammars this renderer lacks.
 */
export function detectFamily(source: string): DiagramFamily | 'unsupported' {
  for (const raw of source.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('%%')) continue
    const head = line.toLowerCase()
    if (/^(graph|flowchart)\b/.test(head)) return 'flowchart'
    if (head.startsWith('sequencediagram')) return 'sequence'
    if (head.startsWith('classdiagram')) return 'class'
    if (head.startsWith('erdiagram')) return 'er'
    if (head.startsWith('statediagram')) return 'state'
    if (/^xychart(-beta)?\b/.test(head)) return 'xychart'
    return 'unsupported'
  }
  return 'unsupported'
}

/**
 * Render one Mermaid source to SVG markup.
 * @param source - Mermaid source without the surrounding fence.
 * @param limits - Size bounds from the plugin Config.
 * @returns Finished markup, or an outcome explaining why nothing was drawn.
 */
export async function renderDiagram(source: string, limits: RenderLimits): Promise<RenderOutcome> {
  if (source.length > limits.maxSourceChars) {
    return {
      ok: false,
      family: 'unsupported',
      reason: 'too-large',
      message: `Diagram source is larger than ${limits.maxSourceChars} characters.`,
    }
  }
  const family = detectFamily(source)
  if (family === 'unsupported') {
    return {
      ok: false,
      family,
      reason: 'unsupported',
      message: 'This diagram type is not supported yet: this renderer draws flowcharts, state, sequence, class, ER, and XY charts.',
    }
  }
  let svg: string
  try {
    const { renderMermaidSVG } = await loadRenderer()
    svg = renderMermaidSVG(source, COLORS)
  } catch (error) {
    return { ok: false, family, reason: 'invalid', message: describe(error, limits.maxMessageChars) }
  }
  if (!looksLikeSafeSvg(svg)) {
    return {
      ok: false,
      family,
      reason: 'invalid',
      message: 'The renderer produced markup this page will not insert.',
    }
  }
  return { ok: true, family, svg: stripExternalFont(svg) }
}

/** Keep the page's font instead of the renderer's Google Fonts import. */
function stripExternalFont(svg: string): string {
  return svg.replace(FONT_IMPORT, '').replace(FONT_DECLARATION, `font-family: ${FONT_STACK};`)
}

/**
 * Reject markup that could execute or frame content if inserted as HTML.
 *
 * Two checks, both structural rather than textual: every element must be one
 * the renderer draws, and no attribute may be an event handler or a script
 * URL. Attribute *values* are blanked before the handler check — a label
 * reading `onerror=…` sits inside a `data-label` value and is harmless text,
 * not an attribute.
 * @param svg - Candidate markup.
 * @returns Whether the markup is a plain SVG drawing.
 */
function looksLikeSafeSvg(svg: string): boolean {
  if (!svg.startsWith('<svg')) return false
  for (const match of svg.matchAll(/<\/?([a-zA-Z][\w:-]*)/g)) {
    const element = match[1] ?? ''
    if (!SAFE_ELEMENTS.has(element)) return false
  }
  // Element text is data, never markup: blank it before looking at attributes,
  // so a label reading `onerror=…` cannot be mistaken for a handler.
  const tagsOnly = svg.replace(/>[^<]*</g, '><')
  const withoutValues = tagsOnly.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''")
  if (/\son[a-z]+\s*=/i.test(withoutValues)) return false
  return !/javascript:/i.test(tagsOnly)
}

/** Renderer errors are model-facing text; bound and flatten them. */
function describe(error: unknown, maxChars: number): string {
  const text = error instanceof Error ? error.message : String(error)
  const firstLine = text.split('\n')[0]?.trim() ?? ''
  return firstLine.length > maxChars ? `${firstLine.slice(0, maxChars)}…` : firstLine || 'Mermaid could not parse this diagram.'
}
