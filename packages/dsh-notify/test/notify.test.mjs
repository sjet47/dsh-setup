import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveBusTarget } from '../lib/dbus.js'
import { decodeMessage, encodeMessage, FIELD, MESSAGE_TYPE, signatureOf } from '../lib/marshal.js'
import { escapeMarkup } from '../lib/notifier.js'
import { watchingSession } from '../lib/presence.js'
import { collapsePreview, completionNotice } from '../lib/summary.js'

/** Encode one `Notify` call exactly as the notifier does. */
function encodeNotify({ appName = 'DSH', replacesId = 0, summary = 'Done', body = '', timeout = -1 } = {}) {
  const bodyValues = [
    { type: 'string', value: appName },
    { type: 'uint32', value: replacesId },
    { type: 'string', value: '' },
    { type: 'string', value: summary },
    { type: 'string', value: body },
    { type: 'string-array', values: [] },
    { type: 'dict', entries: [['urgency', { type: 'byte', value: 1 }]] },
    { type: 'int32', value: timeout },
  ]
  return encodeMessage(
    MESSAGE_TYPE.methodCall,
    7,
    [
      [FIELD.path, { type: 'object-path', value: '/org/freedesktop/Notifications' }],
      [FIELD.interface, { type: 'string', value: 'org.freedesktop.Notifications' }],
      [FIELD.member, { type: 'string', value: 'Notify' }],
      [FIELD.destination, { type: 'string', value: 'org.freedesktop.Notifications' }],
      [FIELD.signature, { type: 'signature', value: 'susssasa{sv}i' }],
    ],
    bodyValues,
  )
}

test('a Notify call round-trips through the wire format', () => {
  const message = decodeMessage(encodeNotify({ summary: '修复登录超时', body: '改了 3 个文件' }))
  assert.ok(message)
  assert.equal(message.type, MESSAGE_TYPE.methodCall)
  assert.equal(message.serial, 7)
  assert.equal(message.member, 'Notify')
  assert.equal(message.signature, 'susssasa{sv}i')
  assert.deepEqual(message.body, ['DSH', 0, '', '修复登录超时', '改了 3 个文件', [], [['urgency', 1]], -1])
})

test('the fixed header points at the body it declares', () => {
  const message = encodeNotify()
  // 'l', method call, flags 0, protocol version 1
  assert.deepEqual([...message.subarray(0, 4)], [0x6c, 1, 0, 1])
  const bodyLength = message.readUInt32LE(4)
  const fieldsLength = message.readUInt32LE(12)
  const bodyStart = 16 + fieldsLength + ((8 - ((16 + fieldsLength) % 8)) % 8)
  assert.equal(bodyLength, message.length - bodyStart)
  assert.equal(bodyLength > 0, true)
})

test('a truncated message waits for more bytes', () => {
  const message = encodeNotify()
  assert.equal(decodeMessage(message.subarray(0, 15)), undefined)
  assert.equal(decodeMessage(message.subarray(0, message.length - 1)), undefined)
  assert.equal(decodeMessage(message).length, message.length)
})

test('a method return decodes the notification id', () => {
  const reply = encodeMessage(MESSAGE_TYPE.methodReturn, 7, [
    [FIELD.replySerial, { type: 'uint32', value: 7 }],
    [FIELD.signature, { type: 'signature', value: 'u' }],
  ], [{ type: 'uint32', value: 4506 }])
  const message = decodeMessage(reply)
  assert.equal(message.type, MESSAGE_TYPE.methodReturn)
  assert.equal(message.replySerial, 7)
  assert.deepEqual(message.body, [4506])
})

test('a bus error reply decodes name and message', () => {
  const reply = encodeMessage(MESSAGE_TYPE.error, 9, [
    [FIELD.replySerial, { type: 'uint32', value: 8 }],
    [FIELD.errorName, { type: 'string', value: 'org.freedesktop.DBus.Error.UnknownMethod' }],
    [FIELD.signature, { type: 'signature', value: 's' }],
  ], [{ type: 'string', value: 'no such method' }])
  const message = decodeMessage(reply)
  assert.equal(message.errorName, 'org.freedesktop.DBus.Error.UnknownMethod')
  assert.deepEqual(message.body, ['no such method'])
})

test('signatures describe the tagged values', () => {
  assert.equal(signatureOf({ type: 'byte', value: 1 }), 'y')
  assert.equal(signatureOf({ type: 'string-array', values: [] }), 'as')
  assert.equal(signatureOf({ type: 'dict', entries: [] }), 'a{sv}')
  assert.equal(signatureOf({ type: 'object-path', value: '/' }), 'o')
})

