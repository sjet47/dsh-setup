import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, fileHeartbeat } from '../lib/index.js'
import {
  buildHeartbeatArgs,
  getStateFilePath,
  HeartbeatTracker,
  pruneStateFiles,
  shouldSendSessionHeartbeat,
  shouldTrackTool,
} from '../lib/heartbeat.js'

const cwd = '/work/project'

test('config exposes the tunables', () => {
  const defaults = Config()
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.sessionHeartbeatIntervalMs, 60_000)
  assert.equal(defaults.retentionDays, 30)
  assert.equal(defaults.trackSubagents, false)
})

test('read maps to a file heartbeat without line changes', () => {
  const heartbeat = fileHeartbeat('read', { file_path: 'src/a.ts' }, cwd)
  assert.deepEqual(heartbeat, {
    type: 'file',
    entity: '/work/project/src/a.ts',
    projectFolder: cwd,
    category: 'coding',
    sourceEvent: 'PostToolUse',
  })
})

test('write counts content lines and keeps dsh snake_case arguments', () => {
  const heartbeat = fileHeartbeat('write', { file_path: '/tmp/x.ts', content: 'a\nb\nc' }, cwd)
  assert.equal(heartbeat.isWrite, true)
  assert.equal(heartbeat.lineChanges, 3)
  assert.equal(heartbeat.entity, '/tmp/x.ts')
})

test('edit estimates line changes from old_string/new_string', () => {
  const heartbeat = fileHeartbeat('edit', { file_path: 'a.ts', old_string: 'one', new_string: 'one\ntwo\nthree' }, cwd)
  assert.equal(heartbeat.isWrite, true)
  assert.equal(heartbeat.lineChanges, 3)
})

test('non-file tools and pathless calls produce no heartbeat', () => {
  assert.equal(fileHeartbeat('bash', { command: 'ls' }, cwd), undefined)
  assert.equal(fileHeartbeat('write', {}, cwd), undefined)
  assert.equal(fileHeartbeat('edit', { file_path: '' }, cwd), undefined)
})

test('read_image is tracked, so its heartbeat is reachable', () => {
  assert.equal(shouldTrackTool('read_image'), true)
  assert.equal(shouldTrackTool('bash'), false)
  const heartbeat = fileHeartbeat('read_image', { file_path: 'shot.png' }, cwd)
  assert.equal(heartbeat.entity, '/work/project/shot.png')
})

test('session heartbeats respect an injected throttle window', () => {
  assert.equal(shouldSendSessionHeartbeat(1_000, undefined, 60_000), true)
  assert.equal(shouldSendSessionHeartbeat(30_000, 10_000, 60_000), false)
  assert.equal(shouldSendSessionHeartbeat(80_000, 10_000, 60_000), true)
})

test('state files live in the dsh-specific directory', () => {
  const path = getStateFilePath('session-abc', '/tmp/state')
  assert.equal(path, '/tmp/state/session-abc.json')
  assert.ok(!path.includes('pi-wakatime-state'))
})

function stateDirFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wakatime-state-'))
  writeFileSync(join(dir, 'fresh.json'), '{}', 'utf8')
  writeFileSync(join(dir, 'stale.json'), '{}', 'utf8')
  writeFileSync(join(dir, 'notes.txt'), 'keep me', 'utf8')
  const past = Date.now() / 1000 - 60 * 24 * 60 * 60
  utimesSync(join(dir, 'stale.json'), past, past)
  return dir
}

test('pruning removes only old throttle records', () => {
  const dir = stateDirFixture()
  try {
    assert.equal(pruneStateFiles(dir, 30), 1)
    const left = readdirSync(dir).sort()
    assert.deepEqual(left, ['fresh.json', 'notes.txt'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('retention 0 keeps every record', () => {
  const dir = stateDirFixture()
  try {
    assert.equal(pruneStateFiles(dir, 0), 0)
    assert.equal(readdirSync(dir).length, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a queued session heartbeat supersedes the older one for the same session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wakatime-tracker-'))
  const calls = []
  let now = 1_000_000
  const tracker = new HeartbeatTracker({
    dependencies: { getCliLocation: () => '/fake/wakatime-cli', checkAndInstallCli: async () => '/fake/wakatime-cli' },
    plugin: 'dsh-test',
    stateDir: dir,
    now: () => now,
    // Hold the first CLI call so the second heartbeat queues behind it.
    execFile: (file, args, options, callback) => {
      calls.push(args)
      if (calls.length === 1) setTimeout(() => callback(null, '', ''), 5)
      else callback(null, '', '')
    },
  })
  try {
    const request = { type: 'session', entity: '/work/.dsh-session', projectFolder: '/work', stateKey: 'session-1' }
    tracker.track(request)
    tracker.track(request)
    tracker.track(request)
    await new Promise((resolve) => setTimeout(resolve, 40))
    // In-flight de-duplication plus queue coalescing: never three calls.
    assert.ok(calls.length <= 2, `expected at most 2 CLI calls, got ${calls.length}`)
    assert.equal(readdirSync(dir).includes('session-1.json'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the queue has a bounded depth', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wakatime-queue-'))
  let release
  const blocked = new Promise((resolve) => {
    release = resolve
  })
  let calls = 0
  const tracker = new HeartbeatTracker({
    dependencies: { getCliLocation: () => '/fake/wakatime-cli', checkAndInstallCli: async () => '/fake/wakatime-cli' },
    plugin: 'dsh-test',
    stateDir: dir,
    maxQueueDepth: 3,
    execFile: (_file, _args, _options, callback) => {
      calls += 1
      void blocked.then(() => callback(null, '', ''))
    },
  })
  try {
    for (let index = 0; index < 20; index += 1) {
      tracker.track({ type: 'file', entity: `/work/f${index}.ts`, projectFolder: '/work', category: 'coding' })
    }
    release()
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.ok(calls <= 4, `expected the queue to stay bounded, got ${calls} calls`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('heartbeat args mark session entities as unsaved', () => {
  const args = buildHeartbeatArgs({
    cliPath: 'cli',
    plugin: 'dsh-test',
    request: { type: 'session', entity: '/work/.dsh-session', projectFolder: '/work', stateKey: 's' },
  })
  assert.ok(args.includes('--is-unsaved-entity'))
  const fileArgs = buildHeartbeatArgs({
    cliPath: 'cli',
    plugin: 'dsh-test',
    request: { type: 'file', entity: '/work/a.ts', isWrite: true, lineChanges: 4 },
  })
  assert.ok(fileArgs.includes('--write'))
  assert.ok(fileArgs.includes('ai coding'))
})
