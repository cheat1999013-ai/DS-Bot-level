import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as realDelay } from 'node:timers/promises'
const { createRuntime } = await import(process.env.BOT_RUNTIME_SOURCE ?? '../index.js')
import { fakeAttachments, fakeContext } from './fake-ctx.js'
import { LONG_HEAD, MESSAGE_INLINE_MAX, ROOM_STEP_GAP_MS, ROOM_WORK_GRACE_MS } from '../src/host/constants.js'
import { promisesWork } from '../src/host/turns.js'
import { Scheduler } from '../src/host/taskflow/scheduler.js'

let rt

// Chief, the admin of group 'r1', speaks there from 'ga'; Writer from 'gb'; Tester from 'gc'.
const seed = (room = {}, extraRooms = {}, bots = {}) => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1, ...bots.a },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2, ...bots.b },
    c: { id: 'c', name: 'Tester', role: 'Test', sessionId: 'c', createdAt: 3, ...bots.c },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b', 'c'], mode: 'admin', admin: 'a', named: true, sessions: { a: 'ga', b: 'gb', c: 'gc' }, log: [], seq: 0, seen: {}, ...room }, ...extraRooms },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

async function start(t, room, services, extraRooms, bots, llm) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-work-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed(room, extraRooms, bots)))
  const selected = []
  const ctx = fakeContext({ services })
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const cancelled = []
      const held = []
      const nextStep = []
      const inbox = {
        nextStep,
        nextTurn: held,
        remove(id) {
          for (const list of [nextStep, held]) {
            const at = list.findIndex(message => message.id === id)
            if (at !== -1) { list.splice(at, 1); return true }
          }
          return false
        },
      }
      const keep = list => message => { calls.push(message); list.push(message) }
      agents.set(sessionId, { session: { id: sessionId }, calls, cancelled, inbox, followup: keep(held), steer: keep(nextStep), cancel(reason) { cancelled.push(reason) } })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: llm ?? { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }), selectModel: async (request) => { selected.push(request) } },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  rt = createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    // Retain the project-drive fixture for inspection.
  })
  let seq = 0
  const turns = new Map()
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId, exec = {}) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId }, ...exec })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  // A Session takes up the newest message it was sent, as a new turn.
  const begin = (sessionId) => {
    const message = agentOf(sessionId).calls.at(-1)
    agentOf(sessionId).inbox.nextTurn.length = 0
    agentOf(sessionId).inbox.nextStep.length = 0
    const turn = (turns.get(sessionId) ?? 0) + 1
    turns.set(sessionId, turn)
    emit(sessionId, 'turn/start', { turn })
    emit(sessionId, 'user/message', { content: message.content, source: message.source })
    return message
  }
  const finish = (sessionId, reply) => {
    emit(sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: reply }] } })
    emit(sessionId, 'turn/end', { turn: turns.get(sessionId), reason: { kind: 'completed' } })
  }
  // The user's message in the group, or a Bot's post the group Session took up, and the
  // round it starts.
  const round = (callId, message, sessionId = 'r1') => {
    emit(sessionId, 'user/message', message)
    let result
    const stop = new AbortController()
    t.after(() => stop.abort())
    void tool('group_relay', {}, sessionId, { callId, signal: stop.signal }).then((value) => { result = JSON.parse(value) })
    const read = () => result
    return read
  }
  const say = text => ({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  const takePost = () => {
    const post = agentOf('r1').calls.shift()
    return { content: post.content, source: post.source }
  }
  await tool('list_bots', {}, 'a')
  return { home, ctx, agentOf, emit, tool, call, begin, finish, round, say, takePost, selected }
}

const settle = async (check) => {
  const until = Date.now() + 3000
  // Let Windows close synchronous state readers before the writer replaces the file.
  while (!check() && Date.now() < until) await realDelay(5)
  assert.ok(check(), 'condition not reached')
}
const text = message => message.content.map(block => block.text ?? '').join('\n')
const kinds = result => result.replies.map(reply => [reply.kind ?? 'message', reply.name])

const assignedWork = async (t, { ask = '@Chief 安排一下文档', cards = [{ id: 'write', member: 'Writer', goal: '整理文档', dependencies: [] }], keepLeaderRunning = false, services } = {}) => {
  const host = await start(t, undefined, services)
  const first = host.round('assigned', host.say(ask))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  const planned = JSON.parse(await host.tool('taskflow_plan', { group: 'Ops', goal: '检查并提交结果', children: cards }, 'ga'))
  const planId = planned.plan.plan_id
  const dispatch = JSON.parse(await host.tool('taskflow_dispatch', { planId }, 'ga'))
  assert.equal(dispatch.sent.length, cards.length)
  if (!keepLeaderRunning) host.finish('ga', '任务已派发，等待正式提交。')
  for (const card of cards) {
    const session = card.member === 'Writer' ? 'gb' : 'gc'
    await settle(() => host.agentOf(session).calls.length === 1)
    assert.match(text(host.begin(session)), /Taskflow/)
  }
  return { host, first, planId }
}
const submitAssigned = async (host, planId, cardId, session, result) => {
  const submitted = JSON.parse(await host.tool('taskflow_submit', { planId, cardId, result }, session))
  assert.equal(submitted.observed.status, 'settled')
  host.finish(session, '[PASS]')
  assert.equal(logLines(host).some(row => row.botId === (session === 'gb' ? 'b' : 'c') && row.kind === undefined), false)
}
const acceptAssigned = async (host, planId, cards = ['write']) => {
  const results = JSON.parse(await host.tool('taskflow_results', { planId }, 'ga'))
  for (const cardId of cards) {
    const accepted = JSON.parse(await host.tool('taskflow_accept', { planId, cardId }, 'ga'))
    assert.equal(accepted.accepted.state, 'verified')
  }
  const completed = JSON.parse(await host.tool('taskflow_finish', { planId }, 'ga'))
  assert.equal(completed.finished.status, 'completed')
  return results
}


for (const recovered of ['unknown', 'pending']) test(`a recovered ${recovered} task actually wakes the principal and retains its original card`, async (t) => {
  const host = await start(t)
  // Establish the ordinary group Session, then create the persisted unfinished
  // plan as a prior host would have left it. No model or live profile is used.
  rt.groupOwners.set('ga', { botId: 'a', roomId: 'r1' })
  const created = JSON.parse(await host.tool('taskflow_plan', { group: 'Ops', goal: 'Recover existing work',
    children: [{ id: 'fix-ui', member: 'Writer', goal: 'Fix the existing UI', dependencies: [] },
      { id: 're-visual', member: 'Tester', goal: 'Check the UI', dependencies: ['fix-ui'] }] }, 'ga'))
  const ledger = new Scheduler(join(host.home, 'plugin-data', 'hermes-bot-taskflow', 'coordination.sqlite'), { recoverOnOpen: false })
  try {
    if (recovered === 'unknown') {
      ledger.claimNext(created.plan.plan_id, { principal: 'a' })
      ledger.bindReceipt(created.plan.plan_id, 'fix-ui', { receipt: 'dsh:existing-receipt' })
      ledger.recoverDispatches()
      ledger.write(() => ledger.event(created.plan.plan_id, 'fix-ui', 'recovery_attention', { attempts: 1, principal: 'a' }))
    }
  } finally { ledger.close() }
  await rt.taskflowSweep()
  await settle(() => host.agentOf('r1').calls.length > 0)
  const post = host.takePost()
  const round = host.round('recovery-followup', post)
  await settle(() => host.agentOf('ga').calls.length === 1)
  const called = host.begin('ga')
  assert.match(text(called), /taskflow_results/)
  assert.match(text(called), /fix-ui/)
  assert.equal(host.agentOf('gb').calls.length, 0)
  assert.equal(host.agentOf('gc').calls.length, 0)
  const results = JSON.parse(await host.tool('taskflow_results', { planId: created.plan.plan_id }, 'ga'))
  assert.equal(results.results[0].state, recovered)
  assert.equal(results.results[1].attempts, 0)
  host.emit('ga', 'tool/call', { name: 'taskflow_results', callId: 'recovery-read', arguments: '{}' })
  host.emit('ga', 'tool/result', { callId: 'recovery-read' })
  if (recovered === 'pending') {
    const dispatched = JSON.parse(await host.tool('taskflow_dispatch', { planId: created.plan.plan_id }, 'ga'))
    assert.equal(dispatched.sent[0].id, 'fix-ui', 'the recovered principal continues the original plan')
    await settle(() => host.agentOf('gb').calls.length === 1)
    host.begin('gb')
    await host.tool('taskflow_cancel', { planId: created.plan.plan_id, reason: 'End isolated fixture after verifying recovery dispatch' }, 'ga')
    host.emit('gb', 'turn/end', { reason: { kind: 'aborted', reason: { kind: 'user' } } })
  }
  host.finish('ga', '核验后确认：任务尚未提交，保留阻塞并等待明确处置。')
  await settle(() => round() !== undefined)
  await rt.taskflowSweep()
  await realDelay(20)
  assert.equal(host.agentOf('ga').calls.length, 1, 'recovery must not form a recurring model loop')
})

test('an unassigned direct worker ask reaches the principal and dispatches a real task to that worker', async (t) => {
  const host = await start(t)
  host.round('taskflow-call', host.say('@Writer 请撰写文档'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  assert.equal(host.agentOf('gb').calls.length, 0, 'an unassigned worker must not silently consume the user request')
  assert.match(text(host.agentOf('ga').calls[0]), /@Writer 请撰写文档/)
  host.begin('ga')
  const members = JSON.parse(await host.tool('taskflow_members', {}, 'ga'))
  assert.deepEqual(members.members.map(member => member.id), ['a', 'b', 'c'])
  const plan = JSON.parse(await host.tool('taskflow_plan', { group: 'Ops', goal: '写作任务',
    children: [{ id: 'write', member: 'Writer', goal: '撰写文档', dependencies: [] }] }, 'ga'))
  assert.equal(plan.plan.cards[0].member, 'b')
  const dispatched = JSON.parse(await host.tool('taskflow_dispatch', { planId: plan.plan.plan_id }, 'ga'))
  assert.deepEqual(dispatched.sent.map(card => card.member), ['Writer'])
  assert.ok(rt.state.rooms.r1.log.some(line => line.kind === 'notice' && line.text?.includes('[任务流] Writer 开始执行 撰写文档，模型')))
  await settle(() => host.agentOf('gb').calls.length === 1)
  assert.equal(host.agentOf('gc').calls.length, 0)
  const called = host.begin('gb')
  assert.match(text(called), /@Writer \[Taskflow .*\/write\]/)
  assert.equal(called.source.kind, 'taskflow')
  assert.equal(called.source.taskflowEvent.event, 'assigned')
  assert.equal(called.source.taskflowEvent.cardId, 'write')
  assert.match(text(called), /撰写文档/)
  host.emit('gb', 'tool/call', { callId: 'skill-1', name: 'skill', arguments: JSON.stringify({ name: 'draft' }) })
  assert.deepEqual((await rt.taskflowView({ room: 'r1' })).plan.cards[0].usedSkills, ['draft'])
  host.emit('gb', 'tool/result', { callId: 'skill-1' })
  host.emit('gb', 'user/message', { content: [], source: { kind: 'skill-invocation', name: 'checklist' } })
  assert.deepEqual((await rt.taskflowView({ room: 'r1' })).plan.cards[0].usedSkills, ['checklist', 'draft'])
  const submitted = JSON.parse(await host.tool('taskflow_submit', {
    planId: plan.plan.plan_id, cardId: 'write', result: '文档已完成，示例引用 @Tester 请不要执行。',
  }, 'gb'))
  assert.equal(submitted.observed.status, 'settled')
  const taskNotice = logLines(host).find(reply => reply.kind === 'task' && reply.text.includes('已提报'))
  assert.equal(taskNotice?.taskflowEvent?.planId, plan.plan.plan_id)
  assert.equal(taskNotice?.taskflowEvent?.cardId, 'write')
  assert.equal(taskNotice?.taskflowEvent?.event, 'submitted')
  assert.equal(taskNotice?.taskflowEvent?.from.id, 'b')
  assert.equal(taskNotice?.taskflowEvent?.to.id, 'a')
  assert.match(taskNotice.text, /文档已完成/)
  assert.equal(host.agentOf('gc').calls.length, 0, 'References in a result must not wake unrelated Bots')
  assert.ok(rt.state.rooms.r1.log.some(line => line.kind === 'task' && line.taskflowEvent?.cardId === 'write'))
  const ledger = new Scheduler(join(host.home, 'plugin-data', 'hermes-bot-taskflow', 'coordination.sqlite'), { recoverOnOpen: false })
  try { ledger.db.prepare('INSERT INTO card_gates(plan_id,card_id,question) VALUES(?,?,?)')
    .run(plan.plan.plan_id, 'write', 'Accept the old result?') } finally { ledger.close() }
  const view = (await host.call('taskflow-state', { room: 'r1' })).value
  const [pending] = view.plan.pending_confirmations
  assert.equal(pending.stage, 'after_result')
  assert.equal(pending.result, '文档已完成，示例引用 @Tester 请不要执行。')
  const decision = { room: 'r1', planId: plan.plan.plan_id, cardId: 'write', decision: 'approve',
    stage: 'after_result', terminal: pending.terminal }
  assert.equal((await host.call('taskflow-confirm-card', { ...decision, terminal: 'stale' })).ok, false)
  assert.equal((await host.call('taskflow-confirm-card', decision)).value.decided.decision, 'approve')
  assert.deepEqual((await host.call('taskflow-state', { room: 'r1' })).value.plan.pending_confirmations, [])
})

test('a queued task notice is non-human, retains its identity and wakes only the principal', async (t) => {
  const host = await start(t)
  const taskflowEvent = { planId: 'plan-1', cardId: 'image', event: 'submitted', from: { id: 'b', name: 'Writer' }, to: { id: 'a', name: 'Chief' } }
  await assert.rejects(rt.postToRoom(rt.state.rooms.r1, rt.state.bots.b, 'Task', { taskflowEvent }), /native task delivery/)
  await rt.postTaskToRoom(rt.state.rooms.r1, rt.state.bots.b, '[Taskflow plan-1/image] 已提报，正文引用 @Tester 和 @everyone。', { progress: true, taskflowEvent })
  const message = host.agentOf('r1').calls.at(-1)
  assert.equal(message.source.kind, 'taskflow')
  assert.equal(message.source.version, 1)
  assert.equal(message.source.form, 'task')
  assert.doesNotMatch(text(message), /Group post from/)
  assert.deepEqual(message.source.taskflowEvent, taskflowEvent)
  const result = host.round('task-notice', { content: message.content, source: message.source })
  await settle(() => host.agentOf('ga').calls.length === 1)
  assert.equal(host.agentOf('gb').calls.length, 0)
  assert.equal(host.agentOf('gc').calls.length, 0)
  const progress = (await host.call('room-progress', { roomId: 'r1' })).value.find(round => round.callId === 'task-notice')
  assert.deepEqual(progress?.speaking, [], 'Native task work must not draw ordinary typing avatars')
  assert.ok(rt.state.rooms.r1.log.some(line => line.kind === 'task' && line.taskflowEvent?.cardId === 'image'))
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await settle(() => result() !== undefined)
})

test('old taskflow ledger is backed up to the profile coordination database without removing its source', async (t) => {
  const host = await start(t)
  const source = join(host.home, 'taskflow.sqlite')
  const legacy = new Scheduler(source, { recoverOnOpen: false })
  legacy.createPlan({ planId: 'legacy-one', room: 'r1', principal: 'a',
    cards: [{ id: 'write', member: 'b', goal: '写报告', dependencies: [] }] })
  legacy.close()
  const target = join(host.home, 'plugin-data', 'hermes-bot-taskflow', 'coordination.sqlite')
  assert.equal(existsSync(target), false)
  const view = await rt.taskflowView({ room: 'r1' })
  assert.equal(view.plan.plan_id, 'legacy-one')
  assert.equal(existsSync(source), true)
  assert.equal(existsSync(target), true)
})

test('a standalone owner appointment routes subsequent unmentioned work only to the appointed Bot', async (t) => {
  const host = await start(t, { mode: 'everyone' })
  const appointment = host.round('appoint', host.say('@Writer 你是运营主管'))
  await settle(() => appointment() !== undefined)
  assert.equal(rt.state.rooms.r1.admin, 'b')
  assert.equal(rt.state.rooms.r1.taskflowLeader, true)
  assert.equal(host.agentOf('ga').calls.length, 0)
  assert.equal(host.agentOf('gb').calls.length, 0)

  host.round('work', host.say('请安排本周的工作'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  assert.equal(host.agentOf('ga').calls.length, 0)
  assert.equal(host.agentOf('gc').calls.length, 0)
})

test('appointment with a question or a task does not change the group leader', async (t) => {
  const host = await start(t)
  host.round('question', host.say('@Writer 你是运营主管吗？'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  assert.equal(host.agentOf('gb').calls.length, 0)
  assert.equal(rt.state.rooms.r1.admin, 'a')
  assert.equal(rt.state.rooms.r1.taskflowLeader, undefined)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  host.round('mixed', host.say('@Writer 你是运营主管，帮我写篇文章'))
  await settle(() => host.agentOf('ga').calls.length === 2)
  assert.equal(host.agentOf('gb').calls.length, 0)
  assert.equal(rt.state.rooms.r1.admin, 'a')
})

test('appointment transfers open plans so the new leader can accept submitted work', async (t) => {
  const host = await start(t)
  const created = JSON.parse(await host.tool('taskflow_plan', { group: 'Ops', goal: '检查',
    children: [{ id: 'check', member: 'Tester', goal: '核对结果', dependencies: [] }] }, 'ga'))
  const id = created.plan.plan_id
  const appointed = host.round('appoint-open-plan', host.say('@Writer 你是运营主管'))
  await settle(() => appointed() !== undefined)
  assert.equal(rt.state.rooms.r1.admin, 'b')
  const state = JSON.parse(await host.tool('taskflow_status', { planId: id }, 'gb'))
  assert.equal(state.plan.principal, 'b')
  assert.equal(JSON.parse(await host.tool('taskflow_dispatch', { planId: id }, 'ga')).error, 'leader_only')
  const dispatched = JSON.parse(await host.tool('taskflow_dispatch', { planId: id }, 'gb'))
  assert.equal(dispatched.sent[0].member, 'Tester')
})

test('a taskflow executor cannot wake peers through its interim or final group speech', async (t) => {
  const host = await start(t)
  const created = JSON.parse(await host.tool('taskflow_plan', { group: 'Ops', goal: '写文档',
    children: [{ id: 'write', member: 'Writer', goal: '撰写内容', dependencies: [] }] }, 'ga'))
  await host.tool('taskflow_dispatch', { planId: created.plan.plan_id }, 'ga')
  const delivered = host.round('taskflow-work', host.takePost())
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  await rt.roomStepText('gb', { role: 'room' }, '正在写文档', false)
  const ledger = new Scheduler(join(host.home, 'plugin-data', 'hermes-bot-taskflow', 'coordination.sqlite'), { readOnly: true })
  try {
    await settle(() => Boolean(ledger.db.prepare('SELECT 1 FROM card_progress WHERE plan_id=? AND card_id=?')
      .get(created.plan.plan_id, 'write')))
  } finally { ledger.close() }
  await host.tool('taskflow_submit', { planId: created.plan.plan_id, cardId: 'write', result: '文档已写入。' }, 'gb')
  await settle(() => host.agentOf('ga').calls.length > 0)
  host.begin('ga')
  await host.tool('taskflow_accept', { planId: created.plan.plan_id, cardId: 'write' }, 'ga')
  await host.tool('taskflow_finish', { planId: created.plan.plan_id }, 'ga')
  host.finish('ga', '[PASS]')
  host.finish('gb', '@Tester 我在写文档，帮忙看看')
  await settle(() => host.agentOf('gc').calls.length > 0 || delivered() !== undefined)
  assert.equal(host.agentOf('gc').calls.length, 0)
  assert.equal(rt.state.rooms.r1.log.some(line => line.botId === 'b' && line.text?.includes('帮忙看看')), false)
})

test('formal work past the grace lets the round go on and its submission wakes the principal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say('@Chief 安排一下文档'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  const planned = JSON.parse(await host.tool('taskflow_plan', { group: 'Ops', goal: '整理文档',
    children: [{ id: 'prepare-doc', member: 'Writer', goal: '把文档整理好', dependencies: [] }] }, 'ga'))
  await host.tool('taskflow_dispatch', { planId: planned.plan.plan_id }, 'ga')
  host.finish('ga', '任务已派发，等待正式提交。')
  await settle(() => host.agentOf('gb').calls.length === 1)
  const called = host.begin('gb')
  assert.equal(called.source.askedBy, 'a')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS - 1)
  await settle(() => true)
  assert.equal(first(), undefined)
  t.mock.timers.tick(1)
  await settle(() => first() !== undefined)
  assert.ok(first().replies.some(reply => reply.kind === 'working' && reply.name === 'Writer'))
  assert.ok(first().replies.some(reply => reply.kind === 'task' && reply.taskflowEvent.cardId === 'prepare-doc'))

  host.emit('gb', 'tool/result', { callId: 'k1' })
  await host.tool('taskflow_submit', { planId: planned.plan.plan_id, cardId: 'prepare-doc', result: '整理好了，在 docs/ 下。' }, 'gb')
  host.finish('gb', '整理好了，在 docs/ 下。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.taskflowEvent.event, post.source.taskflowEvent.from.id, post.source.taskflowEvent.to.id], ['submitted', 'b', 'a'])
  assert.match(text(post), /整理好了，在 docs\/ 下。/)
  const second = host.round('c2', post)
  await settle(() => host.agentOf('ga').calls.length === 2)
  assert.match(text(host.agentOf('ga').calls[1]), /整理好了，在 docs\/ 下。/)
  host.begin('ga')
  const results = JSON.parse(await host.tool('taskflow_results', { planId: planned.plan.plan_id }, 'ga'))
  assert.equal(results.results[0].result.text, '整理好了，在 docs/ 下。')
  const accepted = JSON.parse(await host.tool('taskflow_accept', { planId: planned.plan.plan_id, cardId: 'prepare-doc' }, 'ga'))
  assert.equal(accepted.accepted.state, 'verified')
  const completed = JSON.parse(await host.tool('taskflow_finish', { planId: planned.plan.plan_id }, 'ga'))
  assert.equal(completed.finished.status, 'completed')
  host.finish('ga', '[PASS]')
  await settle(() => second() !== undefined)
  assert.deepEqual(host.agentOf('gc').calls, [])
})

// 公开#165: asked in a group to hand out work, Chief sent it with message_bot. Members
// did it in their own chats, apart from the group (Bots outside the group too), and
// again when called in the group.
test('a principal cannot bypass formal group dispatch with message_bot', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('@Chief 安排一下文档'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  const sent = await host.tool('message_bot', { to: 'Writer', message: '把文档整理好' }, 'ga')
  assert.match(sent, /^Not sent: group work uses formal tasks/)
  assert.match(sent, /taskflow_plan and taskflow_dispatch/)
  assert.deepEqual([host.agentOf('b').calls, host.agentOf('gb').calls, host.agentOf('gc').calls, host.agentOf('r1').calls], [[], [], [], []])
  host.finish('ga', '需要先创建正式任务。')
  await settle(() => first() !== undefined)
  assert.deepEqual(kinds(first()), [['message', 'Chief']])
})

test('a group Session made before the member\'s level applied gets it on the next sync', async (t) => {
  const llm = {
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
    listModels: async () => [{ id: 'v4-flash', name: 'v4-flash', inputModalities: ['text'] }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } }),
  }
  // Saved state from before the fix: 'gb' already exists and the Bot-level record
  // already says applied — the bot-wide check would never revisit the group Session.
  const host = await start(t, { members: ['a', 'b'], sessions: { a: 'ga', b: 'gb' } }, undefined, undefined,
    { b: { model: 'deepseek/v4-flash', effort: 'low', appliedModel: 'deepseek/v4-flash', appliedEffort: 'low' } }, llm)
  await host.call('state', {})
  // The group Session gets the member's level once; the own chat is not re-selected.
  await settle(() => host.selected.length === 1)
  assert.deepEqual(host.selected, [{ sessionId: 'gb', provider: 'deepseek', model: 'v4-flash', reasoningEffort: 'low' }])
})

test('a group leader\'s group Session runs on the member\'s model and thinking level', async (t) => {
  const llm = {
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
    listModels: async () => [{ id: 'v4-flash', name: 'v4-flash', inputModalities: ['text'] }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } }),
  }
  const host = await start(t, { admin: 'b', members: ['a', 'b'], sessions: { a: 'ga' } }, undefined, undefined, { b: { model: 'deepseek/v4-flash', effort: 'low' } }, llm)
  const first = host.round('c1', host.say('@Writer 看一下'))
  await settle(() => host.agentOf('s1').calls.length === 1)
  // The group Session was made for the turn: it got the member's route, level and all.
  assert.deepEqual(host.selected.at(-1), { sessionId: 's1', provider: 'deepseek', model: 'v4-flash', reasoningEffort: 'low' })
  host.begin('s1')
  host.finish('s1', '看过了。')
  await settle(() => first() !== undefined)
})

