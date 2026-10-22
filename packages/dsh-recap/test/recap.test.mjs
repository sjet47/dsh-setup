import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { makeContext, jsonOf } from '../../../test/fake-ctx.mjs'

const root = mkdtempSync(join(tmpdir(), 'dsh-recap-test-'))
process.env.DSH_HOME = join(root, 'dsh-home')

function makeSession() {
  return {
    id: 'session-recap',
    header: { cwd: '/work/project' },
    seq: 3,
    deriveMessages() {
      return [
        { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Port pi-recap to dsh' }] },
        { id: 'm2', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'Working on it.' }] },
      ]
    },
    requestContext() {
      return { provider: 'deepseek', model: 'deepseek-chat' }
    },
  }
}

function makeLlm(reply) {
  return {
    async *stream() {
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    listProviders() {
      return [{ id: 'deepseek', name: 'DeepSeek' }]
    },
  }
}

test('generating a recap stores it and marks it current', async () => {
  const session = makeSession()
  const harness = makeContext(session, { llm: makeLlm('  Porting pi-recap.   Decided on file storage. Next: verify.  ') })
  apply(harness.ctx)

  const empty = await jsonOf(
    await harness.routes.get('/api/dsh-recap/state').fetch(new Request('http://x/api/dsh-recap/state?session=session-recap')),
  )
  assert.equal(empty.text, '')
  assert.equal(empty.current, false)

  const generated = await jsonOf(
    await harness.routes
      .get('/api/dsh-recap/generate')
      .fetch(new Request('http://x/api/dsh-recap/generate?session=session-recap', { method: 'POST' })),
  )
  assert.equal(generated.text, 'Porting pi-recap. Decided on file storage. Next: verify.')
  assert.equal(generated.visible, true)
  assert.equal(generated.current, true)
  assert.equal(generated.provider, 'deepseek')

  const file = join(root, 'dsh-home', 'dsh-recap', 'session-recap.json')
  assert.equal(existsSync(file), true)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).text, generated.text)
})

test('a new event makes the recap stale, and a fresh process restores it hidden', async () => {
  const session = makeSession()
  const first = makeContext(session, { llm: makeLlm('Goal. State. Next.') })
  apply(first.ctx)
  await first.routes
    .get('/api/dsh-recap/generate')
    .fetch(new Request('http://x/api/dsh-recap/generate?session=session-recap', { method: 'POST' }))

  session.seq += 1
  const stale = await jsonOf(
    await first.routes.get('/api/dsh-recap/state').fetch(new Request('http://x/api/dsh-recap/state?session=session-recap')),
  )
  assert.equal(stale.current, false)
  assert.equal(stale.stale, true)

  const second = makeContext(session, { llm: makeLlm('unused') })
  apply(second.ctx)
  const restored = await jsonOf(
    await second.routes.get('/api/dsh-recap/state').fetch(new Request('http://x/api/dsh-recap/state?session=session-recap')),
  )
  assert.equal(restored.text, 'Goal. State. Next.')
  assert.equal(restored.visible, false)
})

test('/recap status and model pinning', async () => {
  const session = makeSession()
  const harness = makeContext(session, { llm: makeLlm('unused') })
  apply(harness.ctx)
  const command = harness.commands.get('recap')

  const status = await command.handler({ agent: { id: 'session-recap' }, rawInput: 'status', attachments: [], signal: new AbortController().signal })
  assert.match(status.text, /model: deepseek\/deepseek-chat/)

  const pinned = await command.handler({ agent: { id: 'session-recap' }, rawInput: 'config other/model-x', attachments: [], signal: new AbortController().signal })
  assert.match(pinned.text, /pinned to other\/model-x/)
  assert.equal(JSON.parse(readFileSync(join(root, 'dsh-home', 'dsh-recap.json'), 'utf8')).model, 'model-x')

  const reset = await command.handler({ agent: { id: 'session-recap' }, rawInput: 'config reset', attachments: [], signal: new AbortController().signal })
  assert.match(reset.text, /session route/)
})

test('empty conversations and unknown sessions fail loudly', async () => {
  const session = { ...makeSession(), deriveMessages: () => [] }
  const harness = makeContext(session, { llm: makeLlm('unused') })
  apply(harness.ctx)
  const response = await harness.routes
    .get('/api/dsh-recap/generate')
    .fetch(new Request('http://x/api/dsh-recap/generate?session=session-recap', { method: 'POST' }))
  assert.equal(response.status, 500)
  assert.match((await jsonOf(response)).error, /No conversation/)

  const missing = await harness.routes
    .get('/api/dsh-recap/state')
    .fetch(new Request('http://x/api/dsh-recap/state?session=other'))
  assert.equal(missing.status, 404)
})

test.after(() => rmSync(root, { recursive: true, force: true }))
