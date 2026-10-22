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
  new Function('window', readFileSync(process.argv[2] ?? `/tmp/${pkg}.bundle.js`, 'utf8'))(fakeWindow)
  if (!loaded) throw new Error(`${pkg}: loader never called`)
  const regs = []
  const ctx = {
    slots: {
      inject(name, cb) { return cb() },
      register(options, component) { regs.push({ options, component }); return () => {} },
    },
  }
  loaded.exports.apply(ctx)
  if (regs.length !== 1) throw new Error(`${pkg}: expected 1 registration, got ${regs.length}`)
  const { options, component } = regs[0]
  const html = renderToString(React.createElement(component, { sessionId: 'session-test' }))
  results.push({ pkg, id: loaded.id, slot: options.name, entryId: options.id, exports: Object.keys(loaded.exports), htmlLength: html.length })
}
console.table(results)