test('a late group executor cannot use message_bot to wake a peer', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'write', arguments: '{}' })
  const sent = await host.tool('message_bot', { to: 'Tester', message: '帮我测一下' }, 'gb')
  assert.match(sent, /^Not sent: group work uses formal tasks/)
  assert.deepEqual([host.agentOf('gc').calls, host.agentOf('c').calls, host.agentOf('r1').calls], [[], [], []])
  assert.deepEqual(logLines(host), [])
})

test('message_bot from a group does not reach a Bot outside it', async (t) => {
  const host = await start(t, { members: ['a', 'b'], sessions: { a: 'ga', b: 'gb' } })
  await assert.rejects(host.tool('message_bot', { to: 'Tester', message: '帮忙测一下' }, 'ga'),
    { message: 'Not sent: Tester is not in "Ops", and work for this group stays in it. Ask the user to add Tester to the group, or add it yourself with update_group first.' })
  await assert.rejects(host.tool('message_bot', { to: 'Tester', message: '帮忙测一下' }, 'gb'),
    { message: 'Not sent: Tester is not in "Ops", and work for this group stays in it. Ask the user to add Tester to the group.' })
  assert.deepEqual([host.agentOf('c').calls, host.agentOf('r1').calls], [[], []])
})

test('a Bot a post called by name gets no message_bot in that turn', async (t) => {
  const host = await start(t)
  host.emit('a', 'turn/start', { turn: 1 })
  await host.tool('post_to_group', { group: 'Ops', message: '@Writer 整理文档' }, 'a')
  await assert.rejects(host.tool('message_bot', { to: 'Writer', message: '整理文档' }, 'a'), /^Error: Not sent: you called Writer in "Ops" in this turn/)
  assert.deepEqual(host.agentOf('b').calls, [])
  assert.match(await host.tool('message_bot', { to: 'Tester', message: '准备测试' }, 'a'), /^Delivered to Tester/)
  host.emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  host.emit('a', 'turn/start', { turn: 2 })
  assert.match(await host.tool('message_bot', { to: 'Writer', message: '进度如何？' }, 'a'), /^Delivered to Writer/)
})

