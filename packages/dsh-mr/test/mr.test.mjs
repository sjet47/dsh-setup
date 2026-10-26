import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config } from '../lib/index.js'
import { ciFromGithub, normalizeGitlab } from '../lib/forge.js'
import { renderMrLine } from '../lib/format.js'
import { makeContext, jsonOf } from '../../../test/fake-ctx.mjs'

const dir = mkdtempSync(join(tmpdir(), 'dsh-mr-test-'))
const session = {
  id: 'session-test',
  header: { cwd: dir },
  seq: 0,
}

function status(harness) {
  return harness.routes
    .get('/api/dsh-mr/status')
    .fetch(new Request('http://localhost/api/dsh-mr/status?session=session-test'))
}

test('config exposes defaults', () => {
  const defaults = Config()
  assert.equal(defaults.refreshMs, 60_000)
  assert.equal(defaults.enabled, true)
})

test('a checkout without a remote reports no request instead of an error', async () => {
  const harness = makeContext(session)
  apply(harness.ctx)
  const body = await jsonOf(await status(harness))
  assert.equal(body.branch, null)
  assert.equal(body.info, null)
  assert.equal(body.cwd, dir)
  assert.equal(body.enabled, true)
  assert.equal(body.refreshMs, 60_000)
})

test('/mr prints the current state', async () => {
  const harness = makeContext(session)
  apply(harness.ctx)
  const command = harness.commands.get('mr')
  const result = await command.handler({
    agent: { id: 'session-test' },
    rawInput: '',
    attachments: [],
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /No merge request/)
})

test('/mr rejects an unknown argument and honors the disabled switch', async () => {
  const harness = makeContext(session)
  apply(harness.ctx)
  const command = harness.commands.get('mr')
  const bad = await command.handler({
    agent: { id: 'session-test' },
    rawInput: 'pr',
    attachments: [],
    signal: new AbortController().signal,
  })
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /Usage/)

  const off = makeContext(session)
  apply(off.ctx, { refreshMs: 60_000, enabled: false })
  const disabled = await off.commands.get('mr').handler({
    agent: { id: 'session-test' },
    rawInput: '',
    attachments: [],
    signal: new AbortController().signal,
  })
  assert.match(disabled.text, /disabled/)
  const hidden = await jsonOf(await status(off))
  assert.equal(hidden.enabled, false)
  assert.equal(hidden.info, null)
})

test('the status route reports the effective working directory', async () => {
  const moved = join(dir, 'nested')
  const harness = makeContext(session, {
    workingDirectory: { get: () => moved },
  })
  apply(harness.ctx)
  const body = await jsonOf(await status(harness))
  assert.equal(body.cwd, moved)
})

test('concurrent first lookups share one forge detection', async () => {
  const harness = makeContext(session)
  apply(harness.ctx)
  const route = harness.routes.get('/api/dsh-mr/status')
  const responses = await Promise.all([
    route.fetch(new Request('http://x/api/dsh-mr/status?session=session-test')),
    route.fetch(new Request('http://x/api/dsh-mr/status?session=session-test')),
    route.fetch(new Request('http://x/api/dsh-mr/status?session=session-test')),
  ])
  for (const response of responses) {
    const body = await jsonOf(response)
    // No remote in the temp dir: every reader must agree, rather than one
    // seeing a half-initialized forge cache.
    assert.equal(body.forge, null)
    assert.equal(body.branch, null)
    assert.equal(body.cwd, dir)
  }
})

test('the status route requires a session id', async () => {
  const harness = makeContext(session)
  apply(harness.ctx)
  const response = await harness.routes
    .get('/api/dsh-mr/status')
    .fetch(new Request('http://x/api/dsh-mr/status'))
  assert.equal(response.status, 400)
  assert.equal((await jsonOf(response)).error, 'missing session')
})

test('GitLab payload normalization and CI fallback states', () => {
  const info = normalizeGitlab([
    {
      iid: 12,
      title: 'Login rework',
      state: 'opened',
      draft: false,
      has_conflicts: true,
      web_url: 'https://gitlab.example.com/g/p/-/merge_requests/12',
      sha: 'abc',
      head_pipeline: { status: 'running' },
    },
  ])
  assert.equal(info.ref, '!12')
  assert.equal(info.state, 'opened')
  assert.equal(info.ci, 'running')
  assert.equal(info.conflicts, true)
  assert.match(renderMrLine(info), /^⬤ !12 ⋯CI ⚠conflict Login rework$/)
})

test('GitHub rollup maps failures and pending checks', () => {
  assert.equal(ciFromGithub([{ conclusion: 'SUCCESS' }]), 'success')
  assert.equal(ciFromGithub([{ conclusion: 'SUCCESS' }, { state: 'FAILURE' }]), 'failed')
  assert.equal(ciFromGithub([{ status: 'IN_PROGRESS' }]), 'running')
  assert.equal(ciFromGithub([]), 'none')
})

test.after(() => rmSync(dir, { recursive: true, force: true }))
