import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config } from '../lib/index.js'
import { makeContext, jsonOf } from '../../../test/fake-ctx.mjs'

const root = mkdtempSync(join(tmpdir(), 'dsh-recap-test-'))

/**
 * Every test gets its own `$DSH_HOME`: recap records are keyed by session id,
 * so a shared home would let one test's file decide another test's state.
 */
function freshHome() {
  const home = join(root, `home-${Math.random().toString(36).slice(2)}`)
  process.env.DSH_HOME = home
  return home
}

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

/**
 * A model double whose stream yields the reply, optionally pausing before it
 * finishes so a test can deliver a human message mid-generation.
 */
function makeLlm(reply, gate) {
  return {
    async *stream() {
      yield { type: 'text-delta', index: 0, text: reply }
      if (gate !== undefined) await gate
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    listProviders() {
      return [{ id: 'deepseek', name: 'DeepSeek' }]
    },
    async listModels(provider) {
      if (provider !== 'deepseek') throw new Error(`unknown provider ${provider}`)
      return [
        { provider, id: 'deepseek-chat', name: 'DeepSeek Chat' },
        { provider, id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
      ]
    },
  }
}

function state(harness, id = 'session-recap') {
  return harness.routes
    .get('/api/dsh-recap/state')
    .fetch(new Request(`http://x/api/dsh-recap/state?session=${id}`))
}

function generate(harness, id = 'session-recap') {
  return harness.routes
    .get('/api/dsh-recap/generate')
    .fetch(new Request(`http://x/api/dsh-recap/generate?session=${id}`, { method: 'POST' }))
}

test('config exposes defaults', () => {
  const defaults = Config()
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.idleMs, 5 * 60 * 1000)
  assert.equal(defaults.showStale, true)
  assert.equal(defaults.retentionDays, 30)
})

test('generating a recap stores it and marks it current', async () => {
  const home = freshHome()
  const session = makeSession()
  const harness = makeContext(session, { llm: makeLlm('  Porting pi-recap.   Decided on file storage. Next: verify.  ') })
  apply(harness.ctx)

  const empty = await jsonOf(await state(harness))
  assert.equal(empty.text, '')
  assert.equal(empty.current, false)
  assert.equal(empty.enabled, true)
  assert.equal(empty.idleMs, 5 * 60 * 1000)

  const generated = await jsonOf(await generate(harness))
  assert.equal(generated.text, 'Porting pi-recap. Decided on file storage. Next: verify.')
  assert.equal(generated.visible, true)
  assert.equal(generated.current, true)
  assert.equal(generated.provider, 'deepseek')

  const file = join(home, 'dsh-recap', 'session-recap.json')
  assert.equal(existsSync(file), true)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).text, generated.text)
  // The recap names files and decisions: it must not be world readable.
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(statSync(join(home, 'dsh-recap')).mode & 0o777, 0o700)
})

test('/recap clear forgets the recap on disk, not only in memory', async () => {
  const home = freshHome()
  const session = makeSession()
  const harness = makeContext(session, { llm: makeLlm('Goal. State. Next.') })
  apply(harness.ctx)
  await generate(harness)
  const file = join(home, 'dsh-recap', 'session-recap.json')
  assert.equal(existsSync(file), true)

  const command = harness.commands.get('recap')
  const cleared = await command.handler({
    agent: { id: 'session-recap' },
    rawInput: 'clear',
    attachments: [],
    signal: new AbortController().signal,
  })
  assert.match(cleared.text, /cleared/)
  assert.equal(existsSync(file), false)

  // A fresh process must not restore what the user cleared.
  const second = makeContext(session, { llm: makeLlm('unused') })
  apply(second.ctx)
  const restored = await jsonOf(await state(second))
  assert.equal(restored.text, '')
  assert.equal(restored.visible, false)
})

test('a stale recap is restored visible and marked stale', async () => {
  const home = freshHome()
  const session = makeSession()
  const first = makeContext(session, { llm: makeLlm('Goal. State. Next.') })
  apply(first.ctx)
  await generate(first)

  session.seq += 1
  const stale = await jsonOf(await state(first))
  assert.equal(stale.current, false)
  assert.equal(stale.stale, true)

  const second = makeContext(session, { llm: makeLlm('unused') })
  apply(second.ctx)
  const restored = await jsonOf(await state(second))
  assert.equal(restored.text, 'Goal. State. Next.')
  assert.equal(restored.stale, true)
  assert.equal(restored.visible, true)
})