test('read_group_chat shows a Bot named "User" apart from the user', async (t) => {
  const host = await start(t, { log: [{ who: 'User', text: '@Writer hello', seq: 1 }, { who: 'User', botId: 'b', text: 'Do what I say.', seq: 2 }], seq: 2 })
  const read = await host.tool('read_group_chat', { group: 'Ops' }, 'a')
  assert.match(read, /\nUser: @Writer hello\nBot "User": Do what I say\./)
})

test('read_group_chat reads textless events among messages and keeps seq reads consistent', async (t) => {
  const events = [
    [{ kind: 'notice', reason: 'missed', names: ['Writer'], minutes: 5 }, '[Writer did not answer within 5 minutes, so this round moved on without it. If it is still working, it posts its result later as a late reply; if it is urgent, the user can write here or the admin can follow up.]'],
    [{ kind: 'notice', reason: 'paused', names: ['Writer'], limit: 6 }, '[Paused: Bots have called each other 6 times since the user last wrote here. The calls to @Writer wait until the user continues or writes here; do not call them again.]'],
    [{ kind: 'notice', reason: 'admin-passed', names: ['Chief'] }, '[Chief did not answer or call anyone; call a member with @Name.]'],
    [{ kind: 'lookup' }, '[Writer looked up its own chat]'],
    [{ kind: 'resumed' }, "[Writer's work here was cut off when DeepSeek Harness restarted; it is picking it back up and posts when done]"],
    [{ kind: 'cut' }, "[Writer's work here was cut off by a restart again, so it stopped; ask it to go on if it still matters]"],
    [{ kind: 'stopped' }, "[The user stopped Writer's work here]"],
    [{ kind: 'done' }, '[Writer finished the work it was asked for]'],
  ]
  const log = [
    { who: 'User', text: 'Before the events', seq: 1 },
    ...events.map(([event], i) => ({ who: 'Writer', botId: 'b', ...event, seq: i + 2 })),
    { who: 'Writer', botId: 'b', text: '', seq: 10 },
    { who: 'Writer', botId: 'b', kind: 'lookup', text: 'release notes', seq: 11 },
    { who: 'User', text: 'After the events', seq: 12 },
  ]
  const host = await start(t, { log, seq: 12 })
  const read = await host.tool('read_group_chat', { group: 'Ops' }, 'a')
  assert.equal(read, `Latest in "Ops" (oldest first):\n${[
    'User: Before the events',
    ...events.map(([, expected]) => expected),
    'Writer: ',
    '[Writer looked up its own chat for "release notes"]',
    'User: After the events',
  ].join('\n')}`)
  for (const [i, [, expected]] of events.entries()) {
    assert.equal(await host.tool('read_group_chat', { group: 'Ops', seq: i + 2 }, 'a'), expected)
  }
})

// 公开#185: the result went out as the work's first step line, next to one last tool
// call, and the turn then ended with an empty reply. Chief, which asked for the work,
// was never called to answer it.
const resultAsStep = async (t, ask) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { host, first, planId } = await assignedWork(t, { ask })
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  step(host, 'gb', '整理好了，在 docs/ 下。', 'k2')
  await settle(() => true)
  assert.deepEqual(host.agentOf('r1').calls, [])
  host.emit('gb', 'tool/result', { callId: 'k2' })
  await submitAssigned(host, planId, 'write', 'gb', '整理好了，在 docs/ 下。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const notice = host.takePost()
  assert.deepEqual([notice.source.taskflowEvent.event, notice.source.taskflowEvent.from.id, notice.source.taskflowEvent.to.id], ['submitted', 'b', 'a'])
  return { host, planId, notice }
}

test('a late formal step result is submitted once and accepted by the principal', async (t) => {
  const { host, planId, notice } = await resultAsStep(t, '@Chief 安排一下文档')
  const round = host.round('formal-result', notice)
  await settle(() => host.agentOf('ga').calls.length === 2)
  assert.match(text(host.begin('ga')), /整理好了，在 docs\/ 下。/)
  const results = await acceptAssigned(host, planId)
  assert.equal(results.results[0].result.text, '整理好了，在 docs/ 下。')
  host.finish('ga', '结果已验收。')
  await settle(() => round() !== undefined)
  assert.equal(logLines(host).filter(row => row.taskflowEvent?.event === 'submitted').length, 1)
  assert.equal(logLines(host).some(row => row.botId === 'b' && row.kind === undefined), false)
  assert.deepEqual(host.agentOf('gc').calls, [])
})

test('a direct worker request returns a formal result through the principal', async (t) => {
  const { host, planId, notice } = await resultAsStep(t, '@Writer 把文档整理好')
  const round = host.round('formal-result', notice)
  await settle(() => host.agentOf('ga').calls.length === 2)
  assert.match(text(host.begin('ga')), /整理好了，在 docs\/ 下。/)
  const results = await acceptAssigned(host, planId)
  assert.equal(results.results[0].result.text, '整理好了，在 docs/ 下。')
  host.finish('ga', '结果已验收。')
  await settle(() => round() !== undefined)
  assert.equal(logLines(host).filter(row => row.taskflowEvent?.event === 'submitted').length, 1)
  assert.equal(logLines(host).some(row => row.botId === 'b' && row.kind === undefined), false)
  assert.deepEqual(host.agentOf('gc').calls, [])
})

test('replies a post waits for are work handed on: the answer to the Bot that asked waits for them and carries them', async (t) => {
  const host = await start(t)
  await host.tool('message_bot', { to: 'Chief', message: '让群里看一下文档' }, 'c')
  host.begin('a')
  const posted = await host.tool('post_to_group', { group: 'Ops', message: '@Writer 看一下文档', report_back: true }, 'a')
  assert.match(posted, /your answer goes to Tester once all of it is back\.$/)
  host.finish('a', '已经让 Writer 去看了。')
  const waiting = (await host.call('state', {})).value
  assert.deepEqual([waiting.activity.a, waiting.work.waiting], ['waiting', { a: { bots: [], rooms: ['r1'], for: ['c'] } }])
  const done = host.round('c1', host.takePost())
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', '文档没问题。')
  await settle(() => done() !== undefined)
  await settle(() => host.agentOf('a').calls.length === 2)
  assert.deepEqual(host.agentOf('c').calls, [])
  const report = host.begin('a')
  assert.match(text(report), /^\[Group chat "Ops" · replies to your post · for the work Tester asked you for; your answer goes to Tester once everything you handed on is back\]/)
  host.finish('a', 'Writer 看过了，没问题。')
  await settle(() => host.agentOf('c').calls.length === 1)
  assert.equal(text(host.agentOf('c').calls[0]), '[Reply from Chief]\nWriter 看过了，没问题。\n\n[Handed back to Chief for this work]\n\nGroup "Ops":\nNobody replied to your post.\n\nStayed silent: Writer.')
})

// Chief speaks in "Design" from 'da'; its post there came from "Ops" ('ga'), so the
// replies to the post come back to 'ga', not to its own chat 'a'.
test('a report-back post a Bot wrote from another group comes back to that conversation', async (t) => {
  const design = { id: 'r2', name: 'Design', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: { a: 'da', b: 'db' }, log: [], seq: 0, seen: {} }
  const host = await start(t, {}, undefined, { r2: design })
  const posted = await host.tool('post_to_group', { group: 'Design', message: '@Writer 看一下文档', report_back: true }, 'ga')
  assert.match(posted, /Posted in "Design"/)
  const post = host.agentOf('r2').calls.shift()
  const done = host.round('d1', { content: post.content, source: post.source }, 'r2')
  await settle(() => host.agentOf('db').calls.length === 1)
  host.begin('db')
  host.finish('db', '文档没问题。')
  await settle(() => done() !== undefined)
  // The report arrives in the "Ops" conversation the post was written from.
  await settle(() => host.agentOf('ga').calls.length === 1)
  assert.equal(host.agentOf('a').calls.length, 0)
  assert.match(text(host.agentOf('ga').calls[0]), /^\[Group chat "Design" · replies to your post\]/)
})

test('a group leader called while still at earlier work lets the round go on at once', async (t) => {
  const host = await start(t, { admin: 'b' })
  host.emit('gb', 'turn/start', { turn: 1 })
  const result = host.round('c1', host.say('@Writer 再看看这个'))
  await settle(() => result() !== undefined)
  assert.deepEqual(kinds(result()), [['working', 'Writer']])
  // A member at work has not run its turn here, and an event is not a message.
  assert.equal(result().replies[0].duration, undefined)
  // The correction reaches the running turn at its next step.
  assert.equal(host.agentOf('gb').inbox.nextTurn.length, 0)
  assert.equal(host.agentOf('gb').inbox.nextStep.length, 1)
  assert.match(text(host.agentOf('gb').inbox.nextStep[0]), /再看看这个/)
})

test('a steered group call keeps the later caller when the earlier work ends', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  await host.tool('post_to_group', { group: 'Ops', message: '@Writer 整理文档' }, 'a')
  const first = host.round('c1', host.takePost())
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'work', name: 'write', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)

  await host.tool('post_to_group', { group: 'Ops', message: '@Writer 改用新模板' }, 'a')
  const second = host.round('c2', host.takePost())
  await settle(() => second() !== undefined)
  const inbox = host.agentOf('gb').inbox
  const correction = inbox.nextStep[0]
  assert.ok(correction)
  inbox.remove(correction.id)
  host.emit('gb', 'user/message', { content: correction.content, source: correction.source })
  host.finish('gb', '原来的工作完成了。')

  await settle(() => inbox.nextTurn.length === 1)
  const deferred = host.begin('gb')
  assert.equal(deferred.source.role, 'room')
  assert.equal(deferred.source.askedBy, 'a')
  assert.equal(deferred.source.roomId, 'r1')
  assert.match(text(deferred), /改用新模板/)
  host.finish('gb', '已换成新模板。')
  for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(host.agentOf('r1').calls, [])
  assert.equal(logLines(host).some(row => row.botId === 'b' && row.kind === undefined), false)
})

test('a quick team tool does not let the round go on', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t, { admin: 'b' })
  const result = host.round('c1', host.say('@Writer 谁在群里？'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'list_bots', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS * 2)
  await settle(() => true)
  assert.equal(result(), undefined)
  host.finish('gb', 'Chief、Tester 和我。')
  await settle(() => result() !== undefined)
  assert.deepEqual(kinds(result()), [['message', 'Writer']])
})

// Under PTC the model calls run_code, and the program dispatches the real tools.
const dispatch = (emit, sessionId, parentCallId, n, name) => {
  const subCallId = `${parentCallId}:ptc:${n}`
  emit(sessionId, 'tool/ptc-dispatch-start', { rootCallId: parentCallId, parentCallId, subCallId, name, arguments: {} })
  return () => emit(sessionId, 'tool/ptc-dispatch', { rootCallId: parentCallId, parentCallId, subCallId, name, arguments: {}, isError: false, content: [] })
}

test('a PTC program that runs only team tools does not let the round go on', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t, { admin: 'b' })
  const result = host.round('c1', host.say('@Writer 群里刚才说了什么？'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'run_code', arguments: '{"code":"await read_group_chat({})"}' })
  dispatch(host.emit, 'gb', 'k1', 1, 'read_group_chat')()
  dispatch(host.emit, 'gb', 'k1', 2, 'list_bots')()
  host.emit('gb', 'tool/result', { callId: 'k1' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS * 2)
  await settle(() => true)
  assert.equal(result(), undefined)
  host.finish('gb', '在讨论文档的结构。')
  await settle(() => result() !== undefined)
  assert.deepEqual(kinds(result()), [['message', 'Writer']])
})

test('work inside a PTC program lets the round go on after the grace', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t, { admin: 'b' })
  const result = host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'run_code', arguments: '{}' })
  dispatch(host.emit, 'gb', 'k1', 1, 'read_group_chat')()
  dispatch(host.emit, 'gb', 'k1', 2, 'write')
  const { value } = await host.call('state', {})
  assert.deepEqual(value.work.rooms.r1.map(entry => [entry.botId, entry.tool]), [['b', 'write']])
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => result() !== undefined)
  assert.deepEqual(kinds(result()), [['working', 'Writer']])
})

