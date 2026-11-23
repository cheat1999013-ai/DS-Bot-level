import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fixture } from './taskflow-fixture.mjs'
import { AUTO_NOTE, Scheduler } from '../src/host/taskflow/scheduler.js'
import { buildToolDefinitions } from '../src/host/taskflow/tools.js'

const body = '## 做了什么\n完成隔离任务并核对输出。\n\n## 为什么这么做\n使用真实隔离数据使结果可复核。\n\n## 里面的错误怎么避免\n本次未发现错误；下次仍先核对输入与验收条件。\n\n## 要在下次任务中做的更好我需要什么\n需要完整的输入样例和验收条件，执行前从任务说明核实。'
async function ready(goal) {
  const env = fixture()
  try {
    if (goal) env.rt.roomOf('room-1').goal = goal
    const { plan } = env.service.plan({ group: 'IT-create', goal: '心得结构回归',
      children: [{ id: 'a', member: 'Writer', goal: '隔离工作', dependencies: [] }] }, env.admin)
    await env.service.dispatch({ planId: plan.plan_id }, env.admin)
    await env.service.submit({ planId: plan.plan_id, cardId: 'a', result: '实际结果' }, env.memberA)
    await env.service.accept({ planId: plan.plan_id, cardId: 'a' }, env.admin)
    return { ...env, planId: plan.plan_id }
  } catch (error) { env.cleanup(); throw error }
}
const noErrorBody = body.replace(/\n\n## 里面的错误怎么避免[\s\S]*?(?=\n\n## 要在下次任务中做的更好我需要什么)/, '')

test('executor and principal can omit the error section when no errors occurred', async () => {
  const env = await ready()
  try {
    env.scheduler.note(env.planId, 'a', { member: 'bot-a', text: AUTO_NOTE, auto: true })
    assert.equal(env.service.sleepNote({ planId: env.planId, cardId: 'a', text: noErrorBody }, env.memberA).note.text, noErrorBody)
    const result = env.service.sleepConsolidate({ planId: env.planId, title: '实际心得', text: noErrorBody }, env.admin)
    assert.equal(result.insight.text, noErrorBody)
    assert.equal(env.knowledge.db.prepare('SELECT text FROM insight_sources').get().text, noErrorBody)
  } finally { env.cleanup() }
})

test('duplicate peer reflections are returned for rewriting without saving or replacing the first note', async () => {
  const env = fixture()
  try {
    const { plan } = env.service.plan({ goal: '共同核验方案', children: [
      { id: 'a', member: 'Writer', goal: '核对方案', dependencies: [] },
      { id: 'b', member: 'Reviewer', goal: '独立核验', dependencies: [] },
    ] }, env.admin)
    const planId = plan.plan_id
    await env.service.dispatch({ planId }, env.admin)
    await env.service.submit({ planId, cardId: 'a', result: '结果甲' }, env.memberA)
    await env.service.submit({ planId, cardId: 'b', result: '结果乙' }, env.memberB)
    const tool = buildToolDefinitions(value => value, env.service).find(item => item.name === 'taskflow_sleep_note')
    const first = JSON.parse(await tool.execute({ planId, cardId: 'a', text: noErrorBody }, env.memberA))
    assert.equal(first.note.text, noErrorBody)
    const events = env.scheduler.events(planId).length
    for (const duplicate of [noErrorBody, noErrorBody.replaceAll('。', '！'), noErrorBody.replace('输出', '结果')]) {
      const rejected = JSON.parse(await tool.execute({ planId, cardId: 'b', text: duplicate }, env.memberB))
      assert.equal(rejected.error, 'note_duplicate')
      assert.match(rejected.message, /a.*重写/)
      assert.deepEqual(env.scheduler.listNotes(planId).map(note => note.card_id), ['a'])
      assert.equal(env.scheduler.events(planId).length, events)
    }
    const rewritten = noErrorBody.replace('使用真实隔离数据使结果可复核。', '逐项对照原始台账的金额与币种，发现展示页将年度折算价格标成月价，按官方账单逐行校准。')
    const accepted = JSON.parse(await tool.execute({ planId, cardId: 'b', text: rewritten }, env.memberB))
    assert.equal(accepted.note.text, rewritten)
  } finally { env.cleanup() }
})

test('a completed stage plan cannot start reflections until the overall group goal is completed', async () => {
  const env = fixture()
  try {
    const room = env.rt.roomOf('room-1')
    room.goal = { id: 'project-1', status: 'active', createdAt: Date.now(), current: 0 }
    const { plan } = env.service.plan({ goal: '阶段一', children: [
      { id: 'a', member: 'Writer', goal: '交付阶段一', dependencies: [] },
    ] }, env.admin)
    const planId = plan.plan_id
    await env.service.dispatch({ planId }, env.admin)
    await env.service.submit({ planId, cardId: 'a', result: '阶段结果' }, env.memberA)
    await env.service.accept({ planId, cardId: 'a' }, env.admin)
    const finished = env.service.finish({ planId }, env.admin)
    assert.equal(finished.finished.status, 'completed')
    assert.notEqual(finished.next, 'taskflow_sleep_consolidate')
    const tool = buildToolDefinitions(value => value, env.service).find(item => item.name === 'taskflow_sleep_note')
    const args = { planId, cardId: 'a', text: noErrorBody }
    room.goal.current = 1
    for (const status of ['active', 'paused', 'stopped']) {
      room.goal.status = status
      const posts = env.posts.length
      const rejected = JSON.parse(await tool.execute(args, env.memberA))
      assert.equal(rejected.error, 'reflection_deferred')
      assert.equal(env.posts.length, posts)
      assert.deepEqual(env.service.sleepPending({ planId }, env.admin).pending_cards, [])
      assert.throws(() => env.service.sleepConsolidate({ planId, title: '阶段心得', text: noErrorBody }, env.admin),
        error => error.code === 'reflection_deferred')
      assert.deepEqual(env.scheduler.listNotes(planId), [])
      assert.deepEqual(await env.service.requestGoalReflections(room, room.goal.id), [])
      assert.equal(env.posts.length, posts)
    }
    room.goal.status = 'active'
    env.scheduler.db.prepare('UPDATE plans SET group_goal_id=NULL WHERE plan_id=?').run(planId)
    assert.equal(JSON.parse(await tool.execute(args, env.memberA)).error, 'reflection_deferred')
    env.scheduler.db.prepare('UPDATE plans SET group_goal_id=? WHERE plan_id=?').run(room.goal.id, planId)
    room.goal.status = 'complete'
    const before = env.posts.length
    assert.deepEqual(await env.service.requestGoalReflections(room, room.goal.id), [planId])
    assert.equal(env.posts.length, before + 1)
    assert.deepEqual(env.posts.at(-1).taskflowEvent.to, { id: 'bot-a', name: 'Writer' })
    assert.match(env.posts.at(-1).text, /项目已通过总验收/)
    assert.deepEqual(env.service.sleepPending({ planId }, env.admin).pending_cards, ['a'])
    room.pastGoals = [room.goal]
    room.goal = { id: 'project-2', status: 'active', createdAt: Date.now() + 10 }
    assert.deepEqual(env.service.sleepPending({ planId }, env.admin).pending_cards, ['a'])
    room.pastGoals = []
    const reopened = new Scheduler(env.scheduler.path, { readOnly: true })
    try {
      assert.equal(reopened.planState(planId).reflection_released, true)
    } finally { reopened.close() }
    const saved = JSON.parse(await tool.execute(args, env.memberA))
    assert.equal(saved.error, undefined)
    assert.equal(saved.note.text, noErrorBody)
    assert.equal(env.service.sleepConsolidate({ planId, title: '项目心得', text: noErrorBody }, env.admin).insight.text, noErrorBody)
  } finally { env.cleanup() }
})

test('project completion persists reflection eligibility while room taskflow is disabled', async () => {
  const goal = { id: 'project-disabled', status: 'active', createdAt: Date.now() }
  const env = await ready(goal)
  try {
    const room = env.rt.roomOf('room-1')
    const { planId } = env
    env.service.finish({ planId }, env.admin)
    assert.equal(env.scheduler.planState(planId).reflection_released, false)
    room.taskflowEnabled = false
    goal.status = 'complete'
    const before = env.posts.length
    assert.deepEqual(await env.service.requestGoalReflections(room, goal.id), [])
    assert.equal(env.posts.length, before)
    const reopened = new Scheduler(env.scheduler.path, { readOnly: true })
    try {
      assert.equal(reopened.planState(planId).reflection_released, true)
    } finally { reopened.close() }
    delete room.goal
    room.taskflowEnabled = true
    assert.equal(env.service.sleepNote({ planId, cardId: 'a', text: noErrorBody }, env.memberA).note.text, noErrorBody)
  } finally { env.cleanup() }
})

const malformed = [
  '只有做法、坑和经验的一段文字',
  body.replace('为什么这么做', '为什么'),
  body.replace('完成隔离任务并核对输出。', '  '),
  body.replace('## 做了什么', '## 为什么这么做'),
  body + '\n\n## 做了什么\n重复正文',
  body.replace(/\n\n## 要在下次任务中做的更好我需要什么[\s\S]*/, ''),
]

test('new executor reflections reject missing, empty, repeated or unordered sections without writing a note/event', async () => {
  const env = await ready()
  try {
    const events = env.scheduler.db.prepare('SELECT COUNT(*) AS n FROM events').get().n
    for (const text of malformed) {
      assert.throws(() => env.service.sleepNote({ planId: env.planId, cardId: 'a', text }, env.memberA),
        error => error.code === 'invalid_reflection_format')
      assert.deepEqual(env.scheduler.listNotes(env.planId), [])
      assert.equal(env.scheduler.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, events)
    }
    assert.equal(env.service.sleepNote({ planId: env.planId, cardId: 'a', text: body }, env.memberA).note.text, body)
  } finally { env.cleanup() }
})

test('invalid consolidated reflections preserve source notes and write no knowledge or source staging', async () => {
  const env = await ready()
  try {
    env.service.sleepNote({ planId: env.planId, cardId: 'a', text: body }, env.memberA)
    const notes = env.scheduler.listNotes(env.planId)
    for (const text of malformed) {
      assert.throws(() => env.service.sleepConsolidate({ planId: env.planId, title: '四段心得', text }, env.admin),
        error => error.code === 'invalid_reflection_format')
      assert.deepEqual(env.scheduler.listNotes(env.planId), notes)
      assert.equal(env.scheduler.planInsight(env.planId), null)
      assert.equal(env.knowledge.db.prepare('SELECT COUNT(*) AS n FROM insight_sources').get().n, 0)
      assert.equal(env.knowledge.db.prepare('SELECT COUNT(*) AS n FROM insights').get().n, 0)
    }
    const result = env.service.sleepConsolidate({ planId: env.planId, title: '四段心得', text: body }, env.admin)
    assert.equal(result.insight.text, body)
    assert.equal(readFileSync(result.publication.path, 'utf8'), `# 四段心得\n\n${body}\n`)
    assert.deepEqual(env.scheduler.listNotes(env.planId), [])
    assert.equal(env.knowledge.db.prepare('SELECT text FROM insight_sources').get().text, body)
    assert.equal(env.service.sleepConsolidate({ planId: env.planId, title: '四段心得', text: body }, env.admin).insight.text, body)
  } finally { env.cleanup() }
})

test('historical freeform reflections remain readable without being rewritten or assigned invented sections', async () => {
  const env = await ready()
  try {
    const text = '历史原文：先读日志，再做最小修复。'
    env.scheduler.note(env.planId, 'a', { member: 'bot-a', text })
    env.scheduler.consolidate(env.planId, { principal: 'bot-admin', title: '历史心得', text })
    env.knowledge.addInsight({ room: 'room-1', planId: env.planId, title: '历史心得', text })
    assert.equal(env.service.sleepPending({ planId: env.planId }, env.admin).insight.text, text)
    const publication = env.knowledge.insightPublication('room-1', env.planId)
    assert.equal(readFileSync(publication.path, 'utf8'), `# 历史心得\n\n${text}\n`)
  } finally { env.cleanup() }
})

test('both real tool schemas and the injected instruction teach the same four-part reflection format', () => {
  const env = fixture()
  try {
    const definitions = buildToolDefinitions(value => value, env.service)
    for (const name of ['taskflow_sleep_note', 'taskflow_sleep_consolidate']) {
      const tool = definitions.find(item => item.name === name)
      assert.equal(typeof tool.parameters.text.description, 'string', `${name} needs a four-part text instruction`)
      for (const heading of ['做了什么', '为什么这么做', '里面的错误怎么避免', '要在下次任务中做的更好我需要什么']) {
        assert.ok(tool.parameters.text.description.includes(heading))
      }
    }
    const instruction = readFileSync(new URL('../src/host/skills/taskflow/SKILL.md', import.meta.url), 'utf8')
    for (const heading of ['做了什么', '为什么这么做', '里面的错误怎么避免', '要在下次任务中做的更好我需要什么']) assert.ok(instruction.includes(`## ${heading}`))
  } finally { env.cleanup() }
})
