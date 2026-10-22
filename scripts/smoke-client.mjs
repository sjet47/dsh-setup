import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import React from 'react'
import { renderToString } from 'react-dom/server'

const require = createRequire(import.meta.url)
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
  const ctx = {
    slots: {
      inject(name, cb) { return cb() },
      register(options, component) { regs.push({ options, component }); return () => {} },
    },
    commandUi: {
      decorate(decoration) { decorations.push(decoration); return () => {} },
    },
    inject(deps, cb) { cb(ctx); return { dispose: async () => {} } },
    effect(fn) { fn(); return () => {} },
  }
  loaded.exports.apply(ctx)
  if (regs.length === 0) throw new Error(`${pkg}: registered no slot`)
  let htmlLength = 0
  for (const { component } of regs) {
    htmlLength += renderToString(React.createElement(component, { sessionId: 'session-test' })).length
  }
  results.push({
    pkg,
    id: loaded.id,
    slots: regs.map((reg) => `${reg.options.name}#${reg.options.id}`).join(', '),
    commandActions: decorations.map((d) => `${d.name}:${d.ui.kind}`).join(', '),
    exports: Object.keys(loaded.exports).join(','),
    htmlLength,
  })
}
console.table(results)
