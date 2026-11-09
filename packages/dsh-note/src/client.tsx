/**
 * Browser half of dsh-note: a header action that opens the project's memory
 * browser, and the browser itself rendered in the frame-wide overlay slot.
 *
 * The panel lives in `shell.overlay` (root scope) rather than a portal into
 * `document.body`: the frame owns the floating layer, its stacking order, and
 * the click-through behavior, so the panel cannot cover host dialogs or be
 * clipped by the composer. The `useSessions` standard prop identifies the
 * Session currently shown in the center column, so a panel left open closes
 * when the user switches Sessions.
 *
 * Reading and deleting go through authenticated `/api/dsh-note/*` routes;
 * deleting a memory removes the file and its MEMORY.md line in one Host step.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, MutableRefObject, ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'

export const inject = ['slots', 'locale'] as const

const NS = 'dsh-note'

/** Copy registered into the Client locale service (see `locale/*.json`). */
const EN: Record<string, string> = {
  'action.label': 'Memory',
  'action.title': 'Project memory shared with Claude Code and pi',
  'dialog.title': 'Memory',
  'dialog.subtitle': '{label} · {count} topics · shared with Claude Code and pi',
  'dialog.search': 'Search title, file, hook or description',
  'dialog.disabled': 'dsh-note is disabled in this profile.',
  'dialog.empty': 'No memories for this project yet.',
  'dialog.emptyHint': 'Ask the agent to remember something, and it appears here.',
  'dialog.noMatch': 'No memories match.',
  'dialog.select': 'Select a memory to read it.',
  'dialog.loading': 'Loading…',
  'dialog.close': 'Close',
  'dialog.refresh': 'Refresh',
  'dialog.copyPath': 'Copy path',
  'dialog.copied': 'Copied',
  'dialog.delete': 'Delete',
  'dialog.deleteConfirm': 'Delete “{title}”?',
  'dialog.deleteHint': 'Removes the file and its MEMORY.md line.',
  'dialog.cancel': 'Cancel',
  'dialog.missing': 'missing',
  'dialog.unindexed': '{file} (unindexed)',
  'dialog.openFailed': 'Cannot open {file}',
  'dialog.deleteFailed': 'Delete failed ({status})',
  'dialog.listFailed': 'Cannot load memories ({status})',
  'dialog.bodyFailed': 'Cannot read {file}',
  'dialog.ageMinutes': '{count}m',
  'dialog.ageHours': '{count}h',
  'dialog.ageDays': '{count}d',
  'dialog.ageMonths': '{count}mo',
  'dialog.modified': 'modified {date} ({age})',
  'dialog.noType': 'no type',
  'dialog.noFrontmatter': 'no frontmatter',
  'dialog.description': 'Recall description',
}
const ZH: Record<string, string> = {
  'action.label': '记忆',
  'action.title': '与 pi 共享的项目记忆',
  'dialog.title': '记忆',
  'dialog.subtitle': '{label} · {count} 条 · 与 pi 共享',
  'dialog.search': '搜索标题、文件、钩子或召回描述',
  'dialog.disabled': 'dsh-note 在当前 profile 中被禁用。',
  'dialog.empty': '这个项目还没有记忆。',
  'dialog.emptyHint': '让 agent 记住一件事，它就会出现在这里。',
  'dialog.noMatch': '没有匹配的记忆。',
  'dialog.select': '选择一条记忆来阅读。',
  'dialog.loading': '加载中…',
  'dialog.close': '关闭',
  'dialog.refresh': '刷新',
  'dialog.copyPath': '复制路径',
  'dialog.copied': '已复制',
  'dialog.delete': '删除',
  'dialog.deleteConfirm': '删除「{title}」？',
  'dialog.deleteHint': '会同时删除文件和 MEMORY.md 里的索引行。',
  'dialog.cancel': '取消',
  'dialog.missing': '文件缺失',
  'dialog.unindexed': '{file}（未索引）',
  'dialog.openFailed': '无法打开 {file}',
  'dialog.deleteFailed': '删除失败（{status}）',
  'dialog.listFailed': '无法加载记忆（{status}）',
  'dialog.bodyFailed': '无法读取 {file}',
  'dialog.ageMinutes': '{count} 分',
  'dialog.ageHours': '{count} 小时',
  'dialog.ageDays': '{count} 天',
  'dialog.ageMonths': '{count} 个月',
  'dialog.modified': '修改于 {date}（{age}）',
  'dialog.noType': '无类型',
  'dialog.noFrontmatter': '无 frontmatter',
  'dialog.description': '召回描述',
}

