import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture as makeFixture } from './taskflow-fixture.mjs'
const fixture = () => { const env = makeFixture(); env.cleanup = () => { env.scheduler.close(); env.knowledge.close() }; return env }
import { install } from '../src/host/group-schedules.js'
import { Scheduler } from '../src/host/taskflow/scheduler.js'

function setup() {
  const env = fixture()
  const listeners = new Map()
  const timers = new Map()
  const snapshots = []
  let sequence = 0
  env.rt.state.groupSchedules = {}
  env.rt.ctx.on = (name, handler) => { listeners.set(name, handler) }
  env.rt.createSession = async () => `trigger-${++sequence}`
  env.rt.save = async () => { snapshots.push(structuredClone(env.rt.state.groupSchedules)) }
  const schedule = {
    async create(request) { const id = `timer-${++sequence}`; timers.set(id, { ...request, id, kind: request.timing.kind, scheduledAt: '2030-01-01T01:00:00.000Z', status: 'active' }); return { id } },
    async catalog() { return [...timers.values()] },
    async edit({ id, action }) { assert.equal(action, 'delete'); timers.delete(id); return { id } },
  }
  env.rt.scheduleService = () => schedule
  env.rt.taskflowDispatchScheduled = spec => env.service.dispatchScheduled(spec)
  env.rt.scheduleEndpoint = async () => ({ available: true, tasks: env.rt.groupSchedulesView(await schedule.catalog()) })
  install(env.rt)
  const create = () => env.rt.groupScheduleEndpoint('group-schedule-create', { target: 'room-1', memberId: 'bot-a',
    title: 'Evidence check', prompt: 'Verify sources', when: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } })
  const fire = async (config, { source = { kind: 'schedule' }, occurrence = '2030-01-01T01:00:00.000Z', id = config.scheduleId, sessionId = config.sessionId } = {}) => {
    let modelCalls = 0
    const frame = `[SCHEDULE REMINDER]\nschedule_id_json: ${JSON.stringify(id)}\noccurrence_at: ${occurrence}\nreminder_prompt_json: ${JSON.stringify(config.prompt)}`
    const stream = listeners.get('llm/stream')({ sessionId, messages: [{ role: 'user', source, content: [{ type: 'text', text: frame }] }] },
      async function* () { modelCalls++; yield { type: 'finish', reason: { kind: 'stop' } } })
    for await (const chunk of stream) assert.equal(chunk.type, 'finish')
    return modelCalls
  }
  return { ...env, timers, snapshots, schedule, create, fire }
}

test('busy group keeps multiple timer occurrences across restart and dispatches them in order', async () => {
  const env = setup()
  try {
    await env.create()
    let config = Object.values(env.rt.state.groupSchedules)[0]
    await env.fire(config)
    const first = config.lastRun.planId
    await env.fire(config, {occurrence:'2030-01-02T01:00:00.000Z'})
    await env.fire(config, {occurrence:'2030-01-03T01:00:00.000Z'})
    assert.deepEqual(config.pendingOccurrences, ['2030-01-02T01:00:00.000Z','2030-01-03T01:00:00.000Z'])
    env.rt.state.groupSchedules = structuredClone(env.rt.state.groupSchedules)
    config = Object.values(env.rt.state.groupSchedules)[0]
    env.scheduler.cancelOrphan(first)
    await env.rt.drainGroupSchedules()
    assert.equal(env.posts.length, 2)
    assert.deepEqual(config.pendingOccurrences, ['2030-01-03T01:00:00.000Z'])
    env.scheduler.cancelOrphan(config.lastRun.planId)
    await env.rt.drainGroupSchedules()
    assert.equal(env.posts.length, 3)
    assert.deepEqual(config.pendingOccurrences, [])
    await env.rt.drainGroupSchedules()
    assert.equal(env.posts.length, 3)
  } finally { env.cleanup() }
})

test('database lock before admission keeps a scheduled occurrence for retry', async () => {
  const env = setup()
  const lock = new Scheduler(env.scheduler.path, { recoverOnOpen:false })
  try {
    await env.create()
    const config = Object.values(env.rt.state.groupSchedules)[0]
    lock.db.exec('BEGIN IMMEDIATE')
    await env.fire(config)
    assert.equal(config.lastRun.state, 'blocked')
    assert.deepEqual(config.pendingOccurrences, ['2030-01-01T01:00:00.000Z'])
    assert.equal(env.posts.length, 0)
    lock.db.exec('ROLLBACK')
    await env.rt.drainGroupSchedules()
    assert.equal(env.posts.length, 1)
    assert.deepEqual(config.pendingOccurrences, [])
  } finally { if (lock.db.isTransaction) lock.db.exec('ROLLBACK'); lock.close(); env.cleanup() }
})