test('the bus address prefers path, then abstract, then the per-user socket', () => {
  assert.deepEqual(resolveBusTarget('unix:path=/run/user/1000/bus'), { path: '/run/user/1000/bus' })
  assert.deepEqual(resolveBusTarget('unix:abstract=/tmp/dbus-abc,guid=ff'), { abstract: '/tmp/dbus-abc' })
  assert.deepEqual(resolveBusTarget('tcp:host=localhost,port=1234'), undefined)
  const fallback = resolveBusTarget('')
  assert.deepEqual(fallback, { path: `/run/user/${process.getuid()}/bus` })
})

test('a reply preview collapses whitespace and keeps a word boundary', () => {
  assert.equal(collapsePreview('line one\n\nline  two\t', 40), 'line one line two')
  assert.equal(collapsePreview(undefined, 40), '')
  assert.equal(collapsePreview('abcdef', 0), '')
  const long = 'alpha beta gamma delta epsilon zeta eta theta'
  const preview = collapsePreview(long, 20)
  assert.equal(preview.endsWith('…'), true)
  assert.equal(preview.length <= 21, true)
  assert.equal(preview.startsWith('alpha beta gamma'), true)
})

test('a completed turn notifies with the session title and preview', () => {
  const notice = completionNotice({
    title: '修复登录超时',
    reason: 'completed',
    text: '已定位到 refresh token 的过期判断。',
    errorMessage: undefined,
    previewChars: 80,
    notifyOnAbort: false,
  })
  assert.deepEqual(notice, { summary: '修复登录超时', body: '已定位到 refresh token 的过期判断。', urgency: 1 })
})

test('cancelled, forked and error turns pick their own wording', () => {
  const base = { title: 'T', text: 'reply', errorMessage: 'provider 429', previewChars: 80 }
  assert.equal(completionNotice({ ...base, reason: 'forked', notifyOnAbort: false }), undefined)
  assert.equal(completionNotice({ ...base, reason: 'aborted', notifyOnAbort: false }), undefined)
  assert.deepEqual(completionNotice({ ...base, reason: 'aborted', notifyOnAbort: true }), {
    summary: '⏹ T',
    body: 'reply',
    urgency: 1,
  })
  assert.deepEqual(completionNotice({ ...base, reason: 'error', notifyOnAbort: false }), {
    summary: '⚠ T',
    body: 'provider 429',
    urgency: 1,
  })
  assert.equal(completionNotice({ ...base, reason: 'interrupted', notifyOnAbort: false }).summary, '⏹ T')
  assert.equal(completionNotice({ ...base, reason: 'max-tokens', notifyOnAbort: false }).summary, '… T')
})

test('an untitled session falls back to DSH', () => {
  const notice = completionNotice({
    title: '',
    reason: 'completed',
    text: undefined,
    errorMessage: undefined,
    previewChars: 80,
    notifyOnAbort: false,
  })
  assert.deepEqual(notice, { summary: 'DSH', body: '', urgency: 1 })
})

test('markup in a reply is escaped for markup-capable daemons', () => {
  assert.equal(escapeMarkup('a < b && c > d'), 'a &lt; b &amp;&amp; c &gt; d')
  assert.equal(escapeMarkup('plain'), 'plain')
})

test('a finished run stays quiet only while it is on a focused screen', () => {
  const now = 1_000_000
  const ttl = 8_000
  const watching = { sessionId: 's1', active: true, at: now - 1_000 }
  assert.equal(watchingSession(watching, 's1', now, ttl), true)
  // A closed tab leaves its last report behind; it must not silence anything.
  assert.equal(watchingSession(watching, 's1', now + ttl + 1, ttl), false)
  // The user switched away, or another window has focus.
  assert.equal(watchingSession({ ...watching, active: false }, 's1', now, ttl), false)
  // A different session finished.
  assert.equal(watchingSession(watching, 's2', now, ttl), false)
  // No page is attached at all.
  assert.equal(watchingSession({ sessionId: null, active: true, at: now }, 's1', now, ttl), false)
  assert.equal(watchingSession(undefined, 's1', now, ttl), false)
})

test('the report is trusted up to and including its ttl', () => {
  const now = 1_000_000
  const report = { sessionId: 's1', active: true, at: now - 8_000 }
  assert.equal(watchingSession(report, 's1', now, 8_000), true)
  assert.equal(watchingSession(report, 's1', now + 1, 8_000), false)
})
