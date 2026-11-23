import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture as makeFixture } from './taskflow-fixture.mjs'
const fixture = () => { const env = makeFixture(); env.cleanup = () => { env.scheduler.close(); env.knowledge.close() }; return env }
import { Scheduler } from '../src/host/taskflow/scheduler.js'
import { join } from 'node:path'

const task = () => ({ scheduleId: 'daily-check', occurrenceAt: '2030-01-01T01:00:00.000Z',
  roomId: 'room-1', memberId: 'bot-a', title: 'Daily verification', prompt: 'Check the actual evidence and return a report.' })

test('a scheduled group occurrence creates a real card and returns its result to the principal', async () => {
  const env = fixture()
  try {
    env.botState.callerOf = () => { throw new Error('Scheduled dispatch must not impersonate a model tool caller') }
    const dispatched = await env.service.dispatchScheduled(task())
    const planId = dispatched.plan.plan_id
    assert.equal(dispatched.plan.cards[0].state, 'running')
    assert.equal(dispatched.plan.principal, 'bot-admin')
    assert.equal(env.posts[0].taskflowEvent.event, 'assigned')
    assert.equal(env.posts[0].taskflowEvent.to.id, 'bot-a')
    assert.equal(env.posts[0].taskflowEvent.schedule.id, 'daily-check')
    assert.ok(!env.posts[0].text.startsWith('@'))
    delete env.botState.callerOf
    await env.service.submit({ planId, cardId: 'scheduled-task', result: 'Actual checked result' }, env.memberA)
    assert.equal(env.posts.at(-1).taskflowEvent.event, 'submitted')
    assert.equal(env.posts.at(-1).taskflowEvent.to.id, 'bot-admin')
    await env.service.accept({ planId, cardId: 'scheduled-task' }, env.admin)
    assert.equal(env.scheduler.planState(planId).cards[0].state, 'verified')
  } finally { env.cleanup() }
})

test('concurrent duplicate occurrences produce one plan and one assignment', async () => {
  const env = fixture()
  try {
    const results = await Promise.all([env.service.dispatchScheduled(task()), env.service.dispatchScheduled(task())])
    assert.equal(env.posts.length, 1)
    assert.equal(env.scheduler.db.prepare('SELECT COUNT(*) AS n FROM plans').get().n, 1)
    assert.ok(results.some(result => result.duplicate === true))
    assert.equal(env.scheduler.scheduledOccurrence('daily-check', task().occurrenceAt).plan_id, results[0].plan.plan_id)
  } finally { env.cleanup() }
})

test('uncertain scheduled dispatch is never resent by an occurrence replay', async () => {
  const env = fixture()
  try {
    let sends = 0
    env.service.post = async () => { sends++; throw new Error('Transport acceptance unknown') }
    const first = await env.service.dispatchScheduled(task())
    assert.equal(first.plan.cards[0].state, 'unknown')
    const again = await env.service.dispatchScheduled(task())
    assert.equal(again.duplicate, true)
    assert.equal(sends, 1)
  } finally { env.cleanup() }
})

test('scheduled dispatch rechecks current principal and rejects an unavailable executor or overlap', async () => {
  const env = fixture()
  try {
    env.rt.state.rooms['room-1'].admin = 'bot-b'
    const first = await env.service.dispatchScheduled(task())
    assert.equal(first.plan.principal, 'bot-b')
    await assert.rejects(env.service.dispatchScheduled({ ...task(), occurrenceAt: '2030-01-02T01:00:00.000Z' }), /plan_already_open/)
    assert.equal(env.posts.length, 1)
    env.rt.state.rooms['room-1'].members = ['bot-b']
    await assert.rejects(env.service.dispatchScheduled({ ...task(), scheduleId: 'other' }), /member_not_in_room/)
    assert.equal(env.posts.length, 1)
  } finally { env.cleanup() }
})

test('occurrence identity survives a coordinator reopen and does not resend recovered unknown work', async () => {
  const env = fixture()
  let reopened
  try {
    const first = await env.service.dispatchScheduled(task())
    reopened = new Scheduler(join(env.rt.taskflowHome, 'coordination.sqlite'))
    env.service.scheduler = reopened
    const replay = await env.service.dispatchScheduled(task())
    assert.equal(replay.duplicate, true)
    assert.equal(replay.planId, first.plan.plan_id)
    assert.equal(reopened.planState(first.plan.plan_id).cards[0].state, 'unknown')
    assert.equal(env.posts.length, 1)
  } finally { reopened?.close(); env.cleanup() }
})

test('a duplicate occurrence constraint rolls back the entire competing plan', async () => {
  const env = fixture()
  try {
    const first = await env.service.dispatchScheduled(task())
    assert.throws(() => env.scheduler.createPlan({ planId: 'competing-plan', room: 'room-2', principal: 'bot-admin',
      cards: [{ id: 'one', member: 'bot-a', goal: 'Check', dependencies: [] }],
      scheduled: { scheduleId: task().scheduleId, occurrenceAt: task().occurrenceAt } }), /UNIQUE/)
    assert.equal(env.scheduler.db.prepare('SELECT COUNT(*) AS n FROM plans').get().n, 1)
    assert.equal(env.scheduler.currentPlanId('room-1'), first.plan.plan_id)
  } finally { env.cleanup() }
})
