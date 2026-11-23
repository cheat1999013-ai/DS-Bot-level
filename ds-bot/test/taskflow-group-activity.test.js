import assert from 'node:assert/strict'
import test from 'node:test'
const { install } = await import(process.env.TASKFLOW_HOST_SOURCE ?? '../src/host/taskflow.js')
import { fixture } from './taskflow-fixture.mjs'
import { groupAssignments } from '../src/host/taskflow/group-activity.js'

test('the production board read includes a principal group assignment missing from the formal plan', async () => {
  const env = fixture()
  const effects = []
  env.rt.ctx.effect = register => effects.push(register())
  env.rt.ctx.inject = (_services, register) => register({ skills: { registerProvider() {} } })
  const room = env.rt.state.rooms['room-1']
  room.name = 'lq-create'
  delete env.rt.state.bots[room.admin].id
  env.rt.state.bots['bot-scout'] = { id: 'bot-scout', name: 'Scout', role: 'source research' }
  room.members.push('bot-scout')
  room.log = [
    { seq: 91, who: 'User', text: '@Chief 请关注这位作者，并交给合适的成员处理。' },
    { seq: 94, who: 'Chief', botId: 'bot-admin', text: '@Scout 请补查近期公开推文，附链接、发布时间和可见互动数据；收到结果后我会交给 Writer 起草。' },
    { seq: 95, who: 'Scout', botId: 'bot-scout', text: '我会检查公开来源并逐条核实。' },
  ]
  const original = JSON.stringify(room)
  try {
    env.service.plan({ planId: 'registered', goal: 'Write the selected article',
      children: [{ id: 'write', member: 'Writer', goal: 'Write the article', dependencies: [] }] }, env.admin)
    install(env.rt)
    const beforeEvents = env.scheduler.db.prepare('SELECT COUNT(*) AS count FROM events').get().count
    const view = await env.rt.taskflowView({ room: room.id })
    assert.equal(view.room.admin, room.admin, 'the real DTO must carry the current administrator ID for display filtering')
    assert.equal(view.rooms.find(item => item.id === room.id).admin, room.admin)
    assert.equal(view.plan.plan_id, 'registered')
    assert.deepEqual(view.plan.cards.map(card => card.member), ['bot-a'])
    const assignment = view.observedTasks?.find(item => item.member === 'bot-scout')
    assert.ok(assignment, 'The new Scout assignment must be visible even though the formal plan only contains Writer')
    assert.match(assignment.goal, /请补查近期公开推文/)
    assert.equal(assignment.source.seq, 94)
    assert.equal(assignment.source.kind, 'group_message')
    assert.equal(assignment.state, 'replied')
    assert.equal(JSON.stringify(room), original)
    assert.equal(env.scheduler.db.prepare('SELECT COUNT(*) AS count FROM cards').get().count, 1)
    assert.equal(env.scheduler.db.prepare('SELECT COUNT(*) AS count FROM events').get().count, beforeEvents)
  } finally {
    for (const dispose of effects) dispose?.()
    env.cleanup()
  }
})

test('all-group read exposes each listed plan and supports older timeline pages', async () => {
  const env = fixture(), effects = []
  try {
    env.rt.ctx.effect = register => effects.push(register())
    env.rt.ctx.inject = (_services, register) => register({ skills: { registerProvider() {} } })
    env.scheduler.createPlan({ planId: 'a', room: 'room-1', principal: 'bot-admin', cards: [{ id: 'write', member: 'bot-a', goal: 'write', dependencies: [] }], concurrency: 1, retryLimit: 1 })
    env.scheduler.createPlan({ planId: 'b', room: 'room-2', principal: 'bot-admin', cards: [{ id: 'check', member: 'bot-a', goal: 'check', dependencies: [] }], concurrency: 1, retryLimit: 1 })
    env.scheduler.clock = () => 100
    for (let i = 0; i < 125; i++) env.scheduler.event('a', 'write', 'card_claimed', {})
    install(env.rt)
    const first = await env.rt.taskflowView({ all: true })
    assert.deepEqual(new Set(first.fullPlans.map(plan => plan.plan_id)), new Set(['a', 'b']))
    assert.deepEqual(new Set(first.timelinePlanIds), new Set(['a', 'b']))
    assert.ok(first.fullPlans.find(plan => plan.plan_id === 'b').cards.some(card => card.id === 'check'))
    assert.equal(first.timeline.length, 120)
    assert.ok(first.timelineNext)
    const second = await env.rt.taskflowView({ all: true, timelineBefore: first.timelineNext })
    assert.ok(second.timeline.length > 0)
    assert.equal(new Set([...first.timeline, ...second.timeline].map(event => event.seq)).size, first.timeline.length + second.timeline.length)
  } finally { for (const dispose of effects) dispose?.(); env.cleanup() }
})