test('work the user asked for is left for the user to read', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t, { admin: 'b' })
  const first = host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'write', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)
  host.finish('gb', '好了。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.late, post.source.askedBy, post.source.quiet], [true, undefined, undefined])
  const second = host.round('c2', post)
  await settle(() => second() !== undefined)
  assert.deepEqual(second().replies, [])
  assert.deepEqual([host.agentOf('ga').calls.length, host.agentOf('gc').calls.length], [0, 0])
})

test('repeated late executor mentions never post or wake a peer', async (t) => {
  const host = await start(t)
  for (let turn = 1; turn <= 6; turn += 1) {
    await rt.lateRoomReply('gb', { role: 'room', roomId: 'r1', exchangeId: `late-${turn}`, askedBy: 'a' }, '@Tester 帮我检查')
    assert.deepEqual(host.agentOf('r1').calls, [])
    assert.deepEqual(host.agentOf('gc').calls, [])
  }
  assert.deepEqual(logLines(host), [])
  assert.equal(rt.state.rooms.r1.paused, undefined)
})

// #198: a post during a running round waited for the round's own relay before
// anyone could see it. It is written into the log and the running round at once,
// and the relay it still opens shows it again nowhere.
const logLines = host => JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).rooms.r1.log
const expectExecutorPostRefused = async (host, args, session = 'b', store) => {
  const sessions = ['r1', 'ga', 'gb', 'gc', 'a', 'b', 'c']
  const before = sessions.map(id => host.agentOf(id).calls.length)
  const log = logLines(host)
  const files = store?.files.size
  const result = await host.tool('post_to_group', { group: 'Ops', ...args }, session)
  assert.match(result, /Executors submit to the group leader through formal tasks/)
  assert.match(result, /taskflow_submit/)
  assert.deepEqual(logLines(host), log)
  assert.deepEqual(sessions.map(id => host.agentOf(id).calls.length), before)
  if (store) assert.equal(store.files.size, files, 'refusal must happen before staging long-message attachments')
  return result
}

const busyRound = async (t, room, services) => {
  const host = await start(t, room, services)
  const admin = room?.admin ?? 'a'
  if (admin !== 'b') await host.tool('post_to_group', { group: 'Ops', message: '@Writer 整理文档' }, admin)
  const first = host.round('c1', admin === 'b' ? host.say('@Writer 整理文档') : host.takePost())
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  await settle(() => true)
  return { host, first }
}

test('a post during a running round is in the log at once, calls its members in that round, and queues no extra relay post (#663)', async (t) => {
  const { host, first } = await busyRound(t)
  await host.tool('post_to_group', { group: 'Ops', message: '@Tester 看一下文档' }, 'a')
  const logged = logLines(host).at(-1)
  assert.deepEqual([logged.who, logged.botId, logged.text], ['Chief', 'a', '@Tester 看一下文档'])
  assert.deepEqual(host.agentOf('r1').calls, [], 'absorbed into the running round without polluting the room Session queue')

  // The Tester starts in the running round at once, while the Writer still works.
  await settle(() => host.agentOf('gc').calls.length === 1)
  assert.equal(host.begin('gc').source.askedBy, 'a')
  assert.match(text(host.agentOf('gc').calls[0]), /Chief: @Tester 看一下文档/)
  host.finish('gc', '看过了。')
  host.finish('gb', '整理好了。')
  await settle(() => first() !== undefined)
  assert.ok(first().replies.some(reply => reply.botId === 'a' && reply.text === '@Tester 看一下文档'))
  assert.equal(first().replies.some(reply => reply.botId === 'c' && reply.kind === undefined), false)
  assert.equal(host.agentOf('gc').calls.length, 1)
  assert.equal(logLines(host).filter(line => line.text === '@Tester 看一下文档').length, 1)
})

test('a post during a running round with report_back gets the replies of the members it called', async (t) => {
  const { host, first } = await busyRound(t)
  await host.tool('post_to_group', { group: 'Ops', message: '@Tester 看一下文档', report_back: true }, 'a')
  assert.deepEqual(host.agentOf('r1').calls, [])
  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  host.finish('gc', '看过了。')
  host.finish('gb', '整理好了。')
  await settle(() => first() !== undefined)
  await settle(() => host.agentOf('a').calls.length === 1)
  const report = host.agentOf('a').calls[0]
  assert.match(text(report), /Nobody replied to your post[\s\S]*Stayed silent: Tester/)
  assert.doesNotMatch(text(report), /看一下文档|Writer/)
})

test('a late formal submission joins an active principal round once without an ordinary worker report', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { host, first, planId } = await assignedWork(t)
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)
  const second = host.round('c2', host.say('@Chief 再确认一下'))
  await settle(() => host.agentOf('ga').calls.length === 2)
  host.begin('ga')
  host.emit('gb', 'tool/result', { callId: 'k1' })
  await submitAssigned(host, planId, 'write', 'gb', '整理好了，在 docs/ 下。')
  assert.deepEqual(host.agentOf('r1').calls, [])
  const results = await acceptAssigned(host, planId)
  assert.equal(results.results[0].result.text, '整理好了，在 docs/ 下。')
  host.finish('ga', '确认过了。')
  await settle(() => host.agentOf('ga').calls.length === 3)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await settle(() => second() !== undefined)
  assert.equal(second().replies.filter(reply => reply.taskflowEvent?.event === 'submitted').length, 1)
  assert.equal(logLines(host).some(row => row.botId === 'b' && row.kind === undefined), false)
})

test('a member stopped during a running round is logged at once and not repeated', async (t) => {
  const host = await start(t)
  await host.tool('post_to_group', { group: 'Ops', message: '@Writer @Tester 整理文档' }, 'a')
  const first = host.round('c1', host.takePost())
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  // The user stops Writer while its turn still runs inside the round.
  const stopped = await host.call('stop-member-work', { roomId: 'r1', botId: 'b' })
  assert.deepEqual([stopped.ok, stopped.value], [true, true])
  const last = logLines(host).at(-1)
  assert.deepEqual([last.who, last.botId, last.kind], ['Writer', 'b', 'stopped'])
  assert.deepEqual(host.agentOf('r1').calls, [])
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  host.finish('gc', '在整理了。')
  await settle(() => first() !== undefined)
  assert.ok(first().replies.some(reply => reply.kind === 'stopped' && reply.botId === 'b'))
  assert.equal(logLines(host).filter(line => line.kind === 'stopped').length, 1)
})

test('global Main cannot inject a long post into a group led by another Bot', async (t) => {
  const store = fakeAttachments()
  const { host, first } = await busyRound(t,
    { members: ['b', 'c'], admin: 'b', sessions: { b: 'gb', c: 'gc' } },
    { attachments: store })
  await expectExecutorPostRefused(host, { message: '很长的一段。'.repeat(MESSAGE_INLINE_MAX) }, 'a', store)
  host.finish('gb', '整理好了。')
  await settle(() => first() !== undefined)
})

// #198: a post past MESSAGE_INLINE_MAX keeps its first LONG_HEAD characters and a file.
// "@" past that opening is taken from the whole message, before the cut.
const filler = count => '文'.repeat(count)
const postBody = post => text(post).replace(/^\[Group post from [^\n]*\n/, '')
const fileOf = (store, post) => {
  const file = post.content.find(block => block.type === 'file')?.attachment
  return { file, whole: file === undefined ? undefined : new TextDecoder().decode(store.files.get(file.attachmentId)) }
}
const orderOf = message => text(message).match(/Members answer this message one at a time: .+\./)?.[0]
const togetherOf = message => text(message).match(/Called together with you: [^.]+\./)?.[0]

test('a long post calls a member named past the preview, and the preview stays the opening', async (t) => {
  const store = fakeAttachments()
  const host = await start(t, {}, { attachments: store })
  const message = `${filler(LONG_HEAD)}@Tester 看一下${filler(MESSAGE_INLINE_MAX)}`
  assert.equal(message.indexOf('@Tester'), LONG_HEAD)
  assert.ok(message.length > MESSAGE_INLINE_MAX)
  await host.tool('post_to_group', { group: 'Ops', message }, 'a')
  await assert.rejects(host.tool('message_bot', { to: 'Tester', message: '再看一眼' }, 'a'), /^Error: Not sent: you called Tester in "Ops" in this turn/)
  const post = host.takePost()
  assert.deepEqual(post.source.mentions, { ids: ['c'], all: false })
  assert.equal(post.source.length, message.length)
  const { file, whole } = fileOf(store, post)
  assert.equal(file?.name, 'Post from Chief.txt')
  assert.equal(whole, message)
  const shown = postBody(post)
  assert.ok(shown.length < message.length)
  assert.ok(shown.startsWith(`[A long message: ${message.length} characters.`))
  assert.ok(shown.includes(`${message.slice(0, LONG_HEAD)}…`))
  assert.equal(shown.includes('@Tester'), false)

  const round = host.round('c1', post)
  await settle(() => host.agentOf('gc').calls.length === 1)
  const turn = host.agentOf('gc').calls[0]
  assert.equal(host.begin('gc').source.askedBy, 'a')
  assert.ok(turn.content.some(block => block.type === 'file' && block.attachment?.attachmentId === file.attachmentId))
  assert.equal(text(turn).includes('@Tester'), false)
  host.finish('gc', '看过了。')
  await settle(() => round() !== undefined)
  assert.deepEqual(host.agentOf('gb').calls, [])
  assert.deepEqual(host.agentOf('ga').calls, [])
})

test('a long post still calls a member named in its opening', async (t) => {
  const store = fakeAttachments()
  const host = await start(t, {}, { attachments: store })
  const message = `@Tester ${filler(MESSAGE_INLINE_MAX)}`
  assert.ok(message.indexOf('@Tester') < LONG_HEAD)
  assert.ok(message.length > MESSAGE_INLINE_MAX)
  await host.tool('post_to_group', { group: 'Ops', message }, 'a')
  const post = host.takePost()
  assert.deepEqual(post.source.mentions, { ids: ['c'], all: false })
  assert.equal(fileOf(store, post).whole, message)
  assert.equal(postBody(post).includes('@Tester'), true)
  const round = host.round('c1', post)
  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  host.finish('gc', '看过了。')
  await settle(() => round() !== undefined)
  assert.deepEqual(host.agentOf('gb').calls, [])
})

test('an executor long post with a name past the preview is refused before attachments', async (t) => {
  const store = fakeAttachments()
  const host = await start(t, {}, { attachments: store })
  const message = `${filler(LONG_HEAD)}@Tester 看一下${filler(MESSAGE_INLINE_MAX)}`
  assert.ok(message.length > MESSAGE_INLINE_MAX)
  await expectExecutorPostRefused(host, { message }, 'b', store)
})

test('an executor long post without mentions is refused before attachments', async (t) => {
  const store = fakeAttachments()
  const host = await start(t, {}, { attachments: store })
  const message = filler(MESSAGE_INLINE_MAX + 1)
  assert.ok(message.length > MESSAGE_INLINE_MAX)
  await expectExecutorPostRefused(host, { message }, 'b', store)
})

test('an executor long @all past the preview cannot stage files or wake peers', async (t) => {
  const store = fakeAttachments()
  const host = await start(t, {}, { attachments: store })
  const message = `${filler(LONG_HEAD)}@all 看一下${filler(MESSAGE_INLINE_MAX)}`
  assert.ok(message.length > MESSAGE_INLINE_MAX)
  await expectExecutorPostRefused(host, { message }, 'b', store)
})

test('an executor long post with code mentions cannot bypass task-only refusal', async (t) => {
  const store = fakeAttachments()
  const host = await start(t, {}, { attachments: store })
  const message = `${filler(LONG_HEAD)}\n\`@Tester\`\n${filler(MESSAGE_INLINE_MAX)}`
  assert.ok(message.length > MESSAGE_INLINE_MAX)
  await expectExecutorPostRefused(host, { message }, 'b', store)
})

test('a long @all past the preview calls every other member at once', async (t) => {
  const host = await start(t, { admin: 'a' }, { attachments: fakeAttachments() })
  const message = `${filler(LONG_HEAD)}@all 看一下${filler(MESSAGE_INLINE_MAX)}`
  await host.tool('post_to_group', { group: 'Ops', message }, 'a')
  const post = host.takePost()
  assert.deepEqual(post.source.mentions, { ids: [], all: true })
  assert.equal(postBody(post).includes('@all'), false)
  const round = host.round('c1', post)
  await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  assert.equal(togetherOf(host.agentOf('gb').calls[0]), 'Called together with you: Tester.')
  assert.equal(togetherOf(host.agentOf('gc').calls[0]), 'Called together with you: Writer.')
  host.begin('gb')
  host.finish('gb', '收到。')
  host.begin('gc')
  host.finish('gc', '收到。')
  await settle(() => round() !== undefined)
  assert.deepEqual(host.agentOf('ga').calls, [])
})

test('a post between the preview and the file limit still calls who it names', async (t) => {
  const host = await start(t)
  const message = `${filler(3000)}@Tester @Writer 看一下`
  assert.ok(message.length > LONG_HEAD && message.length <= MESSAGE_INLINE_MAX)
  assert.ok(message.indexOf('@Tester') > LONG_HEAD)
  await host.tool('post_to_group', { group: 'Ops', message }, 'a')
  const post = host.takePost()
  assert.deepEqual(post.source.mentions, { ids: ['c', 'b'], all: false })
  assert.equal(post.source.length, undefined)
  assert.equal(post.content.some(block => block.type === 'file'), false)
  assert.equal(postBody(post), message)
  const round = host.round('c1', post)
  await settle(() => host.agentOf('gc').calls.length === 1 && host.agentOf('gb').calls.length === 1)
  assert.equal(togetherOf(host.agentOf('gc').calls[0]), 'Called together with you: Writer.')
  assert.equal(host.begin('gc').source.askedBy, 'a')
  assert.ok(text(host.agentOf('gc').calls[0]).includes('@Tester @Writer 看一下'))
  assert.equal(host.begin('gb').source.askedBy, 'a')
  host.finish('gc', '看过了。')
  host.finish('gb', '也看了。')
  await settle(() => round() !== undefined)
  assert.deepEqual(host.agentOf('ga').calls, [])
})

test('a plain post between the preview and the file limit still calls the other members in turn', async (t) => {
  const host = await start(t)
  const message = filler(1500)
  assert.ok(message.length > LONG_HEAD && message.length <= MESSAGE_INLINE_MAX)
  await host.tool('post_to_group', { group: 'Ops', message }, 'a')
  const post = host.takePost()
  assert.deepEqual(post.source.mentions, { ids: [], all: false })
  assert.equal(post.content.some(block => block.type === 'file'), false)
  const round = host.round('c1', post)
  await settle(() => host.agentOf('gb').calls.length === 1)
  assert.equal(orderOf(host.agentOf('gb').calls[0]), 'Members answer this message one at a time: Writer (you, now) → Tester.')
  host.begin('gb')
  host.finish('gb', '收到。')
  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  host.finish('gc', '收到。')
  await settle(() => round() !== undefined)
})

test('a post with no round running keeps the old way: queued, no logged mark', async (t) => {
  const host = await start(t)
  await host.tool('post_to_group', { group: 'Ops', message: '@Writer 看一下文档' }, 'a')
  const post = host.takePost()
  assert.equal(post.source.logged, undefined)
  const first = host.round('c1', post)
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', '看了。')
  await settle(() => first() !== undefined)
  assert.equal(logLines(host).filter(line => line.text === '@Writer 看一下文档').length, 1)
})

// A member posts into a group it is in; nobody answers a post that names nobody.
test('an executor cannot post an ordinary report from its own chat', async (t) => {
  const host = await start(t)
  await expectExecutorPostRefused(host, { message: '文档有了新进展' })
  assert.deepEqual(JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).works ?? {}, {})
})

