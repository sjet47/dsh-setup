// Render every client bundle's slot components in Node, without a browser.
// This catches syntax errors, a loader that never registers, and components
// that throw during render; it is not a substitute for the live page.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import React from 'react'
import { renderToString } from 'react-dom/server'

const require = createRequire(import.meta.url)

/** Minimal locale runtime double: stable snapshot plus bind(). */
function makeLocale() {
  const dictionaries = new Map()
  return {
    getSnapshot: () => ({ active: 'en', locales: [{ id: 'en', label: 'English' }], revision: dictionaries.size }),
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

/** Standard slot props the components under test read. */
const standardProps = {
  sessionId: 'session-test',
  useSessions: (selector) => selector({ byId: { 'session-test': { id: 'session-test', retainedBy: { mainView: 1 } } } }),
  useSessionStatus: (selector) => selector({ get: () => ({ running: false }) }),
}

const results = []
for (const pkg of ['dsh-mr', 'dsh-note', 'dsh-recap']) {
  let loaded
  const fakeWindow = {
    __ModuleLoader__: {
      load({ id, factory }) {
        const module = { exports: {} }
        const req = (spec) => {
          if (spec === 'react') return React
          if (spec === 'react/jsx-runtime') return require('react/jsx-runtime')
          if (spec === 'react-dom') return require('react-dom')
          throw new Error(`unexpected require: ${spec}`)
        }
        loaded = { id, exports: factory(req) }
      },
    },
  }
  new Function('window', readFileSync(new URL(`../packages/${pkg}/lib/client.js`, import.meta.url), 'utf8'))(fakeWindow)
  if (!loaded) throw new Error(`${pkg}: loader never called`)
  const regs = []
  const decorations = []
  const locale = makeLocale()
  const ctx = {
    slots: {
      inject(name, cb) { return cb() },
      register(options, component) { regs.push({ options, component }); return () => {} },
    },
    commandUi: {
      decorate(decoration) { decorations.push(decoration); return () => {} },
    },
    locale,
    inject(deps, cb) { cb(ctx); return { dispose: async () => {} } },
    effect(fn) { return fn() }
  }
  loaded.exports.apply(ctx)
  if (regs.length === 0) throw new Error(`${pkg}: registered no slot`)
  /** Keyed slots take `key`; render their page view, not the summary. */
  const propsFor = (options) => ({
    ...standardProps,
    ...(options.name === 'plugins.bundle.config' ? { view: 'page' } : {}),
  })
  let htmlLength = 0
  for (const { options, component } of regs) {
    htmlLength += renderToString(React.createElement(component, propsFor(options))).length
  }
  // Open the panel through the same client action `/memory` and `/recap` run,
  // then render again so the panel bodies (not just the triggers) are covered.
  for (const decoration of decorations) decoration.ui.run({ sessionId: 'session-test' })
  let openLength = 0
  for (const { options, component } of regs) {
    openLength += renderToString(React.createElement(component, propsFor(options))).length
  }
  results.push({
    pkg,
    id: loaded.id,
    slots: regs.map((reg) => `${reg.options.name}#${reg.options.key ?? reg.options.id}`).join(', '),
    commandActions: decorations.map((d) => `${d.name}:${d.ui.kind}`).join(', '),
    exports: Object.keys(loaded.exports).join(','),
    htmlLength,
    openLength,
  })
}
console.table(results)
