import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, Config } from '../lib/index.js'
import { parseMermaidFences, assistantText } from '../lib/fences.js'
import { detectFamily, renderDiagram } from '../lib/render.js'
import { makeContext, jsonOf } from '../../../test/fake-ctx.mjs'

const LIMITS = { maxSourceChars: 20_000, maxMessageChars: 240 }

/* ── fence extraction ─────────────────────────────────────────────────────── */

test('finds every Mermaid fence in document order', () => {
  const text = [
    'Here are two diagrams.',
    '',
    '```mermaid',
    'graph TD',
    '  A --> B',
    '```',
    '',
    'And a sequence one:',
    '',
    '~~~Mermaid',
    'sequenceDiagram',
    '  A->>B: hi',
    '~~~',
    '',
    '```ts',
    'const x = 1',
    '```',
  ].join('\n')
  const fences = parseMermaidFences(text)
  assert.equal(fences.length, 2)
  assert.deepEqual(fences.map((fence) => fence.source), [
    'graph TD\n  A --> B',
    'sequenceDiagram\n  A->>B: hi',
  ])
  assert.deepEqual(fences.map((fence) => fence.line), [3, 10])
})

test('ignores fenced code that is not Mermaid', () => {
  const text = ['```js', 'const a = 1', '```', '```python', 'x = 1', '```'].join('\n')
  assert.deepEqual(parseMermaidFences(text), [])
})

test('keeps an unterminated fence so a streaming answer still draws', () => {
  const fences = parseMermaidFences('```mermaid\ngraph TD\n  A --> B')
  assert.equal(fences.length, 1)
  assert.equal(fences[0].source, 'graph TD\n  A --> B')
})

test('drops an empty unterminated fence', () => {
  assert.deepEqual(parseMermaidFences('```mermaid'), [])
})

test('a fence inside another fence closes as soon as its own marker ends it', () => {
  // GFM closes a three-backtick fence at the next three-backtick line; the
  // inner `mermaid` line is body text, not a second diagram.
  const text = ['````md', '```mermaid', 'graph TD', '```', '````'].join('\n')
  assert.deepEqual(parseMermaidFences(text), [])
})

test('honours the diagram budget', () => {
  const one = '```mermaid\ngraph TD\n A --> B\n```'
  const text = [one, one, one].join('\n\n')
  assert.equal(parseMermaidFences(text, { maxDiagrams: 2 }).length, 2)
})

test('trims blank edges without touching interior blank lines', () => {
  const fences = parseMermaidFences('```mermaid\n\ngraph TD\n\n  A --> B\n\n```')
  assert.equal(fences[0].source, 'graph TD\n\n  A --> B')
})

test('strips a consistent indentation inside a quoted fence', () => {
  const fences = parseMermaidFences('  ```mermaid\n  graph TD\n    A --> B\n  ```')
  assert.equal(fences[0].source, 'graph TD\n  A --> B')
})

test('assistantText keeps answer text and skips reasoning and tool calls', () => {
  const text = assistantText([
    { kind: 'reasoning', text: 'thinking' },
    { kind: 'text', text: 'first' },
    { kind: 'tool-call', name: 'bash' },
    { kind: 'text', text: 'second' },
  ])
  assert.equal(text, 'first\n\nsecond')
})

/* ── family detection ─────────────────────────────────────────────────────── */

test('classifies the grammars this renderer draws', () => {
  const cases = [
    ['graph TD\n A --> B', 'flowchart'],
    ['flowchart LR\n A --> B', 'flowchart'],
    ['sequenceDiagram\n A->>B: hi', 'sequence'],
    ['classDiagram\n class A', 'class'],
    ['erDiagram\n A ||--o{ B : has', 'er'],
    ['stateDiagram-v2\n [*] --> A', 'state'],
    ['xychart-beta\n x-axis [a]', 'xychart'],
    ['%% a comment\nsequenceDiagram\n A->>B: hi', 'sequence'],
  ]
  for (const [source, family] of cases) assert.equal(detectFamily(source), family, source)
})

test('reports grammars this renderer lacks', () => {
  for (const source of ['pie title Pets', 'gantt\n title A', 'mindmap\n root((r))', 'timeline\n 2024 : x', 'gitGraph\n commit', 'nonsense']) {
    assert.equal(detectFamily(source), 'unsupported', source)
  }
})

/* ── rendering ────────────────────────────────────────────────────────────── */

