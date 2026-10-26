/**
 * Browser half of dsh-recap: a one-line recap above the composer plus a panel
 * that shows the full text, its model and its freshness with actions.
 *
 * The panel is rendered in the frame-wide `shell.overlay` slot (root scope) and
 * targets the Session shown in the center column, so it is never clipped by the
 * composer and closes when the user switches Sessions. Both `/recap` (a
 * client-side command decoration) and clicking the line open it; the Host owns
 * generation and this module only reads and triggers it.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, MutableRefObject, ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'

export const inject = ['slots', 'locale'] as const

const NS = 'dsh-recap'
const POLL_MS = 30_000

/** Copy registered into the Client locale service (see `locale/*.json`). */
const EN: Record<string, string> = {
  'action.label': 'Recap',
  'action.open': 'Open the full recap',
  'action.regenerate': 'Regenerate recap',
  'action.hide': 'Hide recap',
  'action.stale': 'stale',
  'action.staleTitle': 'The session moved on since this recap',
  'panel.title': 'Recap',
  'panel.close': 'Close',
  'panel.generate': 'Generate',
  'panel.regenerate': 'Regenerate',
  'panel.generating': 'Recapping…',
  'panel.dismiss': 'Dismiss',
  'panel.empty': "No recap yet. Generate one from this session's conversation.",
  'panel.current': 'current',
  'panel.stale': 'stale',
  'panel.autoIdle': 'Generates automatically after {minutes} min idle',
  'panel.failed': 'Recap generation failed.',
  'panel.updateFailed': 'Could not update the recap.',
}
const ZH: Record<string, string> = {
  'action.label': '摘要',
  'action.open': '打开完整摘要',
  'action.regenerate': '重新生成摘要',
  'action.hide': '隐藏摘要',
  'action.stale': '已过期',
  'action.staleTitle': '此后会话有新进展',
  'panel.title': '会话摘要',
  'panel.close': '关闭',
  'panel.generate': '生成',
  'panel.regenerate': '重新生成',
  'panel.generating': '生成中…',
  'panel.dismiss': '忽略',
  'panel.empty': '还没有摘要。可以从当前会话生成一条。',
  'panel.current': '最新',
  'panel.stale': '已过期',
  'panel.autoIdle': '闲置 {minutes} 分钟后自动生成',
  'panel.failed': '生成摘要失败。',
  'panel.updateFailed': '无法更新摘要。',
}

interface RecapWire {
  text: string
  visible: boolean
  stale: boolean
  generating: boolean
  current: boolean
  enabled: boolean
  idleMs: number
  provider?: string
  model?: string
}

type PostResult = { ok: true; state: RecapWire } | { ok: false; error: string }

/* ── panel store ──────────────────────────────────────────────────────────── */

let recapOpen: string | undefined
const openListeners = new Set<() => void>()

function setRecapOpen(sessionId: string | undefined): void {
  recapOpen = sessionId
  for (const listener of openListeners) listener()
}

function subscribeOpen(listener: () => void): () => void {
  openListeners.add(listener)
  return () => openListeners.delete(listener)
}

function useRecapOpen(): string | undefined {
  return useSyncExternalStore(
    subscribeOpen,
    () => recapOpen,
    () => recapOpen,
  )
}

/* ── locale ───────────────────────────────────────────────────────────────── */

function useT(locale: LocaleRuntime): Translate {
  useSyncExternalStore(
    useCallback((listener: () => void) => locale.subscribe(listener), [locale]),
    useCallback(() => locale.getSnapshot().revision, [locale]),
    () => 0,
  )
  return locale.bind(NS)
}

/* ── wire ─────────────────────────────────────────────────────────────────── */

async function readState(sessionId: string): Promise<RecapWire | undefined> {
  try {
    const response = await fetch(`/api/dsh-recap/state?session=${encodeURIComponent(sessionId)}`, {
      credentials: 'same-origin',
    })
    if (!response.ok) return undefined
    return (await response.json()) as RecapWire
  } catch {
    return undefined
  }
}

