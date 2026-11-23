import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture } from './taskflow-fixture.mjs'
import { install } from '../src/host/group-schedules.js'
import { install as installSchedules } from '../src/host/schedules.js'

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

test('the native timer trigger dispatches a formal card without consulting a model or a group @ prompt', async () => {
  const env = setup()
  try {
    const view = await env.create()
    assert.equal(view.tasks[0].mode, 'group-card')
    const config = Object.values(env.rt.state.groupSchedules)[0]
    assert.notEqual(config.sessionId, 'room-1')
    assert.ok(env.snapshots.some(snapshot => Object.values(snapshot).some(entry => entry.sessionId && entry.stage === 'creating')))
    assert.equal(await env.fire(config), 0)
    assert.equal(env.posts.length, 1)
    assert.equal(env.posts[0].taskflowEvent.event, 'assigned')
    assert.equal(config.lastRun.state, 'dispatched')
    assert.equal(await env.fire(config), 0)
    assert.equal(env.posts.length, 1)
    assert.equal(env.rt.groupSchedulesView([...env.timers.values()])[0].lastRun.planId, config.lastRun.planId)
  } finally { env.cleanup() }
})

test('an existing worker recurrence keeps its ID and clock slots when connected to native group cards', async () => {
  const env = setup()
  try {
    const task = { id: 'existing', title: 'Collect material', prompt: 'Collect material', kind: 'rrule',
      rrule: 'DTSTART;TZID=Asia/Singapore:20261111T190000\r\nRRULE:FREQ=HOURLY;INTERVAL=3',
      scheduledAt: '2030-01-01T01:00:00.000Z', status: 'active', updatedAt: '2026-11-19T20:00:00.203Z',
      target: { kind: 'session', sessionId: 'group-a' } }
    env.timers.set(task.id, task)
    env.rt.chatOwners = new Map()
    env.rt.pastOwners = new Map()
    env.rt.ctx.get = name => name === 'schedule' ? env.schedule : undefined
    installSchedules(env.rt)
    let edits = 0
    let conflict = true
    env.schedule.edit = async request => {
      edits++
      assert.equal(request.id, task.id)
      assert.equal(request.expectedUpdatedAt, task.updatedAt)
      assert.equal(request.action, 'update')
      assert.deepEqual(Object.keys(request.patch), ['target'])
      const saved = Object.values(env.snapshots.at(-1))[0]
      assert.equal(saved.scheduleId, task.id)
      assert.equal(saved.stage, 'ready')
      assert.equal(request.patch.target.sessionId, saved.sessionId)
      if (conflict) return { id: task.id, code: 'schedule_conflict' }
      const next = { ...task, target: request.patch.target }
      env.timers.set(task.id, next)
      return next
    }
    const connect = () => env.rt.groupScheduleEndpoint('group-schedule-connect', { id: task.id, sessionId: 'group-a' })
    await assert.rejects(connect(), /timer was not moved/)
    assert.equal(env.timers.get(task.id), task)
    assert.deepEqual(env.rt.groupSchedulesView([...env.timers.values()]), [])
    const pending = (await env.rt.scheduleEndpoint('schedules')).tasks
    assert.equal(pending.length, 1)
    assert.equal(pending[0].id, task.id)
    assert.equal(pending[0].sessionId, 'group-a')
    assert.equal(pending[0].botId, 'bot-a')
    assert.equal(pending[0].roomId, 'room-1')
    assert.equal(pending[0].mode, undefined)
    conflict = false
    const view = await connect()
    await connect()
    assert.equal(edits, 2)
    assert.equal(Object.keys(env.rt.state.groupSchedules).length, 1)
    assert.equal(env.timers.size, 1)
    const row = view.tasks[0]
    assert.equal(row.rrule, task.rrule)
    assert.equal(row.scheduledAt, task.scheduledAt)
    assert.equal(row.memberId, 'bot-a')
    const config = Object.values(env.rt.state.groupSchedules)[0]
    assert.equal(await env.fire(config), 0)
    assert.equal(env.posts[0].taskflowEvent.to.id, 'bot-a')
    await env.service.submit({ planId: config.lastRun.planId, cardId: 'scheduled-task', result: 'Collected material' }, env.memberA)
    assert.equal(env.posts.at(-1).taskflowEvent.to.id, 'bot-admin')
    assert.equal(env.posts.at(-1).taskflowEvent.event, 'submitted')
  } finally { env.cleanup() }
})

