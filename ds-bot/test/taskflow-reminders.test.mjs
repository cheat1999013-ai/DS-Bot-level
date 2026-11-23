import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture } from './taskflow-fixture.mjs'
import { buildToolDefinitions } from '../src/host/taskflow/tools.js'
import { createTaskflowRecovery } from '../src/host/taskflow/recovery.js'
import { Scheduler } from '../src/host/taskflow/scheduler.js'
import { install } from '../src/host/taskflow.js'

async function setup(stage = 'running') {
  const env = fixture()
  let now = 1000
  env.scheduler.clock = () => now
  env.service.plan({ planId: 'reminded', goal: 'Finish the original work', children: [
    { id: 'write', member: 'Writer', goal: 'Write a real result', dependencies: [] },
  ] }, env.admin)
  if (stage !== 'pending') await env.service.dispatch({ planId: 'reminded' }, env.admin)
  if (['submitted', 'verified', 'completed'].includes(stage)) {
    await env.service.submit({ planId: 'reminded', cardId: 'write', result: 'Actual fixture result' }, env.memberA)
  }
  if (['verified', 'completed'].includes(stage)) await env.service.accept({ planId: 'reminded', cardId: 'write' }, env.admin)
  if (stage === 'completed') env.service.finish({ planId: 'reminded' }, env.admin)
  env.posts.length = 0
  const recovery = createTaskflowRecovery(env.rt, env.botState, () => env.scheduler)
  const post = () => recovery.post(env.service, env.botState.room('room-1'), env.scheduler.planState('reminded'), 'write', 'reminder')
  return { ...env, recovery, post, advance: seconds => { now += seconds } }
}

test('finishing a collection plan prompts the principal to assess the wider goal', async () => {
  const env = await setup('verified')
  try {
    const finish = buildToolDefinitions(value => value, env.service).find(tool => tool.name === 'taskflow_finish')
    const result = JSON.parse(await finish.execute({ planId: 'reminded' }, env.admin))
    assert.equal(result.success, true)
    assert.equal(result.next, 'taskflow_sleep_consolidate')
    assert.match(result.followUp, /整体目标/)
    assert.match(result.followUp, /其他.*成员/)
    assert.match(result.followUp, /重复/)
    assert.equal(env.scheduler.planState('reminded').status, 'completed')
    env.service.plan({ planId: 'follow-up', goal: 'Continue the wider goal', children: [
      { id: 'review', member: 'Reviewer', goal: 'Review the result', dependencies: [] },
    ] }, env.admin)
    const old = env.service.sleepPending({ planId: 'reminded' }, env.admin)
    assert.equal(old.plan_id, 'reminded', 'explicit old plan survives current pointer change')
    const list = buildToolDefinitions(value => value, env.service).find(tool => tool.name === 'taskflow_plans')
    const recent = JSON.parse(await list.execute({}, env.admin))
    assert.equal(recent.success, true)
    assert.equal(recent.autoFollowUpEnabled, true)
    env.rt.state.rooms['room-1'].taskflowEnabled = false
    assert.equal(JSON.parse(await list.execute({}, env.admin)).autoFollowUpEnabled, false)
    env.rt.state.rooms['room-1'].taskflowEnabled = true
    env.rt.state.rooms['room-1'].goal = { status: 'paused' }
    assert.equal(JSON.parse(await list.execute({}, env.admin)).autoFollowUpEnabled, false)
    assert.deepEqual(new Set(recent.plans.map(plan => plan.plan_id)), new Set(['reminded', 'follow-up']))
    assert.equal(JSON.parse(await list.execute({}, env.memberA)).error, 'leader_only')
    assert.match(result.followUp, /显式传入/)
    assert.match(result.followUp, /最近20个/)
  } finally { env.cleanup() }
})

test('unfinished plans remind the current principal once per five minutes, including exact boundaries', async () => {
  const env = await setup()
  try {
    assert.equal(await env.post(), false)
    env.advance(299)
    assert.equal(await env.post(), false)
    env.advance(1)
    assert.equal(await env.post(), true)
    assert.equal(env.posts.length, 1)
    const event = env.posts[0].taskflowEvent
    assert.equal(event.event, 'recovery')
    assert.equal(event.recovery.kind, 'reminder')
    assert.equal(event.to.id, 'bot-admin')
    assert.match(env.posts[0].text, /taskflow_results/)
    assert.match(env.posts[0].text, /催|督促/)
    assert.equal(env.recovery.claim('room-2', 'bot-admin', event), false)
    assert.equal(env.recovery.claim('room-1', 'bot-a', event), false)
    assert.equal(env.recovery.claim('room-1', 'bot-admin', event), true)
    assert.equal(env.recovery.claim('room-1', 'bot-admin', event), false)
    env.advance(299)
    assert.equal(await env.post(), false)
    env.advance(1)
    assert.equal(await env.post(), true)
    assert.equal(env.posts.length, 2)
    assert.notEqual(env.posts[1].taskflowEvent.recovery.key, event.recovery.key)
    assert.equal(env.scheduler.cardView('reminded', 'write').attempts, 1)
    assert.equal(env.scheduler.cardView('reminded', 'write').state, 'running')
  } finally { env.cleanup() }
})