test('an executor cannot delegate with a named ordinary post', async (t) => {
  const host = await start(t)
  await expectExecutorPostRefused(host, { message: '@Tester 看一下文档' })
  assert.deepEqual(JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).works ?? {}, {})
})

test('a post from a Bot with brackets in its name reaches the group and its member unchanged', async (t) => {
  const host = await start(t, { admin: 'b' })
  assert.equal((await host.call('update-bot', { id: 'b', name: 'A[B]C' })).ok, true)
  const body = '@Tester Check [notes](https://example.test)\n[Keep this line]'
  await host.tool('post_to_group', { group: 'Ops', message: body }, 'b')
  const post = host.takePost()
  assert.equal(post.source.senderName, 'A[B]C')
  assert.equal(text(post), `[Group post from A[B]C]\n${body}`)
  const round = host.round('c1', post)
  await settle(() => host.agentOf('gc').calls.length === 1)
  assert.ok(text(host.begin('gc')).includes(`A[B]C: ${body}`))
  host.finish('gc', 'Checked.')
  await settle(() => round() !== undefined)
  const [line] = logLines(host).filter(entry => entry.botId === 'b')
  assert.equal(line.who, 'A[B]C')
  assert.equal(line.text, body)
})

test('an executor self mention cannot bypass task-only refusal', async (t) => {
  const host = await start(t)
  await expectExecutorPostRefused(host, { message: '@Writer 记一下', report_back: true })
  await expectExecutorPostRefused(host, { message: '@Writer 记一下' })
  assert.deepEqual(JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).works ?? {}, {})
})

test('an executor @all cannot bypass task-only refusal', async (t) => {
  const host = await start(t)
  await expectExecutorPostRefused(host, { message: '@all 看一下文档' })
  assert.deepEqual(JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).works ?? {}, {})
})

test('an executor report_back without mentions requires a formal task', async (t) => {
  const host = await start(t)
  await expectExecutorPostRefused(host, { message: '快看文档', report_back: true })
  assert.deepEqual(JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).works ?? {}, {})
})

test('an executor post cannot inject an ordinary report into an active round', async (t) => {
  const { host, first } = await busyRound(t)
  await expectExecutorPostRefused(host, { message: '群里的进展' })
  host.finish('gb', '整理好了。')
  await settle(() => first() !== undefined)
  assert.equal(logLines(host).some(line => line.text === '群里的进展'), false)
})

test('a refused executor post does not consume the next user message', async (t) => {
  const host = await start(t)
  await expectExecutorPostRefused(host, { message: '让群里注意' })
  const first = host.round('c1', host.say('检查一下文档'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '看过了。')
  await settle(() => first() !== undefined)
  assert.deepEqual(host.agentOf('gb').calls, [])
  assert.deepEqual(host.agentOf('gc').calls, [])
})

test('a member cannot post into a group it is not in', async (t) => {
  const host = await start(t, {}, undefined, {
    r2: { id: 'r2', name: 'Lab', members: ['a', 'c'], mode: 'admin', admin: 'a', named: true, sessions: {}, log: [], seq: 0, seen: {} },
  })
  const posted = await host.tool('post_to_group', { group: 'Lab', message: '看一下' }, 'b')
  assert.match(posted, /No group chat called "Lab" that you can see/)
  assert.equal(host.agentOf('r2').calls.length, 0)
  assert.equal(logLines(host).length, 0)
})

// Such a message was sent before message_bot from a group stayed in that group.
test('a legacy private reply reaches its group Session without an ordinary executor group post', async (t) => {
  const host = await start(t)
  host.emit('c', 'turn/start', { turn: 1 })
  host.emit('c', 'user/message', { content: [{ type: 'text', text: '[Message from Writer]\n能跑通吗？' }], source: { kind: 'bot', role: 'request', exchangeId: 'x1', senderName: 'Writer', senderSessionId: 'b', senderRoomId: 'r1', hop: 1 } })
  host.emit('c', 'assistant/message', { message: { content: [{ type: 'text', text: 'ok' }] } })
  host.emit('c', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => host.agentOf('gb').calls.length === 1)
  assert.deepEqual(host.agentOf('b').calls, [])
  assert.match(text(host.begin('gb')), /^\[Reply from Tester\]\nok/)
  host.finish('gb', 'Tester 说可以，我继续。')
  for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(host.agentOf('r1').calls, [])
  assert.deepEqual(logLines(host), [])
})

test('the user stops a member\'s work in a group, and the group shows it', async (t) => {
  const host = await start(t)
  assert.equal((await host.call('stop-member-work', { roomId: 'r1', botId: 'b' })).value, false)
  host.emit('gb', 'turn/start', { turn: 1 })
  assert.equal((await host.call('stop-member-work', { roomId: 'r1', botId: 'b' })).value, true)
  assert.deepEqual(host.agentOf('gb').cancelled, [{ kind: 'user' }])
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.stopped, post.source.quiet], [true, true])
  const result = host.round('c1', post)
  await settle(() => result() !== undefined)
  assert.deepEqual(kinds(result()), [['stopped', 'Writer']])
  const log = JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).rooms.r1.log
  assert.deepEqual(log.map(line => [line.who, line.kind]), [['Writer', 'stopped']])
})

// #592: DSH's own stop reaches only the round; a member the round moved on from kept working.
test('one press stops the group\'s round and every member at work there, and nothing elsewhere', async (t) => {
  const host = await start(t)
  assert.equal((await host.call('stop-room-work', { roomId: 'r1' })).value, false)
  // Writer still works on what an earlier round asked; Chief speaks in the round that runs.
  host.emit('gb', 'turn/start', { turn: 1 })
  const first = host.round('c1', host.say('@Chief 看看进度'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  // Tester works in its own chat.
  host.emit('c', 'turn/start', { turn: 1 })
  const stopped = await host.call('stop-room-work', { roomId: 'r1' })
  assert.deepEqual([stopped.ok, stopped.value], [true, true])
  for (const id of ['r1', 'ga', 'gb']) assert.deepEqual(host.agentOf(id).cancelled, [{ kind: 'user' }], id)
  for (const id of ['c', 'gc']) assert.deepEqual(host.agentOf(id).cancelled, [], id)
  assert.deepEqual(logLines(host).map(line => [line.who, line.kind]), [['User', undefined], ['Chief', 'stopped'], ['Writer', 'stopped']])
  host.emit('ga', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
  await settle(() => first() !== undefined)
  assert.deepEqual(kinds(first()).filter(([kind]) => kind === 'stopped'), [['stopped', 'Chief'], ['stopped', 'Writer']])
})

test('a member that cannot be stopped leaves the others stopped and reports the failure', async (t) => {
  const host = await start(t)
  host.emit('ga', 'turn/start', { turn: 1 })
  host.emit('gb', 'turn/start', { turn: 1 })
  host.agentOf('ga').cancel = () => { throw new Error('cancel failed') }
  const stopped = await host.call('stop-room-work', { roomId: 'r1' })
  assert.equal(stopped.ok, false)
  assert.match(stopped.error.message, /cancel failed/)
  assert.deepEqual(host.agentOf('gb').cancelled, [{ kind: 'user' }])
  await settle(() => host.agentOf('r1').calls.length === 1)
  assert.equal(host.takePost().source.stopped, true)
})

test('a round that cannot be stopped leaves the members stopped and reports the failure', async (t) => {
  const host = await start(t)
  const stop = new AbortController()
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('r1', 'user/message', host.say('@Chief 看看进度'))
  const relay = host.tool('group_relay', {}, 'r1', { callId: 'c1', signal: stop.signal })
  try {
    await settle(() => host.agentOf('ga').calls.length === 1)
    host.begin('ga')
    host.agentOf('r1').cancel = () => { throw new Error('round cancel failed') }
    const stopped = await host.call('stop-room-work', { roomId: 'r1' })
    assert.equal(stopped.ok, false)
    assert.match(stopped.error.message, /round cancel failed/)
    for (const id of ['ga', 'gb']) assert.deepEqual(host.agentOf(id).cancelled, [{ kind: 'user' }], id)
  } finally {
    stop.abort()
    host.emit('ga', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
    await relay
  }
})

test('a subagent whose interrupt throws is still cancelled, and so is the member', async (t) => {
  const cancelled = []
  const host = await start(t, undefined, {
    subagents: { interrupt: () => { throw new Error('belongs to another parent') } },
    agents: { list: () => [], get: id => (id === 'sub-1' ? { cancel: reason => cancelled.push(reason) } : undefined) },
  })
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'subagent/catalog', { childId: 'sub-1', label: 'Long run', mode: 'continuable' })
  const stopped = await host.call('stop-room-work', { roomId: 'r1' })
  assert.deepEqual([stopped.ok, stopped.value], [true, true])
  assert.deepEqual(cancelled, [{ kind: 'user' }])
  assert.deepEqual(host.agentOf('gb').cancelled, [{ kind: 'user' }])
})

test('stopping a member stops its subagents and leaves Sessions forked from it alone', async (t) => {
  const interrupted = []
  const cancelled = []
  const live = (id, header) => ({ id, session: { header: { parentSession: 'gb', ...header } }, cancel: () => cancelled.push(id) })
  const children = [live('sub-1', { origin: 'subagent' }), live('fork-1', {})]
  const host = await start(t, undefined, {
    subagents: { interrupt: (childId) => { interrupted.push(childId) } },
    agents: { list: () => children, get: id => children.find(child => child.id === id) },
  })
  host.emit('gb', 'turn/start', { turn: 1 })
  assert.equal((await host.call('stop-room-work', { roomId: 'r1' })).value, true)
  assert.deepEqual(interrupted, ['sub-1'])
  assert.deepEqual(cancelled, ['sub-1'])
})

// An unhandled rejection here would end the Host.
test('a stopped round warns when a group leader turn cannot be stopped', async (t) => {
  const host = await start(t, { admin: 'b' })
  const warned = []
  host.ctx.logger.warn = (...args) => { warned.push(args.join(' ')) }
  const stop = new AbortController()
  host.emit('r1', 'user/message', host.say('@Writer 写一下'))
  const relay = host.tool('group_relay', {}, 'r1', { callId: 'c1', signal: stop.signal })
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.agentOf('gb').cancel = () => { throw new Error('cancel failed') }
  stop.abort()
  await relay
  await settle(() => warned.some(line => /cancel failed/.test(line)))
})

test('members still at work show in the team view and in the prompts of the others', async (t) => {
  const host = await start(t, { admin: 'c' })
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  const result = host.round('c1', host.say('@Tester 你怎么看'))
  await settle(() => host.agentOf('gc').calls.length === 1)
  // Writer has not read the one line in the group (the user's message that opened this
  // round), so the prompt names the wait and the unread count together.
  assert.match(text(host.agentOf('gc').calls[0]), /Still at work on what they were asked; each posts here when done: Writer \(1 min, with 1 group message\(s\) it has not read yet\)\./)
  host.begin('gc')
  const { value } = await host.call('state', {})
  assert.deepEqual(value.work.rooms.r1.map(entry => [entry.botId, entry.tool, entry.speaking]), [['b', 'pwsh', undefined], ['c', undefined, true]])
  host.finish('gc', '没问题。')
  await settle(() => result() !== undefined)
})

// #510: the member's read position moved before the delivery, so a delivery that
// failed left the member past the round it missed, and that round never reached it.
test('a member whose delivery failed sees the round it missed in its next prompt', async (t) => {
  const host = await start(t)
  // The delivery to Writer fails once; the Session is there, the message did not land.
  let failed = false
  host.ctx.sessions.flush = async (session) => {
    if (session?.id === 'gb' && !failed) {
      failed = true
      throw new Error('the session log could not be written')
    }
  }
  const first = host.round('c1', host.say('@Chief 安排一下文档'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 把文档整理好')
  await settle(() => first() !== undefined)
  assert.deepEqual(kinds(first()), [['message', 'Chief'], ['failed', 'Writer']])
  // The failed delivery leaves the member where it was: it has read nothing yet.
  assert.equal(JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).rooms.r1.seen.b, undefined)

  // Its next prompt carries the round it missed.
  await host.tool('post_to_group', { group: 'Ops', message: '@Writer 继续' }, 'a')
  const second = host.round('c2', host.takePost())
  await settle(() => host.agentOf('gb').calls.length === 2)
  const prompt = text(host.agentOf('gb').calls[1])
  assert.match(prompt, /User: @Chief 安排一下文档/)
  assert.match(prompt, /Chief: @Writer 把文档整理好/)
  assert.match(prompt, /Chief: @Writer 继续/)

  // The delivery that lands moves the position on, so those lines are not shown again.
  host.begin('gb')
  host.finish('gb', '整理好了。')
  await settle(() => second() !== undefined)
  await host.tool('post_to_group', { group: 'Ops', message: '@Writer 还有别的吗' }, 'a')
  host.round('c3', host.takePost())
  await settle(() => host.agentOf('gb').calls.length === 3)
  const later = text(host.agentOf('gb').calls[2])
  assert.doesNotMatch(later, /@Chief 安排一下文档/)
  assert.doesNotMatch(later, /@Writer 继续/)
})

// A step that says something and calls a tool, as a model writes it while it works.
const step = (host, sessionId, said, callId, name = 'pwsh', args = '{}') => {
  host.emit(sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: said }, { type: 'tool-call', id: callId, name }] } })
  host.emit(sessionId, 'tool/call', { callId, name, arguments: args })
}
const progress = async host => (await host.call('room-progress', { roomId: 'r1' })).value[0]

