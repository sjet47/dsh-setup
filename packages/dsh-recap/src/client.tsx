/**
 * Browser half of dsh-recap: one line under the composer showing the session
 * recap, with regenerate and dismiss actions. The Host owns generation; this
 * panel only reads and triggers it.
 */
import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'

export const inject = ['slots'] as const

interface RecapWire {
  text: string
  visible: boolean
  stale: boolean
  generating: boolean
  current: boolean
  provider?: string
  model?: string
}

const actionStyle: CSSProperties = {
  border: 0,
  background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary, #888)',
  cursor: 'pointer',
  fontSize: 11,
  padding: '0 4px',
  lineHeight: '16px',
}

function RecapLine({ sessionId }: { sessionId: string }): ReactNode {
  const [state, setState] = useState<RecapWire | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`/api/dsh-recap/state?session=${encodeURIComponent(sessionId)}`, {
        credentials: 'same-origin',
      })
      if (!response.ok) return
      setState((await response.json()) as RecapWire)
    } catch {
      // Keep the previous line when the host is unreachable.
    }
  }, [sessionId])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 60_000)
    return () => clearInterval(timer)
  }, [load])

  const regenerate = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const response = await fetch(`/api/dsh-recap/generate?session=${encodeURIComponent(sessionId)}`, {
        method: 'POST',
        credentials: 'same-origin',
      })
      if (response.ok) setState((await response.json()) as RecapWire)
    } catch {
      // Leave the previous line in place.
    } finally {
      setBusy(false)
    }
  }, [sessionId])

  const dismiss = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`/api/dsh-recap/dismiss?session=${encodeURIComponent(sessionId)}`, {
        method: 'POST',
        credentials: 'same-origin',
      })
      if (response.ok) setState((await response.json()) as RecapWire)
    } catch {
      // Ignore: the next load reconciles.
    }
  }, [sessionId])

  if (state === undefined || state.text === '' || !state.visible) return null

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        padding: '2px 4px 4px',
        color: 'var(--dsw-alias-label-tertiary, #888)',
        fontSize: 11,
        lineHeight: '16px',
      }}
    >
      <span style={{ flex: 'none', opacity: 0.8 }}>Recap</span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: 'var(--dsw-alias-label-secondary, #666)',
        }}
        title={state.text}
      >
        {state.text}
      </span>
      {state.stale ? (
        <span style={{ flex: 'none', color: 'var(--dsw-alias-state-warning-primary, #f08c00)' }}>stale</span>
      ) : null}
      <button type="button" style={actionStyle} onClick={() => void regenerate()} disabled={busy}>
        {busy ? 'Recapping…' : 'Refresh'}
      </button>
      <button type="button" style={actionStyle} onClick={() => void dismiss()}>
        Dismiss
      </button>
    </div>
  )
}

/** Register the recap line in the composer dock. */
export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.composer.dock',
        id: 'dsh-recap',
        order: 10,
      },
      RecapLine,
    ),
  )
}
