/**
 * Browser half of dsh-recap: a one-line recap under the composer plus a full
 * panel that shows the recap, its model and its freshness with actions.
 *
 * Both `/recap` (a client-side command decoration) and clicking the line open
 * the panel. The Host owns generation; this module only reads and triggers it.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'

export const inject = ['slots'] as const

const SURFACE = 'var(--dsw-alias-bg-layer-2, #ffffff)'
const BORDER = 'var(--dsw-alias-border-l1, rgba(0,0,0,0.12))'
const TEXT = 'var(--dsw-alias-label-primary, #1f1f1f)'
const MUTED = 'var(--dsw-alias-label-tertiary, #6b6b6b)'
const FILL = 'var(--dsw-alias-fill-l1, rgba(0,0,0,0.05))'
const WARNING = 'var(--dsw-alias-state-warn-primary, #f08c00)'
const ERROR = 'var(--dsw-alias-state-error-primary, #e03131)'
const FONT = 'var(--dsh-content-font-size, 14px)'
/** One step of the content font size, so the panel follows the theme setting. */
const scale = (factor: number): string => `calc(${FONT} * ${factor})`

interface RecapWire {
  text: string
  visible: boolean
  stale: boolean
  generating: boolean
  current: boolean
  provider?: string
  model?: string
}

/** Which sessions have the recap panel open. */
const openSessions = new Set<string>()
const openListeners = new Set<() => void>()

function setRecapOpen(sessionId: string, open: boolean): void {
  if (open) openSessions.add(sessionId)
  else openSessions.delete(sessionId)
  for (const listener of openListeners) listener()
}

function subscribeRecapOpen(listener: () => void): () => void {
  openListeners.add(listener)
  return () => openListeners.delete(listener)
}

function useRecapOpen(sessionId: string): boolean {
  return useSyncExternalStore(
    subscribeRecapOpen,
    () => openSessions.has(sessionId),
    () => false,
  )
}

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

async function post(sessionId: string, action: 'generate' | 'dismiss'): Promise<RecapWire | undefined> {
  try {
    const response = await fetch(`/api/dsh-recap/${action}?session=${encodeURIComponent(sessionId)}`, {
      method: 'POST',
      credentials: 'same-origin',
    })
    if (!response.ok) return undefined
    return (await response.json()) as RecapWire
  } catch {
    return undefined
  }
}

const actionStyle: CSSProperties = {
  border: `0.5px solid ${BORDER}`,
  borderRadius: 6,
  background: 'transparent',
  color: MUTED,
  cursor: 'pointer',
  fontSize: scale(0.86),
  padding: '1px 7px',
  lineHeight: 1.3,
}

const BRAND = 'var(--dsw-alias-brand-primary, #4d6bfe)'
const ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  margin: '0 0 8px',
  padding: '7px 10px',
  border: `0.5px solid ${BORDER}`,
  borderRadius: 10,
  background: FILL,
  fontSize: scale(0.86),
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
  fontSize: scale(0.86),
  lineHeight: 1.3,
  padding: '0 3px',
}
const STALE: CSSProperties = {
  flex: 'none',
  color: WARNING,
  fontSize: scale(0.78),
  lineHeight: 1.5,
}

/** Recap card directly above the composer: two clamped lines plus actions. */
function RecapLine({ sessionId }: { sessionId: string }): ReactNode {
  const [state, setState] = useState<RecapWire | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const open = useRecapOpen(sessionId)

  useEffect(() => {
    let live = true
    void (async () => {
      const next = await readState(sessionId)
      if (live && next !== undefined) setState(next)
    })()
    const timer = setInterval(() => {
      void readState(sessionId).then((next) => {
        if (live && next !== undefined) setState(next)
      })
    }, 60_000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [sessionId, open])

  const regenerate = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const next = await post(sessionId, 'generate')
      if (next !== undefined) setState(next)
    } finally {
      setBusy(false)
    }
  }, [sessionId])

  const hide = useCallback(async (): Promise<void> => {
    const next = await post(sessionId, 'dismiss')
    if (next !== undefined) setState(next)
  }, [sessionId])

  if (state === undefined || state.text === '' || !state.visible) return null

  return (
    <div style={ROW}>
      <span style={LABEL}>
        <span aria-hidden style={{ opacity: 0.9 }}>
          ✦
        </span>
        Recap
      </span>
      <button
        type="button"
        onClick={() => setRecapOpen(sessionId, true)}
        title={state.text}
        style={ROW_TEXT}
      >
        {state.text}
      </button>
      {state.stale ? (
        <span style={STALE} title="The session moved on since this recap">
          stale
        </span>
      ) : null}
      <span style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 2 }}>
        <button type="button" style={ROW_ACTION} onClick={() => setRecapOpen(sessionId, true)} title="Open the full recap">
          Open
        </button>
        <button type="button" style={ROW_ACTION} onClick={() => void regenerate()} disabled={busy} title="Regenerate recap">
          {busy ? '…' : '↻'}
        </button>
        <button type="button" style={ROW_ACTION} onClick={() => void hide()} title="Hide recap">
          ×
        </button>
      </span>
    </div>
  )
}

