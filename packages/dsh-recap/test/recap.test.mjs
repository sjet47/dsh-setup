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
 * A model double answering both requests a recap makes: the language-detection
 * call (recognized by its prompt) and the recap call itself. `requests` keeps
 * every request so a test can inspect what each one carried.
 */
function makeLlm(reply, gate, detected = 'en') {
  return {
    requests: [],
    /** Detection asks for the cheapest level; the double advertises one. */
    async resolveModelInfo(provider, model) {
      return {
        provider,
        id: model,
        name: model,
        reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }] },
      }
    },
    async *stream(request) {
      this.requests.push(request)
      const detection = /detect the language/i.test(request.system)
      yield { type: 'text-delta', index: 0, text: detection ? detected : reply }
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

/** The recap request, as opposed to the language-detection one. */
function recapRequest(llm) {
  return llm.requests.find((request) => !/detect the language/i.test(request.system))
}

/** The language-detection request. */
function detectionRequest(llm) {
  return llm.requests.find((request) => /detect the language/i.test(request.system))
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

test('detection reads only the human words, and the recap follows them', async () => {
  freshHome()
  // A short Chinese question followed by a long English answer: judging the
  // mixed conversation is what used to produce an English recap.
  const session = {
    ...makeSession(),
    deriveMessages() {
      return [
        { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '把 recap 改成中文' }] },
        {
          id: 'm2',
          role: 'assistant',
          source: { kind: 'model' },
          content: [{ type: 'text', text: 'I will change the system prompt and then rerun the tests. '.repeat(20) }],
        },
      ]
    },
  }
  const llm = makeLlm('把 recap 改成中文；已改 prompt，下一步跑测试。', undefined, 'zh-Hans')
  const harness = makeContext(session, { llm })
  apply(harness.ctx)
  await generate(harness)

  const detection = detectionRequest(llm)
  assert.ok(detection, 'a detection request must be issued')
  const detectionText = detection.messages[0].content[0].text
  // Only the human's own words: the assistant's English reply is the signal
  // that must not reach the detector.
  assert.match(detectionText, /把 recap 改成中文/)
  assert.doesNotMatch(detectionText, /rerun the tests/)
  // Detection is not a thinking job, but a reasoning route may spend the
  // budget thinking before it answers, so the cap must leave room for that
  // while staying far below the recap's own budget.
  assert.equal(detection.reasoningEffort, 'off')
  assert.ok(detection.maxTokens >= 256 && detection.maxTokens <= 1024)

  const recap = recapRequest(llm)
  assert.match(recap.system, /Simplified Chinese/)
  // The recap body still carries the whole conversation.
  assert.match(recap.messages[0].content[0].text, /rerun the tests/)
})

test('an unknown detection answer leaves the recap on its own rule', async () => {
  freshHome()
  const llm = makeLlm('Goal. State. Next.', undefined, 'unknown')
  // Too little human text for the script heuristic either: nothing decides the
  // language but the recap prompt's own soft rule.
  const session = {
    ...makeSession(),
    deriveMessages() {
      return [{ id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'ok' }] }]
    },
  }
  const harness = makeContext(session, { llm })
  apply(harness.ctx)
  await generate(harness)

  const recap = recapRequest(llm)
  // No hard language override: the prompt's soft rule decides.
  assert.doesNotMatch(recap.system, /## Output language/)
  assert.match(recap.system, /language the session's human writes in/i)
})

test('a failed detection never fails the recap', async () => {
  freshHome()
  const llm = {
    async *stream(request) {
      this.requests.push(request)
      if (/detect the language/i.test(request.system)) throw new Error('detector exploded')
      yield { type: 'text-delta', index: 0, text: 'Goal. State. Next.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    requests: [],
  }
  const harness = makeContext(makeSession(), { llm })
  apply(harness.ctx)
  const result = await jsonOf(await generate(harness))
  assert.equal(result.text, 'Goal. State. Next.')
})

test('a truncated detection answer still lands on the right language', async () => {
  freshHome()
  // A reasoning route that spends the whole budget thinking emits no text at
  // all. That must degrade to the script heuristic, not to the soft rule —
  // otherwise a Chinese session silently recaps in English again.
  const llm = {
    async *stream(request) {
      this.requests.push(request)
      if (/detect the language/i.test(request.system)) {
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
        return
      }
      yield { type: 'text-delta', index: 0, text: '把 recap 改成中文。' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    requests: [],
  }
  const session = {
    ...makeSession(),
    deriveMessages() {
      return [
        { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '把 recap 改成中文，先看 packages/dsh-recap/src/index.ts 里的 prompt' }] },
      ]
    },
  }
  const harness = makeContext(session, { llm })
  apply(harness.ctx)
  await generate(harness)

  assert.match(recapRequest(llm).system, /Write the recap in Chinese/)
  const status = await harness.commands.get('recap').handler({
    agent: { id: 'session-recap' },
    rawInput: 'status',
    attachments: [],
    signal: new AbortController().signal,
  })
  // Which path decided the language is visible, so a heuristic guess is never
  // mistaken for a model answer.
  assert.match(status.text, /language: zh · heuristic/)
})

test('regenerating without new human input reuses the detected language', async () => {
  freshHome()
  const llm = makeLlm('把 recap 改成中文。', undefined, 'zh-Hans')
  const harness = makeContext(makeSession(), { llm })
  apply(harness.ctx)
  await generate(harness)
  await generate(harness)

  const detections = llm.requests.filter((request) => /detect the language/i.test(request.system))
  assert.equal(detections.length, 1)
})

test('language replies are normalized and rejected when unusable', async () => {
  const { parseLanguageReply, languageInstruction, collectUserText } = await import('../lib/language.js')
  assert.equal(parseLanguageReply('zh-Hans'), 'zh-Hans')
  assert.equal(parseLanguageReply('```\nzh-Hant\n```'), 'zh-Hant')
  assert.equal(parseLanguageReply('zh-hans'), 'zh-Hans')
  // A model that answers in prose still names the language first.
  assert.equal(parseLanguageReply('Simplified Chinese (zh)'), 'zh')
  assert.equal(parseLanguageReply('unknown'), undefined)
  assert.equal(parseLanguageReply(''), undefined)
  assert.equal(parseLanguageReply('klingon'), undefined)
  assert.match(languageInstruction('ja'), /Japanese/)
  assert.equal(languageInstruction('klingon'), '')
  // Non-text blocks never reach detection.
  assert.equal(
    collectUserText([
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'tool-call', id: 'c', name: 'read', arguments: '{}' }] },
    ]),
    '',
  )
})

test('the script heuristic ignores code and paths', async () => {
  const { heuristicLanguage } = await import('../lib/language.js')
  // A Chinese sentence that quotes identifiers and paths is still Chinese.
  assert.equal(heuristicLanguage('把 packages/dsh-recap/src/index.ts 里的 prompt 改一下，recap 老是出英文'), 'zh')
  assert.equal(heuristicLanguage('請把這個檔案改好，順便跑測試'), 'zh')
  assert.equal(heuristicLanguage('Make the recap follow the user language'), 'en')
  assert.equal(heuristicLanguage('recap を日本語にしてください'), 'ja')
  assert.equal(heuristicLanguage('recap 을 한국어로 바꿔줘'), 'ko')
  assert.equal(heuristicLanguage('Сделай recap на русском языке'), 'ru')
  // Not enough signal to decide: the recap keeps its own rule.
  assert.equal(heuristicLanguage('ok'), undefined)
  assert.equal(heuristicLanguage('```ts\nconst x: number = 1\n```'), undefined)
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
