import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { ciFromGithub, normalizeGitlab } from '../lib/forge.js'
import { renderMrLine } from '../lib/format.js'
import { makeContext, jsonOf } from '../../../test/fake-ctx.mjs'

const dir = mkdtempSync(join(tmpdir(), 'dsh-mr-test-'))
const session = {
  id: 'session-test',
  header: { cwd: dir },
  seq: 0,
}

test('a checkout without a remote reports no request instead of an error', async () => {
  const { ctx, routes } = makeContext(session)
  apply(ctx, { refreshMs: 60_000, enabled: true })
  const route = routes.get('/api/dsh-mr/status')
  assert.ok(route)
  const response = await route.fetch(new Request('http://localhost/api/dsh-mr/status?session=session-test'))
  const body = await jsonOf(response)
  assert.equal(body.branch, null)
  assert.equal(body.info, null)
  assert.equal(body.cwd, dir)
})

test('/mr prints the current state', async () => {
  const { ctx, commands } = makeContext(session)
  apply(ctx, { refreshMs: 60_000, enabled: true })
  const command = commands.get('mr')
  const result = await command.handler({ agent: { id: 'session-test' }, rawInput: '', attachments: [], signal: new AbortController().signal })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /No merge request/)
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
