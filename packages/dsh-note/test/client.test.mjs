// Drive the dsh-note browser half in jsdom: open the panel, answer its two Host
// routes with crafted payloads, and check what the list and the detail view
// show. This is the closest thing to the live page available without a browser,
// and it is where the recall metadata (type / modified / description) is
// actually rendered, so it cannot be covered from the Host side alone.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'

const require = createRequire(import.meta.url)
const React = require('react')
const { createRoot } = require('react-dom/client')
const { act } = require('react')

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/* ── environment ──────────────────────────────────────────────────────────── */

let dom
const saved = {}

before(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
  const exposed = ['window', 'document', 'navigator', 'HTMLElement', 'CustomEvent', 'Event', 'Node', 'getComputedStyle', 'MouseEvent', 'KeyboardEvent']
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
  // The panel picks its layout through matchMedia; jsdom ships none.
  dom.window.matchMedia = (query) =>
    /** @type {any} */ ({
      media: query,
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    })
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
        return params === undefined
          ? template
          : template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
      }
    },
  }
}

/**
 * Load the plugin bundle against a fake module table and run `apply`.
 * @returns the registered panel component and the `/memory` decoration.
 */
function loadPlugin(locale) {
  let loaded
  dom.window.__ModuleLoader__ = {
    load({ factory }) {
      const req = (spec) => {
        if (spec === 'react') return React
        if (spec === 'react/jsx-runtime') return require('react/jsx-runtime')
        if (spec === 'react-dom') return require('react-dom')
        throw new Error(`unexpected require: ${spec}`)
      }
      loaded = { exports: factory(req) }
    },
  }
  new Function('window', bundle)(dom.window)
  const registrations = []
  const decorations = []
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
    commandUi: {
      decorate(decoration) {
        decorations.push(decoration)
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
    panel: registrations.find((entry) => entry.options.name === 'shell.overlay').component,
    action: registrations.find((entry) => entry.options.name === 'conversation.session.header.actions').component,
    decoration: decorations[0],
  }
}

/** Answer the two Host routes the panel calls; both `fetch` bindings are stubbed. */
function stubRoutes(list, body) {
  const stub = async (url) => {
    const target = String(url)
    const payload = target.includes('/api/dsh-note/body') ? body : list
    return { ok: true, status: 200, json: async () => payload }
  }
  dom.window.fetch = stub
  globalThis.fetch = stub
}

const panelProps = {
  sessionId: 'session-test',
  useSessions: (selector) =>
    selector({ byId: { 'session-test': { id: 'session-test', retainedBy: { mainView: 1 } } } }),
  useSessionStatus: (selector) => selector({ get: () => ({ running: false }) }),
}

/** Mount the panel, open it through the `/memory` decoration, and settle its fetches. */
async function openPanel(plugin) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(React.Fragment, null, React.createElement(plugin.panel, panelProps)))
  })
  await act(async () => {
    plugin.decoration.ui.run({ sessionId: 'session-test' })
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  const dialog = container.querySelector('[role="dialog"]')
  assert.ok(dialog !== null, 'the panel opened')
  return {
    container,
    dialog,
    unmount: () => act(() => root.unmount()),
  }
}

/** Every list row, in order, as the text a reader sees. */
function rows(dialog) {
  return [...dialog.querySelectorAll('button')]
    .filter((button) => button.getAttribute('aria-current') !== null || button.textContent !== 'Close')
    .map((button) => button.textContent ?? '')
}

const LIST = {
  enabled: true,
  label: '~/repo/pi-setup',
  memoryDir: '/home/sjet/.claude/projects/-home-sjet-repo-pi-setup/memory',
  topics: [
    {
      title: '插件管理分工',
      file: 'plugin-management-boundary.md',
      hook: 'pi-setup 只收编小插件源码',
      indexed: true,
      exists: true,
      size: 973,
      mtimeMs: Date.parse('2026-11-09T04:28:57Z'),
      type: 'project',
      description: 'pi-setup 只收编小插件源码，不接管独立社区插件的安装与更新管理',
      modifiedMs: Date.parse('2026-11-09T04:28:57Z'),
      hasFrontmatter: true,
    },
    {
      title: '跨 harness 迁移记忆',
      file: 'memory-cross-harness-migration.md',
      hook: '每项目一个 claude -p 让它自己摘录',
      indexed: true,
      exists: true,
      size: 2400,
      mtimeMs: Date.parse('2026-11-09T05:00:00Z'),
      type: 'feedback',
      description: '把一套 harness 的记忆迁到另一套时，用每项目一个会话让它自己摘录',
      modifiedMs: Date.parse('2026-11-09T05:00:00Z'),
      hasFrontmatter: true,
    },
    {
      title: 'legacy note',
      file: 'legacy.md',
      hook: '老目录里没有 frontmatter 的一条',
      indexed: true,
      exists: true,
      size: 500,
      mtimeMs: Date.parse('2026-10-27T09:00:00Z'),
      modifiedMs: Date.parse('2026-10-27T09:00:00Z'),
      hasFrontmatter: false,
    },
  ],
}

const BODY = (file) => ({
  file,
  text: '正文第一行\n',
  path: `/home/sjet/.claude/projects/-home-sjet-repo-pi-setup/memory/${file}`,
})

/* ── tests ────────────────────────────────────────────────────────────────── */

test('the list shows the metadata.type cell in front of each title', async () => {
  stubRoutes(LIST, BODY('plugin-management-boundary.md'))
  const { dialog, unmount } = await openPanel(loadPlugin(makeLocale()))
  const text = dialog.textContent ?? ''
  assert.match(text, /project/)
  assert.match(text, /feedback/)
  assert.match(text, /插件管理分工/)
  // The tag precedes the title in the row, so the reader scans type first.
  const row = rows(dialog).find((rowText) => rowText.includes('插件管理分工'))
  assert.ok(row !== undefined)
  assert.ok(row.indexOf('project') < row.indexOf('插件管理分工'), row)
  unmount()
})

test('opening a memory shows type, the modified date and the description', async () => {
  stubRoutes(LIST, BODY('plugin-management-boundary.md'))
  const { dialog, unmount } = await openPanel(loadPlugin(makeLocale()))
  const row = [...dialog.querySelectorAll('button')].find((button) => button.textContent?.includes('插件管理分工'))
  assert.ok(row !== undefined)
  await act(async () => {
    row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  const text = dialog.textContent ?? ''
  assert.match(text, /project/)
  assert.match(text, /modified 2026-11-09/)
  assert.match(text, /只收编小插件源码，不接管独立社区插件的安装与更新管理/)
  // The frontmatter block itself is stripped Host-side and never rendered.
  assert.doesNotMatch(text, /name: /)
  unmount()
})

test('a memory with no frontmatter says so, because recall cannot reach it', async () => {
  stubRoutes(LIST, BODY('legacy.md'))
  const { dialog, unmount } = await openPanel(loadPlugin(makeLocale()))
  const row = [...dialog.querySelectorAll('button')].find((button) => button.textContent?.includes('legacy note'))
  assert.ok(row !== undefined)
  await act(async () => {
    row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  // `hasFrontmatter: false` is a defect, not a blank cell: Claude Code cannot
  // recall this file, so the detail view names it.
  assert.match(dialog.textContent ?? '', /no frontmatter/)
  unmount()
})

test('search also matches the recall description', async () => {
  stubRoutes(LIST, BODY('plugin-management-boundary.md'))
  const { dialog, unmount } = await openPanel(loadPlugin(makeLocale()))
  const input = dialog.querySelector('input')
  assert.ok(input !== null)
  // "harness" appears only in the description, never in a title, file or hook.
  // Controlled input: write through the prototype setter so React's value
  // tracker notices, then let `Simulate` fire the change the way a keystroke
  // would (`onChange` is the tracker-backed plugin, not a plain listener).
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, 'harness')
  })
  await act(async () => {
    require('react-dom/test-utils').Simulate.change(input)
  })
  const text = dialog.textContent ?? ''
  assert.match(text, /跨 harness 迁移记忆/)
  assert.doesNotMatch(text, /插件管理分工/)
  unmount()
})
