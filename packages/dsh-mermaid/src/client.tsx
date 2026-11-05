/**
 * Browser half of dsh-mermaid: a diagram action under each assistant message
 * and the viewer it opens.
 *
 * The action renders only for messages that actually contain ` ```mermaid `
 * fences. The fences themselves stay where Chat put them — this plugin never
 * edits Chat's Markdown output, so a code block keeps its copy button and its
 * syntax highlighting. Opening the action asks the Host to draw every diagram
 * in that message and shows the results in a frame-wide overlay.
 *
 * The overlay lives in `shell.overlay` (root scope) rather than a portal: the
 * frame owns the floating layer and its stacking order, so the panel cannot be
 * clipped by the composer or land under a Host dialog. Each drawing is inserted
 * into its own shadow root because the renderer ships a stylesheet with bare
 * `svg`/`text` selectors that would otherwise restyle the whole application;
 * theme CSS variables still cascade through the shadow boundary.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { AssistantChatData, ChatSnapshot, UseChat } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { assistantText, parseMermaidFences, type MermaidFence } from './fences.js'

export const inject = ['slots', 'locale'] as const

const NS = 'dsh-mermaid'

/** Copy registered into the Client locale service (see `locale/*.json`). */
const EN: Record<string, string> = {
  'action.label': 'Diagrams',
  'action.title': 'View the Mermaid diagrams in this message',
  'panel.title': 'Diagrams',
  'panel.subtitle': '{count} in this message',
  'panel.close': 'Close',
  'panel.loading': 'Drawing…',
  'panel.zoomIn': 'Zoom in',
  'panel.zoomOut': 'Zoom out',
  'panel.reset': 'Reset view',
  'panel.fit': 'Fit',
  'panel.source': 'Source',
  'panel.preview': 'Preview',
  'panel.copy': 'Copy source',
  'panel.copied': 'Copied',
  'panel.download': 'Download SVG',
  'panel.failed': 'Could not draw this diagram',
  'panel.requestFailed': 'The renderer did not answer ({status})',
  'panel.disabled': 'dsh-mermaid is disabled in this profile.',
  'panel.unsupported': 'Unsupported diagram type',
  'panel.diagram': 'Diagram {index}',
}

const ZH: Record<string, string> = {
  'action.label': '图表',
  'action.title': '查看这条消息里的 Mermaid 图',
  'panel.title': '图表',
  'panel.subtitle': '本消息 {count} 张',
  'panel.close': '关闭',
  'panel.loading': '绘制中…',
  'panel.zoomIn': '放大',
  'panel.zoomOut': '缩小',
  'panel.reset': '重置视图',
  'panel.fit': '适应窗口',
  'panel.source': '源码',
  'panel.preview': '预览',
  'panel.copy': '复制源码',
  'panel.copied': '已复制',
  'panel.download': '下载 SVG',
  'panel.failed': '这张图没能画出来',
  'panel.requestFailed': '渲染器没有响应（{status}）',
  'panel.disabled': 'dsh-mermaid 在这个 profile 里被禁用了。',
  'panel.unsupported': '暂不支持该图表类型',
  'panel.diagram': '第 {index} 张',
}

/* ── theme tokens ─────────────────────────────────────────────────────────── */

// An opaque raised surface. `--dsw-alias-bg-overlay` is a mid grey in dark mode
// (#61666b), and a plate of it behind a light-on-dark drawing reads as haze.
const SURFACE = 'var(--dsw-alias-bg-layer-1, #ffffff)'
const BORDER = 'var(--dsw-alias-border-l2, rgba(0,0,0,0.16))'
const TEXT = 'var(--dsw-alias-label-primary, #1f1f1f)'
const MUTED = 'var(--dsw-alias-label-secondary, #6b6b6b)'
const HOVER = 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05))'
const ERROR = 'var(--dsw-alias-state-error-primary, #e03131)'

/* ── locale ───────────────────────────────────────────────────────────────── */

