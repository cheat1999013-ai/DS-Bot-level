import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { installSlotTrace, slotFailureFacts } from '../src/client/slot-trace.js'
const app = createRequire(new URL('../../app/package.json', import.meta.url))
const { SlotCore } = app('@deepseek-ai/dsh-client-ui-slots')

test('public slot observer records real winner changes and the exact retired registration without modifying other cells', async () => {
  const core = new SlotCore()
  core.register({ name: 'root', children: { 'conversation.chat.node': { kind: 'keyed', scope: 'root' } } }, () => null)
  function NativeTrigger() {}
  function BotTrigger() {}
  core.register({ name: 'conversation.chat.node', key: 'turn-trigger', registrant: 'native-chat' }, NativeTrigger)
  core.register({ name: 'conversation.chat.node', key: 'turn-trigger', priority: -100, registrant: 'ds-bot' }, BotTrigger)
  core.register({ name: 'conversation.chat.node', key: 'turn-error' }, () => null)
  const traces = []; let changed; let unsubscribed = 0
  const slots = { entries: key => core.entries(key), entriesOfSlot: key => core.entriesOfSlot(key),
    onEntryError: fn => core.onEntryError(fn), subscribe: (_key, fn) => { changed = fn; return () => { unsubscribed += 1 } } }
  const stop = installSlotTrace(slots, { getFacts: () => ({ ready: true, mainIsRoom: true, message: 'DO_NOT_LOG_BODY' }), write: value => traces.push(value) })
  const before = core.entriesOfSlot('conversation.chat.node')
  const failed = before.find(e => e.options.key === 'turn-trigger')
  assert.equal(failed.component, BotTrigger)
  const error = new TypeError("Cannot read properties of undefined (reading 'code')")
  error.stack = "TypeError: credential-and-message-DO_NOT_LOG_BODY\n    at NativeTurnError (dsh-app://secret-location/?token=DO_NOT_LOG_TOKEN:540:21)"
  core.reportEntryError('conversation.chat.node', failed, error, { abdicate: true })
  changed(); await Promise.resolve()
  const crash = traces.find(row => row.phase === 'crash')
  assert.equal(crash.entry.registrant, 'ds-bot')
  assert.equal(crash.entry.component, 'BotTrigger')
  assert.equal(crash.failure.read, 'undefined.code')
  assert.deepEqual(crash.failure.frames, [{ function: 'NativeTurnError', line: 540, column: 21 }])
  assert.equal(crash.abdicated, true)
  assert.equal(core.entriesOfSlot('conversation.chat.node').find(e => e.options.key === 'turn-trigger').component, NativeTrigger)
  assert.equal(core.entriesOfSlot('conversation.chat.node').find(e => e.options.key === 'turn-error'), before.find(e => e.options.key === 'turn-error'))
  assert.doesNotMatch(JSON.stringify(traces), /DO_NOT_LOG|secret-location|token=|dsh-app:/)
  stop(); assert.equal(unsubscribed, 1)
  const size = traces.length; changed(); await Promise.resolve(); assert.equal(traces.length, size)
})

test('unsupported diagnostics and a failing writer cannot change application behavior or expose arbitrary error messages', () => {
  assert.doesNotThrow(() => installSlotTrace({})())
  const facts = slotFailureFacts(new Error('DO_NOT_LOG_PROVIDER_BODY'))
  assert.doesNotMatch(JSON.stringify(facts), /DO_NOT_LOG_PROVIDER_BODY/)
  let callback
  const slots = { entriesOfSlot: () => [], onEntryError: fn => { callback = fn; return () => {} } }
  const off = installSlotTrace(slots, { write: () => { throw Error('Broken diagnostic sink') } })
  assert.doesNotThrow(() => callback('conversation.chat.node', {}, new TypeError('Other error'), { abdicated: true }))
  assert.doesNotThrow(off)
})

test('review boundaries reject arbitrary entry labels, error families and stack prose', () => {
  let callback
  const records = []
  const entry = { options: { key: 'turn-trigger', registrant: 'DO_NOT_LOG/body token' }, component: { displayName: 'DO_NOT_LOG body/path' } }
  const stop = installSlotTrace({ entriesOfSlot: () => [entry], onEntryError: fn => { callback = fn; return () => {} } }, { write: value => records.push(value) })
  const error = new TypeError("Cannot read properties of null (reading 'planId')")
  error.stack = "TypeError: DO_NOT_LOG\n    at DO_NOT_LOG prose <value> (https://private.test/?token=DO_NOT_LOG:21:4)"
  callback('conversation.chat.node', entry, error, {})
  const crash = records.find(row => row.phase === 'crash')
  assert.equal(crash.entry.component, 'anonymous')
  assert.equal(crash.entry.registrant, 'other')
  assert.deepEqual(crash.failure.frames, [{ function: 'anonymous', line: 21, column: 4 }])
  for (const value of [new Error(error.message), new ReferenceError(error.message), new RangeError(error.message), new TypeError('Other message')]) {
    value.stack = error.stack
    assert.deepEqual(slotFailureFacts(value), { type: 'other' })
  }
  assert.doesNotMatch(JSON.stringify(records), /DO_NOT_LOG|private.test|token=/)
  stop()
})

test('missing or throwing queueMicrotask never escapes the observable notification', () => {
  const original = globalThis.queueMicrotask
  let changed
  const stop = installSlotTrace({ entriesOfSlot: () => [], onEntryError: () => () => {}, subscribe: (_key, fn) => { changed = fn; return () => {} } })
  try {
    globalThis.queueMicrotask = undefined
    assert.doesNotThrow(changed)
    globalThis.queueMicrotask = () => { throw Error('Unavailable scheduler') }
    assert.doesNotThrow(changed)
  } finally { globalThis.queueMicrotask = original; stop() }
})