test('draws a flowchart to SVG', async () => {
  const outcome = await renderDiagram('graph TD\n  A[开始] --> B{判定}', LIMITS)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.family, 'flowchart')
  assert.match(outcome.svg, /^<svg/)
  assert.match(outcome.svg, /var\(--dsw-alias-label-primary\)/)
  assert.match(outcome.svg, /开始/)
})

test('drops the renderer Google Fonts import and keeps the page font', async () => {
  const outcome = await renderDiagram('graph TD\n A --> B', LIMITS)
  assert.equal(outcome.ok, true)
  assert.doesNotMatch(outcome.svg, /fonts\.googleapis\.com/)
  assert.match(outcome.svg, /font-family: system-ui/)
})

test('refuses diagram types it cannot draw instead of misrendering them', async () => {
  const outcome = await renderDiagram('pie title Pets\n  "Dogs" : 386', LIMITS)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'unsupported')
})

test('reports a syntax error without throwing', async () => {
  const outcome = await renderDiagram('sequenceDiagram\n  A->>:', LIMITS)
  if (outcome.ok) assert.match(outcome.svg, /^<svg/)
  else assert.ok(['invalid', 'unsupported'].includes(outcome.reason))
})

test('bounds the source and the echoed error text', async () => {
  const small = await renderDiagram('graph TD\n A --> B', { maxSourceChars: 5, maxMessageChars: 240 })
  assert.equal(small.ok, false)
  assert.equal(small.reason, 'too-large')

  const long = await renderDiagram('graph TD\n  A -->', { maxSourceChars: 20_000, maxMessageChars: 10 })
  if (!long.ok) assert.ok(long.message.length <= 11)
})

/* ── route ────────────────────────────────────────────────────────────────── */

function harness() {
  const context = makeContext({ id: 'session-mermaid', header: { cwd: '/tmp' }, seq: 0 })
  apply(context.ctx, Config())
  return context
}

test('answers one render request for every source', async () => {
  const context = harness()
  const route = context.routes.get('/api/dsh-mermaid/render')
  assert.ok(route !== undefined)
  const response = await route.fetch(
    new Request('http://x/api/dsh-mermaid/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sources: [{ source: 'graph TD\n A --> B' }, { source: 'pie title P' }] }),
    }),
  )
  const body = await jsonOf(response)
  assert.equal(body.enabled, true)
  assert.equal(body.results.length, 2)
  assert.equal(body.results[0].ok, true)
  assert.equal(body.results[1].ok, false)
})

test('rejects a body without sources', async () => {
  const context = harness()
  const route = context.routes.get('/api/dsh-mermaid/render')
  const response = await route.fetch(
    new Request('http://x/api/dsh-mermaid/render', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  )
  assert.equal(response.status, 400)
})

test('rejects more sources than the configured budget', async () => {
  const context = makeContext({ id: 'session-mermaid', header: { cwd: '/tmp' }, seq: 0 })
  apply(context.ctx, Config({ maxDiagrams: 1 }))
  const route = context.routes.get('/api/dsh-mermaid/render')
  const response = await route.fetch(
    new Request('http://x/api/dsh-mermaid/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sources: [{ source: 'graph TD\n A --> B' }, { source: 'graph TD\n C --> D' }] }),
    }),
  )
  assert.equal(response.status, 413)
})

test('a disabled plugin answers without drawing', async () => {
  const context = makeContext({ id: 'session-mermaid', header: { cwd: '/tmp' }, seq: 0 })
  apply(context.ctx, Config({ enabled: false }))
  const route = context.routes.get('/api/dsh-mermaid/render')
  const response = await route.fetch(
    new Request('http://x/api/dsh-mermaid/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sources: [{ source: 'graph TD\n A --> B' }] }),
    }),
  )
  const body = await jsonOf(response)
  assert.equal(body.enabled, false)
  assert.deepEqual(body.results, [])
})

test('label text that merely mentions an event handler is still drawn', async () => {
  // Escape order matters: ` onerror=` inside a label is escaped text, not an
  // attribute, so the safety check must not reject the drawing.
  const outcome = await renderDiagram('graph TD\n  A["try onerror=alert(1) in a label"] --> B', LIMITS)
  assert.equal(outcome.ok, true)
  assert.match(outcome.svg, /onerror=alert\(1\)/)
})

test('the drawing carries no background plate of its own', async () => {
  const outcome = await renderDiagram('graph TD\n A --> B', LIMITS)
  assert.equal(outcome.ok, true)
  assert.doesNotMatch(outcome.svg, /<rect[^>]*width="100%"/)
})
