/**
 * Browser half of dsh-mr: one compact chip in the session header showing the
 * current branch's request, CI state and title. Renders nothing when the branch
 * has no request or the lookup failed.
 */
import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
// Declaration merges: `ctx.slots` and the `conversation.session.header.actions` contract.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'

export const inject = ['slots'] as const

interface MrInfo {
  forge: 'gitlab' | 'github'
  ref: string
  title: string
  state: 'opened' | 'draft' | 'merged' | 'closed'
  ci: 'success' | 'failed' | 'running' | 'none'
  conflicts: boolean
  url: string
}

interface MrStatus {
  info: MrInfo | null
  branch: string | null
  error?: string
}

const STATE_ICON: Record<MrInfo['state'], string> = { opened: '⬤', draft: '◌', merged: '✔', closed: '✕' }
const STATE_COLOR: Record<MrInfo['state'], string> = {
  opened: 'var(--dsw-alias-state-success-primary, #2f9e44)',
  draft: 'var(--dsw-alias-label-tertiary, #888)',
  merged: 'var(--dsw-alias-state-info-primary, #4dabf7)',
  closed: 'var(--dsw-alias-state-error-primary, #e03131)',
}
const CI_TOKEN: Record<Exclude<MrInfo['ci'], 'none'>, string> = { success: '✓CI', failed: '✗CI', running: '⋯CI' }
const CI_COLOR: Record<Exclude<MrInfo['ci'], 'none'>, string> = {
  success: 'var(--dsw-alias-state-success-primary, #2f9e44)',
  failed: 'var(--dsw-alias-state-error-primary, #e03131)',
  running: 'var(--dsw-alias-label-tertiary, #888)',
}

function MrChip({ sessionId }: { sessionId: string }): ReactNode {
  const [status, setStatus] = useState<MrStatus | undefined>(undefined)

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(`/api/dsh-mr/status?session=${encodeURIComponent(sessionId)}`, {
          credentials: 'same-origin',
        })
        if (response.ok) {
          const value = (await response.json()) as MrStatus
          if (live) setStatus(value)
        }
      } catch {
        // Offline or a torn-down host: keep the previous chip.
      }
      if (live) timer = setTimeout(() => void load(), 30_000)
    }
    void load()
    return () => {
      live = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [sessionId])

  const info = status?.info
  if (info === undefined || info === null) return null

  const title = `${info.ref} · ${info.state}${info.ci === 'none' ? '' : ` · CI ${info.ci}`}${info.conflicts ? ' · conflicts' : ''}\n${info.title}`
  const style: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    maxWidth: 360,
    minHeight: 24,
    padding: '0 6px',
    border: '0.5px solid var(--dsw-alias-border-l1, #ddd)',
    borderRadius: 'var(--dsw-radius-sm, 6px)',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary, #555)',
    fontSize: 11,
    lineHeight: '18px',
    textDecoration: 'none',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
  }

  const body = (
    <>
      <span style={{ color: STATE_COLOR[info.state], flex: 'none' }}>{STATE_ICON[info.state]}</span>
      <span style={{ color: 'var(--dsw-alias-label-primary, #222)', flex: 'none', fontVariantNumeric: 'tabular-nums' }}>
        {info.ref}
      </span>
      {info.ci !== 'none' ? (
        <span style={{ color: CI_COLOR[info.ci], flex: 'none' }}>{CI_TOKEN[info.ci]}</span>
      ) : null}
      {info.conflicts ? <span style={{ color: 'var(--dsw-alias-state-warning-primary, #f08c00)', flex: 'none' }}>⚠</span> : null}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{info.title}</span>
    </>
  )

  return info.url ? (
    <a href={info.url} target="_blank" rel="noreferrer" title={title} style={style}>
      {body}
    </a>
  ) : (
    <span title={title} style={style}>
      {body}
    </span>
  )
}

/** Register the chip in the session header's action list. */
export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register(
      {
        name: 'conversation.session.header.actions',
        id: 'dsh-mr',
        order: 30,
      },
      MrChip,
    ),
  )
}