/** Translate through the plugin's namespace and re-render on locale changes. */
function useT(locale: LocaleRuntime): Translate {
  const revision = useSyncExternalStore(
    useCallback((listener: () => void) => locale.subscribe(listener), [locale]),
    useCallback(() => locale.getSnapshot().revision, [locale]),
    () => 0,
  )
  // Memoised on the revision: a fresh binding per render would re-run every
  // effect that lists the translator as a dependency.
  return useMemo(() => locale.bind(NS), [locale, revision])
}

/* ── message → diagrams ───────────────────────────────────────────────────── */

/** One message's diagrams, captured when the action opened the panel. */
interface DiagramSubject {
  /** Stable identity of this viewing session; a new open resets the panel. */
  readonly key: string
  readonly fences: readonly MermaidFence[]
}

/**
 * The visible answer text of the assistant message this action belongs to.
 *
 * The selector returns a string rather than the node payload: a primitive keeps
 * its identity across snapshot rebuilds, so the action re-renders only when the
 * answer text actually changes.
 * @param snapshot - Current Chat publication.
 * @param messageId - The finalized message this action was registered for.
 */
function selectAssistantText(snapshot: ChatSnapshot, messageId: string): string {
  for (const key of snapshot.order) {
    const node = snapshot.nodes.get(key)
    if (node === undefined || node.kind !== 'assistant-step') continue
    const data = node.data as AssistantChatData | undefined
    if (data?.finalNode?.messageId === messageId) return assistantText(data.blocks)
  }
  return ''
}

const NO_FENCES: readonly MermaidFence[] = []

/** Mirrors the Host route's default `maxDiagrams`; a larger request is refused. */
const DIAGRAM_BUDGET = 24

/** The diagrams of the message this action belongs to. */
function useMessageFences(useChat: UseChat, messageId: string): readonly MermaidFence[] {
  const text = useChat((snapshot) => selectAssistantText(snapshot, messageId))
  return useMemo(
    () => (text === '' ? NO_FENCES : parseMermaidFences(text, { maxDiagrams: DIAGRAM_BUDGET })),
    [text],
  )
}

/* ── panel store ──────────────────────────────────────────────────────────── */

let panelState: DiagramSubject | null = null
const panelListeners = new Set<() => void>()

function openPanel(subject: DiagramSubject): void {
  panelState = subject
  for (const listener of panelListeners) listener()
}

function closePanel(): void {
  if (panelState === null) return
  panelState = null
  for (const listener of panelListeners) listener()
}

function subscribePanel(listener: () => void): () => void {
  panelListeners.add(listener)
  return () => panelListeners.delete(listener)
}

function usePanel(): DiagramSubject | null {
  return useSyncExternalStore(
    subscribePanel,
    () => panelState,
    () => null,
  )
}

/* ── render request ───────────────────────────────────────────────────────── */

/** Host answer for one source. */
type RenderEntry =
  | { readonly ok: true; readonly svg: string; readonly family: string }
  | { readonly ok: false; readonly reason: string; readonly message: string }

async function requestDiagrams(sources: readonly string[]): Promise<readonly RenderEntry[]> {
  const response = await fetch('/api/dsh-mermaid/render', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sources: sources.map((source) => ({ source })) }),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`status:${response.status}`)
  }
  const payload = (await response.json()) as { enabled?: boolean; results?: unknown }
  if (payload.enabled === false) throw new Error('status:disabled')
  const results = payload.results
  if (!Array.isArray(results)) throw new Error('status:500')
  return results as RenderEntry[]
}

/* ── drawing surface ──────────────────────────────────────────────────────── */

/** Renderer stylesheet scoped to the shadow root, not to the application. */
const SHADOW_STYLE = `
  :host { display: block; height: 100%; }
  .stage { display: flex; height: 100%; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box; }
  svg { display: block; max-width: none; height: auto; }
`

