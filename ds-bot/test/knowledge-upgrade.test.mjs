import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fixture } from './taskflow-fixture.mjs'
import { Retention } from '../src/host/taskflow/retention.js'

test('legacy event indexes and consumed note provenance are restored from original events exactly once', async () => {
  const env = fixture()
  try {
    const plan = env.service.plan({ group: 'IT-create', goal: '恢复真实心得', children: [
      { id: 'write', member: 'Writer', goal: '核对原始响应', dependencies: [] },
    ] }, env.admin).plan
    await env.service.dispatch({ planId: plan.plan_id }, env.admin)
    await env.service.submit({ planId: plan.plan_id, cardId: 'write', result: '原始响应已核对' }, env.memberA)
    await env.service.accept({ planId: plan.plan_id, cardId: 'write' }, env.admin)
    // Reconstruct pre-format ledger rows to verify legacy recovery, not new-tool admission.
    env.scheduler.note(plan.plan_id, 'write', { member: 'bot-a', text: '先保留原始响应，再判断错误原因。' })
    env.scheduler.consolidate(plan.plan_id, { principal: 'bot-admin', title: '响应核对心得', text: '先保留原始响应，再判断错误原因。' })
    env.knowledge.addInsight({ room: 'room-1', planId: plan.plan_id, title: '响应核对心得', text: '先保留原始响应，再判断错误原因。' })
    env.scheduler.db.exec('DELETE FROM node_marks')
    env.knowledge.db.exec('DELETE FROM insight_sources')
    const repaired = env.scheduler.backfillMemory()
    assert.ok(repaired > 0)
    assert.equal(env.scheduler.backfillMemory(), 0)
    const marks = env.scheduler.searchMarks('room-1', '核对')
    assert.ok(marks.length > 0)
    assert.match(env.scheduler.openMark('room-1', marks[0].keyword).content, /核对|响应/)
    new Retention(env.scheduler, env.knowledge).run()
    const sources = env.knowledge.db.prepare('SELECT card_id,member,text FROM insight_sources').all()
    assert.equal(sources.length, 1)
    assert.equal(sources[0].text, '先保留原始响应，再判断错误原因。')
    const publication = env.knowledge.insightPublication('room-1', plan.plan_id)
    assert.equal(publication.provenance, 'preserved')
    assert.match(readFileSync(publication.path, 'utf8'), /先保留原始响应/)
    assert.equal(env.scheduler.listNotes(plan.plan_id).length, 0)
  } finally { env.cleanup() }
})
