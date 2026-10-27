// Build every package: TypeScript host entry, optional client entry, then wrap
// the client CommonJS output in the dsh browser module-loader frame.
//
// A client half is one file: the module loader's `require` resolves package
// names only, so a relative import between compiled client modules would not
// load. Packages listed below split the client into several modules and are
// therefore bundled by esbuild: tsc type-checks the graph, esbuild emits the
// single CommonJS file the wrapper expects.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const tsc = join(root, 'node_modules', '.bin', 'tsc')
const esbuild = join(root, 'node_modules', '.bin', 'esbuild')
const packagesDir = join(root, 'packages')

const only = process.argv.slice(2)
const names = (await readdir(packagesDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => only.length === 0 || only.includes(name))
  .sort()

/** Modules the browser module table provides; bundling them in would fork React. */
const CLIENT_EXTERNAL = [
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/** Packages whose client half imports more than one module, so it must be bundled. */
const BUNDLED_CLIENTS = new Set(['dsh-mermaid'])

for (const name of names) {
  const dir = join(packagesDir, name)
  console.log(`[build] ${name}`)
  execFileSync(tsc, ['-p', 'tsconfig.json'], { cwd: dir, stdio: 'inherit' })
  if (!existsSync(join(dir, 'src', 'client.tsx'))) continue
  if (BUNDLED_CLIENTS.has(name)) {
    // Type-check the whole client graph, then bundle it into one module.
    execFileSync(tsc, ['-p', 'tsconfig.client.json', '--noEmit'], { cwd: dir, stdio: 'inherit' })
    const args = [
      join(dir, 'src', 'client.tsx'),
      '--bundle',
      '--format=cjs',
      '--platform=browser',
      '--target=es2022',
      '--jsx=automatic',
      '--log-level=warning',
      `--outfile=${join(dir, '.client-build', 'client.js')}`,
    ]
    for (const name of CLIENT_EXTERNAL) args.push(`--external:${name}`)
    execFileSync(esbuild, args, { cwd: dir, stdio: 'inherit' })
  } else {
    execFileSync(tsc, ['-p', 'tsconfig.client.json'], { cwd: dir, stdio: 'inherit' })
  }
  execFileSync(process.execPath, [join(root, 'scripts', 'wrap-client.mjs'), dir, name], { stdio: 'inherit' })
}
console.log('[build] done')
