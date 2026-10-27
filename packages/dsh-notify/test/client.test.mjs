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
    client.apply({
      uiWorkspace: { openSession: (id) => opened.push(id) },
      effect: (run) => effects.push(run()),
    })
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
    client.apply({ uiWorkspace: { openSession: (id) => opened.push(id) }, effect: (run) => effects.push(run()) })
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
    client.apply({ uiWorkspace: { openSession: (id) => opened.push(id) }, effect: (run) => effects.push(run()) })
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
  client.apply({ uiWorkspace: { openSession: () => {} }, effect: (run) => effects.push(run()) })
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