/** Read the drawing's natural size from its markup, for the initial fit. */
function intrinsicSize(svg: string): { width: number; height: number } | undefined {
  const viewBox = /viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/.exec(svg)
  if (viewBox !== null) {
    const width = Number(viewBox[3])
    const height = Number(viewBox[4])
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) return { width, height }
  }
  return undefined
}

/**
 * The drawing, isolated in a shadow root.
 * @param props - Markup from the Host and the current view transform.
 */
function DiagramSurface({ svg, scale, offset }: { svg: string; scale: number; offset: { x: number; y: number } }) {
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    // The Host already rejected executable or framing markup, so this inserts
    // only the drawing and its own stylesheet.
    shadow.innerHTML = `<style>${SHADOW_STYLE}</style><div class="stage">${svg}</div>`
    return () => {
      shadow.replaceChildren()
    }
  }, [svg])
  return (
    <div
      ref={hostRef}
      style={{
        width: '100%',
        height: '100%',
        transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
        transformOrigin: 'center center',
      }}
    />
  )
}

/* ── panel ────────────────────────────────────────────────────────────────── */

const MIN_SCALE = 0.1
const MAX_SCALE = 4
/** Multiplicative step for buttons and the wheel, so each notch feels equal. */
const ZOOM_STEP = 1.25

/** Keep a scale inside the supported range and at two decimals. */
function clampScale(value: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.round(value * 100) / 100))
}

const panelStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 60,
  // `shell.overlay` is a click-through layer; an occupant opts back into
  // pointer events.
  pointerEvents: 'auto',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 12,
  background: 'rgba(0,0,0,0.5)',
}

/**
 * Card size as a fraction of the viewport, at the golden ratio.
 *
 * The diagram opens at 100% rather than being auto-fitted, so this is the size
 * of the *window*, not of the drawing: a card that covers most of the viewport
 * reads as a modal takeover, while this leaves the page as visible context.
 */
const CARD_WIDTH = '62vw'
const CARD_HEIGHT = '62vh'

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: CARD_WIDTH,
  height: CARD_HEIGHT,
  borderRadius: 14,
  border: `1px solid ${BORDER}`,
  background: SURFACE,
  color: TEXT,
  boxShadow: '0 18px 48px rgba(0,0,0,0.28)',
  overflow: 'hidden',
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '12px 14px',
  borderBottom: `1px solid ${BORDER}`,
}

const iconButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  height: 28,
  minWidth: 28,
  padding: '0 8px',
  borderRadius: 7,
  border: 'none',
  background: 'transparent',
  color: MUTED,
  fontSize: 12,
  cursor: 'pointer',
  lineHeight: 1,
}

const activeTabStyle: CSSProperties = {
  ...iconButtonStyle,
  background: HOVER,
  color: TEXT,
}

