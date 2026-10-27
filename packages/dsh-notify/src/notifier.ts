/**
 * The `org.freedesktop.Notifications` client: one method call, tagged the way
 * desktop notification daemons expect.
 * @module dsh-notify/notifier
 */
import type { DbusValue } from './marshal.js'
import { SessionBus } from './dbus.js'

/** One notification to display. */
export interface NotificationRequest {
  /** Application name shown as the notification's source. */
  readonly appName: string
  /** Replaces the daemon-side notification with this id; 0 posts a new one. */
  readonly replacesId?: number
  /** Application icon: an absolute path or an icon-theme name. */
  readonly appIcon?: string
  /** Bold first line, plain text. */
  readonly summary: string
  /** Body text, plain text; it is escaped for daemons that render markup. */
  readonly body?: string
  /** 0 low, 1 normal, 2 critical. */
  readonly urgency?: number
  /** Milliseconds the daemon keeps the notification; -1 uses the daemon default. */
  readonly expireTimeoutMs?: number
}

/** Method address shared by every notification. */
const NOTIFICATIONS = {
  destination: 'org.freedesktop.Notifications',
  path: '/org/freedesktop/Notifications',
  interfaceName: 'org.freedesktop.Notifications',
} as const

/**
 * Escape reply text for the `body-markup` case.
 *
 * Notification bodies may be rendered as markup (quickshell and most daemons
 * announce `body-markup` and use a rich-text label), where a reply containing
 * `<`, `>` or `&` — JSON, HTML, comparisons — would otherwise be swallowed as
 * a tag. The summary is left alone because it is always rendered as plain text.
 * @param text - plain reply text.
 * @returns text that renders literally under a markup-capable daemon.
 */
export function escapeMarkup(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** Posts desktop notifications over one bus connection. */
export class Notifier {
  constructor(private readonly bus: SessionBus) {}

  /** Whether a local session bus was found. */
  get available(): boolean {
    return this.bus.available
  }

  /**
   * Post or replace one notification.
   * @param request - content and presentation of the notification.
   * @returns the daemon-assigned id, reusable as a later `replacesId`.
   */
  async notify(request: NotificationRequest): Promise<number> {
    const hints: Array<readonly [string, DbusValue]> = [
      ['urgency', { type: 'byte', value: request.urgency ?? 1 }],
      ['category', { type: 'string', value: 'dsh.session' }],
    ]

    const reply = await this.bus.call({
      ...NOTIFICATIONS,
      member: 'Notify',
      body: [
        { type: 'string', value: request.appName },
        { type: 'uint32', value: request.replacesId ?? 0 },
        { type: 'string', value: request.appIcon ?? '' },
        { type: 'string', value: request.summary },
        { type: 'string', value: escapeMarkup(request.body ?? '') },
        { type: 'string-array', values: [] },
        { type: 'dict', entries: hints },
        { type: 'int32', value: request.expireTimeoutMs ?? -1 },
      ],
    })
    const id = reply[0]
    return typeof id === 'number' ? id : 0
  }

  /** Shut the client down; used when the plugin unloads. */
  close(): void {
    this.bus.close()
  }
}
