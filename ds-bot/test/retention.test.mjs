import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { fixture } from './taskflow-fixture.mjs'
import { Scheduler } from '../src/host/taskflow/scheduler.js'
import { Knowledge } from '../src/host/taskflow/knowledge.js'
import { Retention } from '../src/host/taskflow/retention.js'
import { install } from '../src/host/taskflow.js'

const HOUR = 3600
const reflection = text => `## 做了什么\n${text}\n\n## 为什么这么做\n保留已复核的任务依据以支持后续恢复和检索。\n\n## 里面的错误怎么避免\n先核对原始记录，避免把恢复后的摘要冒充原始事实。\n\n## 要在下次任务中做的更好我需要什么\n需要保留原始日志和可复用的隔离验证步骤。`

test('a new scan repairs an insight missing from knowledge after consolidation fails', async () => {
  const env = fixture()
  try {
    const created = env.service.plan({ group: 'IT-create', goal: 'recover insight',
      children: [{ id: 'a', member: 'Writer', goal: 'write', dependencies: [] }] }, env.admin)
    const id = created.plan.plan_id
    await env.service.dispatch({ planId: id }, env.admin)
    await env.service.submit({ planId: id, cardId: 'a', result: 'written' }, env.memberA)
    await env.service.accept({ planId: id, cardId: 'a' }, env.admin)
    env.service.sleepNote({ planId: id, cardId: 'a', text: reflection('keep the method') }, env.memberA)
    const addInsight = env.knowledge.addInsight
    env.knowledge.addInsight = () => { throw new Error('interrupted after coordinator commit') }
    try {
      assert.throws(() => env.service.sleepConsolidate({ planId: id, title: 'Recovery', text: reflection('Keep the method') }, env.admin),
        /interrupted after coordinator commit/)
    } finally { env.knowledge.addInsight = addInsight }
    assert.equal(env.scheduler.planInsight(id).text, reflection('Keep the method'))
    assert.equal(env.knowledge.db.prepare('SELECT 1 FROM insights WHERE plan_id=?').get(id), undefined)
    const reopenedScheduler = new Scheduler(join(env.rt.taskflowHome, 'coordination.sqlite'))
    const reopenedKnowledge = new Knowledge(join(env.rt.taskflowHome, 'knowledge.sqlite'))
    try {
      const scan = new Retention(reopenedScheduler, reopenedKnowledge)
      assert.deepEqual(scan.run(), [])
      assert.deepEqual({ ...reopenedKnowledge.db.prepare('SELECT text,acceptance FROM insights WHERE plan_id=?').get(id) },
        { text: reflection('Keep the method'), acceptance: 'write' })
      assert.deepEqual(scan.run(), [])
    } finally {
      reopenedScheduler.close()
      reopenedKnowledge.close()
    }
  } finally { env.cleanup() }
})

test('a new host resumes cancellation, stops the member and lets retention clear the plan', async () => {
  const env = fixture()
  const effects = []
  const stopped = []
  env.rt.ctx.effect = register => effects.push(register())
  env.rt.stopMemberWork = async (_room, member) => {
    stopped.push(member)
    if (stopped.length === 1) throw new Error('stop unavailable')
  }
  env.rt.postToRoom = async () => {}
  try {
    install(env.rt)
    const tool = name => env.rt.teamTools.find(item => item.name === name)
    const created = JSON.parse(await tool('taskflow_plan').execute({ group: 'IT-create', goal: 'cancel after restart',
      children: [{ id: 'a', member: 'Writer', goal: 'work', dependencies: [] }] }, { agent: env.admin }))
    const id = created.plan.plan_id
    await tool('taskflow_dispatch').execute({ planId: id }, { agent: env.admin })
    env.scheduler.requestCancel(id, { principal: 'bot-admin', reason: 'owner cancelled' })
    assert.equal(env.scheduler.planState(id).status, 'cancelling')
    for (const dispose of effects.splice(0)) dispose?.()
    install(env.rt)
    await env.rt.taskflowSweep()
    assert.deepEqual(stopped, ['bot-a'])
    assert.equal(env.scheduler.planState(id).status, 'cancelling')
    assert.deepEqual(new Retention(env.scheduler, env.knowledge).run(), [])
    await env.rt.taskflowSweep()
    assert.deepEqual(stopped, ['bot-a', 'bot-a'])
    assert.equal(env.scheduler.planState(id).status, 'cancelled')
    assert.deepEqual(new Retention(env.scheduler, env.knowledge).run(), [{ planId: id, status: 'removed' }])
    assert.equal(env.scheduler.db.prepare('SELECT 1 FROM plans WHERE plan_id=?').get(id), undefined)
  } finally {
    for (const dispose of effects) dispose?.()
    env.cleanup()
  }
})