/** A small chevron/plus glyph set so the panel needs no icon package. */
function Glyph({ path, size = 14 }: { path: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d={path} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

const ICON = {
  close: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  reset: 'M4 4v6h6M20 20v-6h-6M4 10a8 8 0 0114-3M20 14a8 8 0 01-14 3',
  code: 'M9 18l-6-6 6-6M15 6l6 6-6 6',
  copy: 'M9 9h9v12H9zM6 15H4V3h9v2',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
}

/**
 * The frame-wide diagram viewer.
 * @param props - Client locale runtime.
 */
function DiagramPanel({ locale }: { locale: LocaleRuntime }): ReactNode {
  const subject = usePanel()
  const t = useT(locale)
  const [index, setIndex] = useState(0)
  const [results, setResults] = useState<readonly RenderEntry[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [showSource, setShowSource] = useState(false)
  const [copied, setCopied] = useState(false)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ x: number; y: number } | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const translateRef = useRef(t)
  translateRef.current = t

  const key = subject?.key ?? null

  // One open draws every diagram of that message in a single request.
  useEffect(() => {
    if (subject === null) {
      setResults(null)
      setFailure(null)
      return undefined
    }
    let cancelled = false
    setResults(null)
    setFailure(null)
    setIndex(0)
    setScale(1)
    setOffset({ x: 0, y: 0 })
    setShowSource(false)
    requestDiagrams(subject.fences.map((fence) => fence.source)).then(
      (next) => {
        if (!cancelled) setResults(next)
      },
      (error: unknown) => {
        if (cancelled) return
        const status = error instanceof Error && error.message.startsWith('status:') ? error.message.slice(7) : '—'
        const translate = translateRef.current
        setFailure(status === 'disabled' ? translate('panel.disabled') : translate('panel.requestFailed').replace('{status}', status))
      },
    )
    return () => {
      cancelled = true
    }
  }, [key, subject])

  // Escape closes; the panel owns the top layer while it is open.
  useEffect(() => {
    if (subject === null) return undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        closePanel()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [subject])

  const current = results?.[index]
  const source = subject?.fences[index]?.source ?? ''

  /** Scale that shows the whole drawing, never above its natural size. */
  const fitToViewport = useCallback(() => {
    if (current === undefined || !current.ok) return
    const natural = intrinsicSize(current.svg)
    const body = bodyRef.current
    if (natural === undefined || body === null) return
    const width = body.clientWidth - 32
    const height = body.clientHeight - 32
    if (width <= 0 || height <= 0) return
    const fit = Math.min(width / natural.width, height / natural.height, 1)
    setScale(clampScale(fit))
    setOffset({ x: 0, y: 0 })
  }, [current])

  const zoom = useCallback((factor: number) => {
    setScale((value) => clampScale(value * factor))
  }, [])

  // Zoom on the wheel, as a diagram viewer should. React registers its wheel
  // listener as passive, so this is attached natively to keep preventDefault
  // effective and stop the page from scrolling behind the panel.
  //
  // `key` is a dependency because the body element only exists while a subject
  // is open: the effect's first run sees no element, and opening the panel must
  // re-run it rather than rely on `showSource` changing.
  useEffect(() => {
    const body = bodyRef.current
    if (body === null || showSource) return undefined
    let lastAt = 0
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      // Trackpads emit a burst of events per gesture; without a floor the
      // drawing races from 100% to the bound in one flick.
      const now = Date.now()
      if (now - lastAt < 24) return
      lastAt = now
      setScale((value) => clampScale(event.deltaY < 0 ? value * ZOOM_STEP : value / ZOOM_STEP))
    }
    body.addEventListener('wheel', onWheel, { passive: false })
    return () => body.removeEventListener('wheel', onWheel)
  }, [showSource, key])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = { x: event.clientX, y: event.clientY }
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragRef.current
    if (start === null) return
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    dragRef.current = { x: event.clientX, y: event.clientY }
    setOffset((value) => ({ x: value.x + dx, y: value.y + dy }))
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const copySource = useCallback(() => {
    if (source === '') return
    void navigator.clipboard.writeText(source).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }, [source])

  const downloadSvg = useCallback(() => {
    if (current === undefined || !current.ok) return
    const blob = new Blob([current.svg], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `mermaid-${index + 1}.svg`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, [current, index])

  if (subject === null) return null

  const count = subject.fences.length
  const loading = results === null && failure === null

  return (
    <div style={panelStyle} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closePanel()}>
      <div style={cardStyle} role="dialog" aria-modal="true" aria-label={t('panel.title')}>
        <div style={headerStyle}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
            <strong style={{ fontSize: 13, fontWeight: 600 }}>{t('panel.title')}</strong>
            <span style={{ fontSize: 11, color: MUTED }}>
              {t('panel.subtitle').replace('{count}', String(count))}
            </span>
          </div>
          <div style={{ flex: 1 }} />
          {count > 1 && (
            <div style={{ display: 'flex', gap: 2, overflowX: 'auto', maxWidth: '40%' }}>
              {subject.fences.map((fence, position) => (
                <button
                  key={`${fence.line}-${position}`}
                  type="button"
                  style={position === index ? activeTabStyle : iconButtonStyle}
                  title={t('panel.diagram').replace('{index}', String(position + 1))}
                  onClick={() => {
                    setIndex(position)
                    setScale(1)
                    setOffset({ x: 0, y: 0 })
                  }}
                >
                  {position + 1}
                </button>
              ))}
            </div>
          )}
          <button type="button" style={iconButtonStyle} title={t('panel.close')} aria-label={t('panel.close')} onClick={closePanel}>
            <Glyph path={ICON.close} />
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 10px', borderBottom: `1px solid ${BORDER}` }}>
          <button type="button" style={iconButtonStyle} title={t('panel.zoomOut')} aria-label={t('panel.zoomOut')} onClick={() => zoom(1 / ZOOM_STEP)}>
            <Glyph path={ICON.minus} />
          </button>
          <span style={{ fontSize: 11, color: MUTED, minWidth: 40, textAlign: 'center' }}>{Math.round(scale * 100)}%</span>
          <button type="button" style={iconButtonStyle} title={t('panel.zoomIn')} aria-label={t('panel.zoomIn')} onClick={() => zoom(ZOOM_STEP)}>
            <Glyph path={ICON.plus} />
          </button>
          <button
            type="button"
            style={iconButtonStyle}
            title={t('panel.reset')}
            aria-label={t('panel.reset')}
            onClick={() => {
              setScale(1)
              setOffset({ x: 0, y: 0 })
            }}
          >
            <Glyph path={ICON.reset} />
          </button>
          <button type="button" style={iconButtonStyle} title={t('panel.fit')} aria-label={t('panel.fit')} onClick={fitToViewport}>
            <Glyph path={ICON.fit} />
          </button>
          <span style={{ width: 1, height: 16, background: BORDER, margin: '0 4px' }} />
          <button
            type="button"
            style={showSource ? activeTabStyle : iconButtonStyle}
            title={showSource ? t('panel.preview') : t('panel.source')}
            onClick={() => setShowSource((value) => !value)}
          >
            <Glyph path={ICON.code} />
            <span>{showSource ? t('panel.preview') : t('panel.source')}</span>
          </button>
          <div style={{ flex: 1 }} />
          <button type="button" style={iconButtonStyle} title={t('panel.copy')} onClick={copySource}>
            <Glyph path={ICON.copy} />
            <span>{copied ? t('panel.copied') : t('panel.copy')}</span>
          </button>
          <button
            type="button"
            style={iconButtonStyle}
            title={t('panel.download')}
            aria-label={t('panel.download')}
            disabled={current === undefined || !current.ok}
            onClick={downloadSvg}
          >
            <Glyph path={ICON.download} />
          </button>
        </div>

        <div
          ref={bodyRef}
          style={{
            position: 'relative',
            flex: 1,
            minHeight: 0,
            overflow: 'hidden',
            cursor: showSource ? 'auto' : dragging ? 'grabbing' : 'grab',
            // Panning must not paint a text selection over the labels; the
            // source view keeps selection so its text stays copyable.
            userSelect: showSource ? 'text' : 'none',
          }}
          onPointerDown={showSource ? undefined : onPointerDown}
          onPointerMove={showSource ? undefined : onPointerMove}
          onPointerUp={showSource ? undefined : onPointerUp}
          onPointerCancel={showSource ? undefined : onPointerUp}
        >
          {loading && (
            <div style={{ ...centered, color: MUTED, fontSize: 12 }}>{t('panel.loading')}</div>
          )}
          {failure !== null && <div style={{ ...centered, color: ERROR, fontSize: 12 }}>{failure}</div>}
          {!loading && failure === null && showSource && <SourceView source={source} />}
          {!loading && failure === null && !showSource && current !== undefined && current.ok && (
            <div style={{ ...centered, padding: 0 }}>
              <DiagramSurface svg={current.svg} scale={scale} offset={offset} />
            </div>
          )}
          {!loading && failure === null && !showSource && current !== undefined && !current.ok && (
            <FailedDiagram
              message={current.message}
              source={source}
              title={current.reason === 'unsupported' ? t('panel.unsupported') : t('panel.failed')}
            />
          )}
        </div>
      </div>
    </div>
  )
}

const centered: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
  textAlign: 'center',
}

/** Source view: the exact fence body, so it can be copied and edited. */
function SourceView({ source, inline = false }: { source: string; inline?: boolean }) {
  return (
    <pre
      style={{
        position: inline ? 'relative' : 'absolute',
        inset: inline ? undefined : 0,
        flex: inline ? 1 : undefined,
        margin: 0,
        padding: 16,
        overflow: 'auto',
        fontSize: 12,
        lineHeight: 1.6,
        fontFamily: 'var(--dsw-font-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
        color: TEXT,
        whiteSpace: 'pre',
        tabSize: 2,
      }}
    >
      {source}
    </pre>
  )
}

/** A diagram the renderer declined: why, plus the source it could not read. */
function FailedDiagram({ message, source, title }: { message: string; source: string; title: string }) {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 'none', padding: '12px 16px', borderBottom: `1px solid ${BORDER}`, color: ERROR, fontSize: 12 }}>
        <strong style={{ display: 'block', marginBottom: 2 }}>{title}</strong>
        <span style={{ color: MUTED }}>{message}</span>
      </div>
      <SourceView source={source} inline />
    </div>
  )
}

