import assert from 'node:assert/strict'
import test from 'node:test'
import { SchedulerError } from '../src/host/taskflow/scheduler.js'
import { fixture } from './taskflow-fixture.mjs'
import { readFileSync } from 'node:fs'

const harness = fixture
function methodDraft(env, prefix, title, step) {
  const sources = Array.from({length:10}, (_, i) => ({ id:`${prefix}${i}`, step, validation:'验证请求与来源一致并保存记录' }))
  const preview = env.service.skillProposeMethod({ title, sources }, env.admin).preview
  return env.service.skillProposeMethod({ title, sources, previewDigest:preview.digest }, env.admin).draft
}
const reflection = '## 做了什么\n使用真实隔离 fixture 完成任务并核对结果。\n\n## 为什么这么做\n隔离验证可以复现问题并避免改动用户数据。\n\n## 里面的错误怎么避免\n未发现新错误；下次先核对输入并检查实际输出。\n\n## 要在下次任务中做的更好我需要什么\n需要可复用的隔离 fixture 和明确验收条件，开始前从任务说明核实。'

test('plan, dispatch, submit, accept and finish run end to end through the tool service', async () => {
  const env = harness()
  try {
    const planned = env.service.plan({
      group: 'IT-create', goal: 'ship it',
      children: [
        { id: 'write', member: 'Writer', goal: 'write copy', dependencies: [] },
        { id: 'review', member: 'Reviewer', goal: 'review copy', dependencies: ['write'] },
      ],
      concurrency: 1,
    }, env.admin)
    assert.equal(planned.plan.cards.length, 2)
    assert.equal(planned.plan.cards[0].member, 'bot-a')
    assert.equal(planned.plan.principal_name, 'Chief')

    const dispatched = await env.service.dispatch({ group: 'IT-create' }, env.admin)
    assert.equal(dispatched.sent.length, 1)
    assert.match(env.posts[0].text, /^@Writer \[Taskflow .*\/write\]/)
    assert.equal(env.posts[0].scope.room.id, 'room-1')

    const submitted = await env.service.submit({
      planId: planned.plan.plan_id, cardId: 'write', result: 'copy is ready',
    }, env.memberA)
    assert.equal(submitted.observed.status, 'settled')
    assert.match(env.posts.at(-1).text, /^@Chief \[Taskflow /)

    // A non-executor cannot submit someone else's card.
    await assert.rejects(() => env.service.submit({
      planId: planned.plan.plan_id, cardId: 'write', result: 'fake',
    }, env.memberB), error => error instanceof SchedulerError && error.code === 'not_card_executor')

    const accepted = await env.service.accept({
      planId: planned.plan.plan_id, cardId: 'write',
    }, env.admin)
    assert.equal(accepted.accepted.state, 'verified')
    assert.equal(accepted.dispatch.sent.length, 1)

    await env.service.submit({ planId: planned.plan.plan_id, cardId: 'review', result: 'reviewed' }, env.memberB)
    await env.service.accept({ planId: planned.plan.plan_id, cardId: 'review' }, env.admin)
    const done = env.service.finish({ planId: planned.plan.plan_id }, env.admin)
    assert.equal(done.finished.status, 'completed')
  } finally {
    env.cleanup()
  }
})

test('dispatch fills separate Bot slots when earlier ready cards share one Bot', async () => {
  const env = harness()
  try {
    const planned = env.service.plan({
      group: 'IT-create', goal: 'parallel work', concurrency: 2,
      children: [
        { id: 'write-1', member: 'Writer', goal: 'first', dependencies: [] },
        { id: 'write-2', member: 'Writer', goal: 'second', dependencies: [] },
        { id: 'review', member: 'Reviewer', goal: 'third', dependencies: [] },
      ],
    }, env.admin)
    const dispatched = await env.service.dispatch({ planId: planned.plan.plan_id }, env.admin)
    assert.deepEqual(dispatched.sent.map(card => card.id), ['write-1', 'review'])
    assert.equal(env.posts.length, 2)
    assert.deepEqual(dispatched.plan.cards.map(card => card.state), ['running', 'pending', 'running'])
    assert.deepEqual(env.scheduler.claimNext(planned.plan.plan_id, { principal: 'bot-admin' }), [])
  } finally {
    env.cleanup()
  }
})

test('leadership and session visibility are enforced from state, not arguments', async () => {
  const env = harness()
  try {
    assert.equal(env.service.visible('leader', env.admin), true)
    assert.equal(env.service.visible('leader', env.memberA), false)
    assert.equal(env.service.visible('member', env.memberA), true)
    assert.equal(env.service.visible('any', env.outsider), false)
    const own = { session: { id: 'own-a' } }
    assert.equal(env.service.visible('any', own), false)
    assert.throws(() => env.service.status({ group: 'IT-create' }, own), error => error.code === 'group_session_required')
    assert.throws(() => env.service.status({ group: 'Empty room' }, own), error => error.code === 'group_session_required')
    assert.throws(() => env.service.plan({
      group: 'IT-create', goal: 'x', children: [{ id: 'a', member: 'Reviewer', goal: 'x', dependencies: [] }],
    }, env.memberA), error => error.code === 'leader_only')
    assert.throws(() => env.service.status({}, env.outsider), error => error.code === 'not_a_bot_session')
  } finally {
    env.cleanup()
  }
})

test('an ambiguous dispatch failure holds its card for explicit recovery without posting it twice', async () => {
  const env = harness()
  try {
    const planned = env.service.plan({ group: 'IT-create', goal: 'publish',
      children: [{ id: 'a', member: 'Writer', goal: 'publish one item', dependencies: [] }] }, env.admin)
    const posts = []
    env.service.post = async payload => { posts.push(payload); throw new Error('acknowledgment lost') }
    const first = await env.service.dispatch({ planId: planned.plan.plan_id }, env.admin)
    assert.equal(posts.length, 1)
    assert.equal(first.plan.cards[0].state, 'unknown')
    assert.match(first.held[0].reason, /acknowledgment lost/)
    const second = await env.service.dispatch({ planId: planned.plan.plan_id }, env.admin)
    assert.equal(second.sent.length, 0)
    assert.equal(posts.length, 1)
  } finally { env.cleanup() }
})

test('confirm gate and trusted test gate are exposed through the tool service', async () => {
  const env = harness()
  try {
    const planned = env.service.plan({
      group: 'IT-create', goal: 'publish',
      children: [{ id: 'publish', member: 'Writer', goal: 'publish', dependencies: [], confirm: 'Publish now?' }],
      testRequiredCards: ['publish'],
      testChecks: { publish: { command: 'node -e "process.exit(0)"', workdir: process.cwd() } },
    }, env.admin)
    const planId = planned.plan.plan_id
    assert.deepEqual((await env.service.dispatch({ planId }, env.admin)).sent, [])
    env.scheduler.decidePreflight(planId, 'publish', { decision: 'approve', decidedBy: 'user' })
    await env.service.dispatch({ planId }, env.admin)
    await env.service.submit({ planId, cardId: 'publish', result: 'published' }, env.memberA)

    await assert.rejects(() => env.service.accept({ planId, cardId: 'publish' }, env.admin),
      error => error.code === 'trusted_test_verification_required')
    const verified = await env.service.verify({ planId, cardId: 'publish' }, env.admin)
    assert.equal(verified.test.run.state, 'passed')
    const accepted = await env.service.accept({ planId, cardId: 'publish' }, env.admin)
    assert.equal(accepted.accepted.state, 'verified')
  } finally {
    env.cleanup()
  }
})

test('cancel stops active members before marking a plan cancelled and retries failed stops', async () => {
  const env = harness()
  try {
    const planned = env.service.plan({
      group: 'IT-create', goal: 'cancel safely',
      children: [{ id: 'a', member: 'Writer', goal: 'work', dependencies: [] }],
    }, env.admin)
    await env.service.dispatch({ planId: planned.plan.plan_id }, env.admin)
    const stopped = []
    env.service.stopMemberWork = async (_roomId, memberId) => {
      stopped.push(memberId)
      if (stopped.length === 1) throw new Error('stop failed')
    }
    await assert.rejects(() => env.service.cancel({
      planId: planned.plan.plan_id, reason: 'owner cancelled',
    }, env.admin), /stop failed/)
    assert.equal(env.scheduler.planState(planned.plan.plan_id).status, 'cancelling')
    assert.equal(env.scheduler.planState(planned.plan.plan_id).cards[0].state, 'running')
    const cancelled = await env.service.cancel({
      planId: planned.plan.plan_id, reason: 'owner cancelled',
    }, env.admin)
    assert.deepEqual(stopped, ['bot-a', 'bot-a'])
    assert.equal(cancelled.canceled.status, 'cancelled')
  } finally {
    env.cleanup()
  }
})

test('skill drafts need current leader review and human approval; worker search/open obey tier', async () => {
  const env = harness()
  try {
    for (let i = 0; i < 10; i++) env.knowledge.addInsight({ room: 'room-1', planId: `p${i}`,
      title: '登录页面排查', text: `检查登录页面请求及错误日志，验证请求与来源一致并保存记录 ${i}` })
    const draft = methodDraft(env, 'p', '登录页面排查', '检查登录页面请求及错误日志')
    assert.equal(env.service.skillCandidates({}, env.admin).drafts[0].id, draft.id)
    assert.equal(draft.status, 'draft')
    assert.throws(() => env.service.skillReview({ id: draft.id, approved: true }, env.memberA),
      error => error.code === 'leader_only')
    env.service.skillReview({ id: draft.id, approved: true }, env.admin)
    let reviewedSources
    env.service.approveSkill = async ({ sources }) => { reviewedSources = sources }
    const reviewed = await env.service.skillConsolidate({ id: draft.id, text: '检查登录页面请求并复核失败日志', tags: ['代码-排查'] }, env.admin)
    assert.equal(reviewedSources.length, 10)
    assert.match(reviewedSources[0].text, /登录页面请求/)
    assert.equal(reviewed.skill.status, 'approved')
    const found = env.service.skillSearch({ query: '登录' }, env.memberA).skills
    assert.equal(found.length, 1)
    assert.match(env.service.skillOpen({ id: found[0].id }, env.memberA).skill.text, /失败日志/)
    env.rt.state.rooms['room-1'].admin = 'bot-a'
    assert.throws(() => env.service.skillCandidates({}, env.admin), error => error.code === 'leader_only')
  } finally { env.cleanup() }
})

test('skill publication approval is tied to the current leader and exact shared text', async () => {
  const env = harness()
  try {
    for (let i = 0; i < 10; i++) env.knowledge.addInsight({ room: 'room-1', planId: `share-${i}`, title: '共享登录检查', text: `核对登录请求和日志并保留证据，验证请求与来源一致并保存记录 ${i}` })
    const draft = methodDraft(env, 'share-', '共享登录检查', '核对登录请求和日志')
    env.service.skillReview({ id: draft.id, approved: true }, env.admin)
    await env.service.skillConsolidate({ id: draft.id, text: '核对登录请求与日志，保留证据。', tags: ['代码-排查'] }, env.admin)
    await assert.rejects(env.service.skillPublish({ id: draft.id }, env.memberA), error => error.code === 'leader_only')
    await assert.rejects(env.service.skillPublish({ id: draft.id }, env.admin), error => error.code === 'approval_required')
    env.service.approveShare = async () => { env.rt.state.rooms['room-1'].admin = 'bot-a' }
    await assert.rejects(env.service.skillPublish({ id: draft.id }, env.admin), error => error.code === 'leader_only')
    assert.equal(env.knowledge.db.prepare('SELECT COUNT(*) AS n FROM skill_shares').get().n, 0)
    env.rt.state.rooms['room-1'].admin = 'bot-admin'
    env.service.approveShare = async () => { env.knowledge.db.prepare('UPDATE candidates SET text=? WHERE id=?').run('changed after approval', draft.id) }
    await assert.rejects(env.service.skillPublish({ id: draft.id }, env.admin), /skill_changed/)
    assert.equal(env.knowledge.db.prepare('SELECT COUNT(*) AS n FROM skill_shares').get().n, 0)
    env.knowledge.db.prepare('UPDATE candidates SET text=? WHERE id=?').run('核对登录请求与日志，保留证据。', draft.id)
    env.service.approveShare = async () => {}
    const result = await env.service.skillPublish({ id: draft.id }, env.admin)
    assert.match(result.publication.path, /shared/)
    env.service.skillUnpublish({ id: draft.id }, env.admin)
    assert.equal(env.knowledge.db.prepare('SELECT COUNT(*) AS n FROM skill_shares').get().n, 0)
  } finally { env.cleanup() }
})

test('sharing cannot follow a session moved to a different leader room during approval', async () => {
  const env = harness()
  try {
    for (let i = 0; i < 10; i++) env.knowledge.addInsight({ room: 'room-1', planId: `moved-${i}`,
      title: '共享身份核验', text: `核验来源群和主理身份后才公开，验证请求与来源一致并保存记录 ${i}` })
    const draft = methodDraft(env, 'moved-', '共享身份核验', '核验来源群和主理身份')
    env.service.skillReview({ id: draft.id, approved: true }, env.admin)
    await env.service.skillConsolidate({ id: draft.id, text: '公开前核验来源群主理身份。', tags: ['代码-权限'] }, env.admin)
    env.service.approveShare = async () => {
      env.rt.state.rooms['room-1'].admin = 'bot-b'
      env.rt.state.rooms['room-2'].admin = 'bot-admin'
      env.rt.state.rooms['room-2'].members.push('bot-admin')
      env.rt.groupOwners.set('group-admin', { roomId: 'room-2', botId: 'bot-admin' })
    }
    await assert.rejects(env.service.skillPublish({ id: draft.id }, env.admin), /changed|another group|Only the group admin/)
    assert.equal(env.knowledge.db.prepare('SELECT COUNT(*) AS n FROM skill_shares').get().n, 0)
  } finally { env.cleanup() }
})

test('sharing rejects changed source text beyond its preview and changed acceptance evidence', async () => {
  const env = harness()
  try {
    for (let i = 0; i < 10; i++) env.knowledge.addInsight({ room: 'room-1', planId: `evidence-${i}`,
      title: '共享来源证据', text: '核对登录日志并保存原始记录。'.repeat(100) + '验证请求与来源一致并保存记录' + i, acceptance: '已验收：原始日志逐项核对通过。'.repeat(30) })
    const draft = methodDraft(env, 'evidence-', '共享来源证据', '核对登录日志并保存原始记录')
    env.service.skillReview({ id: draft.id, approved: true }, env.admin)
    await env.service.skillConsolidate({ id: draft.id, text: '核对日志并保留来源证据。', tags: ['代码-排查'] }, env.admin)
    for (const field of ['text', 'acceptance']) {
      const original = env.knowledge.db.prepare(`SELECT ${field} AS value FROM insights WHERE plan_id=?`).get('evidence-0').value
      env.service.approveShare = async () => {
        env.knowledge.db.prepare(`UPDATE insights SET ${field}=? WHERE plan_id=?`).run(original + '审批等待期间的变化', 'evidence-0')
      }
      await assert.rejects(env.service.skillPublish({ id: draft.id }, env.admin), /skill_sources?_changed/)
      assert.equal(env.knowledge.db.prepare('SELECT COUNT(*) AS n FROM skill_shares').get().n, 0)
      env.knowledge.db.prepare(`UPDATE insights SET ${field}=? WHERE plan_id=?`).run(original, 'evidence-0')
    }
    const source = env.knowledge.db.prepare('SELECT * FROM candidate_sources WHERE candidate_id=? LIMIT 1').get(draft.id)
    env.service.approveShare = async () => {
      env.knowledge.db.prepare('DELETE FROM candidate_sources WHERE candidate_id=? AND source_id=?').run(draft.id, source.source_id)
    }
    await assert.rejects(env.service.skillPublish({ id: draft.id }, env.admin), /skill_sources_changed/)
    assert.equal(env.knowledge.db.prepare('SELECT COUNT(*) AS n FROM skill_shares').get().n, 0)
    env.knowledge.db.prepare('INSERT INTO candidate_sources(room,tier,source_id,candidate_id) VALUES(?,?,?,?)')
      .run(source.room, source.tier, source.source_id, source.candidate_id)
    env.service.approveShare = async () => {}
    assert.match((await env.service.skillPublish({ id: draft.id }, env.admin)).publication.path, /shared/)
  } finally { env.cleanup() }
})

test('failed work retries automatically once then ends dependent cards and alerts the principal', async () => {
  const env = harness()
  try {
    const planned = env.service.plan({ group: 'IT-create', goal: 'retry', children: [
      { id: 'a', member: 'Writer', goal: 'attempt', dependencies: [] },
      { id: 'b', member: 'Reviewer', goal: 'review', dependencies: ['a'] },
    ] }, env.admin)
    const planId = planned.plan.plan_id
    await env.service.dispatch({ planId }, env.admin)
    await assert.rejects(env.service.dispatchScope(env.service.scope(env.memberA), planId), { code: 'leader_only' })
    assert.equal(env.posts.filter(post => post.taskflowEvent?.event === 'assigned').length, 1)
    await env.service.submit({ planId, cardId: 'a', status: 'failed', result: 'first failure' }, env.memberA)
    assert.deepEqual(env.posts.map(({ scope, taskflowEvent: event }) => [event.event, scope.botId, event.from.id, event.to.id]), [
      ['assigned', 'bot-admin', 'bot-admin', 'bot-a'],
      ['failed', 'bot-a', 'bot-a', 'bot-admin'],
      ['assigned', 'bot-admin', 'bot-admin', 'bot-a'],
    ])
    assert.equal(env.scheduler.cardView(planId, 'a').attempts, 2)
    assert.equal(env.scheduler.cardView(planId, 'a').state, 'running')
    await env.service.submit({ planId, cardId: 'a', status: 'failed', result: 'second failure' }, env.memberA)
    assert.equal(env.scheduler.cardView(planId, 'a').state, 'failed')
    assert.equal(env.scheduler.cardView(planId, 'b').state, 'cancelled')
    assert.match(env.posts.at(-1).text, /@Chief/)
  } finally { env.cleanup() }
})

test('cancelled or failed work cannot be consolidated into the long-term skill pool', async () => {
  const env = harness()
  try {
    const planned = env.service.plan({ group: 'IT-create', goal: 'failed',
      children: [{ id: 'a', member: 'Writer', goal: 'attempt', dependencies: [] }] }, env.admin)
    await env.service.dispatch({ planId: planned.plan.plan_id }, env.admin)
    await env.service.submit({ planId: planned.plan.plan_id, cardId: 'a', status: 'failed', result: 'cannot complete' }, env.memberA)
    assert.throws(() => env.service.sleepConsolidate({ planId: planned.plan.plan_id,
      title: 'bad', text: reflection }, env.admin), error => error.code === 'not_all_verified')
    assert.equal(env.knowledge.db.prepare('SELECT 1 FROM insights WHERE plan_id=?').get(planned.plan.plan_id), undefined)
  } finally { env.cleanup() }
})

test('executor notes and consolidation are gated by identity and completeness', async () => {
  const env = harness()
  try {
    const planned = env.service.plan({
      group: 'IT-create', goal: 'learn',
      children: [{ id: 'a', member: 'Writer', goal: 'do', dependencies: [] }],
    }, env.admin)
    await env.service.dispatch({ planId: planned.plan.plan_id }, env.admin)
    await env.service.submit({ planId: planned.plan.plan_id, cardId: 'a', result: 'done' }, env.memberA)
    await env.service.accept({ planId: planned.plan.plan_id, cardId: 'a' }, env.admin)
    assert.throws(() => env.service.sleepNote({ planId: planned.plan.plan_id, cardId: 'a', text: reflection }, env.memberB),
      error => error.code === 'not_card_executor')
    env.service.sleepNote({ planId: planned.plan.plan_id, cardId: 'a', text: reflection }, env.memberA)
    assert.deepEqual(env.service.sleepPending({ planId: planned.plan.plan_id }, env.admin).pending_cards, [])
    const consolidated = env.service.sleepConsolidate({
      planId: planned.plan.plan_id, title: 'lesson', text: reflection,
    }, env.admin)
    assert.equal(consolidated.insight.title, 'lesson')
    assert.equal(env.knowledge.db.prepare('SELECT text FROM insights WHERE plan_id=?').get(planned.plan.plan_id).text,
      reflection)
    assert.deepEqual(env.knowledge.db.prepare('SELECT card_id,member,text FROM insight_sources WHERE plan_id=?')
      .all(planned.plan.plan_id).map(row => ({ ...row })), [{ card_id: 'a', member: 'bot-a', text: reflection }])
    assert.equal(readFileSync(consolidated.publication.path, 'utf8'), `# lesson\n\n${reflection}\n`)
    const search = env.service.memorySearch({ query: '心得' }, env.admin)
    const insightMark = search.matches.find(mark => mark.kind === 'insight')
    assert.ok(insightMark)
    assert.ok(JSON.stringify(env.service.memoryOpen({ keyword: insightMark.keyword }, env.admin)).includes(reflection.replaceAll('\n', '\\n')))
  } finally {
    env.cleanup()
  }
})