test('trusted acceptance and consolidated insight wait 72h, then archive marks before deleting cards and ledger', async () => {
  const env = fixture()
  let now = 1000
  env.scheduler.clock = () => now
  env.knowledge.clock = () => now
  try {
    const created = env.service.plan({ group: 'IT-create', goal: '登录排查',
      children: [{ id: 'a', member: 'Writer', goal: '排查登录页面', dependencies: [] }] }, env.admin)
    const id = created.plan.plan_id
    await env.service.dispatch({ planId: id }, env.admin)
    await env.service.submit({ planId: id, cardId: 'a', result: '已复核日志' }, env.memberA)
    await env.service.accept({ planId: id, cardId: 'a' }, env.admin)
    env.service.sleepNote({ planId: id, cardId: 'a', text: reflection('保留排查办法') }, env.memberA)
    env.service.sleepConsolidate({ planId: id, title: '登录排查心得', text: reflection('复核请求及日志') }, env.admin)
    env.service.finish({ planId: id }, env.admin)
    const mark = env.scheduler.searchMarks('room-1', '登录排查心得')[0].keyword
    const retention = new Retention(env.scheduler, env.knowledge)
    now += 72 * HOUR - 1
    assert.deepEqual(retention.run(), [])
    assert.equal(env.scheduler.planState(id).cards.length, 1)
    now += 1
    assert.deepEqual(retention.run(), [{ planId: id, status: 'archived' }])
    assert.equal(env.scheduler.db.prepare('SELECT 1 FROM plans WHERE plan_id=?').get(id), undefined)
    assert.equal(env.scheduler.db.prepare('SELECT 1 FROM cards WHERE plan_id=?').get(id), undefined)
    assert.equal(env.scheduler.db.prepare('SELECT 1 FROM node_marks WHERE plan_id=?').get(id), undefined)
    assert.equal(env.knowledge.db.prepare('SELECT text FROM insights WHERE plan_id=?').get(id).text, reflection('复核请求及日志'))
    assert.equal(env.knowledge.searchArchivedMarks('room-1', '登录排查心得')[0].keyword, mark)
    assert.match(env.knowledge.openArchivedMark('room-1', mark).content, /原始明细已清理/)
    const found = env.service.memorySearch({ query: '登录排查心得' }, env.memberA).matches
    assert.equal(found.length, 1)
    assert.equal(found[0].keyword, mark)
    assert.match(env.service.memoryOpen({ keyword: mark }, env.memberA).node.content, /原始明细已清理/)
    assert.deepEqual(retention.run(), [])
  } finally { env.cleanup() }
})

test('missing group at next scheduling removes its active cards and ledger without crossing rooms', async () => {
  const env = fixture()
  try {
    const created = env.service.plan({ group: 'IT-create', goal: 'orphan',
      children: [{ id: 'a', member: 'Writer', goal: 'unfinished', dependencies: [] }] }, env.admin)
    const id = created.plan.plan_id
    await env.service.dispatch({ planId: id }, env.admin)
    const retention = new Retention(env.scheduler, env.knowledge)
    assert.deepEqual(retention.run({ rooms: ['room-2'] }), [{ planId: id, status: 'removed' }])
    assert.equal(env.scheduler.db.prepare('SELECT 1 FROM plans WHERE plan_id=?').get(id), undefined)
  } finally { env.cleanup() }
})

test('cancelled plan deletes its ledger cards and knowledge without archiving failed notes', async () => {
  const env = fixture()
  try {
    const created = env.service.plan({ group: 'IT-create', goal: 'cancel me',
      children: [{ id: 'a', member: 'Writer', goal: 'unfinished', dependencies: [] }] }, env.admin)
    const id = created.plan.plan_id
    await env.service.dispatch({ planId: id }, env.admin)
    await env.service.cancel({ planId: id, reason: 'cannot continue' }, env.admin)
    const retention = new Retention(env.scheduler, env.knowledge)
    assert.deepEqual(retention.run(), [{ planId: id, status: 'removed' }])
    assert.equal(env.scheduler.db.prepare('SELECT 1 FROM plans WHERE plan_id=?').get(id), undefined)
    assert.equal(env.knowledge.db.prepare('SELECT 1 FROM insights WHERE plan_id=?').get(id), undefined)
    assert.deepEqual(retention.run(), [])
  } finally { env.cleanup() }
})

test('legacy completion begins its retention clock at first new scan, never by old ended_at', () => {
  const env = fixture()
  let now = 1000000
  env.scheduler.clock = () => now
  env.knowledge.clock = () => now
  try {
    const created = env.service.plan({ group: 'IT-create', goal: 'legacy',
      children: [{ id: 'a', member: 'Writer', goal: 'task', dependencies: [] }] }, env.admin)
    const id = created.plan.plan_id
    env.scheduler.db.prepare("UPDATE cards SET state='verified' WHERE plan_id=?").run(id)
    env.scheduler.db.prepare("UPDATE plans SET status='completed', ended_at=1 WHERE plan_id=?").run(id)
    env.scheduler.db.prepare('INSERT INTO plan_insights(plan_id,title,text,at) VALUES(?,?,?,?)').run(id, '老记录', '保存的心得', 1)
    const retention = new Retention(env.scheduler, env.knowledge)
    assert.deepEqual(retention.run(), [])
    assert.equal(env.scheduler.db.prepare('SELECT accepted_at FROM retention_clock WHERE plan_id=?').get(id).accepted_at, now)
    now += 72 * HOUR
    assert.deepEqual(retention.run(), [{ planId: id, status: 'archived' }])
  } finally { env.cleanup() }
})