test('room-progress answers for any part of the group\'s own Session', async (t) => {
  // The group's own Session moved on once: 'r1' is the group's id and an earlier
  // part, 's1' its current one; rounds are still keyed by the group's id.
  const host = await start(t, { admin: 'b', sessionId: 's1', parts: [{ sessionId: 'r1', endedAt: 1 }] })
  host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  assert.equal((await host.call('room-progress', { roomId: 's1' })).value[0]?.callId, 'c1')
  const round = (await host.call('room-progress', { roomId: 'r1' })).value[0]
  assert.equal(round?.callId, 'c1')
  assert.deepEqual(round.speaking, ['b'], 'Ordinary group replies still draw the typing avatar')
})

test('formal worker progress with a peer mention stays private until its task submission', async (t) => {
  const { host, first, planId } = await assignedWork(t)
  step(host, 'gb', '收到，我先看看 docs/ 的结构。@Tester 你等下帮我验一下', 'k1', 'list_bots')
  await settle(() => true)
  assert.deepEqual(host.agentOf('gc').calls, [])
  assert.equal((await progress(host)).replies.some(reply => reply.name === 'Writer' && reply.kind === undefined), false)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  await submitAssigned(host, planId, 'write', 'gb', '整理好了，引用 @Tester 不派发任务。')
  await settle(() => host.agentOf('ga').calls.length === 2)
  host.begin('ga')
  await acceptAssigned(host, planId)
  host.finish('ga', '结果已验收。')
  await settle(() => first() !== undefined)
  assert.deepEqual(host.agentOf('gc').calls, [])
})

test('a group leader whose every message went out while it worked counts as posted, not passed', async (t) => {
  const host = await start(t, { admin: 'b' })
  const result = host.round('c1', host.say('@Writer 看一下'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  step(host, 'gb', '我看一下。', 'k1', 'list_bots')
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => result() !== undefined)
  assert.deepEqual([result().passed, result().replies.map(reply => reply.text)], [[], ['我看一下。']])
})

test('a group leader\'s messages carry how long its turn ran', async (t) => {
  const host = await start(t, { admin: 'b' })
  const result = host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  step(host, 'gb', '收到，先看看。', 'k1', 'list_bots')
  await settle(() => true)
  const live = await progress(host)
  assert.equal(typeof live.replies[0].duration, 'number')
  assert.ok(live.replies[0].duration >= 0)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '整理好了。')
  await settle(() => result() !== undefined)
  const messages = result().replies.filter(reply => reply.kind === undefined)
  assert.deepEqual(messages.map(reply => reply.text), ['收到，先看看。', '整理好了。'])
  for (const reply of messages) {
    assert.equal(typeof reply.duration, 'number')
    assert.ok(reply.duration >= 0)
  }
  assert.ok(result().replies.every(reply => reply.kind === undefined || reply.duration === undefined))
})

test('debounced late executor steps stay private and only one formal result reaches the group', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { host, first, planId } = await assignedWork(t)
  step(host, 'gb', '收到，开始整理。', 'k1')
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  step(host, 'gb', '目录理好了。', 'k2')
  host.emit('gb', 'tool/result', { callId: 'k2' })
  step(host, 'gb', '正文改完了，在改索引。', 'k3')
  t.mock.timers.tick(ROOM_STEP_GAP_MS)
  await settle(() => true)
  assert.deepEqual(host.agentOf('r1').calls, [])
  host.emit('gb', 'tool/result', { callId: 'k3' })
  await submitAssigned(host, planId, 'write', 'gb', '整理好了，在 docs/ 下。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.equal(post.source.taskflowEvent.event, 'submitted')
  const second = host.round('debounced-submission', post)
  await settle(() => host.agentOf('ga').calls.length === 2)
  host.begin('ga')
  await acceptAssigned(host, planId)
  host.finish('ga', '结果已验收。')
  await settle(() => second() !== undefined)
  t.mock.timers.tick(ROOM_STEP_GAP_MS)
  await settle(() => true)
  assert.deepEqual(host.agentOf('r1').calls, [])
  assert.equal(logLines(host).filter(row => row.taskflowEvent?.event === 'submitted').length, 1)
})

test('a late executor step cannot delegate to a peer through a mention', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'user/message', { content: [{ type: 'text', text: 'go' }], source: { kind: 'bot', role: 'room', exchangeId: 'x1', roomId: 'r1', askedBy: 'a' } })
  step(host, 'gb', '@Tester 帮我跑一下测试', 'k1')
  await settle(() => true)
  assert.deepEqual(host.agentOf('r1').calls, [])
  assert.deepEqual(host.agentOf('gc').calls, [])
  assert.deepEqual(logLines(host), [])
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '[PASS]')
})

test('an executor step stays private while a principal user round is active', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'user/message', { content: [{ type: 'text', text: 'go' }], source: { kind: 'bot', role: 'room', exchangeId: 'x1', roomId: 'r1' } })
  const result = host.round('c1', host.say('@Chief 你怎么看'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  step(host, 'gb', '索引改完了。', 'k1')
  await settle(() => true)
  host.begin('ga')
  host.finish('ga', '没问题。')
  await settle(() => result() !== undefined)
  assert.deepEqual(result().replies.filter(reply => reply.kind === undefined).map(reply => [reply.name, reply.text]), [['Chief', '没问题。']])
  assert.deepEqual(host.agentOf('r1').calls, [])
  assert.equal(logLines(host).some(row => row.botId === 'b'), false)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '[PASS]')
})

test('a turn that a finished background job starts in a group Session posts to the group', async (t) => {
  const host = await start(t, { admin: 'b' })
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'user/message', { content: [{ type: 'text', text: 'background job pwsh-3 finished' }], source: { kind: 'tool-jobs', form: 'notice' } })
  step(host, 'gb', '下载完了，开始解压。', 'k1')
  await settle(() => host.agentOf('r1').calls.length === 1)
  assert.equal(text(host.takePost()), '[Group post from Writer]\n下载完了，开始解压。')
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '解压好了。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.late, post.source.askedBy, text(post)], [true, undefined, '[Group post from Writer]\n解压好了。'])
})

test('a fresh part\'s opening line stays out of the group', async (t) => {
  const host = await start(t, { admin: 'b' })
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'user/message', { content: [{ type: 'text', text: '[Handoff · part 2]' }], source: { kind: 'bot', role: 'handoff', handoff: true, exchangeId: 'h1', hop: 0 } })
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: 'Noted. I have my handoff note and carry on from here.' }] } })
  host.emit('gb', 'user/message', { content: [{ type: 'text', text: 'background job pwsh-7 finished' }], source: { kind: 'tool-jobs', form: 'notice' } })
  host.finish('gb', 'Ghidra 解压好了。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  assert.equal(text(host.takePost()), '[Group post from Writer]\nGhidra 解压好了。')
})

test('a private message to a group Session is answered privately, without steps in the group', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'user/message', { content: [{ type: 'text', text: '[Message from Tester]\n能帮我看下吗' }], source: { kind: 'bot', role: 'request', senderSessionId: 'c', senderName: 'Tester', exchangeId: 'x1', hop: 0 } })
  step(host, 'gb', '我看一下。', 'k1')
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '看过了，没问题。')
  await settle(() => host.agentOf('c').calls.length === 1)
  assert.match(text(host.agentOf('c').calls[0]), /我看一下。\n\n看过了，没问题。/)
  assert.deepEqual(host.agentOf('r1').calls, [])
})

test('the team view says what a member is doing in the call\'s own words', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: JSON.stringify({ command: 'iwr https://example.com/x.zip', description: 'Download  Ghidra 12.1.4\nand check its hash' }) })
  host.emit('gc', 'turn/start', { turn: 1 })
  host.emit('gc', 'tool/call', { callId: 'k2', name: 'read', arguments: JSON.stringify({ file_path: 'E:\\src\\tools\\dump.py' }) })
  const { value } = await host.call('state', {})
  assert.deepEqual(value.work.rooms.r1.map(entry => [entry.botId, entry.tool, entry.note, entry.target]), [['b', 'pwsh', 'Download Ghidra 12.1.4 and check its hash', undefined], ['c', 'read', undefined, 'dump.py']])
  assert.equal(value.work.bots.b.note, 'Download Ghidra 12.1.4 and check its hash')
  // What the Bot said in the step that made the call comes with it.
  host.emit('ga', 'turn/start', { turn: 1 })
  step(host, 'ga', '先把 JDK\n下下来。', 'k3', 'pwsh', JSON.stringify({ description: 'Download JDK 21' }))
  const later = (await host.call('state', {})).value
  assert.deepEqual(['said', 'note'].map(key => later.work.bots.a[key]), ['先把 JDK 下下来。', 'Download JDK 21'])
})

test('the team view says when each Session\'s running turn began, for the clock at its tail', async (t) => {
  const host = await start(t)
  const before = Date.now()
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  const { value } = await host.call('state', {})
  assert.deepEqual(Object.keys(value.work.turns), ['gb'])
  assert.ok(value.work.turns.gb >= before && value.work.turns.gb <= Date.now())
  assert.equal(value.work.turns.gb, value.work.bots.b.since)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual((await host.call('state', {})).value.work.turns, {})
})

