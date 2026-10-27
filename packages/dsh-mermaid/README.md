# dsh-mermaid

Draw the Mermaid diagrams written in Chat messages, in a frame-wide viewer.

## What you get

1. An assistant message that contains a ` ```mermaid ` fence gets a **图表 · n** action under it (one per message, with the diagram count).
2. The action opens a viewer at 62% of the viewport (golden ratio) showing every diagram in that message: switch between them, zoom (buttons, wheel, drag to pan), toggle **源码 / 预览**, copy the source, or download the SVG.
3. A diagram opens at **100%** and is never scaled down automatically — a complex diagram stays legible. Press **fit** when you want the whole drawing in view, and **reset** to return to 100%.
4. The code fence in the message itself is left exactly as Chat rendered it — no syntax-highlighted block is replaced, so copy, wrap, and language labels keep working.

The viewer closes on `Esc`, on the close button, or on a click outside the card.

## Supported diagrams

| 1 | Grammar | Status |
|---|---------|--------|
| 1 | `graph` / `flowchart` | drawn |
| 2 | `stateDiagram` / `stateDiagram-v2` | drawn |
| 3 | `sequenceDiagram` | drawn |
| 4 | `classDiagram` | drawn |
| 5 | `erDiagram` | drawn |
| 6 | `xychart-beta` | drawn |
| 7 | `pie`, `gantt`, `mindmap`, `timeline`, `gitGraph`, `journey` | reported as unsupported, source shown |

Anything this renderer cannot draw is reported as such with its source, never drawn incorrectly.

## Why the Host draws

The renderer is [beautiful-mermaid](https://github.com/lukilabs/beautiful-mermaid) plus ELK: about 1.5 MB of JavaScript. A browser bundle would parse that on every page load, so the Host imports it lazily on the first diagram request and the browser half only inserts finished SVG.

Rendered SVG colours itself with theme CSS variables (`--dsw-alias-label-primary`, `--dsw-alias-bg-layer-1`, …), so a diagram already on screen follows light/dark switches and font-size changes without a new request. The renderer's stylesheet is isolated in a shadow root: its bare `svg`/`text` selectors never reach the application.

## Config

```yaml
- id: dsh-mermaid
  name: dsh-mermaid
  config:
    enabled: true          # false keeps the action hidden and answers no render requests
    maxSourceChars: 20000  # longest single diagram source
    maxDiagrams: 24        # most diagrams answered in one request
    maxMessageChars: 240   # longest error text echoed to the browser
```

## Tests

```bash
pnpm test                                   # everything
node --test packages/dsh-mermaid/test       # this package
```

1. `test/mermaid.test.mjs` drives the Host half: fence extraction, grammar classification, real rendering through beautiful-mermaid, the safety check, and the `/api/dsh-mermaid/render` route against a fake Cordis context.
2. `test/client.test.mjs` drives the browser half in jsdom: it clicks the message action, stubs the route, and checks the viewer's open state, the shadow-root insert, the unsupported and failed-request branches, the source toggle, and Escape.

## Notes

1. Only `text` blocks of an assistant message are scanned; a Mermaid fence inside reasoning or a tool call is not a diagram.
2. The Host route is `POST /api/dsh-mermaid/render`, authenticated like every other `/api/*` route.
3. The viewer's shadow-root isolation means the diagram does not inherit the page's font *metrics* used at layout time; the renderer estimates text width, so an unusually long label may sit slightly wide.