/* ── chat action ──────────────────────────────────────────────────────────── */

const actionStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  height: 24,
  padding: '0 8px',
  borderRadius: 6,
  border: `1px solid ${BORDER}`,
  background: 'transparent',
  color: MUTED,
  fontSize: 11,
  cursor: 'pointer',
}

/**
 * One diagram action under an assistant message.
 * @param props - Assistant action owner props plus the Chat selector hook.
 */
function DiagramAction({ messageId, useChat, locale }: { messageId: string; useChat: UseChat; locale: LocaleRuntime }) {
  const fences = useMessageFences(useChat, messageId)
  const t = useT(locale)
  if (fences.length === 0) return null
  return (
    <button
      type="button"
      style={actionStyle}
      title={t('action.title')}
      onClick={() => openPanel({ key: `${messageId}:${Date.now()}`, fences })}
      onMouseEnter={(event) => {
        event.currentTarget.style.background = HOVER
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = 'transparent'
      }}
    >
      <svg width={13} height={13} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="3" y="3" width="7" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.7" />
        <rect x="14" y="15" width="7" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.7" />
        <rect x="3" y="15" width="7" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.7" />
        <path d="M10 6h4a3 3 0 013 3v6M10 18h4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
      <span>{t('action.label')}</span>
      <span style={{ opacity: 0.7 }}>{fences.length}</span>
    </button>
  )
}

/* ── installation ─────────────────────────────────────────────────────────── */

/**
 * Register the message action, the viewer, and the plugin's copy.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const disposeEn = ctx.locale.register(NS, 'en', EN)
    const disposeZh = ctx.locale.register(NS, 'zh', ZH)
    return () => {
      disposeEn()
      disposeZh()
    }
  })

  ctx.slots.inject('conversation.chat.assistant-actions', () => {
    const Action = (props: { messageId: string; useChat: UseChat }) => (
      <DiagramAction messageId={props.messageId} useChat={props.useChat} locale={ctx.locale} />
    )
    return ctx.slots.register({ name: 'conversation.chat.assistant-actions', id: 'dsh-mermaid-action', order: 30 }, Action)
  })

  ctx.slots.inject('shell.overlay', () => {
    const Panel = () => <DiagramPanel locale={ctx.locale} />
    return ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'dsh-mermaid-panel',
        order: 30,
        label: () => ctx.locale.bind(NS)('panel.title'),
      },
      Panel,
    )
  })
}