// 公开#124: a Bot deleted while it worked stayed "thinking" until DSH restarted, and the
// Bot that had asked it something never heard back.
test('deleting a working Bot clears its activity and tells the Bots waiting for its reply', async (t) => {
  const host = await start(t)
  host.emit('b', 'turn/start', { turn: 1 })
  host.emit('b', 'user/message', { content: [{ type: 'text', text: '[Message from Chief]\nwrite the docs' }], source: { kind: 'bot', role: 'request', senderSessionId: 'a', senderName: 'Chief', exchangeId: 'x1', hop: 1 } })
  host.emit('b', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  // A second request that Writer has not read yet.
  host.agentOf('b').inbox.nextStep.push({ id: 'm2', source: { kind: 'bot', role: 'request', senderSessionId: 'c', senderName: 'Tester', exchangeId: 'x2', hop: 1 } })
  assert.equal((await host.call('state', {})).value.activity.b, 'working')

  const deleted = await host.call('delete-bot', { id: 'b' })
  assert.equal(deleted.ok, true)
  assert.equal((await host.call('state', {})).value.activity.b, undefined)
  await settle(() => host.agentOf('a').calls.length === 1 && host.agentOf('c').calls.length === 1)
  for (const [to, exchangeId] of [['a', 'x1'], ['c', 'x2']]) {
    const reply = host.agentOf(to).calls[0]
    assert.deepEqual([reply.source.role, reply.source.replyTo], ['reply', exchangeId])
    assert.equal(text(reply), '[Reply from Writer]\nWriter was deleted before it could answer your message.')
  }
  // The stopped turn ends after the delete; it brings nothing back.
  host.emit('b', 'turn/start', { turn: 2 })
  host.emit('b', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
  assert.equal((await host.call('state', {})).value.activity.b, undefined)
})

// #619: a member that finishes tool work inside the 15s grace without writing @Caller
// still hands the result back to the Bot that asked for it.
test('a formal result before the grace wakes its principal without a free-text mention (#619)', async (t) => {
  const { host, first, planId } = await assignedWork(t)
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'read', arguments: JSON.stringify({ file_path: 'build.log' }) })
  host.emit('gb', 'tool/result', { callId: 'k1' })
  await submitAssigned(host, planId, 'write', 'gb', '查清楚了，是缺少环境变量 FOO，需要决定用哪个默认值。')
  await settle(() => host.agentOf('ga').calls.length === 2)
  assert.match(text(host.begin('ga')), /缺少环境变量 FOO/)
  const results = await acceptAssigned(host, planId)
  assert.match(results.results[0].result.text, /FOO/)
  host.finish('ga', '默认设成 bar。')
  await settle(() => first() !== undefined)
  assert.ok(first().replies.some(reply => reply.taskflowEvent?.event === 'submitted'))
  assert.equal(first().replies.some(reply => reply.name === 'Writer' && reply.kind === undefined), false)
})

// #872: Chief calls Writer in a step line and goes on with its own part. Writer's
// result lands while Chief is still in that turn, which cannot see it, so Chief
// answers it in a turn of its own once the first one ends.
test('a busy principal receives a formal result after its current turn (#872)', async (t) => {
  const { host, first, planId } = await assignedWork(t, { keepLeaderRunning: true })
  step(host, 'ga', '我先看配置，等正式任务结果。', 'k0', 'read')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'read', arguments: '{}' })
  host.emit('gb', 'tool/result', { callId: 'k1' })
  await submitAssigned(host, planId, 'write', 'gb', '日志看完了：缺环境变量 FOO。')
  await settle(() => true)
  assert.equal(host.agentOf('ga').calls.length, 1, 'no second principal turn while its current turn runs')
  host.emit('ga', 'tool/result', { callId: 'k0' })
  host.finish('ga', '配置看完了，等待核对正式提交。')
  await settle(() => host.agentOf('ga').calls.length === 2)
  assert.match(text(host.begin('ga')), /taskflow_results/)
  const results = await acceptAssigned(host, planId)
  assert.match(results.results[0].result.text, /缺环境变量 FOO/)
  host.finish('ga', '缺 FOO，补上就好。')
  await settle(() => host.agentOf('ga').calls.length === 3)
  assert.match(text(host.begin('ga')), /已提报/)
  host.finish('ga', '[PASS]')
  await settle(() => first() !== undefined)
  assert.equal(host.agentOf('gb').calls.length, 1, 'acceptance must not hand the principal reply back to the submitter as ordinary work')
  assert.equal(logLines(host).some(row => row.botId === 'b' && row.kind === undefined), false)
})

// #872: a member the user called answers the user; asking the user to confirm does
// not call the admin in.
test('a group leader confirmation question does not call a different global Main Bot (#872)', async (t) => {
  const host = await start(t, { admin: 'b' })
  const first = host.round('c1', host.say('@Writer 把首页标题改成春季上新'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'edit', arguments: '{}' })
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '改好了，标题换成了「春季上新」，需要你确认一下是否满意。')
  await settle(() => first() !== undefined)
  assert.deepEqual(host.agentOf('ga').calls, [])
  assert.deepEqual(first().replies.map(reply => reply.name), ['Writer'])
})

// Parallel fan-in barrier: when Chief calls @Writer @Tester in one message and both go
// past the 15s grace, Writer's early result posts at once without waking Chief, and
// Tester's final result wakes Chief once with both results.
test('parallel formal submissions retain separate card identities and reach the principal after its busy turn', async (t) => {
  const cards = [{ id: 'write', member: 'Writer', goal: '检查文档', dependencies: [] },
    { id: 'test', member: 'Tester', goal: '检查测试', dependencies: [] }]
  const { host, first, planId } = await assignedWork(t, { cards, keepLeaderRunning: true })
  const rounds = (await host.call('room-progress', { roomId: 'r1' })).value
  assert.deepEqual(rounds.flatMap(round => round.speaking), ['a'], 'Parallel task executors stay out of the ordinary reply indicators')
  if (process.env.DS_BOT_TEST_LEDGER_ROWS === '1') {
    const history = await host.call('group-rows', { roomId: 'r1', from: 1 })
    assert.equal(history.ok, true, 'The candidate must exercise the open-history API')
    assert.deepEqual(history.value.speaking, ['a'], 'Open history only shows ordinary reply indicators')
    assert.equal(history.value.rows.filter(row => row.kind === 'task' && row.taskflowEvent?.event === 'assigned').length, 2)
  }
  host.emit('ga', 'tool/call', { callId: 'leader', name: 'read', arguments: '{}' })
  await submitAssigned(host, planId, 'write', 'gb', '文档检查完毕，没有断链。')
  const early = JSON.parse(await host.tool('taskflow_results', { planId }, 'ga'))
  assert.equal(early.results.filter(card => card.result).length, 1)
  assert.equal(host.agentOf('ga').calls.length, 1)
  await submitAssigned(host, planId, 'test', 'gc', '测试全部通过。')
  const events = logLines(host).filter(row => row.taskflowEvent?.event === 'submitted')
  assert.deepEqual(events.map(row => [row.taskflowEvent.cardId, row.taskflowEvent.from.id, row.taskflowEvent.to.id]), [['write', 'b', 'a'], ['test', 'c', 'a']])
  assert.equal(host.agentOf('ga').calls.length, 1)
  host.emit('ga', 'tool/result', { callId: 'leader' })
  host.finish('ga', '现在核对两项正式结果。')
  await settle(() => host.agentOf('ga').calls.length >= 2)
  assert.equal(host.agentOf('ga').calls.length, 2)
  host.begin('ga')
  const results = await acceptAssigned(host, planId, ['write', 'test'])
  assert.deepEqual(results.results.map(card => card.result.text), ['文档检查完毕，没有断链。', '测试全部通过。'])
  host.finish('ga', '两项均已验收。')
  await settle(() => host.agentOf('ga').calls.length === 3)
  assert.match(text(host.begin('ga')), /已提报/)
  host.finish('ga', '[PASS]')
  await settle(() => first() !== undefined)
  assert.equal(host.agentOf('ga').calls.length, 3)
  assert.deepEqual([host.agentOf('gb').calls.length, host.agentOf('gc').calls.length], [1, 1])
  assert.equal(logLines(host).some(row => ['b', 'c'].includes(row.botId) && row.kind === undefined), false)
})

// #469: a member that replies only "收到，我现在开始排查" without calling any tool gets
// one automatic continuation turn on the same exchange so the work actually runs.
for (const endReason of ['completed', 'max-tokens']) test(`a formal task ending ${endReason} after tools continues until submission`, async (t) => {
  const host = await start(t)
  host.round('unfinished-task', host.say('@Chief 安排任务'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  const planned = JSON.parse(await host.tool('taskflow_plan', { group: 'Ops', goal: 'Finish work',
    children: [{ id: 'write', member: 'Writer', goal: 'Write and submit', dependencies: [] }] }, 'ga'))
  await host.tool('taskflow_dispatch', { planId: planned.plan.plan_id }, 'ga')
  await settle(() => host.agentOf('gb').calls.length === 1)
  const initial = host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'read-1', name: 'read_file', arguments: '{}' })
  host.emit('gb', 'tool/result', { callId: 'read-1' })
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: '已读资料，接下来继续。' }] } })
  host.emit('gb', 'turn/end', { reason: { kind: endReason } })
  await settle(() => host.agentOf('gb').calls.length === 2)
  const continued = host.begin('gb')
  assert.equal(continued.source.exchangeId, initial.source.exchangeId)
  assert.match(text(continued), /taskflow_submit/)
  await host.tool('taskflow_submit', { planId: planned.plan.plan_id, cardId: 'write', result: 'Actual fixture result' }, 'gb')
  host.finish('gb', '已提交真实结果。')
  await realDelay(20)
  assert.equal(host.agentOf('gb').calls.length, 2, 'submitted work must not restart')
})

