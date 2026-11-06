import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config } from '../lib/index.js'
import {
  ciFromGithub,
  githubLogin,
  githubRemoteRepos,
  githubRepoInfo,
  gitlabRepoInfo,
  normalizeGithub,
  normalizeGitlab,
} from '../lib/forge.js'
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

// ── which request belongs to this checkout ───────────────────────────────
//
// The branch name alone is a weak key: a project's default branch collects
// history (`!1694 "Master"` merged in 2023), and a popular fork's branch name is
// shared by strangers' pull requests. These cases pin the two extra facts the
// lookup uses — the default branch and the repositories this checkout owns.

function gitlabMergeRequest(overrides = {}) {
  return {
    iid: 1694,
    title: 'Master',
    state: 'merged',
    source_branch: 'master',
    source_project_id: 171,
    target_project_id: 171,
    sha: 'efd0c02a7069b76fc6c058c5edaa6d18186052a4',
    web_url: 'https://gitlab.example.com/g/p/-/merge_requests/1694',
    ...overrides,
  }
}

const DEFAULT_BRANCH = { branch: 'master', defaultBranch: 'master' }

test('GitLab: a merged request from another fork is not this branch', () => {
  const fork = gitlabMergeRequest({ source_project_id: 900 })
  assert.equal(normalizeGitlab([fork], DEFAULT_BRANCH), undefined)
  // Without the ids (older payload) the request is kept: unknown proves nothing.
  const bare = gitlabMergeRequest({ source_project_id: undefined, target_project_id: undefined })
  assert.equal(normalizeGitlab([bare], { branch: 'master' })?.ref, '!1694')
  assert.equal(normalizeGitlab([gitlabMergeRequest()], DEFAULT_BRANCH), undefined)
})

test('GitLab: the default branch hides merged and closed history, other branches do not', () => {
  const merged = gitlabMergeRequest()
  assert.equal(normalizeGitlab([merged], DEFAULT_BRANCH), undefined)
  assert.equal(normalizeGitlab([gitlabMergeRequest({ state: 'closed' })], DEFAULT_BRANCH), undefined)
  // A feature branch that was merged is exactly where its tip landed.
  const feature = { branch: 'feat/login', defaultBranch: 'master' }
  assert.equal(normalizeGitlab([merged], feature)?.state, 'merged')
  // An open request on the default branch is still the current work.
  const opened = gitlabMergeRequest({ state: 'opened' })
  assert.equal(normalizeGitlab([opened], DEFAULT_BRANCH)?.ref, '!1694')
  // No default branch known: nothing is hidden.
  assert.equal(normalizeGitlab([merged], { branch: 'master' })?.state, 'merged')
})

test('GitLab: history is dropped before the newest open request is picked', () => {
  const info = normalizeGitlab(
    [gitlabMergeRequest({ iid: 20, state: 'merged' }), gitlabMergeRequest({ iid: 21, state: 'opened' })],
    DEFAULT_BRANCH,
  )
  assert.equal(info?.ref, '!21')
})

function githubPullRequest(overrides = {}) {
  return {
    number: 80,
    title: 'Create exp.py with an easy-to-understand ',
    state: 'OPEN',
    isDraft: false,
    url: 'https://github.com/V4bel/dirtyfrag/pull/80',
    statusCheckRollup: [],
    headRepository: { nameWithOwner: 'Bode512/dirtyfrag' },
    ...overrides,
  }
}

test('GitHub: a pull request from a stranger fork shares only the branch name', () => {
  const checkout = { branch: 'master', defaultBranch: 'master', repos: ['v4bel/dirtyfrag'], login: 'sjet47' }
  assert.equal(normalizeGithub([githubPullRequest()], checkout), undefined)
  // Own fork, even without a remote for it: contributing upstream is normal.
  const own = githubPullRequest({ headRepository: { nameWithOwner: 'sjet47/dirtyfrag' } })
  assert.equal(normalizeGithub([own], checkout)?.ref, '#80')
  // Repository reachable through another remote of this checkout.
  const mirrored = githubPullRequest({ headRepository: { nameWithOwner: 'V4bel/dirtyfrag' } })
  assert.equal(normalizeGithub([mirrored], checkout)?.ref, '#80')
  // Deleted fork (no head repository) and an unprobed checkout keep everything.
  const gone = githubPullRequest({ headRepository: null })
  assert.equal(normalizeGithub([gone], checkout)?.ref, '#80')
  assert.equal(normalizeGithub([githubPullRequest()], { branch: 'master' })?.ref, '#80')
})

test('GitHub: the default branch hides merged and closed history', () => {
  const checkout = { branch: 'main', defaultBranch: 'main', repos: ['sjet47/assethub'] }
  const merged = githubPullRequest({ state: 'MERGED', headRepository: { nameWithOwner: 'sjet47/assethub' } })
  assert.equal(normalizeGithub([merged], checkout), undefined)
  assert.equal(
    normalizeGithub([{ ...merged, state: 'CLOSED' }], checkout),
    undefined,
  )
  assert.equal(normalizeGithub([merged], { ...checkout, branch: 'feat/login' })?.state, 'merged')
})

test('GitHub: fork filtering happens before the newest open request is picked', () => {
  const checkout = { branch: 'master', repos: ['sjet47/repo'] }
  const info = normalizeGithub(
    [
      githubPullRequest({ number: 2, headRepository: { nameWithOwner: 'stranger/repo' } }),
      githubPullRequest({ number: 3, state: 'CLOSED', headRepository: { nameWithOwner: 'sjet47/repo' } }),
    ],
    checkout,
  )
  assert.equal(info?.ref, '#3')
})

test('githubRemoteRepos: reads owner/name from every GitHub remote form', () => {
  assert.deepEqual(
    githubRemoteRepos([
      'git@github.com:sjet47/rdb',
      'https://github.com/HDT3213/rdb.git',
      'ssh://git@github.com/Team/App.git',
      'git@git.maxjia.com:sunlinhao/rcman.git',
      'not a url',
    ]),
    ['sjet47/rdb', 'hdt3213/rdb', 'team/app'],
  )
  assert.deepEqual(githubRemoteRepos([]), [])
})

test('repo probes tolerate junk and an unauthenticated CLI', () => {
  assert.deepEqual(gitlabRepoInfo({ default_branch: 'master' }), { defaultBranch: 'master' })
  assert.deepEqual(gitlabRepoInfo({ default_branch: null }), {})
  assert.deepEqual(gitlabRepoInfo(undefined), {})
  assert.deepEqual(githubRepoInfo({ defaultBranchRef: { name: 'main' } }), { defaultBranch: 'main' })
  assert.deepEqual(githubRepoInfo({ defaultBranchRef: null }), {})
  assert.deepEqual(githubRepoInfo([]), {})
  assert.equal(githubLogin('sjet47\n'), 'sjet47')
  assert.equal(githubLogin('  Sjet47  '), 'sjet47')
  assert.equal(githubLogin(''), undefined)
})

test.after(() => rmSync(dir, { recursive: true, force: true }))