test('all-group read retains current plans beyond the global history limit', async () => {
  const env = fixture(), effects = []
  try {
    env.rt.ctx.effect = register => effects.push(register())
    env.rt.ctx.inject = (_services, register) => register({ skills: { registerProvider() {} } })
    env.scheduler.clock = () => 1
    env.scheduler.createPlan({ planId: 'quiet', room: 'room-2', principal: 'bot-admin', cards: [{ id: 'quiet-card', member: 'bot-a', goal: 'quiet', dependencies: [] }], concurrency: 1, retryLimit: 1 })
    env.scheduler.setCurrentPlan('room-2', 'quiet')
    for (let i = 0; i < 21; i++) {
      env.scheduler.clock = () => 2 + i
      env.scheduler.createPlan({ planId: `new-${i}`, room: 'room-1', principal: 'bot-admin', cards: [{ id: 'card', member: 'bot-a', goal: 'new', dependencies: [] }], concurrency: 1, retryLimit: 1 })
      if (i < 20) {
        env.scheduler.requestCancel(`new-${i}`, { principal: 'bot-admin', reason: 'historical fixture' })
        env.scheduler.finishCancel(`new-${i}`, { principal: 'bot-admin' })
      }
    }
    env.scheduler.setCurrentPlan('room-1', 'new-20')
    install(env.rt)
    const data = await env.rt.taskflowView({ all: true })
    const quiet = data.fullPlans.filter(plan => plan.plan_id === 'quiet')
    assert.equal(quiet.length, 1)
    assert.equal(quiet[0].cards[0].id, 'quiet-card')
    assert.equal(data.rooms.find(room => room.id === 'room-2').planId, 'quiet')
  } finally { for (const dispose of effects) dispose?.(); env.cleanup() }
})

test('current-only timeline finds current events behind newer historical events', async () => {
  const env = fixture(), effects = []
  try {
    env.rt.ctx.effect = register => effects.push(register())
    env.rt.ctx.inject = (_services, register) => register({ skills: { registerProvider() {} } })
    env.scheduler.clock = () => 2
    env.scheduler.createPlan({ planId: 'old', room: 'room-1', principal: 'bot-admin', cards: [{ id: 'old-work', member: 'bot-a', goal: 'old', dependencies: [] }], concurrency: 1, retryLimit: 1 })
    env.scheduler.db.prepare("UPDATE plans SET status='completed', ended_at=? WHERE plan_id='old'").run(Date.now() / 1000)
    env.scheduler.clock = () => 1
    env.scheduler.createPlan({ planId: 'current', room: 'room-1', principal: 'bot-admin', cards: [{ id: 'work', member: 'bot-a', goal: 'live', dependencies: [] }], concurrency: 1, retryLimit: 1 })
    env.scheduler.event('current', 'work', 'card_claimed', {})
    env.scheduler.clock = () => 2
    for (let i = 0; i < 125; i++) env.scheduler.event('old', 'old-work', 'card_claimed', {})
    env.scheduler.setCurrentPlan('room-1', 'current')
    install(env.rt)
    const current = await env.rt.taskflowView({ room: 'room-1', currentOnly: true })
    const all = await env.rt.taskflowView({ all: true, currentOnly: true })
    assert.ok(current.timeline.some(item => item.plan_id === 'current' && item.card_id === 'work'))
    assert.ok(all.timeline.some(item => item.plan_id === 'current' && item.card_id === 'work'))
    assert.ok(current.timeline.every(item => item.plan_id === 'current'))
    const legacy = await env.rt.taskflowView({ room: 'room-1' })
    assert.ok(legacy.timeline.some(item => item.plan_id === 'old'), 'legacy unfiltered view stays available')
  } finally { for (const dispose of effects) dispose?.(); env.cleanup() }
})