test('a live executor suppresses reminders only in its group and an idle running card still gets a reminder', async () => {
  const env = await setup()
  try {
    const room = env.botState.room('room-1')
    room.sessions = { 'bot-a': 'worker-group-session' }
    env.rt.live = new Map([['worker-group-session', { turn: 'working' }]])
    env.advance(300)
    assert.equal(await env.post(), false)
    assert.equal(env.posts.length, 0)
    env.rt.live.clear()
    env.rt.live.set('worker-other-room', { turn: 'unrelated work' })
    assert.equal(await env.post(), true)
    const event = env.posts[0].taskflowEvent
    env.rt.live.set('worker-group-session', { turn: 'resumed' })
    assert.equal(env.recovery.claim('room-1', 'bot-admin', event), false)
    env.rt.live.delete('worker-group-session')
    assert.equal(env.recovery.claim('room-1', 'bot-admin', event), true)
  } finally { env.cleanup() }
})

for (const stage of ['pending', 'submitted', 'verified']) test(`${stage} work remains incomplete and gets a principal disposition reminder`, async () => {
  const env = await setup(stage)
  try {
    const before = env.scheduler.planState('reminded')
    env.advance(300)
    assert.equal(await env.post(), true)
    assert.deepEqual(env.scheduler.planState('reminded'), before)
    assert.match(env.posts[0].text, stage === 'verified' ? /taskflow_finish/ : /taskflow_results/)
  } finally { env.cleanup() }
})

test('completed and cancelled plans do not send or admit a delayed reminder', async () => {
  for (const disposition of ['completed', 'cancelled']) {
    const env = await setup('verified')
    try {
      env.advance(300)
      assert.equal(await env.post(), true)
      const event = env.posts[0].taskflowEvent
      if (disposition === 'completed') env.service.finish({ planId: 'reminded' }, env.admin)
      else {
        env.scheduler.requestCancel('reminded', { principal: 'bot-admin', reason: 'User cancelled' })
        env.scheduler.finishCancel('reminded', { principal: 'bot-admin' })
      }
      assert.equal(env.recovery.claim('room-1', 'bot-admin', event), false)
      env.posts.length = 0
      env.advance(300)
      assert.equal(await env.post(), false)
      assert.equal(env.posts.length, 0)
    } finally { env.cleanup() }
  }
})

test('reminder cadence survives reopen and an ambiguous send is not repeated in the same period', async () => {
  const env = await setup()
  let reopened
  try {
    env.advance(300)
    const send = env.service.post
    env.service.post = async args => { await send(args); throw Error('send succeeded then interrupted') }
    await assert.rejects(env.post(), /send succeeded then interrupted/)
    env.service.post = send
    reopened = new Scheduler(env.scheduler.path, { recoverOnOpen: false, clock: env.scheduler.clock })
    const recovery = createTaskflowRecovery(env.rt, env.botState, () => reopened)
    const post = () => recovery.post(env.service, env.botState.room('room-1'), reopened.planState('reminded'), 'write', 'reminder')
    assert.equal(await post(), false)
    env.advance(300)
    assert.equal(await post(), true)
    assert.equal(env.posts.length, 2)
  } finally { reopened?.close(); env.cleanup() }
})

test('leadership transfer routes the next reminder to the new current principal and rejects the old one', async () => {
  const env = await setup()
  try {
    env.advance(300)
    await env.post()
    const old = env.posts[0].taskflowEvent
    env.scheduler.transferPrincipal('room-1', 'bot-admin', 'bot-b')
    env.rt.state.rooms['room-1'].admin = 'bot-b'
    assert.equal(env.recovery.claim('room-1', 'bot-admin', old), false)
    assert.equal(await env.post(), true)
    const current = env.posts[1].taskflowEvent
    assert.equal(current.to.id, 'bot-b')
    env.rt.readOnly = () => 'locked'
    assert.equal(env.recovery.claim('room-1', 'bot-b', current), false)
    assert.equal(await env.post(), false)
    env.rt.readOnly = () => undefined
    assert.equal(env.recovery.claim('room-1', 'bot-b', current), true)
  } finally { env.cleanup() }
})

for (const transition of ['completion', 'executor startup']) test(`${transition} during asynchronous Host post preparation suppresses the reminder`, async () => {
  const env = await setup(transition === 'completion' ? 'verified' : 'pending')
  const effects = [], sends = []
  try {
    env.rt.ctx.effect = register => effects.push(register())
    env.rt.postTaskToRoom = async (...args) => sends.push(args)
    install(env.rt)
    await env.rt.taskflowView({ room: 'room-1' })
    env.scheduler.db.prepare('UPDATE plans SET created_at=? WHERE plan_id=?').run(Date.now() / 1000 - 301, 'reminded')
    let loads = 0
    env.rt.load = async () => {
      if (++loads !== 3) return
      if (transition === 'completion') env.service.finish({ planId: 'reminded' }, env.admin)
      else {
        await env.service.dispatch({ planId: 'reminded' }, env.admin)
        env.botState.room('room-1').sessions = { 'bot-a': 'worker-group-session' }
        env.rt.live = new Map([['worker-group-session', { turn: 'started' }]])
      }
    }
    assert.deepEqual(await env.rt.taskflowCheck(), [])
    assert.equal(env.scheduler.planState('reminded').status, transition === 'completion' ? 'completed' : 'open')
    assert.equal(sends.length, 0)
  } finally { for (const dispose of effects) dispose?.(); env.cleanup() }
})
