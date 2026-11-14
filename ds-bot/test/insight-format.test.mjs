import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fixture } from './taskflow-fixture.mjs'
import { buildToolDefinitions } from '../src/host/taskflow/tools.js'

const body = '## 做了什么\n完成隔离任务并核对输出。\n\n## 为什么这么做\n使用真实隔离数据使结果可复核。\n\n## 里面的错误怎么避免\n本次未发现错误；下次仍先核对输入与验收条件。\n\n## 要在下次任务中做的更好我需要什么\n需要完整的输入样例和验收条件，执行前从任务说明核实。'
async function ready() {
  const env = fixture()
  try {
    const { plan } = env.service.plan({ group: 'IT-create', goal: '心得结构回归',
      children: [{ id: 'a', member: 'Writer', goal: '隔离工作', dependencies: [] }] }, env.admin)
    await env.service.dispatch({ planId: plan.plan_id }, env.admin)
    await env.service.submit({ planId: plan.plan_id, cardId: 'a', result: '实际结果' }, env.memberA)
    await env.service.accept({ planId: plan.plan_id, cardId: 'a' }, env.admin)
    return { ...env, planId: plan.plan_id }
  } catch (error) { env.cleanup(); throw error }
}
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