async function post(sessionId: string, action: 'generate' | 'dismiss'): Promise<PostResult> {
  try {
    const response = await fetch(`/api/dsh-recap/${action}?session=${encodeURIComponent(sessionId)}`, {
      method: 'POST',
      credentials: 'same-origin',
    })
    const payload = (await response.json()) as RecapWire & { error?: unknown }
    if (!response.ok) {
      return { ok: false, error: typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}` }
    }
    return { ok: true, state: payload }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/* ── theme tokens ─────────────────────────────────────────────────────────── */

const SURFACE = 'var(--dsw-alias-bg-layer-2, #ffffff)'
const BORDER = 'var(--dsw-alias-border-l1, rgba(0,0,0,0.12))'
const TEXT = 'var(--dsw-alias-label-primary, #1f1f1f)'
const MUTED = 'var(--dsw-alias-label-tertiary, #6b6b6b)'
const WARN = 'var(--dsw-alias-state-warn-primary, #f08c00)'
const ERROR = 'var(--dsw-alias-state-error-primary, #e03131)'
const BRAND = 'var(--dsw-alias-brand-primary, #4d6bfe)'
const FONT = 'var(--dsh-content-font-size, 14px)'
const scale = (factor: number): string => `calc(${FONT} * ${factor})`

/**
 * The composer dock floats over the scrolling transcript, so its card needs an
 * opaque body: a translucent fill let scrolled text read through the copy.
 * The host's own dock bars (`QueueDock`, `GoalBar`) use the translucent menu
 * surface with a heavy backdrop blur; this paints the same menu tint over the
 * opaque base layer instead, which keeps the host look without depending on
 * `backdrop-filter` support. (`--dsw-alias-fill-l1` is not a theme token, so
 * the previous fill silently fell back to a 5% black.)
 */
const CARD_SURFACE =
  'linear-gradient(var(--dsw-specific-menu, rgba(248,249,250,0.58)), var(--dsw-specific-menu, rgba(248,249,250,0.58))), var(--dsw-alias-bg-base, #ffffff)'

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1000,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'auto',
}
const maskStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.24))',
  backdropFilter: 'var(--dsw-mask-blur, blur(2px))',
}
const panelStyle: CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  width: 'min(560px, calc(100vw - 48px))',
  maxHeight: 'min(420px, calc(100vh - 96px))',
  background: SURFACE,
  color: TEXT,
  border: `0.5px solid ${BORDER}`,
  borderRadius: 'var(--dsw-radius-panel, 12px)',
  boxShadow: 'var(--dsw-elevation-prominent, 0 12px 40px rgba(0,0,0,.28))',
  overflow: 'hidden',
  fontSize: FONT,
}
const actionStyle: CSSProperties = {
  border: `0.5px solid ${BORDER}`,
  borderRadius: 'var(--dsw-radius-sm, 6px)',
  background: 'transparent',
  color: MUTED,
  cursor: 'pointer',
  font: 'inherit',
  fontSize: scale(0.88),
  padding: '2px 8px',
  lineHeight: 1.3,
}
/**
 * `conversation.input.dock` is a full-width strip: the slot allocates the whole
 * conversation column and each entry constrains its own box. Copy the host's
 * own dock geometry (`QueueDock`, `GoalBar`) so the card lines up with the
 * composer card and the transcript text instead of spanning the whole column.
 * The tokens are published on the conversation body, with fallbacks for a
 * composition that does not set them.
 */
const DOCK_FRAME: CSSProperties = {
  boxSizing: 'border-box',
  width:
    'calc(100% - var(--dsh-composer-side-clearance, 16px) - var(--dsh-composer-side-clearance, 16px)' +
    ' - var(--dsh-composer-dock-inset, 8px) - var(--dsh-composer-dock-inset, 8px))',
  maxWidth:
    'calc(var(--dsh-composer-card-max-width, 952px) - var(--dsh-composer-dock-inset, 8px) - var(--dsh-composer-dock-inset, 8px))',
  margin: '0 auto',
  padding: '0 var(--dsh-composer-dock-inset, 8px)',
}
const ROW: CSSProperties = {
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  minWidth: 0,
  padding: '7px 10px',
  border: `0.5px solid ${BORDER}`,
  borderRadius: 'var(--dsw-radius-md, 8px)',
  background: CARD_SURFACE,
  boxShadow: 'var(--dsw-elevation-panel, 0 3px 8px rgba(0,0,0,.06))',
  fontSize: scale(0.88),
  lineHeight: 1.5,
  color: MUTED,
}
const LABEL: CSSProperties = {
  flex: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  color: BRAND,
  fontWeight: 600,
  letterSpacing: '.02em',
  lineHeight: 1.5,
}
const ROW_TEXT: CSSProperties = {
  flex: 1,
  minWidth: 0,
  border: 0,
  padding: 0,
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary, #5c5c5c)',
  cursor: 'pointer',
  textAlign: 'left',
  font: 'inherit',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
}
const ROW_ACTION: CSSProperties = {
  border: 0,
  background: 'transparent',
  color: MUTED,
  cursor: 'pointer',
  fontSize: scale(0.88),
  lineHeight: 1.3,
  padding: '0 3px',
}
const STALE: CSSProperties = {
  flex: 'none',
  color: WARN,
  fontSize: scale(0.8),
  lineHeight: 1.5,
}

/**
 * Modal keyboard contract: focus moves into the panel, Tab stays inside it,
 * Escape closes it, and focus returns to whatever opened it.
 */
function useDialogBehavior(panelRef: MutableRefObject<HTMLDivElement | null>, onClose: () => void): void {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const panel = panelRef.current
    const focusables = (): HTMLElement[] => {
      if (panel === null) return []
      return Array.from(
        panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.offsetParent !== null)
    }
    const initial = panel?.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0] ?? panel
    initial?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) {
        event.preventDefault()
        panel?.focus()
        return
      }
      const first = items[0]!
      const last = items[items.length - 1]!
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      previous?.focus?.()
    }
  }, [panelRef])
}

/* ── composer line ────────────────────────────────────────────────────────── */

interface StatusSnapshotLike {
  get(id: string): { running?: boolean } | undefined
}

type UseSessionStatusLike = <T>(selector: (snapshot: StatusSnapshotLike) => T) => T

function RecapLine({ sessionId, locale, useSessionStatus }: {
  sessionId: string
  locale: LocaleRuntime
  useSessionStatus: UseSessionStatusLike
}): ReactNode {
  const t = useT(locale)
  const [state, setState] = useState<RecapWire | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const running = useSessionStatus((snapshot) => snapshot.get(sessionId)?.running === true)
  const wasRunning = useRef(false)

  const load = useCallback(async (): Promise<void> => {
    const next = await readState(sessionId)
    if (next !== undefined) setState(next)
  }, [sessionId])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(timer)
  }, [load])

  // A turn starts hiding the card at once, and a turn ending re-reads the Host
  // state immediately instead of waiting for the next poll.
  useEffect(() => {
    if (running) {
      wasRunning.current = true
      return
    }
    if (wasRunning.current) {
      wasRunning.current = false
      void load()
    }
  }, [running, load])

  // The Host hides the recap on the next human message; reflect that without
  // waiting for the next poll.
  const visible = state !== undefined && state.visible && !running
  if (!visible) return null

  const regenerate = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await post(sessionId, 'generate')
      if (result.ok) setState(result.state)
    } finally {
      setBusy(false)
    }
  }

  const hide = async (): Promise<void> => {
    const result = await post(sessionId, 'dismiss')
    if (result.ok) setState(result.state)
  }

  return (
    <div style={DOCK_FRAME}>
      <div style={ROW}>
        <span style={LABEL}>
          <span aria-hidden style={{ opacity: 0.9 }}>
            ✦
          </span>
          {t('action.label')}
        </span>
        <button
          type="button"
          onClick={() => setRecapOpen(sessionId)}
          title={t('action.open')}
          aria-label={t('action.open')}
          style={ROW_TEXT}
        >
          {state.text}
        </button>
        {state.stale ? (
          <span style={STALE} title={t('action.staleTitle')}>
            {t('action.stale')}
          </span>
        ) : null}
        <span style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          <button
            type="button"
            style={ROW_ACTION}
            onClick={() => void regenerate()}
            disabled={busy}
            title={t('action.regenerate')}
            aria-label={t('action.regenerate')}
          >
            {busy ? '…' : '↻'}
          </button>
          <button
            type="button"
            style={ROW_ACTION}
            onClick={() => void hide()}
            title={t('action.hide')}
            aria-label={t('action.hide')}
          >
            ×
          </button>
        </span>
      </div>
    </div>
  )
}

/* ── panel ────────────────────────────────────────────────────────────────── */

function RecapPanel({ sessionId, onClose, locale }: {
  sessionId: string
  onClose: () => void
  locale: LocaleRuntime
}): ReactNode {
  const t = useT(locale)
  const [state, setState] = useState<RecapWire | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const panelRef = useRef<HTMLDivElement | null>(null)
  useDialogBehavior(panelRef, onClose)

  useEffect(() => {
    let live = true
    void readState(sessionId).then((next) => {
      if (live && next !== undefined) setState(next)
    })
    return () => {
      live = false
    }
  }, [sessionId])

  const run = async (action: 'generate' | 'dismiss'): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      const result = await post(sessionId, action)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setState(result.state)
      if (action === 'dismiss') onClose()
    } finally {
      setBusy(false)
    }
  }

  const text = state?.text ?? ''
  const model = state === undefined ? '' : [state.provider, state.model].filter(Boolean).join('/')
  const idleMinutes = state === undefined || state.idleMs <= 0 ? 0 : Math.round(state.idleMs / 60_000)

  return (
    <div style={overlayStyle} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div style={maskStyle} aria-hidden="true" onMouseDown={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dsh-recap-title"
        tabIndex={-1}
        style={panelStyle}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: `0.5px solid ${BORDER}` }}>
          <strong
            id="dsh-recap-title"
            style={{ fontSize: scale(1.08) }}
            title={idleMinutes > 0 ? t('panel.autoIdle', { minutes: idleMinutes }) : undefined}
          >
            {t('panel.title')}
          </strong>
          <span style={{ flex: 1, color: MUTED, fontSize: scale(0.88) }}>
            {model === '' ? '' : model}
            {state !== undefined && text !== '' ? ` · ${state.current ? t('panel.current') : t('panel.stale')}` : ''}
          </span>
          <button type="button" style={actionStyle} onClick={onClose} data-autofocus>
            {t('panel.close')}
          </button>
        </div>

        <div
          style={{
            padding: '12px 14px',
            overflow: 'auto',
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {text === '' ? <span style={{ color: MUTED }}>{t('panel.empty')}</span> : text}
        </div>

        {error !== undefined ? (
          <div style={{ padding: '0 14px 8px', color: ERROR, fontSize: scale(0.88) }}>{error}</div>
        ) : null}

        <div style={{ display: 'flex', gap: 8, padding: '8px 14px 12px', alignItems: 'center' }}>
          <button
            type="button"
            style={{ ...actionStyle, color: TEXT, padding: '3px 10px' }}
            onClick={() => void run('generate')}
            disabled={busy || state?.enabled === false}
          >
            {busy
              ? t('panel.generating')
              : text === ''
                ? t('panel.generate')
                : t('panel.regenerate')}
          </button>
          <button type="button" style={actionStyle} onClick={() => void run('dismiss')} disabled={busy || text === ''}>
            {t('panel.dismiss')}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── frame overlay ────────────────────────────────────────────────────────── */

interface SessionSummaryLike {
  retainedBy?: Record<string, number>
}

interface SessionsSnapshotLike {
  byId: Record<string, SessionSummaryLike>
}

type UseSessionsLike = <T>(selector: (state: SessionsSnapshotLike) => T) => T

function RecapOverlay({ useSessions, locale }: { useSessions: UseSessionsLike; locale: LocaleRuntime }): ReactNode {
  const open = useRecapOpen()
  const current = useSessions((state) => {
    for (const session of Object.values(state.byId)) {
      if ((session.retainedBy?.mainView ?? 0) > 0) return (session as SessionSummaryLike & { id: string }).id
    }
    return undefined
  })

  useEffect(() => {
    if (open !== undefined && open !== current) setRecapOpen(undefined)
  }, [current, open])

  if (open === undefined || open !== current) return null
  return <RecapPanel key={open} sessionId={open} onClose={() => setRecapOpen(undefined)} locale={locale} />
}

/* ── registration ─────────────────────────────────────────────────────────── */

/** Open the panel from the `/recap` client action. */
function runRecapCommand(session: { sessionId: string }): void {
  setRecapOpen(String(session.sessionId))
}

/** Register the dock line, the overlay panel, and the `/recap` action. */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const disposeEn = ctx.locale.register(NS, 'en', EN)
    const disposeZh = ctx.locale.register(NS, 'zh', ZH)
    return () => {
      disposeEn()
      disposeZh()
    }
  })

  ctx.slots.inject('conversation.input.dock', () => {
    const Line = (props: { sessionId: string; useSessionStatus: UseSessionStatusLike }) => (
      <RecapLine sessionId={props.sessionId} useSessionStatus={props.useSessionStatus} locale={ctx.locale} />
    )
    return ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'dsh-recap',
        order: 30,
        label: 'Recap',
      },
      Line,
    )
  })

  ctx.slots.inject('shell.overlay', () => {
    const Overlay = (props: { useSessions: UseSessionsLike }) => (
      <RecapOverlay useSessions={props.useSessions} locale={ctx.locale} />
    )
    return ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'dsh-recap-panel',
        order: 30,
        label: 'Recap',
      },
      Overlay,
    )
  })

  ctx.inject(['commandUi'], (scoped) => {
    scoped.effect(() =>
      scoped.commandUi.decorate({
        name: 'recap',
        available: () => true,
        ui: { kind: 'action', run: runRecapCommand },
      }),
    )
  })
}