/** The recap panel: full text, model, freshness, and the actions. */
function RecapPanel({ sessionId }: { sessionId: string }): ReactNode {
  const open = useRecapOpen(sessionId)
  const [state, setState] = useState<RecapWire | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!open) return
    let live = true
    setError(undefined)
    void readState(sessionId).then((next) => {
      if (live && next !== undefined) setState(next)
    })
    return () => {
      live = false
    }
  }, [open, sessionId])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setRecapOpen(sessionId, false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, sessionId])

  const run = useCallback(
    async (action: 'generate' | 'dismiss'): Promise<void> => {
      setBusy(true)
      setError(undefined)
      try {
        const next = await post(sessionId, action)
        if (next === undefined) {
          setError(action === 'generate' ? 'Recap generation failed.' : 'Could not update the recap.')
          return
        }
        setState(next)
        if (action === 'dismiss') setRecapOpen(sessionId, false)
      } finally {
        setBusy(false)
      }
    },
    [sessionId],
  )

  if (!open) return null

  const text = state?.text ?? ''
  const model = state === undefined ? '' : [state.provider, state.model].filter(Boolean).join('/')

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.5)',
      }}
      onMouseDown={(event) => event.target === event.currentTarget && setRecapOpen(sessionId, false)}
    >
      <div
        role="dialog"
        aria-label="Session recap"
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: 'min(560px, 92vw)',
          maxHeight: 'min(420px, 80vh)',
          background: SURFACE,
          color: TEXT,
          border: `0.5px solid ${BORDER}`,
          borderRadius: 12,
          boxShadow: 'var(--dsw-elevation-panel, 0 12px 40px rgba(0,0,0,.28))',
          overflow: 'hidden',
          fontSize: FONT,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: `0.5px solid ${BORDER}` }}>
          <strong style={{ fontSize: scale(1.08) }}>Recap</strong>
          <span style={{ flex: 1, color: MUTED, fontSize: scale(0.86) }}>
            {model === '' ? '' : model}
            {state !== undefined && text !== '' ? ` · ${state.current ? 'current' : 'stale'}` : ''}
          </span>
          <button type="button" style={actionStyle} onClick={() => setRecapOpen(sessionId, false)}>
            Close
          </button>
        </div>

        <div style={{ padding: '12px 14px', overflow: 'auto', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {text === '' ? (
            <span style={{ color: MUTED }}>No recap yet. Generate one from this session's conversation.</span>
          ) : (
            text
          )}
        </div>

        {error !== undefined ? <div style={{ padding: '0 14px 8px', color: ERROR, fontSize: scale(0.86) }}>{error}</div> : null}

        <div style={{ display: 'flex', gap: 8, padding: '8px 14px 12px', alignItems: 'center' }}>
          <button
            type="button"
            style={{ ...actionStyle, color: 'var(--dsw-alias-label-primary, #1f1f1f)', padding: '3px 10px' }}
            onClick={() => void run('generate')}
            disabled={busy}
          >
            {busy ? 'Recapping…' : text === '' ? 'Generate' : 'Regenerate'}
          </button>
          <button type="button" style={actionStyle} onClick={() => void run('dismiss')} disabled={text === ''}>
            Dismiss
          </button>
          <span style={{ flex: 1 }} />
          <span style={{ color: MUTED, fontSize: scale(0.78) }}>auto after 5 min idle</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** Open the panel from the `/recap` client action. */
function runRecapCommand(session: { sessionId: string }): void {
  setRecapOpen(String(session.sessionId), true)
}

/** Register the dock line, the panel, and the `/recap` client action. */
export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'dsh-recap',
        order: 10,
      },
      RecapLine,
    ),
  )

  ctx.slots.inject('conversation.input.overlay', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.overlay',
        id: 'dsh-recap-panel',
        order: 30,
      },
      RecapPanel,
    ),
  )

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
