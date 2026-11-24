import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture } from './taskflow-fixture.mjs'
import { buildToolDefinitions } from '../src/host/taskflow/tools.js'

const reflection = '## 做了什么\n核实资料。\n## 为什么这么做\n确保准确。\n## 里面的错误怎么避免\n逐条核对来源。\n## 要在下次任务中做的更好我需要什么\n保留来源清单。'

test('native tools deliver an assigned card, result card and saved-note card with verified sender and recipient', async () => {
  const env = fixture()
  try {
    const planned = env.service.plan({ planId: 'card-loop', goal: 'Write and review',
      children: [{ id: 'write', member: 'Writer', goal: 'Write the evidence-backed report', dependencies: [] }] }, env.admin)
    await env.service.dispatch({ planId: planned.plan.plan_id }, env.admin)
    const assigned = env.posts[0]
    assert.equal(assigned.taskflowEvent?.event, 'assigned')
    assert.equal(assigned.taskflowEvent?.from.id, 'bot-admin')
    assert.equal(assigned.taskflowEvent?.to.id, 'bot-a')
    assert.equal(assigned.taskflowEvent?.goal, 'Write the evidence-backed report')
    await env.service.submit({ planId: planned.plan.plan_id, cardId: 'write', result: 'Verified result with source links.' }, env.memberA)
    const submitted = env.posts.at(-1)
    assert.equal(submitted.taskflowEvent?.event, 'submitted')
    assert.equal(submitted.taskflowEvent?.from.id, 'bot-a')
    assert.equal(submitted.taskflowEvent?.to.id, 'bot-admin')
    assert.match(submitted.text, /Verified result with source links/)
    await env.service.accept({ planId: planned.plan.plan_id, cardId: 'write' }, env.admin)
    env.service.finish({ planId: planned.plan.plan_id }, env.admin)
    const tool = buildToolDefinitions(value => value, env.service).find(tool => tool.name === 'taskflow_sleep_note')
    const result = JSON.parse(await tool.execute({ planId: planned.plan.plan_id, cardId: 'write', text: reflection }, env.memberA))
    assert.equal(result.success, true)
    const noted = env.posts.at(-1)
    assert.equal(noted.taskflowEvent?.event, 'reflection')
    assert.equal(noted.taskflowEvent?.cardId, 'write')
    assert.equal(noted.taskflowEvent?.to.id, 'bot-admin')
    assert.match(noted.text, /要在下次任务中做的更好我需要什么/)
    assert.equal(env.scheduler.listNotes(planned.plan.plan_id)[0].text, reflection)
  } finally { env.cleanup() }
})

test('a refused or invalid reflection cannot emit a saved-note task card', async () => {
  const env = fixture()
  try {
    env.service.plan({ planId: 'pending', goal: 'Write', children: [{ id: 'write', member: 'Writer', goal: 'Write', dependencies: [] }] }, env.admin)
    const tool = buildToolDefinitions(value => value, env.service).find(tool => tool.name === 'taskflow_sleep_note')
    const result = JSON.parse(await tool.execute({ planId: 'pending', cardId: 'write', text: 'I say this succeeded' }, env.memberA))
    assert.equal(result.success, false)
    assert.equal(env.posts.length, 0)
    assert.equal(env.scheduler.listNotes('pending').length, 0)
  } finally { env.cleanup() }
})

test('a note notification failure reports delivery separately from the successfully saved note', async () => {
  const env = fixture()
  try {
    env.service.plan({ planId: 'saved', goal: 'Write', children: [{ id: 'write', member: 'Writer', goal: 'Write', dependencies: [] }] }, env.admin)
    await env.service.dispatch({ planId: 'saved' }, env.admin)
    await env.service.submit({ planId: 'saved', cardId: 'write', result: 'Done' }, env.memberA)
    await env.service.accept({ planId: 'saved', cardId: 'write' }, env.admin)
    env.service.finish({ planId: 'saved' }, env.admin)
    env.service.post = async () => { throw new Error('delivery unavailable') }
    const tool = buildToolDefinitions(value => value, env.service).find(tool => tool.name === 'taskflow_sleep_note')
    const result = JSON.parse(await tool.execute({ planId: 'saved', cardId: 'write', text: reflection }, env.memberA))
    assert.equal(result.success, true)
    assert.equal(result.notification.sent, false)
    assert.equal(env.scheduler.listNotes('saved')[0].text, reflection)
    assert.equal(env.scheduler.events('saved').filter(event => event.type === 'note_saved').length, 1)
  } finally { env.cleanup() }
})

test('a result card returns to the live principal after a leadership change', async () => {
  const env = fixture()
  try {
    env.service.plan({ planId: 'leader', goal: 'Write', children: [{ id: 'write', member: 'Writer', goal: 'Write', dependencies: [] }] }, env.admin)
    await env.service.dispatch({ planId: 'leader' }, env.admin)
    env.rt.state.rooms['room-1'].admin = 'bot-b'
    await env.service.submit({ planId: 'leader', cardId: 'write', result: 'Done' }, env.memberA)
    assert.equal(env.posts.at(-1).taskflowEvent.to.id, 'bot-b')
    assert.match(env.posts.at(-1).text, /^@Reviewer /)
  } finally { env.cleanup() }
})
