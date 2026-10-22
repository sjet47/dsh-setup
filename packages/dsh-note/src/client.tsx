/**
 * Browser half of dsh-note: a header action that opens the project's memory
 * browser. Reads through the authenticated `/api/dsh-note/*` routes; deleting a
 * memory removes the file and its MEMORY.md line in one Host-side step.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'

export const inject = ['slots'] as const

interface Topic {
  title: string
  file: string
  hook: string
  indexed: boolean
  exists: boolean
  size?: number
  mtimeMs?: number
}

interface ListPayload {
  label: string
  memoryDir: string
  topics: Topic[]
}

interface BodyPayload {
  file: string
  text: string
  path: string
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatAge(mtimeMs: number | undefined): string {
  if (mtimeMs === undefined) return ''
  const minutes = Math.max(0, Math.round((Date.now() - mtimeMs) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 60) return `${days}d`
  const months = Math.round(days / 30)
  return `${months}mo`
}

const modalStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 2000,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(0,0,0,0.35)',
}
const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: 'min(820px, 94vw)',
  maxHeight: 'min(640px, 86vh)',
  background: 'var(--dsw-specific-menu, #fff)',
  color: 'var(--dsw-alias-label-primary, #222)',
  border: '0.5px solid var(--dsw-alias-border-l1, #ddd)',
  borderRadius: 12,
  boxShadow: 'var(--dsw-elevation-prominent, 0 12px 40px rgba(0,0,0,.28))',
  overflow: 'hidden',
  fontSize: 13,
}
const buttonStyle: CSSProperties = {
  border: '0.5px solid var(--dsw-alias-border-l1, #ddd)',
  borderRadius: 6,
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary, #555)',
  cursor: 'pointer',
  fontSize: 12,
  padding: '2px 8px',
}

function MemoryBrowser({ sessionId, onClose }: { sessionId: string; onClose: () => void }): ReactNode {
  const [list, setList] = useState<ListPayload | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Topic | undefined>(undefined)
  const [body, setBody] = useState<BodyPayload | undefined>(undefined)
  const [armed, setArmed] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  const reload = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`/api/dsh-note/list?session=${encodeURIComponent(sessionId)}`, {
        credentials: 'same-origin',
      })
      if (!response.ok) throw new Error(`list failed (${response.status})`)
      setList((await response.json()) as ListPayload)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [sessionId])

  useEffect(() => {
    void reload()
  }, [reload])

  const openTopic = useCallback(
    async (topic: Topic): Promise<void> => {
      setSelected(topic)
      setBody(undefined)
      setArmed(undefined)
      try {
        const response = await fetch(
          `/api/dsh-note/body?session=${encodeURIComponent(sessionId)}&file=${encodeURIComponent(topic.file)}`,
          { credentials: 'same-origin' },
        )
        if (!response.ok) throw new Error(`cannot open ${topic.file}`)
        setBody((await response.json()) as BodyPayload)
        setError(undefined)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [sessionId],
  )

  const remove = useCallback(
    async (topic: Topic): Promise<void> => {
      if (armed !== topic.file) {
        setArmed(topic.file)
        return
      }
      try {
        const response = await fetch(`/api/dsh-note/delete?session=${encodeURIComponent(sessionId)}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ file: topic.file }),
        })
        if (!response.ok) throw new Error(`delete failed (${response.status})`)
        setSelected(undefined)
        setBody(undefined)
        setArmed(undefined)
        await reload()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [armed, reload, sessionId],
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const topics = useMemo(() => {
    const all = list?.topics ?? []
    if (query.trim() === '') return all
    const needle = query.trim().toLowerCase()
    return all.filter((topic) =>
      `${topic.title} ${topic.file} ${topic.hook}`.toLowerCase().includes(needle),
    )
  }, [list, query])

  return (
    <div style={modalStyle} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div style={panelStyle} role="dialog" aria-label="Project memory">
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 8,
            padding: '10px 14px',
            borderBottom: '0.5px solid var(--dsw-alias-border-l1, #ddd)',
          }}
        >
          <strong style={{ fontSize: 13 }}>Memory</strong>
          <span style={{ color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: 12 }}>
            {list?.label ?? ''} · {(list?.topics ?? []).length} topics · shared with pi
          </span>
          <span style={{ flex: 1 }} />
          <button type="button" style={buttonStyle} onClick={onClose}>
            Close
          </button>
        </div>

        <div style={{ display: 'flex', minHeight: 0, flex: 1 }}>
          <div
            style={{
              width: 320,
              flex: 'none',
              display: 'flex',
              flexDirection: 'column',
              borderRight: '0.5px solid var(--dsw-alias-border-l1, #ddd)',
              minHeight: 0,
            }}
          >
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search title, file or hook"
              style={{
                margin: 8,
                padding: '4px 8px',
                borderRadius: 6,
                border: '0.5px solid var(--dsw-alias-border-l1, #ddd)',
                background: 'transparent',
                color: 'inherit',
                fontSize: 12,
                outline: 'none',
              }}
            />
            <div style={{ overflow: 'auto', minHeight: 0 }}>
              {topics.map((topic) => (
                <button
                  key={topic.file}
                  type="button"
                  onClick={() => void openTopic(topic)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '6px 10px',
                    border: 0,
                    borderLeft:
                      selected?.file === topic.file ? '2px solid var(--dsw-alias-label-primary, #222)' : '2px solid transparent',
                    background: selected?.file === topic.file ? 'var(--dsw-alias-fill-l1, rgba(0,0,0,.04))' : 'transparent',
                    color: 'inherit',
                    cursor: 'pointer',
                    fontSize: 12,
                  }}
                >
                  <div style={{ display: 'flex', gap: 6 }}>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {topic.title}
                    </span>
                    <span style={{ color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: 10, flex: 'none' }}>
                      {topic.exists ? `${formatBytes(topic.size)} · ${formatAge(topic.mtimeMs)}` : 'missing'}
                    </span>
                  </div>
                  <div
                    style={{
                      color: 'var(--dsw-alias-label-tertiary, #888)',
                      fontSize: 11,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {topic.indexed ? topic.hook || topic.file : `${topic.file} (unindexed)`}
                  </div>
                </button>
              ))}
              {topics.length === 0 ? (
                <div style={{ padding: 12, color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: 12 }}>
                  No memories match.
                </div>
              ) : null}
            </div>
          </div>

          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            {selected === undefined ? (
              <div style={{ padding: 16, color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: 12 }}>
                Select a memory to read it.
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px' }}>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {selected.title}
                  </span>
                  <button
                    type="button"
                    style={{
                      ...buttonStyle,
                      color: armed === selected.file ? 'var(--dsw-alias-state-error-primary, #e03131)' : undefined,
                    }}
                    onClick={() => void remove(selected)}
                  >
                    {armed === selected.file ? 'Confirm delete' : 'Delete'}
                  </button>
                </div>
                <div
                  style={{
                    padding: '0 12px',
                    color: 'var(--dsw-alias-label-tertiary, #888)',
                    fontSize: 11,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={body?.path ?? selected.file}
                >
                  {body?.path ?? selected.file}
                </div>
                <pre
                  style={{
                    flex: 1,
                    overflow: 'auto',
                    margin: '8px 12px 12px',
                    padding: 10,
                    borderRadius: 8,
                    background: 'var(--dsw-alias-fill-l1, rgba(0,0,0,.04))',
                    fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
                    fontSize: 12,
                    lineHeight: 1.5,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {body?.text ?? 'Loading…'}
                </pre>
              </>
            )}
          </div>
        </div>

        {error !== undefined ? (
          <div style={{ padding: '6px 12px', color: 'var(--dsw-alias-state-error-primary, #e03131)', fontSize: 11 }}>
            {error}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function MemoryAction({ sessionId }: { sessionId: string }): ReactNode {
  const [open, setOpen] = useState(false)
  const [count, setCount] = useState<number | undefined>(undefined)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const response = await fetch(`/api/dsh-note/list?session=${encodeURIComponent(sessionId)}`, {
          credentials: 'same-origin',
        })
        if (!response.ok) return
        const payload = (await response.json()) as ListPayload
        if (live) setCount(payload.topics.length)
      } catch {
        // Leave the count unknown; the button still opens the browser.
      }
    })()
    return () => {
      live = false
    }
  }, [sessionId, open])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Project memory shared with pi"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          minHeight: 24,
          padding: '0 6px',
          border: '0.5px solid var(--dsw-alias-border-l1, #ddd)',
          borderRadius: 'var(--dsw-radius-sm, 6px)',
          background: 'transparent',
          color: 'var(--dsw-alias-label-secondary, #555)',
          cursor: 'pointer',
          fontSize: 11,
          lineHeight: '18px',
        }}
      >
        Memory{count === undefined ? '' : ` · ${count}`}
      </button>
      {open ? (
        <MemoryBrowser
          sessionId={sessionId}
          onClose={() => {
            setOpen(false)
            setCount(undefined)
          }}
        />
      ) : null}
    </>
  )
}

/** Register the memory button in the session header's action list. */
export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register(
      {
        name: 'conversation.session.header.actions',
        id: 'dsh-note',
        order: 20,
      },
      MemoryAction,
    ),
  )
}
