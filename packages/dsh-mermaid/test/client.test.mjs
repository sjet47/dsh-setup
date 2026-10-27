// Drive the dsh-mermaid browser half in jsdom: click the message action, let the
// panel fetch its drawings from a stubbed route, and check what the viewer shows.
// This is the closest thing to the live page available without a browser: it
// covers the click path, the request, the shadow-root insert, and the failure
// and unsupported branches.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'

const require = createRequire(import.meta.url)
const React = require('react')
const { createRoot } = require('react-dom/client')
const { act } = require('react')
// beautiful-mermaid is ESM-only (its `exports` has no `require` arm).
const { renderMermaidSVG } = await import('beautiful-mermaid')

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/* ── environment ──────────────────────────────────────────────────────────── */

let dom
const saved = {}

before(() => {
  dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { pretendToBeVisual: true })
  // Some globals are getter-only accessors in modern Node; define rather than assign.
  const exposed = ['window', 'document', 'navigator', 'HTMLElement', 'CustomEvent', 'Event', 'Node', 'getComputedStyle', 'MouseEvent', 'KeyboardEvent', 'WheelEvent']
  saved.fetch = globalThis.fetch
  for (const key of exposed) {
    saved[key] = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, {
      value: key === 'window' ? dom.window : dom.window[key],
      configurable: true,
      writable: true,
    })
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  // jsdom has no layout, so the panel's fit step must not divide by zero.
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { get: () => 800, configurable: true })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', { get: () => 600, configurable: true })
  dom.window.HTMLElement.prototype.setPointerCapture = () => {}
  dom.window.HTMLElement.prototype.releasePointerCapture = () => {}
  dom.window.HTMLElement.prototype.hasPointerCapture = () => false
})

after(() => {
  globalThis.fetch = saved.fetch
  for (const [key, descriptor] of Object.entries(saved)) {
    if (descriptor === undefined) delete globalThis[key]
    else Object.defineProperty(globalThis, key, descriptor)
  }
  dom.window.close()
})

/* ── harness ──────────────────────────────────────────────────────────────── */