test('a confirmed unsent cancelled timer releases its room and retries after unpausing', async () => {
  const env = setup()
  try {
    await env.create()
    const config = Object.values(env.rt.state.groupSchedules)[0]
    const post = env.service.post
    env.service.post = async () => {
      env.rt.state.rooms['room-1'].taskflowEnabled = false
      const error = new Error('delivery cancelled before send')
      error.code = 'taskflow_delivery_cancelled'
      throw error
    }
    await env.fire(config)
    assert.equal(env.posts.length, 0)
    const prior = env.scheduler.scheduledOccurrence(config.scheduleId, '2030-01-01T01:00:00.000Z')
    assert.equal(env.scheduler.planState(prior.plan_id).status, 'cancelled')
    assert.equal(env.scheduler.scheduledRetryable(prior.plan_id), true)
    assert.equal(env.scheduler.cancelledPlans().some(plan => plan.plan_id === prior.plan_id), false)
    assert.equal(env.scheduler.db.prepare("SELECT COUNT(*) AS n FROM plans WHERE room='room-1' AND status IN ('open','cancelling')").get().n, 0)
    assert.deepEqual(config.pendingOccurrences, ['2030-01-01T01:00:00.000Z'])
    env.rt.state.rooms['room-1'].taskflowEnabled = true
    env.service.post = post
    await env.rt.drainGroupSchedules()
    const next = env.scheduler.scheduledOccurrence(config.scheduleId, '2030-01-01T01:00:00.000Z')
    assert.notEqual(next.plan_id, prior.plan_id)
    assert.equal(env.scheduler.planState(prior.plan_id).status, 'cancelled')
    assert.equal(env.posts.length, 1)
    assert.deepEqual(config.pendingOccurrences, [])
    await env.rt.drainGroupSchedules()
    assert.equal(env.posts.length, 1)
  } finally { env.cleanup() }
})

test('a disabled group retains its timer occurrence until taskflow is enabled', async () => {
  const env = setup()
  try {
    await env.create()
    const config = Object.values(env.rt.state.groupSchedules)[0]
    env.rt.state.rooms['room-1'].taskflowEnabled = false
    await env.fire(config)
    assert.equal(env.posts.length, 0)
    assert.deepEqual(config.pendingOccurrences, ['2030-01-01T01:00:00.000Z'])
    env.rt.state.rooms['room-1'].taskflowEnabled = true
    await env.rt.drainGroupSchedules()
    assert.equal(env.posts.length, 1)
    assert.deepEqual(config.pendingOccurrences, [])
  } finally { env.cleanup() }
})

test('an ambiguous dispatch holds later occurrences rather than automatically retrying', async () => {
  const env = setup()
  try {
    await env.create()
    const config = Object.values(env.rt.state.groupSchedules)[0]
    let calls = 0
    env.rt.taskflowDispatchScheduled = async () => { calls++; throw new Error('Unknown delivery') }
    await env.fire(config)
    assert.equal(config.lastRun.state, 'needs-review')
    await env.fire(config, {occurrence:'2030-01-02T01:00:00.000Z'})
    await env.rt.drainGroupSchedules()
    assert.equal(calls, 1)
    assert.deepEqual(config.pendingOccurrences, ['2030-01-02T01:00:00.000Z'])
  } finally { env.cleanup() }
})

test('an ambiguous occurrence freezes every schedule for the same room', async () => {
  const env = setup()
  try {
    await env.create()
    await env.create()
    const [first, second] = Object.values(env.rt.state.groupSchedules)
    let calls = 0
    env.rt.taskflowDispatchScheduled = async () => { calls++; throw new Error('Unknown delivery') }
    await env.fire(first)
    await env.fire(second, { occurrence:'2030-01-02T01:00:00.000Z' })
    await env.rt.drainGroupSchedules()
    assert.equal(calls, 1)
    assert.deepEqual(second.pendingOccurrences, ['2030-01-02T01:00:00.000Z'])
  } finally { env.cleanup() }
})

test('a group task executor can be changed after a principal transfer without recreating the timer', async () => {
  const env = setup()
  try {
    await env.create()
    const config = Object.values(env.rt.state.groupSchedules)[0]
    const timerId = config.scheduleId
    env.rt.state.rooms['room-1'].admin = 'bot-a'
    await env.fire(config)
    assert.equal(config.lastRun.state, 'blocked')
    await assert.rejects(env.rt.groupScheduleEndpoint('group-schedule-update', {id:config.id, memberId:'bot-a'}), /non-principal/)
    await env.rt.groupScheduleEndpoint('group-schedule-update', {id:config.id, memberId:'bot-b'})
    assert.equal(config.memberId, 'bot-b')
    assert.equal(config.scheduleId, timerId)
  } finally { env.cleanup() }
})

test('room deletion leaves an inert controller tombstone when Automation is unavailable', async () => {
  const env = setup()
  try {
    await env.create()
    const config = Object.values(env.rt.state.groupSchedules)[0]
    env.rt.scheduleService = () => undefined
    await env.rt.cancelGroupSchedules('room-1')
    assert.equal(config.stage, 'deleting')
    assert.equal(env.rt.state.groupSchedules[config.id], config)
    assert.equal(await env.fire(config), 0)
    assert.equal(env.posts.length, 0)
    delete env.rt.state.rooms['room-1']
    env.rt.scheduleService = () => env.schedule
    await env.rt.drainGroupSchedules()
    assert.equal(env.timers.size, 0)
    assert.equal(env.rt.state.groupSchedules[config.id], undefined)
  } finally { env.cleanup() }
})

