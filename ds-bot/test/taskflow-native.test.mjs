import assert from 'node:assert/strict'
import test from 'node:test'
import { taskMessageOf, nativeTaskSource, validateTaskEvent } from '../src/shared/taskflow-message.js'
import { installTaskProjection, TASK_NODE_KIND } from '../src/client/task-projection.js'
import { groupTaskRecord } from '../src/shared/group-task-record.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const task = { planId: 'p', cardId: 'write', event: 'assigned', from: { id: 'chief', name: 'Chief' }, to: { id: 'writer', name: 'Writer' } }

test('native task source is versioned and preserves typed identity without a Bot message envelope', () => {
  const source = nativeTaskSource('room', task, { exchangeId: 'delivery' })
  assert.equal(source.kind, 'taskflow')
  assert.equal(source.version, 1)
  assert.equal(source.role, 'post')
  assert.notEqual(source.form, 'relay')
  const message = createUserMessage({ source, content: [{ type: 'text', text: 'Actual input' }] })
  assert.equal(message.source.kind, 'taskflow')
  assert.deepEqual(taskMessageOf(JSON.parse(JSON.stringify(message))), task)
  assert.deepEqual(taskMessageOf({ source }), task)
  assert.equal(validateTaskEvent({ ...task, from: {} }), null)
  assert.throws(() => nativeTaskSource('room', { ...task, planId: '' }), /task/i)
  assert.equal(taskMessageOf({ source: { ...source, version: 100 } }), null)
  assert.equal(taskMessageOf({ source: { ...source, taskflowEvent: {} } }), null)
  assert.equal(groupTaskRecord({ kind: 'task', taskSchemaVersion: 1, taskflowEvent: task, text: 'Real' }, {}).kind, 'task')
  assert.equal(groupTaskRecord({ kind: 'task', taskSchemaVersion: 1, taskflowEvent: {}, text: 'Broken' }, {}).kind, 'task-error')
})

test('native task projection persists the task kind and handles malformed native payloads without ordinary Bot fallback', () => {
  let projection
  const dispose = () => {}
  assert.equal(installTaskProjection({ uiConversation: { events: { register: value => { projection = value; return dispose } } } }), dispose)
  const source = nativeTaskSource('room', task, { exchangeId: 'native-delivery' })
  const event = { type: 'user/message', seq: 7, time: 123, data: { source, content: [{ type: 'text', text: 'Actual task body' }] } }
  const matched = projection.match['user/message'](event)
  assert.ok(matched)
  const state = projection.start({}, { event })
  const node = projection.buildViewNode({ key: 'node', id: matched.id, state, start: { event, location: {} } })
  assert.equal(node.kind, TASK_NODE_KIND)
  assert.equal(node.data.task.planId, 'p')
  assert.equal(node.data.text, 'Actual task body')
  const broken = { ...event, data: { ...event.data, source: { ...source, taskflowEvent: {} } } }
  const errorState = projection.start({}, { event: broken })
  assert.equal(errorState.error, true)
  assert.equal(errorState.task, null)
  assert.equal(projection.match['user/message']({ ...event, data: { ...event.data, source: { kind: 'bot' } } }), null)
})
