import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { confirmedLegacyTask, taskMessageOf } from '../src/shared/taskflow-message.js'

const data = { seq: 12, time: 1001000, source: { kind: 'user', rpcId: 'legacy-call' },
  content: [{ type: 'text', text: '@Chief [Taskflow plan-1/image] 已提报，等待逐卡验收。' }] }
const event = { type: 'result_observed', plan_id: 'plan-1', card_id: 'image', principal_name: 'Chief', at: 1000, payload: { status: 'settled' } }
test('human-looking legacy notices require a matching settled ledger event and time', () => {
  assert.equal(taskMessageOf(data), null)
  assert.deepEqual(confirmedLegacyTask(data, { timeline: [event] }), { planId: 'plan-1', cardId: 'image', event: 'submitted' })
  for (const change of [{ plan_id: 'other' }, { card_id: 'review' }, { principal_name: 'Other' },
    { at: 2000 }, { at: 900 }, { payload: { status: 'failed' } }])
    assert.equal(confirmedLegacyTask(data, { timeline: [{ ...event, ...change }] }), null)
  assert.equal(confirmedLegacyTask({ ...data, source: { kind: 'user' } }, { timeline: [event] }), null)
  assert.equal(confirmedLegacyTask({ ...data, content: [{ type: 'text', text: 'Please quote: ' + data.content[0].text }] }, { timeline: [event] }), null)
})
test('new task messages retain task identity without changing human source records', () => {
  const task = { planId: 'plan-1', cardId: 'image' }
  assert.deepEqual(taskMessageOf({ source: { kind: 'bot', role: 'post', taskflowEvent: task } }), task)
  assert.equal(taskMessageOf({ ...data, source: { kind: 'bot', role: 'post' } }), null)
  assert.equal(taskMessageOf({ ...data, source: { kind: 'user', taskflowEvent: task } }), null)
  for (const invalid of [{}, [], { planId: ' leading-space' }, { planId: 'p', cardId: '' }, { planId: 'p', event: {} }]) {
    assert.equal(taskMessageOf({ source: { kind: 'bot', role: 'post', taskflowEvent: invalid } }), null)
  }
})

const { outputFiles } = await build({ stdin: { contents: "export { TaskInputCell, TaskMessage } from './src/client/task-message.js'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, bundle: true, format: 'cjs', platform: 'browser', write: false, external: ['react', '@deepseek-ai/dsh-client-ui-primitives'] })
const state = []
let cursor = 0
let effects = []
const module = { exports: {} }
const h = (type, props, ...children) => ({ type, props, children })
const requests = []
runInNewContext(outputFiles[0].text, { module, exports: module.exports,
  fetch: async (_url, options) => { requests.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ ok: true, value: { timeline: [event] } }) } },
  require: name => name === 'react'
  ? { createElement: h, useEffect: effect => effects.push(effect), useState: initial => { const index = cursor++; if (!(index in state)) state[index] = initial; return [state[index], value => { state[index] = value }] } }
  : { MarkdownText: 'MarkdownText' } })
const { TaskInputCell, TaskMessage } = module.exports
const NativeUser = () => null
const render = props => { cursor = 0; effects = []; return TaskInputCell(props) }
test('legacy task verification swaps only the confirmed row and keeps the native fallback', async () => {
  let reads = 0
  const loadTaskflow = async room => { assert.equal(room, 'room'); reads++; return { timeline: [event] } }
  const props = { node: { data }, sessionId: 'room', loadTaskflow, Fallback: NativeUser }
  assert.equal(render(props).type, NativeUser)
  effects.forEach(effect => effect())
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(render(props).type, TaskMessage)
  assert.equal(reads, 1)
  assert.equal(render({ ...props, sessionId: 'another-room' }).type, NativeUser)
  assert.equal(render({ ...props, node: { data: { seq: 99, source: { kind: 'user' }, content: [{ type: 'text', text: 'My real message' }] } } }).type, NativeUser)
})
test('the production legacy path reads the actual taskflow-state API', async () => {
  const props = { node: { data: { ...data, seq: 88 } }, sessionId: 'room', Fallback: NativeUser }
  assert.equal(render(props).type, NativeUser)
  effects.forEach(effect => effect())
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(render(props).type, TaskMessage)
  assert.deepEqual(requests, [{ endpoint: 'taskflow-state', payload: { room: 'room' } }])
})
test('a later legacy notice reads the current ledger rather than a permanently cached board', async () => {
  let reads = 0
  let timeline = [event]
  const loadTaskflow = async () => { reads++; return { timeline } }
  const props = { node: { data: { ...data, seq: 101 } }, sessionId: 'room', Fallback: NativeUser, loadTaskflow }
  render(props)
  effects.forEach(effect => effect())
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(render(props).type, TaskMessage)
  timeline = [{ ...event, card_id: 'review' }]
  const next = { ...props, node: { data: { ...data, seq: 102, content: [{ type: 'text', text: '@Chief [Taskflow plan-1/review] 已提报，等待逐卡验收。' }] } } }
  assert.equal(render(next).type, NativeUser)
  effects.forEach(effect => effect())
  await new Promise(resolve => setImmediate(resolve))
  const result = render(next)
  assert.equal(result.type, TaskMessage)
  assert.equal(result.props.task.cardId, 'review')
  assert.equal(reads, 2)
})
test('task presentation has a task header and no user bubble classes', () => {
  const view = TaskMessage({ task: { planId: 'plan-1', cardId: 'image' }, text: data.content[0].text })
  assert.equal(view.type, 'article')
  assert.equal(view.props.className, 'bt-task-message')
  assert.equal(view.props['data-task-reference'], 'plan-1/image')
  assert.equal(view.children[0].children[0].children[0], 'Bot task')
  assert.doesNotMatch(JSON.stringify(view), /bt-urow|bt-umsg|bt-ububble/)
})

test('task cards distinguish assignment, returned result and saved reflection with the same reference', () => {
  for (const [event, label] of [['assigned', 'Task assigned'], ['submitted', 'Result submitted'], ['reflection', 'Reflection submitted']]) {
    const task = { planId: 'plan-1', cardId: 'image', event, from: { name: 'Writer' }, to: { name: 'Chief' } }
    const view = TaskMessage({ task, text: '@Chief [Taskflow plan-1/image] Actual content' })
    assert.equal(view.props['data-task-reference'], 'plan-1/image')
    assert.equal(view.children[0].children[0].children[0], label)
    assert.match(JSON.stringify(view), /Writer → Chief/)
    assert.doesNotMatch(JSON.stringify(view), /@Chief \[Taskflow/)
    assert.match(JSON.stringify(view), /Actual content/)
  }
})