test('production all-group reads preserve each room member level and active tool snapshot', async () => {
  const env = fixture(), effects = []
  try {
    env.rt.ctx.effect = register => effects.push(register())
    env.rt.ctx.inject = (_services, register) => register({ skills: { registerProvider() {} } })
    env.rt.state.rooms['room-2'].admin = 'bot-admin'
    env.rt.state.rooms['room-2'].members.push('bot-admin')
    env.rt.workView = () => ({ 'bot-a': { roomId: 'room-2', tool: 'read_file' } })
    env.scheduler.db.prepare('INSERT INTO bot_rewards(room,plan_id,bot_id,at,points) VALUES(?,?,?,?,?)').run('room-1', 'scope-fixture', 'bot-a', 1, 10)
    install(env.rt)
    const data = await env.rt.taskflowView({ all: true })
    assert.equal(data.membersByRoom['room-1']['bot-a'].level.level, 0.1)
    assert.equal(data.membersByRoom['room-2']['bot-a'].level.level, 0)
    assert.equal(data.membersByRoom['room-1']['bot-a'].tool, null)
    assert.equal(data.membersByRoom['room-2']['bot-a'].tool, 'read_file')
    env.rt.readOnly = () => 'locked'
    env.rt.taskflowHome += '-missing'
    // A separate read-only runtime with no ledger must also retain room scope.
    const rt = { ...env.rt, teamTools: [] }
    install(rt)
    const empty = await rt.taskflowView({ all: true })
    assert.equal(empty.membersByRoom['room-1']['bot-a'].level, null)
    assert.equal(empty.membersByRoom['room-1']['bot-a'].tool, null)
    assert.equal(empty.membersByRoom['room-2']['bot-a'].tool, 'read_file')
  } finally {
    for (const dispose of effects) dispose?.()
    env.cleanup()
  }
})

test('only explicit principal assignments to live members become observed tasks', () => {
  const env = fixture()
  try {
    const room = env.rt.state.rooms['room-1']
    room.log = [
      { seq: 1, who: 'Chief', botId: 'bot-admin', text: '@Writer 你好，今天怎么样？' },
      { seq: 2, who: 'Chief', botId: 'bot-admin', text: '@Writer 不要起草文章。' },
      { seq: 3, who: 'User', text: '@Writer 请起草文章。' },
      { seq: 4, who: 'Chief', text: '@Writer 请起草文章。' },
      { seq: 5, who: 'Reviewer', botId: 'bot-b', text: '@Writer 请起草文章。' },
      { seq: 6, botId: 'bot-admin', text: '`@Writer 请起草文章。`' },
      { seq: 7, botId: 'bot-admin', text: '@Writer [Taskflow registered/write] 请起草文章。' },
      { seq: 8, botId: 'bot-admin', text: '@Missing 请起草文章。' },
      { seq: 9, botId: 'bot-admin', text: '@Writer 请起草文章。', taskflowEvent: { event: 'assigned' } },
      { seq: 10, botId: 'bot-admin', text: '@Writer 请起草文章。' },
      { seq: 11, botId: 'bot-a', text: '我会开始检查资料。' },
    ]
    const before = JSON.stringify(room)
    const tasks = groupAssignments(room, env.rt.state.bots)
    assert.deepEqual(tasks.map(task => task.source.seq), [10])
    assert.equal(tasks[0].source.at, null)
    assert.equal(tasks[0].state, 'replied')
    assert.equal(tasks[0].reply.seq, 11)
    assert.equal(JSON.stringify(room), before)
    room.members = room.members.filter(id => id !== 'bot-a')
    assert.deepEqual(groupAssignments(room, env.rt.state.bots), [])
  } finally { env.cleanup() }
})