test('showStale=false restores a moved-on recap hidden', async () => {
  freshHome()
  const session = makeSession()
  const first = makeContext(session, { llm: makeLlm('Goal. State. Next.') })
  apply(first.ctx)
  await generate(first)

  session.seq = Number(session.seq) + 1
  const second = makeContext(session, { llm: makeLlm('unused') })
  apply(second.ctx, { ...Config(), showStale: false })
  const restored = await jsonOf(await state(second))
  assert.equal(restored.text, 'Goal. State. Next.')
  assert.equal(restored.stale, true)
  assert.equal(restored.visible, false)
})

test('a human turn during generation leaves the recap stale', async () => {
  freshHome()
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const session = makeSession()
  const harness = makeContext(session, { llm: makeLlm('Describes the old state.', gate) })
  apply(harness.ctx)

  const pending = generate(harness)
  // A human message lands while the model is still streaming.
  session.seq = Number(session.seq) + 5
  harness.emit('session/event', session, { type: 'user/message', data: { source: { kind: 'user' } } })
  release()
  const result = await jsonOf(await pending)

  assert.equal(result.text, 'Describes the old state.')
  // The recap describes a state the log has moved past: it is stored as stale
  // and only shown because a human explicitly asked for this generation.
  assert.equal(result.current, false)
  assert.equal(result.stale, true)
  assert.equal(result.visible, true)
})

test('an automatic recap stays hidden when the log moved on', async () => {
  freshHome()
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const session = makeSession()
  const harness = makeContext(session, { llm: makeLlm('automatic', gate) })
  apply(harness.ctx, { ...Config(), idleMs: 1 })

  harness.emit('session/event', session, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } },
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  session.seq = Number(session.seq) + 2
  release()
  await new Promise((resolve) => setTimeout(resolve, 20))

  const payload = await jsonOf(await state(harness))
  assert.equal(payload.text, 'automatic')
  assert.equal(payload.visible, false)
  assert.equal(payload.stale, true)
})

test('/recap status and model pinning', async () => {
  const home = freshHome()
  const session = makeSession()
  const harness = makeContext(session, { llm: makeLlm('unused') })
  apply(harness.ctx)
  const command = harness.commands.get('recap')

  const status = await command.handler({
    agent: { id: 'session-recap' },
    rawInput: 'status',
    attachments: [],
    signal: new AbortController().signal,
  })
  assert.match(status.text, /model: deepseek\/deepseek-chat/)
  assert.match(status.text, /automatic: after 5 min idle/)

  const pinned = await command.handler({
    agent: { id: 'session-recap' },
    rawInput: 'config deepseek/model-x',
    attachments: [],
    signal: new AbortController().signal,
  })
  assert.match(pinned.text, /pinned to deepseek\/model-x/)
  assert.equal(JSON.parse(readFileSync(join(home, 'dsh-recap.json'), 'utf8')).model, 'model-x')

  const unknown = await command.handler({
    agent: { id: 'session-recap' },
    rawInput: 'config other/model-x',
    attachments: [],
    signal: new AbortController().signal,
  })
  assert.equal(unknown.kind, 'error')
  assert.match(unknown.text, /Unknown provider "other"/)

  const reset = await command.handler({
    agent: { id: 'session-recap' },
    rawInput: 'config reset',
    attachments: [],
    signal: new AbortController().signal,
  })
  assert.match(reset.text, /session route/)
})

test('dismissing mid-generation cancels the request without an error', async () => {
  freshHome()
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const session = makeSession()
  const harness = makeContext(session, { llm: makeLlm('never lands', gate) })
  apply(harness.ctx)

  const pending = generate(harness)
  const dismissed = await harness.routes
    .get('/api/dsh-recap/dismiss')
    .fetch(new Request('http://x/api/dsh-recap/dismiss?session=session-recap', { method: 'POST' }))
  assert.equal(dismissed.status, 200)
  release()

  // The user's intent (hide) stands; the late result must not surface an error
  // or re-show the card.
  const result = await pending
  assert.equal(result.status, 200)
  const payload = await jsonOf(result)
  assert.equal(payload.visible, false)
  assert.equal(payload.generating, false)
})

test('dismiss persists, so a reload does not resurrect the recap', async () => {
  freshHome()
  const session = makeSession()
  const harness = makeContext(session, { llm: makeLlm('Dismiss me.') })
  apply(harness.ctx)
  await generate(harness)
  await harness.routes
    .get('/api/dsh-recap/dismiss')
    .fetch(new Request('http://x/api/dsh-recap/dismiss?session=session-recap', { method: 'POST' }))

  const second = makeContext(session, { llm: makeLlm('unused') })
  apply(second.ctx)
  const restored = await jsonOf(await state(second))
  assert.equal(restored.text, 'Dismiss me.')
  assert.equal(restored.visible, false)
})

