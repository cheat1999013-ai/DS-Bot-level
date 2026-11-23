import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture } from './taskflow-fixture.mjs'
import { install } from '../src/host/taskflow.js'
import { Scheduler } from '../src/host/taskflow/scheduler.js'

function host() {
  const env = fixture(), effects = [], posts = []
  env.rt.ctx.effect = register => effects.push(register())
  env.rt.postTaskToRoom = async (_room, _sender, text, options) => posts.push({ text, event: options?.taskflowEvent })
  install(env.rt)
  return { ...env, posts, async open() { await env.rt.taskflowView({ room: 'room-1' }) },
    stop() { for (const dispose of effects) dispose?.(); env.cleanup() } }
}

async function assign(env) {
  await env.open()
  env.service.plan({ planId: 'exhaustion', children: [
    { id: 'write', member: 'Writer', goal: 'Produce a real result', dependencies: [] },
    { id: 'review', member: 'Reviewer', goal: 'Review the result', dependencies: ['write'] },
  ] }, env.admin)
  await env.service.dispatch({ planId: 'exhaustion' }, env.admin)
}

function exhaust(env) {
  assert.equal(env.rt.taskflowContinuation('group-a').exhausted, false)
  assert.equal(env.rt.taskflowContinuation('group-a').exhausted, false)
  assert.equal(env.rt.taskflowContinuation('group-a').exhausted, true)
}

test('exhaustion recovery requires a persisted current-attempt obligation and retains missing results', async () => {
  const env = host()
  try {
    await assign(env)
    await env.rt.taskflowSweep()
    assert.equal(env.posts.length, 0, 'a worker still working must not produce recovery')
    exhaust(env)
    await env.rt.taskflowSweep()
    assert.equal(env.posts.length, 1)
    const { event, text } = env.posts[0]
    assert.equal(event.recovery.kind, 'exhausted')
    assert.equal(event.to.id, 'bot-admin')
    assert.equal(event.cardId, 'write')
    assert.match(text, /taskflow_results/)
    assert.equal(env.scheduler.planState('exhaustion').status, 'open')
    assert.equal(env.scheduler.cardView('exhaustion', 'write').state, 'running')
    assert.equal(env.scheduler.cardView('exhaustion', 'review').attempts, 0)
    assert.throws(() => env.scheduler.resultPayload('exhaustion', 'write'), /result_missing/)
    const claim = env.rt.taskflowClaimRecovery
    assert.equal(claim('room-2', 'bot-admin', event), false)
    assert.equal(claim('room-1', 'bot-a', event), false)
    assert.equal(claim('room-1', 'bot-admin', { ...event, recovery: { ...event.recovery, key: 'forged' } }), false)
    env.rt.readOnly = () => 'locked'
    assert.equal(claim('room-1', 'bot-admin', event), false)
    env.rt.readOnly = () => undefined
    env.rt.state.rooms['room-1'].admin = 'bot-a'
    assert.equal(claim('room-1', 'bot-admin', event), false)
    env.rt.state.rooms['room-1'].admin = 'bot-admin'
    assert.equal(claim('room-1', 'bot-admin', event), true)
    assert.equal(claim('room-1', 'bot-admin', event), false)
    await env.rt.taskflowSweep()
    assert.equal(env.posts.length, 1)
  } finally { env.stop() }
})

test('a submitted result or cancelled plan invalidates an exhaustion wake before admission', async () => {
  for (const disposition of ['submitted', 'cancelled']) {
    const env = host()
    try {
      await assign(env)
      exhaust(env)
      await env.rt.taskflowSweep()
      const event = env.posts[0].event
      if (disposition === 'submitted') await env.service.submit({ planId: 'exhaustion', cardId: 'write', result: 'Real fixture result' }, env.memberA)
      else {
        env.scheduler.requestCancel('exhaustion', { principal: 'bot-admin', reason: 'User stopped the task' })
        env.scheduler.finishCancel('exhaustion', { principal: 'bot-admin' })
      }
      assert.equal(env.rt.taskflowClaimRecovery('room-1', 'bot-admin', event), false)
    } finally { env.stop() }
  }
})

test('an interrupted exhaustion wake consumes one durable reservation across coordinator reopen', async () => {
  const env = host()
  let reopened
  try {
    await assign(env)
    exhaust(env)
    const post = env.rt.postTaskToRoom
    env.rt.postTaskToRoom = async (...args) => { await post(...args); throw Error('send succeeded then interrupted') }
    await assert.rejects(env.rt.taskflowSweep(), /send succeeded then interrupted/)
    reopened = new Scheduler(env.scheduler.path, { recoverOnOpen: false })
    assert.equal(reopened.events('exhaustion').filter(event => event.type === 'recovery_wake_reserved').length, 1)
    env.rt.postTaskToRoom = post
    await env.rt.taskflowSweep()
    assert.equal(env.posts.length, 1, 'an ambiguous paid wake must not be replayed')
  } finally { reopened?.close(); env.stop() }
})