interface Topic {
  title: string
  file: string
  hook: string
  indexed: boolean
  exists: boolean
  size?: number
  mtimeMs?: number
  /** `metadata.type` — Claude Code's recall category. */
  type?: string
  /** Frontmatter `description` — the line Claude Code recall matches on. */
  description?: string
  /** `metadata.modified` when it parses, else the file mtime. */
  modifiedMs?: number
  /** False for a file with no frontmatter block, which recall cannot reach. */
  hasFrontmatter?: boolean
}

interface ListPayload {
  enabled?: boolean
  label: string
  memoryDir: string
  scratchDir?: string
  topics: Topic[]
}

interface BodyPayload {
  file: string
  text: string
  path: string
}

/* ── open-panel store ─────────────────────────────────────────────────────── */

interface NoteStoreState {
  /** Session whose browser is open, if any. */
  open: string | undefined
  /** Bumped after a mutation so the header count refetches. */
  revision: number
}

let noteState: NoteStoreState = { open: undefined, revision: 0 }
const noteListeners = new Set<() => void>()

function setNoteState(patch: Partial<NoteStoreState>): void {
  noteState = { ...noteState, ...patch }
  for (const listener of noteListeners) listener()
}

function subscribeNote(listener: () => void): () => void {
  noteListeners.add(listener)
  return () => noteListeners.delete(listener)
}

function useNoteStore(): NoteStoreState {
  return useSyncExternalStore(
    subscribeNote,
    () => noteState,
    () => noteState,
  )
}

/* ── locale ───────────────────────────────────────────────────────────────── */

/** Translate through the plugin's namespace and re-render on locale changes. */
function useT(locale: LocaleRuntime): Translate {
  useSyncExternalStore(
    useCallback((listener: () => void) => locale.subscribe(listener), [locale]),
    useCallback(() => locale.getSnapshot().revision, [locale]),
    () => 0,
  )
  return locale.bind(NS)
}

/* ── theme tokens ─────────────────────────────────────────────────────────── */

const SURFACE = 'var(--dsw-alias-bg-layer-2, #ffffff)'
const BORDER = 'var(--dsw-alias-border-l1, rgba(0,0,0,0.12))'
const TEXT = 'var(--dsw-alias-label-primary, #1f1f1f)'
const MUTED = 'var(--dsw-alias-label-tertiary, #6b6b6b)'
const SECONDARY = 'var(--dsw-alias-label-secondary, #555)'
/** Hover/selected fill. `--dsw-alias-fill-l1` is not a theme token, so use the
 *  host's own interactive fill instead of a silent 5% black fallback. */
