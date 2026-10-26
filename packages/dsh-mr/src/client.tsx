/**
 * Browser half of dsh-mr: one compact chip in the session header showing the
 * current branch's request, CI state and title. Renders nothing when the branch
 * has no request, the plugin is disabled, or the lookup failed.
 *
 * The chip polls the authenticated status route at the Host's configured
 * freshness, pauses while the page is hidden, and re-reads immediately when it
 * becomes visible again.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
// Declaration merges: `ctx.slots`, `ctx.locale`, and the header-actions contract.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'

export const inject = ['slots', 'locale'] as const

const NS = 'dsh-mr'
/** Minimum poll interval, even when the Host freshness window is shorter. */
const MIN_POLL_MS = 15_000
/** Fallback poll interval when the payload carried none. */
const DEFAULT_POLL_MS = 60_000

/**
 * Copy registered into the Client locale service. The same text lives in
 * `locale/en.json` / `locale/zh.json` for the Plugins page, which reads the
 * exported JSON without activating this module.
 */
const EN: Record<string, string> = {
  'chip.open': 'Open the merge request in the browser',
  'chip.conflicts': 'conflicts with the target branch',
  'chip.ciSuccess': 'CI passed',
  'chip.ciFailed': 'CI failed',
  'chip.ciRunning': 'CI running',
  'chip.stateOpened': 'open',
  'chip.stateDraft': 'draft',
  'chip.stateMerged': 'merged',
  'chip.stateClosed': 'closed',
}
const ZH: Record<string, string> = {
  'chip.open': '在浏览器中打开合并请求',
  'chip.conflicts': '与目标分支存在冲突',
  'chip.ciSuccess': 'CI 通过',
  'chip.ciFailed': 'CI 失败',
  'chip.ciRunning': 'CI 运行中',
  'chip.stateOpened': '进行中',
  'chip.stateDraft': '草稿',
  'chip.stateMerged': '已合并',
  'chip.stateClosed': '已关闭',
}

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
  enabled?: boolean
  refreshMs?: number
  info: MrInfo | null
  branch: string | null
  error?: string
}

const STATE_ICON: Record<MrInfo['state'], string> = { opened: '⬤', draft: '◌', merged: '✔', closed: '✕' }
const STATE_COLOR: Record<MrInfo['state'], string> = {
  opened: 'var(--dsw-alias-state-success-primary, #2f9e44)',
  draft: 'var(--dsw-alias-label-tertiary, #888)',
  merged: 'var(--dsw-alias-brand-primary, #4d6bfe)',
  closed: 'var(--dsw-alias-state-error-primary, #e03131)',
}
const STATE_KEY: Record<MrInfo['state'], string> = {
  opened: 'chip.stateOpened',
  draft: 'chip.stateDraft',
  merged: 'chip.stateMerged',
  closed: 'chip.stateClosed',
}
const CI_TOKEN: Record<Exclude<MrInfo['ci'], 'none'>, string> = { success: '✓CI', failed: '✗CI', running: '⋯CI' }
const CI_KEY: Record<Exclude<MrInfo['ci'], 'none'>, string> = {
  success: 'chip.ciSuccess',
  failed: 'chip.ciFailed',
  running: 'chip.ciRunning',
}
const CI_COLOR: Record<Exclude<MrInfo['ci'], 'none'>, string> = {
  success: 'var(--dsw-alias-state-success-primary, #2f9e44)',
  failed: 'var(--dsw-alias-state-error-primary, #e03131)',
  running: 'var(--dsw-alias-label-tertiary, #888)',
}

/** Translate through the plugin's namespace and re-render on locale changes. */
function useT(locale: LocaleRuntime): Translate {
  useSyncExternalStore(
    useCallback((listener: () => void) => locale.subscribe(listener), [locale]),
    useCallback(() => locale.getSnapshot().revision, [locale]),
    () => 0,
  )
  return locale.bind(NS)
}

/** Only http(s) links reach an anchor; a CLI could return anything. */
function safeHref(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : undefined
  } catch {
    return undefined
  }
}

