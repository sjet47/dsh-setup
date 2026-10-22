// Wrap a compiled CommonJS client entry in the dsh browser module-loader frame:
//   window.__ModuleLoader__.load({ id, factory: (require) => { ...; return module.exports } })
// Usage: node scripts/wrap-client.mjs <package-dir> <package-name>
import { readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

const [pkgDir, pkgName] = process.argv.slice(2)
const cjsPath = join(pkgDir, '.client-build', 'client.js')
const outPath = join(pkgDir, 'lib', 'client.js')

let body
try {
  body = await readFile(cjsPath, 'utf8')
} catch {
  console.error(`[wrap-client] no client build for ${pkgName}; skipping`)
  process.exit(0)
}

const wrapped = `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(pkgName)},\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n${body}\n\t\treturn module.exports;\n\t}\n});\n`
await writeFile(outPath, wrapped)
await rm(join(pkgDir, '.client-build'), { recursive: true, force: true })
console.log(`[wrap-client] wrote ${outPath}`)
