/**
 * dsh-mermaid — render Mermaid diagrams written in Chat messages.
 *
 * The browser half keeps the code fence exactly as Chat rendered it and adds a
 * diagram action under each assistant message that contains Mermaid. This half
 * owns the actual drawing: `POST /api/dsh-mermaid/render` takes the fence
 * sources of one message and answers with finished SVG per source.
 *
 * Rendering belongs here because the renderer is ~1.5 MB, which a client
 * bundle would parse on every page load; the Host imports it lazily on the
 * first diagram request. The returned markup colours itself with theme CSS
 * variables, so the page's light/dark switch and font size apply to a diagram
 * already drawn.
 * @module dsh-mermaid
 */
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { renderDiagram, type RenderOutcome } from './render.js'

export const name = 'mermaid'
export const inject = ['connection'] as const

export interface Config {
  /** Keep the plugin loaded but stop answering render requests. */
  enabled: boolean
  /** Longest single diagram source accepted, in characters. */
  maxSourceChars: number
  /** Most diagrams answered in one request. */
  maxDiagrams: number
  /** Longest error text echoed to the browser. */
  maxMessageChars: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  maxSourceChars: z.number().default(20_000),
  maxDiagrams: z.number().default(24),
  maxMessageChars: z.number().default(240),
})

/** One source in a render request. */
interface RenderRequestItem {
  source?: unknown
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

/**
 * Answer render requests from the browser half.
 * @param ctx - plugin context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config = Config()): void {
  // Requests are cheap to retry and depend only on their body, so the route
  // stays a plain authenticated POST with no session state to resolve.
  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: '/api/dsh-mermaid/render',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request): Promise<Response> => {
        if (!config.enabled) return json({ enabled: false, results: [] })
        let payload: unknown
        try {
          payload = await request.json()
        } catch {
          return json({ error: 'invalid body' }, 400)
        }
        const items = (payload as { sources?: unknown } | null)?.sources
        if (!Array.isArray(items)) return json({ error: 'missing sources' }, 400)
        if (items.length > config.maxDiagrams) {
          return json({ error: `at most ${config.maxDiagrams} diagrams per request` }, 413)
        }
        const limits = { maxSourceChars: config.maxSourceChars, maxMessageChars: config.maxMessageChars }
        const results: RenderOutcome[] = []
        for (const item of items as RenderRequestItem[]) {
          const source = typeof item?.source === 'string' ? item.source : ''
          if (source.trim() === '') {
            results.push({
              ok: false,
              family: 'unsupported',
              reason: 'invalid',
              message: 'Empty diagram source.',
            })
            continue
          }
          results.push(await renderDiagram(source, limits))
        }
        return json({ enabled: true, results })
      },
    }),
  )

  ctx.logger.debug('dsh-mermaid loaded')
}

export { detectFamily } from './render.js'
export { parseMermaidFences } from './fences.js'