const FILL = 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05))'
const ERROR = 'var(--dsw-alias-state-error-primary, #e03131)'
/** A memory Claude Code cannot recall (no frontmatter): a defect, not a hint. */
const WARN = 'var(--dsw-alias-state-warn-primary, #b26a00)'
/** The `metadata.type` cell; the host's brand ink, kept quieter than the title. */
const ACCENT = 'var(--dsw-alias-brand-primary, #4d6bfe)'
const FONT = 'var(--dsh-content-font-size, 14px)'
/** One step of the content font size, so the panel follows the theme setting. */
const scale = (factor: number): string => `calc(${FONT} * ${factor})`

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
  width: 'min(880px, calc(100vw - 48px))',
  height: 'min(640px, calc(100vh - 96px))',
  background: SURFACE,
  color: TEXT,
  border: `0.5px solid ${BORDER}`,
  borderRadius: 'var(--dsw-radius-panel, 12px)',
  boxShadow: 'var(--dsw-elevation-prominent, 0 12px 40px rgba(0,0,0,.28))',
  overflow: 'hidden',
  fontSize: FONT,
}
const buttonStyle: CSSProperties = {
  border: `0.5px solid ${BORDER}`,
  borderRadius: 'var(--dsw-radius-sm, 6px)',
  background: 'transparent',
  color: MUTED,
  cursor: 'pointer',
  font: 'inherit',
  fontSize: scale(0.9),
  padding: '2px 8px',
}
const quietButtonStyle: CSSProperties = {
  border: 0,
  borderRadius: 'var(--dsw-radius-xs, 4px)',
  background: 'transparent',
  color: MUTED,
  cursor: 'pointer',
  font: 'inherit',
  fontSize: scale(0.9),
  padding: '2px 6px',
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Absolute `YYYY-MM-DD HH:MM` in local time, for the detail metadata row. The
 *  list shows a relative age (glanceable); the detail view shows the date itself
 *  (quotable), with the relative age beside it for continuity. */
function formatTimestamp(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatAge(t: Translate, mtimeMs: number | undefined): string {
  if (mtimeMs === undefined) return ''
  const minutes = Math.max(0, Math.round((Date.now() - mtimeMs) / 60_000))
  if (minutes < 60) return t('dialog.ageMinutes', { count: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 48) return t('dialog.ageHours', { count: hours })
  const days = Math.round(hours / 24)
  if (days < 60) return t('dialog.ageDays', { count: days })
  return t('dialog.ageMonths', { count: Math.round(days / 30) })
}

async function readError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown }
    return typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`
  } catch {
    return `HTTP ${response.status}`
  }
}

function useNarrow(): boolean {
  return useSyncExternalStore(
    useCallback((listener: () => void) => {
      const query = window.matchMedia('(max-width: 640px)')
      query.addEventListener('change', listener)
      return () => query.removeEventListener('change', listener)
    }, []),
    useCallback(() => window.matchMedia('(max-width: 640px)').matches, []),
    () => false,
  )
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

/* ── the browser ──────────────────────────────────────────────────────────── */

function MemoryBrowser({ sessionId, t }: { sessionId: string; t: Translate }): ReactNode {
  const [list, setList] = useState<ListPayload | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Topic | undefined>(undefined)
  const [body, setBody] = useState<BodyPayload | undefined>(undefined)
  const [armed, setArmed] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [bodyError, setBodyError] = useState<string | undefined>(undefined)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const openSeq = useRef(0)
  const narrow = useNarrow()
  const close = useCallback(() => setNoteState({ open: undefined }), [])
  // Escape closes the confirm step first, then the panel.
  const requestClose = useCallback(() => {
    if (armed) {
      setArmed(false)
      return
    }
    close()
  }, [armed, close])
  useDialogBehavior(panelRef, requestClose)

  const reload = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`/api/dsh-note/list?session=${encodeURIComponent(sessionId)}`, {
        credentials: 'same-origin',
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(t('dialog.listFailed', { status: response.status }))
      }
      setList((await response.json()) as ListPayload)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [sessionId, t])

  useEffect(() => {
    void reload()
  }, [reload])

  // The confirm step replaces the header actions; focus must follow it so the
  // destructive button is never the default target of a stray Enter.
  useEffect(() => {
    if (armed) cancelRef.current?.focus()
  }, [armed])

  const openTopic = useCallback(
    async (topic: Topic): Promise<void> => {
      const seq = ++openSeq.current
      setSelected(topic)
      setBody(undefined)
      setArmed(false)
      setBodyError(undefined)
      setCopied(false)
      try {
        const response = await fetch(
          `/api/dsh-note/body?session=${encodeURIComponent(sessionId)}&file=${encodeURIComponent(topic.file)}`,
          { credentials: 'same-origin' },
        )
        if (!response.ok) throw new Error(await readError(response))
        const payload = (await response.json()) as BodyPayload
        // A slower earlier request must not overwrite a newer selection.
        if (seq === openSeq.current) setBody(payload)
      } catch (cause) {
        if (seq === openSeq.current) {
          setBodyError(cause instanceof Error ? cause.message : t('dialog.bodyFailed', { file: topic.file }))
        }
      }
    },
    [sessionId, t],
  )

  const remove = useCallback(async (): Promise<void> => {
    if (selected === undefined || deleting) return
    setDeleting(true)
    try {
      const response = await fetch(`/api/dsh-note/delete?session=${encodeURIComponent(sessionId)}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: selected.file }),
      })
      await response.body?.cancel()
      if (!response.ok) throw new Error(t('dialog.deleteFailed', { status: response.status }))
      setSelected(undefined)
      setBody(undefined)
      setArmed(false)
      setError(undefined)
      await reload()
      // The header count reads the same list; tell it to refetch.
      setNoteState({ revision: noteState.revision + 1 })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setDeleting(false)
    }
  }, [deleting, reload, selected, sessionId, t])

  const copyPath = useCallback(async (): Promise<void> => {
    const value = body?.path ?? selected?.file
    if (value === undefined) return
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access can be denied; the path stays selectable in the UI.
    }
  }, [body?.path, selected?.file])

  const topics = useMemo(() => {
    const all = list?.topics ?? []
    const needle = query.trim().toLowerCase()
    if (needle === '') return all
    // `description` is the line Claude Code recall matches on, so searching it
    // here finds the same memories in both tools.
    return all.filter((topic) =>
      `${topic.title} ${topic.file} ${topic.hook} ${topic.type ?? ''} ${topic.description ?? ''}`
        .toLowerCase()
        .includes(needle),
    )
  }, [list, query])

  // The type column costs 9ch of every row: show it only when the dir actually
  // has typed memories (a legacy, frontmatter-free dir would render it empty).
  const showTypes = (list?.topics ?? []).some((topic) => topic.type !== undefined)
  // `metadata.modified` falls back to the file mtime (done in the Host), so this
  // is the same "when did anyone last maintain this" answer for every file.
  const modifiedMs = selected?.modifiedMs ?? selected?.mtimeMs

  const focusRing = '0 0 0 2px var(--dsw-alias-brand-primary, #4d6bfe)'
  const listPaneStyle: CSSProperties = {
    width: narrow ? '100%' : 'clamp(220px, 32%, 320px)',
    flex: 'none',
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    maxHeight: narrow ? '45%' : undefined,
    borderRight: narrow ? undefined : `0.5px solid ${BORDER}`,
    borderBottom: narrow ? `0.5px solid ${BORDER}` : undefined,
  }

  return (
    <div
      style={overlayStyle}
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <div style={maskStyle} aria-hidden="true" onMouseDown={close} />
      <div ref={panelRef} style={panelStyle} role="dialog" aria-modal="true" aria-labelledby="dsh-note-title" tabIndex={-1}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 8,
            padding: '10px 14px',
            borderBottom: `0.5px solid ${BORDER}`,
          }}
        >
          <strong id="dsh-note-title" style={{ fontSize: scale(1.08) }}>
            {t('dialog.title')}
          </strong>
          <span style={{ color: MUTED, fontSize: scale(0.9), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {list === undefined
              ? ''
              : list.enabled === false
                ? t('action.title')
                : t('dialog.subtitle', { label: list.label, count: list.topics.length })}
          </span>
          <span style={{ flex: 1 }} />
          <button type="button" style={quietButtonStyle} onClick={() => void reload()} title={t('dialog.refresh')}>
            ↻
          </button>
          <button type="button" style={buttonStyle} onClick={close}>
            {t('dialog.close')}
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: narrow ? 'column' : 'row', minHeight: 0, flex: 1 }}>
          <div style={listPaneStyle}>
            <input
              data-autofocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && topics.length > 0) void openTopic(topics[0]!)
              }}
              placeholder={t('dialog.search')}
              aria-label={t('dialog.search')}
              style={{
                margin: 8,
                padding: '5px 8px',
                borderRadius: 'var(--dsw-radius-sm, 6px)',
                border: `0.5px solid ${BORDER}`,
                background: 'transparent',
                color: 'inherit',
                font: 'inherit',
                fontSize: scale(0.92),
                outline: 'none',
              }}
              onFocus={(event) => {
                event.currentTarget.style.boxShadow = focusRing
              }}
              onBlur={(event) => {
                event.currentTarget.style.boxShadow = 'none'
              }}
            />
            <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
              {topics.map((topic) => {
                const active = selected?.file === topic.file
                return (
                  <button
                    key={topic.file}
                    type="button"
                    onClick={() => void openTopic(topic)}
                    aria-current={active ? 'true' : undefined}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '6px 10px',
                      border: 0,
                      borderLeft: active
                        ? '2px solid var(--dsw-alias-label-primary, #222)'
                        : '2px solid transparent',
                      background: active ? FILL : 'transparent',
                      color: 'inherit',
                      cursor: 'pointer',
                      font: 'inherit',
                      fontSize: scale(1),
                    }}
                  >
                    <div style={{ display: 'flex', gap: 6 }}>
                      {showTypes ? (
                        <span
                          style={{
                            flex: 'none',
                            // Fixed cell so titles line up; widest type is `reference`.
                            width: '9ch',
                            color: MUTED,
                            fontSize: scale(0.78),
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {topic.type ?? ''}
                        </span>
                      ) : null}
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {topic.title}
                      </span>
                      <span style={{ color: MUTED, fontSize: scale(0.78), flex: 'none' }}>
                        {topic.exists ? `${formatBytes(topic.size)} · ${formatAge(t, topic.mtimeMs)}` : t('dialog.missing')}
                      </span>
                    </div>
                    <div
                      style={{
                        color: MUTED,
                        fontSize: scale(0.86),
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {topic.indexed ? topic.hook || topic.file : t('dialog.unindexed', { file: topic.file })}
                    </div>
                  </button>
                )
              })}
              {topics.length === 0 ? (
                <div style={{ padding: '12px 14px', color: MUTED, fontSize: scale(0.9), lineHeight: 1.6 }}>
                  {list?.enabled === false ? (
                    <div>{t('dialog.disabled')}</div>
                  ) : (
                    <>
                      <div>{(list?.topics ?? []).length === 0 ? t('dialog.empty') : t('dialog.noMatch')}</div>
                      {(list?.topics ?? []).length === 0 ? (
                        <div style={{ marginTop: 4, color: SECONDARY }}>{t('dialog.emptyHint')}</div>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}
            </div>
          </div>

          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            {selected === undefined ? (
              <div style={{ padding: 16, color: MUTED, fontSize: scale(0.92) }}>{t('dialog.select')}</div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px' }}>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {selected.title}
                  </span>
                  <button type="button" style={quietButtonStyle} onClick={() => void copyPath()} title={t('dialog.copyPath')}>
                    {copied ? t('dialog.copied') : t('dialog.copyPath')}
                  </button>
                  <button type="button" style={quietButtonStyle} onClick={() => setArmed(true)}>
                    {t('dialog.delete')}
                  </button>
                </div>
                <div
                  style={{
                    padding: '0 12px 4px',
                    color: MUTED,
                    fontSize: scale(0.84),
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={body?.path ?? selected.file}
                >
                  {body?.path ?? selected.file}
                </div>

                {/* Recall metadata: what Claude Code selects a memory by. The
                    type cell turns into `no frontmatter` in warning colour when
                    the block is missing, because such a file is unreachable by
                    recall — a defect worth seeing, not a blank. */}
                <div
                  style={{
                    display: 'flex',
                    gap: 6,
                    padding: '0 12px 4px',
                    fontSize: scale(0.84),
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {selected.type === undefined ? (
                    // A file with no block at all cannot be recalled (warning); a
                    // block without a `type` field is merely incomplete (dim).
                    // Say nothing until the file actually loaded: on a failed read
                    // the row would assert something we do not know.
                    body === undefined && bodyError === undefined ? (
                      <span style={{ flex: 'none' }} />
                    ) : selected.hasFrontmatter === false ? (
                      <span style={{ color: WARN, flex: 'none' }}>{t('dialog.noFrontmatter')}</span>
                    ) : (
                      <span style={{ color: MUTED, flex: 'none' }}>{t('dialog.noType')}</span>
                    )
                  ) : (
                    <span style={{ color: ACCENT, flex: 'none' }}>{selected.type}</span>
                  )}
                  {modifiedMs === undefined ? null : (
                    <>
                      <span style={{ color: MUTED, flex: 'none' }}>·</span>
                      <span style={{ color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {t('dialog.modified', { date: formatTimestamp(modifiedMs), age: formatAge(t, modifiedMs) })}
                      </span>
                    </>
                  )}
                </div>
                {selected.description === undefined || selected.description === '' ? null : (
                  <div
                    style={{
                      padding: '0 12px 6px',
                      color: SECONDARY,
                      fontSize: scale(0.84),
                      lineHeight: 1.5,
                      // Two rows, then an ellipsis: the description is context, not
                      // the reason the panel opened.
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}
                    title={selected.description}
                  >
                    {selected.description}
                  </div>
                )}

                {armed ? (
                  <div
                    role="group"
                    aria-label={t('dialog.deleteConfirm', { title: selected.title })}
                    style={{
                      margin: '4px 12px 8px',
                      padding: '8px 10px',
                      border: `0.5px solid ${BORDER}`,
                      borderRadius: 'var(--dsw-radius-sm, 6px)',
                      background: FILL,
                      fontSize: scale(0.9),
                    }}
                  >
                    <div style={{ marginBottom: 2 }}>{t('dialog.deleteConfirm', { title: selected.title })}</div>
                    <div style={{ color: MUTED, marginBottom: 8 }}>{t('dialog.deleteHint')}</div>
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                      <button
                        ref={cancelRef}
                        type="button"
                        style={buttonStyle}
                        onClick={() => setArmed(false)}
                        disabled={deleting}
                      >
                        {t('dialog.cancel')}
                      </button>
                      <button
                        type="button"
                        style={{ ...buttonStyle, color: ERROR }}
                        onClick={() => void remove()}
                        disabled={deleting}
                      >
                        {t('dialog.delete')}
                      </button>
                    </div>
                  </div>
                ) : null}

                <pre
                  style={{
                    flex: 1,
                    overflow: 'auto',
                    margin: '4px 12px 12px',
                    padding: 10,
                    borderRadius: 'var(--dsw-radius-md, 8px)',
                    background: FILL,
                    fontFamily: 'var(--dsh-font-family-text, inherit)',
                    fontSize: scale(0.92),
                    lineHeight: 1.6,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {bodyError ?? body?.text ?? t('dialog.loading')}
                </pre>
              </>
            )}
          </div>
        </div>

        {error !== undefined ? (
          <div style={{ padding: '6px 14px', color: ERROR, fontSize: scale(0.86), borderTop: `0.5px solid ${BORDER}` }}>
            {error}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/* ── header action ────────────────────────────────────────────────────────── */

function MemoryAction({ sessionId, locale }: { sessionId: string; locale: LocaleRuntime }): ReactNode {
  const t = useT(locale)
  const { open, revision } = useNoteStore()
  const [count, setCount] = useState<number | undefined>(undefined)
  const [enabled, setEnabled] = useState(true)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const response = await fetch(`/api/dsh-note/list?session=${encodeURIComponent(sessionId)}`, {
          credentials: 'same-origin',
        })
        if (!response.ok) {
          await response.body?.cancel()
          return
        }
        const payload = (await response.json()) as ListPayload
        if (!live) return
        setEnabled(payload.enabled !== false)
        setCount(payload.topics.length)
      } catch {
        // Leave the count unknown; the button still opens the browser.
      }
    })()
    return () => {
      live = false
    }
  }, [sessionId, revision])

  if (!enabled) return null
  const isOpen = open === sessionId
  return (
    <button
      type="button"
      onClick={() => setNoteState({ open: sessionId })}
      title={t('action.title')}
      aria-label={t('action.title')}
      aria-haspopup="dialog"
      aria-expanded={isOpen}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        minHeight: 24,
        padding: '0 6px',
        border: `0.5px solid ${BORDER}`,
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        background: isOpen ? FILL : 'transparent',
        color: MUTED,
        cursor: 'pointer',
        font: 'inherit',
        fontSize: 'var(--dsh-content-font-size-secondary, 12px)',
        lineHeight: '18px',
      }}
    >
      {t('action.label')}
      {count === undefined ? '' : ` · ${count}`}
    </button>
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

function MemoryOverlay({ useSessions, locale }: { useSessions: UseSessionsLike; locale: LocaleRuntime }): ReactNode {
  const t = useT(locale)
  const { open } = useNoteStore()
  const current = useSessions((state) => {
    for (const session of Object.values(state.byId)) {
      if ((session.retainedBy?.mainView ?? 0) > 0) return (session as SessionSummaryLike & { id: string }).id
    }
    return undefined
  })

  // Switching Sessions closes the panel: its memory belongs to the old cwd.
  useEffect(() => {
    if (open !== undefined && open !== current) setNoteState({ open: undefined })
  }, [current, open])

  if (open === undefined || open !== current) return null
  return <MemoryBrowser key={open} sessionId={open} t={t} />
}

/* ── registration ─────────────────────────────────────────────────────────── */

/** Action target for the client-side `/memory` decoration. */
function runMemoryCommand(session: { sessionId: string }): void {
  setNoteState({ open: String(session.sessionId) })
}

/** Register the header button, the overlay panel, and the `/memory` action. */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const disposeEn = ctx.locale.register(NS, 'en', EN)
    const disposeZh = ctx.locale.register(NS, 'zh', ZH)
    return () => {
      disposeEn()
      disposeZh()
    }
  })

  ctx.slots.inject('conversation.session.header.actions', () => {
    const Action = (props: { sessionId: string }) => <MemoryAction sessionId={props.sessionId} locale={ctx.locale} />
    return ctx.slots.register(
      {
        name: 'conversation.session.header.actions',
        id: 'dsh-note',
        order: 25,
        label: 'Memory',
      },
      Action,
    )
  })

  ctx.slots.inject('shell.overlay', () => {
    const Overlay = (props: { useSessions: UseSessionsLike }) => (
      <MemoryOverlay useSessions={props.useSessions} locale={ctx.locale} />
    )
    return ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'dsh-note-panel',
        order: 20,
        label: 'Memory',
      },
      Overlay,
    )
  })

  // Wait for the command surface: a composition without it keeps the button
  // and the panel, just no `/memory` decoration.
  ctx.inject(['commandUi'], (scoped) => {
    scoped.effect(() =>
      scoped.commandUi.decorate({
        name: 'memory',
        available: () => true,
        ui: { kind: 'action', run: runMemoryCommand },
      }),
    )
  })
}