test('ordinary messages cannot fire a group schedule, and an unrelated session retains its native path', async () => {
  const env = setup()
  try {
    await env.create()
    const config = Object.values(env.rt.state.groupSchedules)[0]
    assert.equal(await env.fire(config, { source: { kind: 'user' } }), 0)
    assert.equal(env.posts.length, 0)
    assert.equal(await env.fire(config, { sessionId: 'unrelated-session' }), 1)
    assert.equal(await env.fire(config, { id: 'another-timer' }), 0)
    assert.equal(env.posts.length, 0)
  } finally { env.cleanup() }
})

test('read-only or interrupted occurrence admission never dispatches or auto-replays a card', async () => {
  const env = setup()
  try {
    await env.create()
    const config = Object.values(env.rt.state.groupSchedules)[0]
    env.rt.readOnly = () => 'Read-only host'
    const before = JSON.stringify(config)
    assert.equal(await env.fire(config), 0)
    assert.equal(JSON.stringify(config), before)
    env.rt.readOnly = () => undefined
    config.lastRun = { occurrenceAt: '2030-01-01T01:00:00.000Z', state: 'dispatching' }
    await env.fire(config)
    assert.equal(env.posts.length, 0)
  } finally { env.cleanup() }
})

test('a failed configuration commit leaves the controlled timer unable to dispatch', async () => {
  const env = setup()
  try {
    const save = env.rt.save
    env.rt.save = async () => {
      if (Object.values(env.rt.state.groupSchedules).some(config => config.stage === 'ready')) throw new Error('Disk commit failed')
      return save()
    }
    await assert.rejects(env.create(), /Disk commit failed/)
    const config = Object.values(env.rt.state.groupSchedules)[0]
    assert.equal(config.stage, 'repair')
    await env.fire(config)
    assert.equal(env.posts.length, 0)
    assert.equal(env.timers.size, 0)
  } finally { env.cleanup() }
})

test('deleting a group schedule stops its private timer but retains already created task cards', async () => {
  const env = setup()
  try {
    const archived = []
    env.rt.ctx.workspaceRegistry = { archiveSession: async (id, options) => { archived.push({ id, options }) } }
    await env.create()
    const config = Object.values(env.rt.state.groupSchedules)[0]
    await env.fire(config)
    const planId = config.lastRun.planId
    await env.rt.groupScheduleEndpoint('group-schedule-delete', { id: config.id })
    assert.equal(env.timers.size, 0)
    assert.equal(Object.keys(env.rt.state.groupSchedules).length, 0)
    assert.equal(archived[0].id, config.sessionId)
    assert.equal(archived[0].options.stopActivity, true)
    assert.equal(env.scheduler.planState(planId).cards[0].state, 'running')
  } finally { env.cleanup() }
})

test('the first timer after restart loads its saved controller binding before choosing a model path', async () => {
  const env = setup()
  try {
    await env.create()
    const config = Object.values(env.rt.state.groupSchedules)[0]
    const persisted = structuredClone(env.rt.state.groupSchedules)
    env.rt.state.groupSchedules = {}
    env.rt.load = async () => { env.rt.state.groupSchedules = persisted }
    assert.equal(await env.fire(config), 0)
    assert.equal(env.posts.length, 1)
    assert.equal(persisted[config.id].lastRun.state, 'dispatched')
  } finally { env.cleanup() }
})
