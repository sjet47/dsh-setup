// Plain-text rendering for the `/mr` command and the client chip's fallback.
// Colors are a client concern: the browser chip renders its own markup, so this
// module only produces structurally faithful text.
import type { CiState, MrInfo, MrState } from './forge.js'

export const STATE_ICON: Record<MrState, string> = {
  opened: '⬤',
  draft: '◌',
  merged: '✔',
  closed: '✕',
}

export const STATE_LABEL: Record<MrState, string> = {
  opened: 'open',
  draft: 'draft',
  merged: 'merged',
  closed: 'closed',
}

const CI_TOKEN: Record<Exclude<CiState, 'none'>, string> = {
  success: '✓CI',
  failed: '✗CI',
  running: '⋯CI',
}

/** One status line: `⬤ !1234 ✓CI 登录改造`. */
export function renderMrLine(info: MrInfo): string {
  const parts = [STATE_ICON[info.state], info.ref]
  if (info.ci !== 'none') parts.push(CI_TOKEN[info.ci])
  if (info.conflicts) parts.push('⚠conflict')
  if (info.title) parts.push(info.title)
  return parts.join(' ')
}

/** Multi-line detail for `/mr`, ending with the web URL. */
export function renderMrDetail(info: MrInfo): string {
  const lines = [
    `${info.ref} · ${STATE_LABEL[info.state]}${info.ci === 'none' ? '' : ` · ${info.ci}`}${info.conflicts ? ' · conflicts with target' : ''}`,
    info.title,
  ]
  if (info.url) lines.push(info.url)
  lines.push(`forge: ${info.forge}`)
  return lines.join('\n')
}
