// Build every package: TypeScript host entry, optional client entry, then wrap
// the client CommonJS output in the dsh browser module-loader frame.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const tsc = join(root, 'node_modules', '.bin', 'tsc')
const packagesDir = join(root, 'packages')

const only = process.argv.slice(2)
const names = (await readdir(packagesDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => only.length === 0 || only.includes(name))
  .sort()

for (const name of names) {
  const dir = join(packagesDir, name)
  console.log(`[build] ${name}`)
  execFileSync(tsc, ['-p', 'tsconfig.json'], { cwd: dir, stdio: 'inherit' })
  if (existsSync(join(dir, 'src', 'client.tsx'))) {
    execFileSync(tsc, ['-p', 'tsconfig.client.json'], { cwd: dir, stdio: 'inherit' })
    execFileSync(process.execPath, [join(root, 'scripts', 'wrap-client.mjs'), dir, name], { stdio: 'inherit' })
  }
}
console.log('[build] done')