/** Load the plugin bundle against a fake module table and run its `apply`. */
function loadPlugin(locale) {
  let loaded
  // The bundle receives `window` as a parameter. Hand it the real jsdom window
  // (its DOM methods brand-check `this`) and hang the module table on it.
  dom.window.__ModuleLoader__ = {
    load({ id, factory }) {
      const req = (spec) => {
        if (spec === 'react') return React
        if (spec === 'react/jsx-runtime') return require('react/jsx-runtime')
        throw new Error(`unexpected require: ${spec}`)
      }
      loaded = { id, exports: factory(req) }
    },
  }
  new Function('window', bundle)(dom.window)
  const registrations = []
  const ctx = {
    slots: {
      inject(_name, callback) {
        return callback()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
    locale,
    effect: (fn) => fn(),
    inject(_deps, callback) {
      callback(ctx)
      return { dispose: async () => {} }
    },
  }
  loaded.exports.apply(ctx)
  return {
    id: loaded.id,
    action: registrations.find((entry) => entry.options.name === 'conversation.chat.assistant-actions').component,
    panel: registrations.find((entry) => entry.options.name === 'shell.overlay').component,
  }
}

function makeLocale() {
  const dictionaries = new Map()
  return {
    getSnapshot: () => ({ active: 'en', locales: [{ id: 'en', label: 'English' }], revision: 0 }),
    subscribe: () => () => {},
    register(ns, locale, dict) {
      dictionaries.set(`${ns}:${locale}`, dict)
      return () => {}
    },
    bind(ns) {
      return (key, params) => {
        const template = dictionaries.get(`${ns}:en`)?.[key] ?? key
        return params === undefined ? template : template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
      }
    },
  }
}

/** Chat publication with one assistant answer carrying the given Markdown. */
function chatWith(text) {
  return {
    order: ['assistant-1'],
    nodes: {
      get: () => ({
        kind: 'assistant-step',
        data: {
          status: 'settled',
          turn: 1,
          step: 1,
          time: 0,
          blocks: [{ kind: 'text', text }],
          finalNode: { messageId: 'message-1' },
        },
      }),
    },
  }
}

/**
 * Stub the Host route the browser half calls.
 *
 * The bundle calls bare `fetch`, which inside `new Function` resolves against
 * the Node global rather than the jsdom window, so both are stubbed.
 */
function stubRoute(handler) {
  const stub = async (url, init) => {
    const body = JSON.parse(init.body)
    const results = await handler(body.sources)
    return { ok: true, status: 200, json: async () => ({ enabled: true, results }) }
  }
  dom.window.fetch = stub
  globalThis.fetch = stub
}

/** Draw every source the way the Host does, for the stub. */
async function drawLikeHost(sources) {
  return sources.map(({ source }) => {
    try {
      return { ok: true, family: 'flowchart', svg: renderMermaidSVG(source, { transparent: true }) }
    } catch (error) {
      return { ok: false, reason: 'invalid', message: String(error.message) }
    }
  })
}

/** Mount the action + panel, click the action, and return the live body. */
async function openViewer(plugin, text) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const chat = chatWith(text)
  const Action = plugin.action
  const Panel = plugin.panel
  await act(async () => {
    root.render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(Action, { messageId: 'message-1', useChat: (selector) => selector(chat) }),
        React.createElement(Panel, null),
      ),
    )
  })
  const button = container.querySelector('button')
  assert.ok(button !== null, 'the action button rendered')
  await act(async () => {
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  // Let the stubbed fetch settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return { container, unmount: () => act(() => root.unmount()) }
}

/* ── tests ────────────────────────────────────────────────────────────────── */

const MD = ['流程如下：', '', '```mermaid', 'graph TD', '  A[开始] --> B[结束]', '```'].join('\n')

test('the action shows the diagram count and opens the viewer', async () => {
  stubRoute(drawLikeHost)
  const plugin = loadPlugin(makeLocale())
  const { container, unmount } = await openViewer(plugin, MD)
  const dialog = container.querySelector('[role="dialog"]')
  assert.ok(dialog !== null, 'the viewer opened')
  assert.match(dialog.textContent, /Diagrams/)
  assert.match(dialog.textContent, /1 in this message/)
  unmount()
})

test('the viewer inserts the drawing inside a shadow root', async () => {
  stubRoute(drawLikeHost)
  const plugin = loadPlugin(makeLocale())
  const { container, unmount } = await openViewer(plugin, MD)
  const host = container.querySelector('[role="dialog"] div[style*="transform"]')
  assert.ok(host !== null, 'the drawing host exists')
  const shadow = host.shadowRoot
  assert.ok(shadow !== null, 'the drawing lives in a shadow root')
  assert.match(shadow.innerHTML, /<svg/)
  assert.match(shadow.innerHTML, /开始/)
  unmount()
})

test('an unsupported diagram reports why and shows its source', async () => {
  stubRoute(drawLikeHost)
  const plugin = loadPlugin(makeLocale())
  const { container, unmount } = await openViewer(plugin, '```mermaid\npie title Pets\n  "Dogs" : 386\n```')
  const dialog = container.querySelector('[role="dialog"]')
  assert.ok(dialog !== null)
  assert.match(dialog.textContent, /Could not draw this diagram/)
  assert.match(dialog.textContent, /pie title Pets/)
  unmount()
})

test('a failed render request is reported, not left blank', async () => {
  const failing = async () => ({ ok: false, status: 503, json: async () => ({}) })
  dom.window.fetch = failing
  globalThis.fetch = failing
  const plugin = loadPlugin(makeLocale())
  const { container, unmount } = await openViewer(plugin, MD)
  assert.match(container.textContent, /did not answer \(503\)/)
  unmount()
})

test('the source toggle swaps the drawing for its fence body', async () => {
  stubRoute(drawLikeHost)
  const plugin = loadPlugin(makeLocale())
  const { container, unmount } = await openViewer(plugin, MD)
  const toggle = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Source'))
  assert.ok(toggle !== undefined, 'the source toggle exists')
  await act(async () => {
    toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  const pre = container.querySelector('[role="dialog"] pre')
  assert.ok(pre !== null, 'the source view rendered')
  assert.match(pre.textContent, /graph TD/)
  assert.match(pre.textContent, /A\[开始\] --> B\[结束\]/)
  unmount()
})

test('Escape closes the viewer', async () => {
  stubRoute(drawLikeHost)
  const plugin = loadPlugin(makeLocale())
  const { container, unmount } = await openViewer(plugin, MD)
  assert.ok(container.querySelector('[role="dialog"]') !== null)
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  assert.equal(container.querySelector('[role="dialog"]'), null, 'the viewer closed')
  unmount()
})

test('a message without Mermaid renders no action at all', async () => {
  stubRoute(drawLikeHost)
  const plugin = loadPlugin(makeLocale())
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const Action = plugin.action
  const chat = chatWith('just prose, no diagrams')
  await act(async () => {
    root.render(React.createElement(Action, { messageId: 'message-1', useChat: (selector) => selector(chat) }))
  })
  assert.equal(container.querySelector('button'), null)
  await act(() => root.unmount())
})

/** A drawing wider than the stubbed 800x600 viewport, so fit must shrink it. */
const WIDE = [
  '```mermaid',
  'graph LR',
  ...Array.from({ length: 8 }, (_, i) => `  N${i}[节点 ${i}] --> N${i + 1}[节点 ${i + 1}]`),
  '```',
].join('\n')

test('opens at 100% instead of shrinking a large diagram', async () => {
  stubRoute(drawLikeHost)
  const plugin = loadPlugin(makeLocale())
  const { container, unmount } = await openViewer(plugin, WIDE)
  const zoomLabel = [...container.querySelectorAll('span')].map((node) => node.textContent).find((text) => text?.endsWith('%'))
  assert.equal(zoomLabel, '100%', 'a large diagram still opens at its natural size')
  unmount()
})

test('the fit control shrinks a diagram that does not fit', async () => {
  stubRoute(drawLikeHost)
  const plugin = loadPlugin(makeLocale())
  const { container, unmount } = await openViewer(plugin, WIDE)
  const fit = [...container.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === 'Fit')
  assert.ok(fit !== undefined, 'the fit control exists')
  await act(async () => {
    fit.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  const zoomLabel = [...container.querySelectorAll('span')].map((node) => node.textContent).find((text) => text?.endsWith('%'))
  assert.notEqual(zoomLabel, '100%', 'fit changed the scale')
  assert.ok(Number(zoomLabel?.replace('%', '')) < 100, `fit scaled down, got ${zoomLabel}`)
  unmount()
})

test('the drawing host spans the body so the diagram centres', async () => {
  stubRoute(drawLikeHost)
  const plugin = loadPlugin(makeLocale())
  const { container, unmount } = await openViewer(plugin, MD)
  const host = container.querySelector('[role="dialog"] div[style*="transform"]')
  assert.ok(host !== null, 'the drawing host exists')
  // A host sized to its content leaves the drawing pinned to the left edge:
  // `align-items: stretch` on the flex parent only covers the cross axis.
  assert.equal(host.style.width, '100%')
  assert.equal(host.style.height, '100%')
  unmount()
})
