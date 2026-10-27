import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { detectFocusCommand } from '../lib/index.js'

/**
 * Load the browser bundle exactly as the page's module loader does.
 *
 * The wrapper takes `window` as a real parameter, so the loader object is also
 * the `window` the bundle's own code sees — one double has to serve both.
 * @param pageWindow - listener-capable window double to load into.
 */
function loadClient(pageWindow) {
  let loaded
  pageWindow.__ModuleLoader__ = {
    load({ id, factory }) {
      const module = { exports: {} }
      loaded = { id, exports: factory(() => { throw new Error('unexpected require') }) }
    },
  }
  new Function('window', readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))(pageWindow)
  assert.ok(loaded, 'the loader never ran')
  assert.equal(loaded.id, 'dsh-notify')
  return loaded.exports
}

/** Minimal document/window doubles for the wake listeners. */
/**
 * A Client context double that enforces the rule the real one does: reading a
 * service that was not injected throws, and `get()` is the optional accessor.
 *
 * The earlier double exposed `sessions` as a plain property, which is why the
 * undeclared access that crashed the Desktop went unnoticed.
 * @param injected - the context's own fields, e.g. `uiWorkspace`.
 * @param services - services reachable through `get()` only.
 */
function clientCtx(injected, services = {}) {
  const ctx = { ...injected }
  Object.defineProperty(ctx, 'get', {
    value: (name) => services[name],
    enumerable: false,
  })
  // Undeclared service reads throw, exactly like Cordis.
  for (const name of Object.keys(services)) {
    if (name in injected) continue
    Object.defineProperty(ctx, name, {
      get() {
        throw new Error(`cannot get property "${name}" without inject`)
      },
      enumerable: false,
    })
  }
  return ctx
}

/** A catalog that either already lists the session or gains it later. */
function catalog(ids) {
  const byId = Object.fromEntries(ids.map((id) => [id, { id }]))
  return { list: { getSnapshot: () => ({ byId }) } }
}

/** Let a session appear in the catalog only after `delay` ms. */
function catalogAfter(sessionId, delay) {
  const byId = {}
  setTimeout(() => { byId[sessionId] = { id: sessionId } }, delay)
  return { list: { getSnapshot: () => ({ byId }) } }
}

function installDomDoubles() {
  const listeners = new Map()
  const record = (target) => ({
    addEventListener(type, handler) {
      const key = `${target}:${type}`
      listeners.set(key, [...(listeners.get(key) ?? []), handler])
    },
    removeEventListener(type, handler) {
      const key = `${target}:${type}`
      listeners.set(key, (listeners.get(key) ?? []).filter((entry) => entry !== handler))
    },
  })
  const previous = { document: globalThis.document, window: globalThis.window }
  // Plain assignment is not enough: some Node builds expose read-only globals,
  // and the bundle reads these through the global scope, not our loader frame.
  const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  const pageWindow = { ...record('window') }
  define('document', { visibilityState: 'visible', ...record('document') })
  define('window', pageWindow)
  return {
    listeners,
    pageWindow,
    restore() {
      define('document', previous.document)
      define('window', previous.window)
    },
  }
}

test('a claimed session is revealed through uiWorkspace.openSession', async () => {
  const dom = installDomDoubles()
  const previousFetch = globalThis.fetch
  const claims = []
  globalThis.fetch = async (path, init) => {
    claims.push({ path, method: init.method })
    return { ok: true, json: async () => ({ sessionId: 'session-abc' }) }
  }
  const opened = []
  const effects = []
  try {
    const client = loadClient(dom.pageWindow)
    assert.deepEqual(client.inject, ['uiWorkspace'])
    client.apply(clientCtx(
      { uiWorkspace: { openSession: (id) => opened.push(id) }, effect: (run) => effects.push(run()) },
      { sessions: catalog(['session-abc']) },
    ))
    // The first poll runs immediately; give the promise chain one turn.
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(claims[0], { path: '/api/dsh-notify/claim', method: 'POST' })
    assert.deepEqual(opened, ['session-abc'])
  } finally {
    for (const dispose of effects) dispose()
    globalThis.fetch = previousFetch
    dom.restore()
  }
})

test('an idle claim does not switch sessions', async () => {
  const dom = installDomDoubles()
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ sessionId: null }) })
  const opened = []
  const effects = []
  try {
    const client = loadClient(dom.pageWindow)
    client.apply(clientCtx(
      { uiWorkspace: { openSession: (id) => opened.push(id) }, effect: (run) => effects.push(run()) },
      { sessions: catalog([]) },
    ))
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(opened, [])
  } finally {
    for (const dispose of effects) dispose()
    globalThis.fetch = previousFetch
    dom.restore()
  }
})

