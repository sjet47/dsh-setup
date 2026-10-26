import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config } from '../lib/index.js'
import { buildPromptAppend, SNAPSHOT_TRUNCATED } from '../lib/prompt.js'
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

function list(harness, id = 'session-note') {
  return harness.routes.get('/api/dsh-note/list').fetch(new Request(`http://x/api/dsh-note/list?session=${id}`))
}

function body(harness, file, id = 'session-note') {
  return harness.routes
    .get('/api/dsh-note/body')
    .fetch(new Request(`http://x/api/dsh-note/body?session=${id}&file=${encodeURIComponent(file)}`))
}

function remove(harness, file, id = 'session-note') {
  return harness.routes
    .get('/api/dsh-note/delete')
    .fetch(
      new Request(`http://x/api/dsh-note/delete?session=${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file }),
      }),
    )
}

test('config exposes defaults', () => {
  const defaults = Config()
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.snapshotMaxChars, 16_000)
  assert.equal(defaults.maxBodyBytes, 1024 * 1024)
})

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

test('unloading the plugin disposes the agent prompt sections', async () => {
  let disposed = 0
  const harness = makeContext(session)
  apply(harness.ctx)
  const agent = harness.makeAgent('session-note')
  // A Fiber double: `inject` returns a disposable scope whose disposal runs the
  // disposers registered inside it, like a real agent-scoped fiber.
  agent.ctx.inject = (_deps, callback) => {
    const inner = []
    callback({
      systemPrompt: {
        section(section) {
          harness.sections.push(section)
          const off = () => {
            disposed += 1
          }
          // The real service registers its disposer on the calling fiber; the
          // double records it on the scope it is asked to dispose.
          inner.push(off)
          return off
        },
      },
    })
    return {
      dispose: async () => {
        for (const disposer of inner.reverse()) await disposer()
      },
    }
  }
  harness.emit('agent/created', { agent })
  assert.equal(harness.sections.length, 1)
  await harness.disposeAll()
  assert.equal(disposed, 1)
})

test('shared memory files appear in the browser routes', async () => {
  writeFileSync(join(memoryDir, 'cli.md'), 'Use pnpm.\n', 'utf8')
  writeFileSync(join(memoryDir, 'MEMORY.md'), '- [CLI](cli.md) — package manager\n', 'utf8')

  const harness = makeContext(session)
  apply(harness.ctx)

  const payload = await jsonOf(await list(harness))
  assert.equal(payload.enabled, true)
  assert.equal(payload.topics.length, 1)
  assert.equal(payload.topics[0].file, 'cli.md')
  assert.equal(payload.topics[0].indexed, true)
  assert.equal(payload.topics[0].hook, 'package manager')

  const content = await jsonOf(await body(harness, 'cli.md'))
  assert.equal(content.text, 'Use pnpm.\n')
  assert.equal(content.path, join(memoryDir, 'cli.md'))
})

test('the working directory service overrides the session header', async () => {
  const moved = join(root, 'moved-project')
  mkdirSync(moved, { recursive: true })
  const harness = makeContext(session, { workingDirectory: { get: () => moved } })
  apply(harness.ctx)
  const payload = await jsonOf(await list(harness))
  assert.equal(payload.memoryDir, join(agentDir, 'pi-note', `--${moved.replace(/^\//, '').replace(/[/\\:]/g, '-')}--`))
})

test('delete removes the file and its index line together', async () => {
  const harness = makeContext(session)
  apply(harness.ctx)
  assert.equal((await jsonOf(await remove(harness, 'cli.md'))).ok, true)
  assert.equal(existsSync(join(memoryDir, 'cli.md')), false)
  assert.equal(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8').trim(), '')
})

test('the memory index cannot be deleted through the browser', async () => {
  writeFileSync(join(memoryDir, 'MEMORY.md'), '- [Index](MEMORY.md) — the index\n', 'utf8')
  const harness = makeContext(session)
  apply(harness.ctx)
  const response = await remove(harness, 'MEMORY.md')
  assert.equal(response.status, 500)
  assert.match((await jsonOf(response)).error, /refusing to delete the memory index/)
  assert.equal(existsSync(join(memoryDir, 'MEMORY.md')), true)
  writeFileSync(join(memoryDir, 'MEMORY.md'), '', 'utf8')
})

test('oversized memory bodies are refused instead of buffered', async () => {
  writeFileSync(join(memoryDir, 'big.md'), 'x'.repeat(2048), 'utf8')
  const harness = makeContext(session)
  apply(harness.ctx, { enabled: true, snapshotMaxChars: 16_000, maxBodyBytes: 1024 })
  const response = await body(harness, 'big.md')
  assert.equal(response.status, 413)
  assert.match((await jsonOf(response)).error, /larger than 1024 bytes/)
  rmSync(join(memoryDir, 'big.md'), { force: true })
})

test('a disabled plugin serves no memories and injects no prompt', async () => {
  const harness = makeContext(session)
  apply(harness.ctx, { enabled: false, snapshotMaxChars: 16_000, maxBodyBytes: 1024 })
  const payload = await jsonOf(await list(harness))
  assert.equal(payload.enabled, false)
  assert.deepEqual(payload.topics, [])
  const command = harness.commands.get('memory')
  const result = command.handler({ agent: { id: 'session-note' }, rawInput: '', attachments: [], signal: new AbortController().signal })
  assert.match(result.text, /disabled/)
  harness.emit('agent/created', { agent: harness.makeAgent('session-note') })
  assert.equal(harness.sections.length, 0)
})

test('the snapshot is truncated to the configured prompt budget', () => {
  const long = '- [A](a.md) — one\n'.repeat(500)
  const block = buildPromptAppend('/m', '/s', long, 100)
  assert.ok(block.includes(SNAPSHOT_TRUNCATED))
  assert.ok(block.indexOf('(snapshot truncated') < block.length)
  assert.ok(!block.includes(long))
  const unbounded = buildPromptAppend('/m', '/s', 'short', 100)
  assert.ok(unbounded.endsWith('short'))
})

test('unknown sessions are rejected and the scratch variable resolves per agent', async () => {
  const harness = makeContext(session)
  apply(harness.ctx)
  assert.equal((await list(harness, 'nope')).status, 404)
  assert.equal(harness.shellContributors.length, 1)
  const value = harness.shellContributors[0].resolve({ agent: { id: 'session-note' } })
  assert.match(value.DSH_NOTE_SCRATCHPAD_DIR, /session-note$/)
})

test('memory dirs are created with private permissions', () => {
  const harness = makeContext(session)
  apply(harness.ctx)
  harness.emit('agent/created', { agent: harness.makeAgent('session-note') })
  const scratch = join(tmpdir(), `pi-note-${process.getuid()}`, 'session-note')
  assert.equal(statSync(scratch).mode & 0o777, 0o700)
})

test.after(() => rmSync(root, { recursive: true, force: true }))
