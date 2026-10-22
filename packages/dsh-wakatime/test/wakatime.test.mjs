import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileHeartbeat } from '../lib/index.js'

const cwd = '/work/project'

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