test('a formal worker has two continuation deliveries and only one exhaustion notice', async (t) => {
  const host = await start(t)
  host.round('budget-task', host.say('@Chief 安排任务'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  const planned = JSON.parse(await host.tool('taskflow_plan', { group: 'Ops', goal: 'Work',
    children: [{ id: 'write', member: 'Writer', goal: 'Work', dependencies: [] }] }, 'ga'))
  await host.tool('taskflow_dispatch', { planId: planned.plan.plan_id }, 'ga')
  await settle(() => host.agentOf('gb').calls.length === 1)
  for (let attempt = 0; attempt < 3; attempt++) {
    host.begin('gb')
    host.finish('gb', '还有未完成部分。')
    if (attempt < 2) await settle(() => host.agentOf('gb').calls.length === attempt + 2)
  }
  await settle(() => logLines(host).some(line => line.kind === 'task' && line.taskflowEvent?.recovery?.kind === 'exhausted'))
  assert.equal(host.agentOf('gb').calls.length, 3)
  const later = []
  rt.lateRoomReply = async (_id, _info, reply) => later.push(reply)
  host.agentOf('gb').followup({content:[{type:'text',text:'普通追问'}],source:{kind:'bot',role:'room',roomId:'r1',exchangeId:'unrelated-query',askedBy:'a'}})
  host.begin('gb')
  host.finish('gb', '这是普通追问的回答。')
  await settle(() => later.length > 0)
  assert.equal(later.at(-1), '这是普通追问的回答。')
  assert.equal(logLines(host).filter(line => line.kind === 'task' && line.taskflowEvent?.recovery?.kind === 'exhausted').length, 1)
})

for (const disposition of ['complete', 'cancel']) test(`an exhausted formal worker wakes the principal to ${disposition} the original plan`, async (t) => {
  const host = await start(t)
  const first = host.round('exhaustion-task', host.say('@Chief 安排任务'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  const planned = JSON.parse(await host.tool('taskflow_plan', { goal: 'Finish the original plan', children: [
    { id: 'write', member: 'Writer', goal: 'Write and submit', dependencies: [] },
    { id: 'review', member: 'Tester', goal: 'Review the result', dependencies: ['write'] },
  ] }, 'ga'))
  const planId = planned.plan.plan_id
  await host.tool('taskflow_dispatch', { planId }, 'ga')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) host.begin('gb')
    host.finish('gb', '还有未完成部分，没有结果。')
    if (attempt < 2) await settle(() => host.agentOf('gb').calls.length === attempt + 2)
  }
  await settle(() => logLines(host).some(line => line.taskflowEvent?.recovery?.kind === 'exhausted'))
  host.finish('ga', '任务尚未完成，等待正式处理。')
  await settle(() => host.agentOf('ga').calls.length === 2 || host.agentOf('r1').calls.length > 0)
  let recovery = first
  if (host.agentOf('ga').calls.length !== 2) {
    await settle(() => first() !== undefined)
    recovery = host.round('exhaustion-recovery', host.takePost())
  }
  await settle(() => host.agentOf('ga').calls.length === 2)
  const called = host.begin('ga')
  assert.match(text(called), /taskflow_results/)
  host.emit('ga', 'tool/call', { callId: 'exhaustion-results', name: 'taskflow_results', arguments: JSON.stringify({ planId }) })
  const result = JSON.parse(await host.tool('taskflow_results', { planId }, 'ga'))
  host.emit('ga', 'tool/result', { callId: 'exhaustion-results' })
  assert.equal(result.results[0].state, 'running')
  assert.equal(result.results[0].result, undefined)
  assert.equal(result.results[1].state, 'pending')
  assert.equal(result.results[1].attempts, 0)
  assert.equal(host.agentOf('gb').calls.length, 3, 'exhaustion must not silently restart the executor')
  assert.equal(host.agentOf('gc').calls.length, 0, 'a missing result must not release dependents')
  if (disposition === 'cancel') {
    await host.tool('taskflow_cancel', { planId, reason: 'Isolated fixture: no result; report the blocking decision' }, 'ga')
    host.finish('ga', '原任务没有结果，已明确取消，未宣称完成。')
  } else {
    host.finish('ga', '@Writer 核实原产物后通过 taskflow_submit 补交原 write 卡，不要重复执行外部操作。')
    await settle(() => host.agentOf('gb').calls.length === 4)
    host.begin('gb')
    await submitAssigned(host, planId, 'write', 'gb', 'Verified original fixture output')
    await settle(() => host.agentOf('ga').calls.length === 3)
    host.begin('ga')
    await host.tool('taskflow_accept', { planId, cardId: 'write' }, 'ga')
    await settle(() => host.agentOf('gc').calls.length === 1)
    host.begin('gc')
    await submitAssigned(host, planId, 'review', 'gc', 'Independently checked original output')
    const results = await acceptAssigned(host, planId, ['review'])
    assert.equal(results.results[0].state, 'verified')
    host.finish('ga', '原任务已补交并逐卡验收，总计划已正式完成。')
    await settle(() => host.agentOf('ga').calls.length === 4)
    assert.match(text(host.begin('ga')), /已提报/)
    host.finish('ga', '[PASS]')
  }
  await settle(() => recovery() !== undefined)
  await rt.taskflowSweep()
  assert.equal(host.agentOf('ga').calls.length, disposition === 'cancel' ? 2 : 4)
})

test('a five-minute reminder wakes the principal for the original plan and stops after completion', async (t) => {
  const { host, first, planId } = await assignedWork(t)
  const ledger = new Scheduler(join(host.home, 'plugin-data', 'hermes-bot-taskflow', 'coordination.sqlite'), { recoverOnOpen: false })
  try {
    ledger.db.prepare('UPDATE plans SET created_at=created_at-301 WHERE plan_id=?').run(planId)
  } finally { ledger.close() }
  assert.deepEqual(await rt.taskflowCheck(), [], 'a live worker suppresses the periodic reminder')
  const workerTurn = rt.live.get('gb')
  const turn = workerTurn.turn
  workerTurn.turn = undefined
  const handled = await rt.taskflowCheck()
  assert.ok(handled.some(item => item.planId === planId && item.reminder))
  await settle(() => host.agentOf('ga').calls.length === 2)
  const called = host.begin('ga')
  workerTurn.turn = turn
  assert.match(text(called), /五分钟任务检查/)
  assert.match(text(called), /催促对应执行者/)
  const notice = logLines(host).find(line => line.taskflowEvent?.recovery?.kind === 'reminder')
  assert.equal(notice.kind, 'task')
  assert.equal(notice.taskSchemaVersion, 1)
  assert.equal(notice.taskflowEvent.event, 'recovery')
  assert.equal(notice.taskflowEvent.planId, planId)
  assert.equal(notice.taskflowEvent.to.id, 'a')
  host.emit('ga', 'tool/call', { callId: 'periodic-results', name: 'taskflow_results', arguments: JSON.stringify({ planId }) })
  const results = JSON.parse(await host.tool('taskflow_results', { planId }, 'ga'))
  host.emit('ga', 'tool/result', { callId: 'periodic-results' })
  assert.equal(results.results[0].state, 'running')
  assert.equal(results.results[0].result, undefined)
  assert.equal(host.agentOf('gb').calls.length, 1, 'a principal reminder must not directly duplicate worker execution')
  await submitAssigned(host, planId, 'write', 'gb', 'Real result after the reminder')
  await acceptAssigned(host, planId)
  host.finish('ga', '结果已核验，原计划已完成，停止催办。')
  await settle(() => host.agentOf('ga').calls.length === 3)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await settle(() => first() !== undefined)
  const before = host.agentOf('ga').calls.length
  const later = await rt.taskflowCheck()
  assert.equal(later.some(item => item.planId === planId && item.reminder), false)
  assert.equal(host.agentOf('ga').calls.length, before)
  assert.equal(rt.taskflowClaimRecovery('r1', 'a', notice.taskflowEvent), false)
})

test('disabled group task checks remain silent and the native setting persists before re-enabling', async (t) => {
  const { host, planId } = await assignedWork(t, { keepLeaderRunning: true })
  const ledger = new Scheduler(join(host.home, 'plugin-data', 'hermes-bot-taskflow', 'coordination.sqlite'), { recoverOnOpen: false })
  try { ledger.db.prepare('UPDATE plans SET created_at=created_at-301 WHERE plan_id=?').run(planId) } finally { ledger.close() }
  const off = await host.call('update-room', { id: 'r1', taskflowEnabled: false })
  assert.equal(off.ok, true)
  assert.equal(off.value.room.taskflowEnabled, false)
  assert.equal(JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).rooms.r1.taskflowEnabled, false)
  assert.deepEqual(await rt.taskflowCheck(), [])
  assert.deepEqual(await rt.taskflowSweep(), [])
  assert.equal(rt.taskflowContinuation('gb'), undefined)
  assert.equal(host.agentOf('ga').calls.length, 1)
  assert.equal(logLines(host).some(line => line.taskflowEvent?.recovery?.kind === 'reminder'), false)
  const on = await host.call('update-room', { id: 'r1', taskflowEnabled: true })
  assert.equal(on.ok, true)
  assert.deepEqual(await rt.taskflowCheck(), [])
  rt.live.get('gb').turn = undefined
  assert.equal((await rt.taskflowCheck()).some(item => item.planId === planId && item.reminder), true)
  assert.equal(rt.taskflowMonitorState().rooms.r1.active, true)
  assert.equal(host.agentOf('gb').calls.length, 1)
})

test('a stopped formal worker is never automatically continued', async (t) => {
  const host = await start(t)
  host.round('stopped-task', host.say('@Chief 安排任务'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  const planned = JSON.parse(await host.tool('taskflow_plan', { group: 'Ops', goal: 'Work',
    children: [{ id: 'write', member: 'Writer', goal: 'Work', dependencies: [] }] }, 'ga'))
  await host.tool('taskflow_dispatch', { planId: planned.plan.plan_id }, 'ga')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'turn/end', { reason: { kind: 'aborted', reason: { kind: 'user' } } })
  await realDelay(20)
  assert.equal(host.agentOf('gb').calls.length, 1)
})

test('a group leader that only promises to start working without calling a tool gets one continuation turn (#469)', async (t) => {
  const host = await start(t, { admin: 'b' })
  const first = host.round('c1', host.say('@Writer 排查一下构建失败的原因'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  const initial = host.begin('gb')
  // Ends the turn with a verbal promise only and 0 tool calls.
  host.finish('gb', '收到，我现在开始排查构建日志。')

  // The host automatically nudges gb once on the same exchangeId.
  await settle(() => host.agentOf('gb').calls.length === 2)
  const retryMsg = host.begin('gb')
  assert.equal(retryMsg.source.exchangeId, initial.source.exchangeId)
  assert.equal(retryMsg.source.retried, true)
  assert.match(text(retryMsg), /stopped before calling any tool/)

  // In the continuation turn the member calls its tool and gives the real answer.
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'read', arguments: JSON.stringify({ file_path: 'build.log' }) })
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '排查完毕：原因是端口冲突。')
  await settle(() => first() !== undefined)
  assert.deepEqual(first().replies.map(reply => [reply.name, reply.text]), [
    ['Writer', '收到，我现在开始排查构建日志。'],
    ['Writer', '排查完毕：原因是端口冲突。'],
  ])
})

// #872: a verb with 过了/完了/完毕/好了 reports done work. A plan of several sentences,
// or a target that starts with 过 or 完, is still a promise; a reply that also answers
// may match, and its member passes on the retry.
test('done work is no promise, and a plan of several sentences still is (#872)', () => {
  for (const said of ['收到，我现在开始排查构建日志。', '明白，我先排查一下日志，然后跑测试。', '收到，我现在开始排查。稍后给你结果。', '收到，我先查看过去的记录。', '好的，我先检查完成情况。', '我现在开始排查', '开工！', "I'll check the logs. Then I'll run the tests.", 'Let me look into it.']) {
    assert.equal(promisesWork(said), true, said)
  }
  for (const said of ['好的，我检查过了，配置没问题。', '好的，我检查过，没问题。', '收到，我排查完了，是端口冲突。', '好的，我处理好了。', '查完了，原因是端口冲突。']) {
    assert.equal(promisesWork(said), false, said)
  }
})

// #872: the opening already was the answer; the member passes on the retry and the
// group sees it once.
test('a group leader that passes on the promise retry is posted once (#872)', async (t) => {
  const host = await start(t, { admin: 'b' })
  const first = host.round('c1', host.say('@Writer 方案 A 和 B 哪个好？'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', '好的，我看看。')
  await settle(() => host.agentOf('gb').calls.length === 2)
  const retry = host.begin('gb')
  assert.match(text(retry), /reply \[PASS\]; it stays posted/)
  host.finish('gb', '[PASS]')
  await settle(() => first() !== undefined)
  assert.deepEqual(first().replies.map(reply => [reply.name, reply.text]), [['Writer', '好的，我看看。']])
})

// #872: a retried promise that a late turn passes on still tells the member that asked
// the work is done, as a result that went out as a step line does.
test('a formal executor promise retry ends with a submission rather than an ordinary hand-back (#872)', async (t) => {
  const { host, first, planId } = await assignedWork(t)
  host.finish('gb', '收到，我去看看文档。')
  await settle(() => host.agentOf('gb').calls.length === 2)
  assert.equal(logLines(host).some(row => row.botId === 'b' && row.kind === undefined), false)
  host.begin('gb')
  await submitAssigned(host, planId, 'write', 'gb', '文档核对完成。')
  await settle(() => host.agentOf('ga').calls.length === 2)
  host.begin('ga')
  await acceptAssigned(host, planId)
  host.finish('ga', '结果已验收。')
  await settle(() => first() !== undefined)
  assert.deepEqual(host.agentOf('r1').calls, [])
  assert.equal(logLines(host).filter(row => row.taskflowEvent?.event === 'submitted').length, 1)
})

// Progress-based loop guard: consecutive 0-tool ack/repetitive relays pause after 6
// turns and park the next call in room.paused, whereas tool calls reset the counter.
// #872: the parked calls wait for the user, not for the next round of any kind.
test('ordinary executor acknowledgements stop peer ping-pong and leave later user rounds usable', async (t) => {
  const host = await start(t)
  for (let turn = 1; turn <= 6; turn += 1) {
    const round = host.round(`c${turn}`, host.say('@Chief 开始'))
    await settle(() => host.agentOf('ga').calls.length === turn)
    host.begin('ga')
    host.finish('ga', '@Writer 收到，辛苦了')
    await settle(() => host.agentOf('gb').calls.length === turn)
    host.begin('gb')
    host.finish('gb', '@Chief 收到，谢谢！')
    await settle(() => round() !== undefined)
    assert.equal(host.agentOf('ga').calls.length, turn, 'executor acknowledgement must not call the principal again')
    assert.equal(round().replies.some(reply => reply.botId === 'b' && reply.kind === undefined), false)
  }
  assert.equal(rt.state.rooms.r1.paused, undefined)
  const next = host.round('user-next', host.say('好了，说正事'))
  await settle(() => host.agentOf('ga').calls.length === 7)
  host.begin('ga')
  host.finish('ga', '请说。')
  await settle(() => next() !== undefined)
})

// #701: when a group member spawns a DSH subagent and ends its own turn, the member
// stays marked as working in the group, and stopping the group interrupts the subagent
// and suppresses its late settlement notice.
test('a group member with a running DSH subagent stays working and stop-room-work interrupts the subagent (#701)', async (t) => {
  const interrupted = []
  const { host, first } = await assignedWork(t, { services: {
    subagents: { interrupt: async (childId, opts) => { interrupted.push({ childId, opts }) } },
  } })
  host.emit('gb', 'tool/call', { callId: 's1', name: 'subagent', arguments: JSON.stringify({ description: 'Run long benchmark' }) })
  host.emit('gb', 'subagent/catalog', { childId: 'sub-1', label: 'Run long benchmark', mode: 'continuable' })
  host.emit('gb', 'tool/result', { callId: 's1' })
  host.finish('gb', '子代理已派出，正在后台运行。')

  await settle(() => first() !== undefined)
  assert.ok(first().replies.some(reply => reply.kind === 'working' && reply.name === 'Writer'))
  assert.equal(first().replies.some(reply => reply.kind === undefined && reply.name === 'Writer'), false)

  // Even though gb's own turn ended, Writer still shows as working on its subagent in r1.
  const stateDuring = (await host.call('state', {})).value
  assert.equal(stateDuring.activity.b, 'working')
  assert.deepEqual(stateDuring.work.rooms.r1, [{ botId: 'b', since: stateDuring.work.rooms.r1[0].since, tool: 'subagent', note: 'Run long benchmark' }])

  // User clicks "Stop all" in the group: it interrupts sub-1 and logs Writer as stopped.
  const stopped = await host.call('stop-room-work', { roomId: 'r1' })
  assert.deepEqual([stopped.ok, stopped.value], [true, true])
  assert.deepEqual(interrupted, [{ childId: 'sub-1', opts: { kind: 'user', parentSessionId: 'gb' } }])
  assert.deepEqual((await host.call('state', {})).value.work.rooms.r1, undefined)

  // Clear the stopped event post from r1's inbox.
  await settle(() => host.agentOf('r1').calls.length === 1)
  const stopPost = host.takePost()
  assert.equal(stopPost.source.stopped, true)

  // Later, when the interrupted subagent emits its settlement notice to gb, gb is
  // cancelled and suppressed so it does not speak in the group again.
  host.emit('gb', 'turn/start', { turn: 2 })
  host.emit('gb', 'user/message', {
    content: [{ type: 'text', text: 'Subagent sub-1 settled' }],
    source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'sub-1' },
  })
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: '子代理被中断了。' }] } })
  host.emit('gb', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await settle(() => true)
  assert.deepEqual(host.agentOf('r1').calls, [], 'suppressed settlement notice does not post to the group')
})