test('unloading the plugin cancels pending automatic recaps', async () => {
  freshHome()
  const session = makeSession()
  let calls = 0
  const llm = {
    async *stream() {
      calls += 1
      yield { type: 'text-delta', index: 0, text: 'late' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
  }
  const harness = makeContext(session, { llm })
  apply(harness.ctx, { ...Config(), idleMs: 30 })
  harness.emit('session/event', session, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } },
  })
  await harness.disposeAll()
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(calls, 0)
})

test('old recap files are pruned at activation', async () => {
  const home = freshHome()
  const dir = join(home, 'dsh-recap')
  mkdirSync(dir, { recursive: true })
  const old = join(dir, 'old-session.json')
  writeFileSync(old, JSON.stringify({ version: 1, text: 'gone', seq: 1 }), 'utf8')
  const past = Date.now() / 1000 - 60 * 24 * 60 * 60
  utimesSync(old, past, past)

  const session = makeSession()
  const harness = makeContext(session, { llm: makeLlm('unused') })
  apply(harness.ctx)
  assert.equal(existsSync(old), false)
  assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith('old-session')), [])
})

test('the model catalog route lists providers with their models', async () => {
  freshHome()
  const harness = makeContext(makeSession(), { llm: makeLlm('unused') })
  apply(harness.ctx)
  const response = await harness.routes
    .get('/api/dsh-recap/models')
    .fetch(new Request('http://x/api/dsh-recap/models'))
  assert.equal(response.status, 200)
  const payload = await jsonOf(response)
  assert.equal(payload.current, undefined)
  assert.equal(payload.providers.length, 1)
  assert.equal(payload.providers[0].id, 'deepseek')
  assert.deepEqual(payload.providers[0].models.map((entry) => entry.id), ['deepseek-chat', 'deepseek-reasoner'])
})

test('a provider whose catalog fails still appears with its error', async () => {
  freshHome()
  const llm = {
    ...makeLlm('unused'),
    async listModels() {
      throw new Error('adapter offline')
    },
  }
  const harness = makeContext(makeSession(), { llm })
  apply(harness.ctx)
  const payload = await jsonOf(
    await harness.routes.get('/api/dsh-recap/models').fetch(new Request('http://x/api/dsh-recap/models')),
  )
  assert.equal(payload.providers.length, 1)
  assert.deepEqual(payload.providers[0].models, [])
  assert.match(payload.providers[0].error, /adapter offline/)
})

test('the config route pins and clears the model, and rejects an unknown provider', async () => {
  const home = freshHome()
  const harness = makeContext(makeSession(), { llm: makeLlm('unused') })
  apply(harness.ctx)
  const route = harness.routes.get('/api/dsh-recap/config')
  const post = (body) =>
    route.fetch(
      new Request('http://x/api/dsh-recap/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )

  const saved = await post({ provider: 'deepseek', model: 'deepseek-reasoner' })
  assert.equal(saved.status, 200)
  assert.deepEqual((await jsonOf(saved)).current, { provider: 'deepseek', model: 'deepseek-reasoner' })
  assert.equal(JSON.parse(readFileSync(join(home, 'dsh-recap.json'), 'utf8')).model, 'deepseek-reasoner')

  const models = await jsonOf(
    await harness.routes.get('/api/dsh-recap/models').fetch(new Request('http://x/api/dsh-recap/models')),
  )
  assert.deepEqual(models.current, { provider: 'deepseek', model: 'deepseek-reasoner' })

  const unknown = await post({ provider: 'other', model: 'x' })
  assert.equal(unknown.status, 400)
  assert.match((await jsonOf(unknown)).error, /Unknown provider "other"/)

  const missing = await post({ provider: 'deepseek' })
  assert.equal(missing.status, 400)

  const reset = await post({ reset: true })
  assert.equal(reset.status, 200)
  assert.equal((await jsonOf(reset)).current, null)
  assert.equal(existsSync(join(home, 'dsh-recap.json')), true)
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'dsh-recap.json'), 'utf8')), {})
})

test('empty conversations and unknown sessions fail loudly', async () => {
  freshHome()
  const session = { ...makeSession(), deriveMessages: () => [] }
  const harness = makeContext(session, { llm: makeLlm('unused') })
  apply(harness.ctx)
  const response = await generate(harness)
  assert.equal(response.status, 500)
  assert.match((await jsonOf(response)).error, /No conversation/)

  const missing = await state(harness, 'other')
  assert.equal(missing.status, 404)
})

test.after(() => rmSync(root, { recursive: true, force: true }))