function createChip(locale: LocaleRuntime) {
  return function MrChip({ sessionId }: { sessionId: string }): ReactNode {
    const t = useT(locale)
    const [status, setStatus] = useState<MrStatus | undefined>(undefined)

    useEffect(() => {
      let live = true
      let timer: ReturnType<typeof setTimeout> | undefined
      let controller: AbortController | undefined

      const schedule = (delay: number): void => {
        if (!live) return
        if (timer !== undefined) clearTimeout(timer)
        timer = setTimeout(() => void load(), delay)
      }

      const load = async (): Promise<void> => {
        controller?.abort()
        controller = new AbortController()
        try {
          const response = await fetch(`/api/dsh-mr/status?session=${encodeURIComponent(sessionId)}`, {
            credentials: 'same-origin',
            signal: controller.signal,
          })
          if (response.ok) {
            const value = (await response.json()) as MrStatus
            if (!live) return
            setStatus(value)
            schedule(Math.max(MIN_POLL_MS, value.refreshMs ?? DEFAULT_POLL_MS))
            return
          }
        } catch {
          // Offline or a torn-down host: keep the previous chip and retry.
        }
        schedule(DEFAULT_POLL_MS)
      }

      const onVisibility = (): void => {
        if (document.visibilityState === 'visible') void load()
      }

      void load()
      document.addEventListener('visibilitychange', onVisibility)
      return () => {
        live = false
        controller?.abort()
        if (timer !== undefined) clearTimeout(timer)
        document.removeEventListener('visibilitychange', onVisibility)
      }
    }, [sessionId])

    if (status?.enabled === false) return null
    const info = status?.info
    if (info === undefined || info === null) return null

    const href = safeHref(info.url)
    const state = t(STATE_KEY[info.state])
    const ci = info.ci === 'none' ? '' : t(CI_KEY[info.ci])
    const conflicts = info.conflicts ? t('chip.conflicts') : ''
    const label = [info.ref, state, ci, conflicts, info.title].filter((part) => part !== '').join(' · ')
    const title = `${label}${href === undefined ? '' : `\n${href}`}`
    const style: CSSProperties = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      maxWidth: 'min(360px, 40vw)',
      minHeight: 24,
      padding: '0 6px',
      border: '0.5px solid var(--dsw-alias-border-l1, #ddd)',
      borderRadius: 'var(--dsw-radius-sm, 6px)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary, #555)',
      fontSize: 'var(--dsh-content-font-size-secondary, 12px)',
      lineHeight: '18px',
      textDecoration: 'none',
      overflow: 'hidden',
      whiteSpace: 'nowrap',
    }

    const body = (
      <>
        <span aria-hidden style={{ color: STATE_COLOR[info.state], flex: 'none' }}>
          {STATE_ICON[info.state]}
        </span>
        <span style={{ color: 'var(--dsw-alias-label-primary, #222)', flex: 'none', fontVariantNumeric: 'tabular-nums' }}>
          {info.ref}
        </span>
        {info.ci !== 'none' ? (
          <span aria-hidden style={{ color: CI_COLOR[info.ci], flex: 'none' }}>
            {CI_TOKEN[info.ci]}
          </span>
        ) : null}
        {info.conflicts ? (
          <span aria-hidden style={{ color: 'var(--dsw-alias-state-warn-primary, #f08c00)', flex: 'none' }}>
            ⚠
          </span>
        ) : null}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{info.title}</span>
      </>
    )

    return href === undefined ? (
      <span title={title} aria-label={label} style={style}>
        {body}
      </span>
    ) : (
      <a href={href} target="_blank" rel="noreferrer" title={title} aria-label={label} style={style}>
        {body}
      </a>
    )
  }
}

/** Register the chip in the session header's action list. */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const disposeEn = ctx.locale.register(NS, 'en', EN)
    const disposeZh = ctx.locale.register(NS, 'zh', ZH)
    return () => {
      disposeEn()
      disposeZh()
    }
  })

  const Chip = createChip(ctx.locale)
  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register(
      {
        name: 'conversation.session.header.actions',
        id: 'dsh-mr',
        order: 40,
        label: 'MR',
      },
      Chip,
    ),
  )
}