test('a transport failure keeps the poller alive instead of throwing', async () => {
  const dom = installDomDoubles()
  const previousFetch = globalThis.fetch
  let attempts = 0
  globalThis.fetch = async () => {
    attempts += 1
    if (attempts === 1) throw new Error('host restarting')
    return { ok: true, json: async () => ({ sessionId: 'session-late' }) }
  }
  const opened = []
  const effects = []
  try {
    const client = loadClient(dom.pageWindow)
    client.apply(clientCtx(
      { uiWorkspace: { openSession: (id) => opened.push(id) }, effect: (run) => effects.push(run()) },
      { sessions: catalog([]) },
    ))
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(opened, [])
    assert.equal(attempts, 1)
  } finally {
    for (const dispose of effects) dispose()
    globalThis.fetch = previousFetch
    dom.restore()
  }
})

test('disposing the plugin stops polling and drops the listeners', async () => {
  const dom = installDomDoubles()
  const previousFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return { ok: true, json: async () => ({ sessionId: null }) }
  }
  const effects = []
  const client = loadClient(dom.pageWindow)
  client.apply(clientCtx(
    { uiWorkspace: { openSession: () => {} }, effect: (run) => effects.push(run()) },
    { sessions: catalog([]) },
  ))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(calls, 1)
  for (const dispose of effects) dispose()
  const before = calls
  dom.listeners.clear()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(calls, before, 'no poll may run after disposal')
  assert.equal((dom.listeners.get('document:visibilitychange') ?? []).length, 0)
  assert.equal((dom.listeners.get('window:focus') ?? []).length, 0)
  globalThis.fetch = previousFetch
  dom.restore()
})

test('the focus command follows the compositor that can raise a window', () => {
  const hyprland = detectFocusCommand({ HYPRLAND_INSTANCE_SIGNATURE: 'abc' })
  assert.match(hyprland, /hyprctl dispatch focuswindow class:deepseek-harness/)
  // Both dispatch dialects are attempted: Hyprland 0.56 moved to Lua and took
  // the classic form with it.
  assert.match(hyprland, /hl\.dsp\.focus\(\{ window = "class:deepseek-harness" \}\)/)
  assert.equal(detectFocusCommand({ SWAYSOCK: '/run/user/1000/sway-ipc.sock' }), 'swaymsg [app_id="deepseek-harness"] focus')
  assert.equal(detectFocusCommand({}), '')
  assert.equal(detectFocusCommand({ HYPRLAND_INSTANCE_SIGNATURE: '' }), '')
})

test('a session the client does not know yet is opened once it appears', async () => {
  const dom = installDomDoubles()
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ sessionId: 'session-late' }) })
  const opened = []
  const effects = []
  try {
    const client = loadClient(dom.pageWindow)
    client.apply(clientCtx(
      { uiWorkspace: { openSession: (id) => opened.push(id) }, effect: (run) => effects.push(run()) },
      // Appears after 500ms, i.e. after the first retry has been scheduled.
      { sessions: catalogAfter('session-late', 500) },
    ))
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.deepEqual(opened, [], 'must not switch to an id the client cannot resolve')
    await new Promise((resolve) => setTimeout(resolve, 1200))
    assert.deepEqual(opened, ['session-late'], 'opened exactly once, not once per retry')
  } finally {
    for (const dispose of effects) dispose()
    globalThis.fetch = previousFetch
    dom.restore()
  }
})

test('an undeclared service read would crash the page, and the plugin never does one', async () => {
  const dom = installDomDoubles()
  const previousFetch = globalThis.fetch
  const warnings = []
  const previousWarn = console.warn
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ sessionId: 'session-x' }) })
  console.warn = (...args) => warnings.push(args.join(' '))
  const opened = []
  const effects = []
  try {
    const client = loadClient(dom.pageWindow)
    // The catalog is reachable only through get(); a direct read throws, and
    // this apply must not surface that throw to the loader.
    client.apply(clientCtx(
      { uiWorkspace: { openSession: (id) => opened.push(id) }, effect: (run) => effects.push(run()) },
      { sessions: catalog(['session-x']) },
    ))
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(opened, ['session-x'])
    assert.deepEqual(warnings, [], 'no containment path was taken')
  } finally {
    for (const dispose of effects) dispose()
    console.warn = previousWarn
    globalThis.fetch = previousFetch
    dom.restore()
  }
})

test('a throwing context degrades to a warning instead of failing the entry', () => {
  const dom = installDomDoubles()
  const warnings = []
  const previousWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    const client = loadClient(dom.pageWindow)
    // Property access on an undeclared service throws in the real Client; the
    // Desktop turns an entry that does not activate into a fatal boot error.
    const hostile = {}
    Object.defineProperty(hostile, 'uiWorkspace', {
      get() {
        throw new Error('cannot get property "uiWorkspace" without inject')
      },
    })
    assert.doesNotThrow(() => client.apply(hostile))
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /reveal poller is unavailable/)
  } finally {
    console.warn = previousWarn
    dom.restore()
  }
})