test('group assignments have stable identities across reloads and distinguish recipients and rooms', () => {
  const env = fixture()
  try {
    const room = env.rt.state.rooms['room-1']
    room.log = [{ seq: 20, botId: 'bot-admin', text: '@Writer @Reviewer 请检查公开来源。' },
      { seq: 21, botId: 'bot-admin', text: '@Writer 请起草文章。 @Reviewer 请核查引用。' }]
    delete env.rt.state.bots['bot-a'].id
    delete env.rt.state.bots['bot-b'].id
    const tasks = groupAssignments(room, env.rt.state.bots)
    assert.equal(tasks.length, 4)
    assert.equal(new Set(tasks.map(task => task.id)).size, 4)
    assert.ok(tasks.every(task => room.members.includes(task.member)))
    assert.deepEqual(tasks, groupAssignments(JSON.parse(JSON.stringify(room)), env.rt.state.bots))
    const other = groupAssignments({ ...room, id: 'other' }, env.rt.state.bots)
    assert.ok(other.every(task => !tasks.some(original => original.id === task.id)))
    assert.equal(tasks.find(task => task.source.seq === 21 && task.member === 'bot-b').goal, '请核查引用。')
    const registered = [{ cards: [{ member: 'bot-a', goal: '请起草文章。' }] }]
    assert.equal(groupAssignments(room, env.rt.state.bots, registered).length, 3)
  } finally { env.cleanup() }
})

test('read-only production view shows assignments without a ledger or a formal plan and isolates rooms', async () => {
  const env = fixture()
  const effects = []
  try {
    env.rt.ctx.effect = register => effects.push(register())
    env.rt.ctx.inject = (_services, register) => register({ skills: { registerProvider() {} } })
    env.rt.taskflowHome += '-missing'
    env.rt.readOnly = () => 'locked'
    env.rt.state.rooms['room-1'].log = [{ seq: 4, botId: 'bot-admin', text: '@Writer 请核查公开来源。' }]
    install(env.rt)
    const view = await env.rt.taskflowView({ room: 'room-1' })
    assert.equal(view.room.admin, 'bot-admin')
    assert.equal(view.rooms.find(item => item.id === 'room-2').admin, 'bot-a')
    assert.equal(view.plan, null)
    assert.equal(view.observedTasks.length, 1)
    assert.equal(view.observedTasks[0].member, 'bot-a')
    assert.equal((await env.rt.taskflowView({ room: 'room-2' })).observedTasks.length, 0)
    assert.equal((await env.rt.taskflowView({ all: true })).observedTasks.length, 1)
    assert.equal((await env.rt.taskflowView({ room: 'room-1' })).observedTasks[0].id, view.observedTasks[0].id)
  } finally {
    for (const dispose of effects) dispose?.()
    env.cleanup()
  }
})

test('a departed or missing principal cannot turn retained messages into observed assignments', () => {
  const env = fixture()
  try {
    const room = env.rt.state.rooms['room-1']
    room.log = [{ seq: 9, botId: 'bot-admin', text: '@Writer 请核查公开来源。' }]
    room.members = ['bot-a', 'bot-b']
    const before = JSON.stringify(room)
    const events = env.scheduler.db.prepare('SELECT COUNT(*) AS n FROM events').get().n
    assert.deepEqual(groupAssignments(room, env.rt.state.bots), [])
    assert.equal(JSON.stringify(room), before)
    room.members.push('bot-admin')
    delete env.rt.state.bots['bot-admin']
    const missing = JSON.stringify(room)
    assert.deepEqual(groupAssignments(room, env.rt.state.bots), [])
    assert.equal(JSON.stringify(room), missing)
    assert.equal(env.scheduler.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, events)
    assert.equal(env.scheduler.db.prepare('SELECT COUNT(*) AS n FROM cards').get().n, 0)
  } finally { env.cleanup() }
})
