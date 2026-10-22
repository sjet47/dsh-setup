import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { makeContext, jsonOf } from '../../../test/fake-ctx.mjs'

const root = mkdtempSync(join(tmpdir(), 'dsh-note-test-'))
const agentDir = join(root, 'pi-agent')
const project = join(root, 'project')
mkdirSync(agentDir, { recursive: true })
mkdirSync(project, { recursive: true })
process.env.PI_CODING_AGENT_DIR = agentDir
process.env.DSH_HOME = join(root, 'dsh-home')

const slug = `--${project.replace(/^\//, '').replace(/[/\\:]/g, '-')}--`
const memoryDir = join(agentDir, 'pi-note', slug)

const session = { id: 'session-note', header: { cwd: project }, seq: 0 }

test('memory is prepared in pi’s own pi-note layout and injected', () => {
  const harness = makeContext(session)
  apply(harness.ctx)
  harness.emit('agent/created', { agent: harness.makeAgent('session-note') })

  assert.equal(existsSync(join(memoryDir, 'MEMORY.md')), true)
  assert.equal(harness.sections.length, 1)
  const text = harness.sections[0].text()
  assert.match(text, /# Memory/)
  assert.ok(text.includes(memoryDir))
  assert.ok(text.includes(`pi-note-${process.getuid()}`))
  assert.equal(harness.sections[0].interpolate, false)
})

test('shared memory files appear in the browser routes', async () => {
  writeFileSync(join(memoryDir, 'cli.md'), 'Use pnpm.\n', 'utf8')
  writeFileSync(join(memoryDir, 'MEMORY.md'), '- [CLI](cli.md) — package manager\n', 'utf8')

  const { ctx, routes } = makeContext(session)
  apply(ctx)

  const list = await jsonOf(
    await routes.get('/api/dsh-note/list').fetch(new Request('http://x/api/dsh-note/list?session=session-note')),
  )
  assert.equal(list.topics.length, 1)
  assert.equal(list.topics[0].file, 'cli.md')
  assert.equal(list.topics[0].indexed, true)
  assert.equal(list.topics[0].hook, 'package manager')

  const body = await jsonOf(
    await routes
      .get('/api/dsh-note/body')
      .fetch(new Request('http://x/api/dsh-note/body?session=session-note&file=cli.md')),
  )
  assert.equal(body.text, 'Use pnpm.\n')
  assert.equal(body.path, join(memoryDir, 'cli.md'))
})

test('delete removes the file and its index line together', async () => {
  const { ctx, routes } = makeContext(session)
  apply(ctx)
  const response = await routes
    .get('/api/dsh-note/delete')
    .fetch(
      new Request('http://x/api/dsh-note/delete?session=session-note', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: 'cli.md' }),
      }),
    )
  assert.equal((await jsonOf(response)).ok, true)
  assert.equal(existsSync(join(memoryDir, 'cli.md')), false)
  assert.equal(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8').trim(), '')
})

test('unknown sessions are rejected and the scratch variable resolves per agent', async () => {
  const { ctx, routes, shellContributors } = makeContext(session)
  apply(ctx)
  const missing = await routes.get('/api/dsh-note/list').fetch(new Request('http://x/api/dsh-note/list?session=nope'))
  assert.equal(missing.status, 404)
  assert.equal(shellContributors.length, 1)
  const value = shellContributors[0].resolve({ agent: { id: 'session-note' } })
  assert.match(value.DSH_NOTE_SCRATCHPAD_DIR, /session-note$/)
})

test.after(() => rmSync(root, { recursive: true, force: true }))
