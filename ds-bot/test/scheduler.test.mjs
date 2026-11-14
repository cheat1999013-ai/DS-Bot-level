import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Scheduler, SchedulerError, canonicalJson, digest } from '../src/host/taskflow/scheduler.js'

const TEST_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '.tmp-test')
mkdirSync(TEST_ROOT, { recursive: true })

function schedulerTest(name, fn) {
  test(name, () => {
    const dir = mkdtempSync(join(TEST_ROOT, 'sched-'))
    const scheduler = new Scheduler(join(dir, 'taskflow.sqlite'))
    try {
      fn(scheduler)
    } finally {
      scheduler.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

function plan(scheduler, overrides = {}) {
  return scheduler.createPlan({
    planId: overrides.planId ?? 'plan-1',
    room: overrides.room ?? 'room-1',
    principal: overrides.principal ?? 'bot-admin',
    cards: overrides.cards ?? [
      { id: 'design', member: 'bot-a', goal: 'design the thing', dependencies: [] },
      { id: 'build', member: 'bot-b', goal: 'build the thing', dependencies: ['design'] },
      { id: 'review', member: 'bot-c', goal: 'review the thing', dependencies: ['build'] },
    ],
    concurrency: overrides.concurrency ?? 2,
    retryLimit: overrides.retryLimit ?? 1,
    confirmRequired: overrides.confirmRequired ?? false,
    gates: overrides.gates ?? {},
    testRequiredCards: overrides.testRequiredCards ?? [],
    testChecks: overrides.testChecks ?? {},
    workdir: overrides.workdir ?? null,
  })
}

function runCard(scheduler, planId, cardId, principal = 'bot-admin', text = 'done') {
  const claimed = scheduler.claimNext(planId, { principal })
  assert.equal(claimed.length, 1)
  assert.equal(claimed[0].id, cardId)
  scheduler.bindReceipt(planId, cardId, { receipt: `r-${cardId}` })
  const card = scheduler.planState(planId).cards.find(item => item.id === cardId)
  scheduler.observeResult(planId, cardId, {
    status: 'settled', terminalEventId: `t-${cardId}`, member: card.member,
    receipt: `r-${cardId}`, text,
  })
  return scheduler.resultPayload(planId, cardId)
}

schedulerTest('stall scan distinguishes uncertain dispatch from unreported work', scheduler => {
  plan(scheduler, { cards: [
    { id: 'a', member: 'bot-a', goal: 'a', dependencies: [] },
    { id: 'b', member: 'bot-b', goal: 'b', dependencies: [] },
  ] })
  scheduler.claimNext('plan-1', { principal: 'bot-admin' })
  scheduler.bindReceipt('plan-1', 'a', { receipt: 'r-a' })
  const start = scheduler.clock()
  scheduler.clock = () => start + 301
  assert.deepEqual(scheduler.stalledCards().map(item => [item.cardId, item.state]), [['b', 'dispatching']])
  scheduler.clock = () => start + 3500
  scheduler.touchMemberProgress('room-1', 'bot-a')
  scheduler.clock = () => start + 3601
  assert.deepEqual(scheduler.stalledCards().map(item => [item.cardId, item.state]), [['b', 'dispatching']])
  scheduler.clock = () => start + 7101
  assert.deepEqual(scheduler.stalledCards().map(item => [item.cardId, item.state]), [['a', 'running'], ['b', 'dispatching']])
  scheduler.observeResult('plan-1', 'a', { status: 'settled', terminalEventId: 't-a', member: 'bot-a', receipt: 'r-a', text: 'done' })
  assert.deepEqual(scheduler.stalledCards().map(item => item.cardId), ['b'])
  assert.throws(() => scheduler.failCard('plan-1', 'a', { reason: 'old timeout' }), { code: 'result_already_submitted' })
  assert.equal(scheduler.resultPayload('plan-1', 'a').text, 'done')
})

schedulerTest('departing group worker ends assigned cards and their dependent cards', scheduler => {
  plan(scheduler, { cards: [
    { id: 'a', member: 'bot-a', goal: 'write', dependencies: [] },
    { id: 'b', member: 'bot-b', goal: 'review', dependencies: ['a'] },
  ] })
  scheduler.claimNext('plan-1', { principal: 'bot-admin' })
  scheduler.bindReceipt('plan-1', 'a', { receipt: 'r-a' })
  assert.deepEqual(scheduler.failMemberCards('room-1', 'bot-a').map(item => item.id), ['a'])
  assert.equal(scheduler.cardView('plan-1', 'a').state, 'failed')
  assert.equal(scheduler.cardView('plan-1', 'b').state, 'cancelled')
  assert.equal(scheduler.planState('plan-1').status, 'open')
})

schedulerTest('active taskflow workers can be recovered as quiet after a host restart', scheduler => {
  plan(scheduler, { cards: [{ id: 'a', member: 'bot-a', goal: 'do', dependencies: [] }] })
  assert.equal(scheduler.isAssignedWorker('room-1', 'bot-a'), false)
  const payload = runCard(scheduler, 'plan-1', 'a')
  assert.equal(scheduler.isAssignedWorker('room-1', 'bot-a'), true)
  assert.equal(scheduler.isAssignedWorker('room-2', 'bot-a'), false)
  scheduler.acceptResult('plan-1', 'a', { principal: 'bot-admin', evidence: `principal-result:${digest(payload)}` })
  assert.equal(scheduler.isAssignedWorker('room-1', 'bot-a'), false)
})

schedulerTest('a confirmation card waits for the owner before any worker dispatch', scheduler => {
  plan(scheduler, { cards: [{ id: 'publish', member: 'bot-a', goal: 'publish', dependencies: [] }],
    gates: { publish: 'Publish this result?' } })
  assert.deepEqual(scheduler.claimNext('plan-1', { principal: 'bot-admin' }), [])
  assert.equal(scheduler.cardView('plan-1', 'publish').attempts, 0)
  assert.deepEqual(scheduler.pendingPreflight('plan-1').map(item => item.card_id), ['publish'])
  scheduler.decidePreflight('plan-1', 'publish', { decision: 'reject', note: 'Wait', decidedBy: 'user' })
  assert.deepEqual(scheduler.claimNext('plan-1', { principal: 'bot-admin' }), [])
  assert.equal(scheduler.cardView('plan-1', 'publish').attempts, 0)
})

schedulerTest('completed work grants at most one Bot reward per plan and preserves legacy level boundaries', scheduler => {
  plan(scheduler, { cards: [
    { id: 'first', member: 'bot-a', goal: 'first', dependencies: [] },
    { id: 'second', member: 'bot-a', goal: 'second', dependencies: ['first'] },
  ] })
  assert.deepEqual(scheduler.botLevel('room-1', 'bot-a'), { count: 0, level: 0, tier: 'normal' })
  for (const id of ['first', 'second']) {
    const payload = runCard(scheduler, 'plan-1', id)
    scheduler.acceptResult('plan-1', id, { principal: 'bot-admin', evidence: `principal-result:${digest(payload)}` })
  }
  assert.deepEqual(scheduler.botLevel('room-1', 'bot-a'), { count: 0, level: 0, tier: 'normal' })
  const snapshot = scheduler.completionSnapshot('plan-1')
  scheduler.finishPlan('plan-1', { principal: 'bot-admin', expectedSnapshot: snapshot, evidence: `principal-plan:${digest(snapshot)}` })
  assert.deepEqual(scheduler.botLevel('room-1', 'bot-a'), { count: 1, level: 0.1, tier: 'normal' })
  for (const [count, tier] of [[150, 'normal'], [159, 'normal'], [160, 'excellent'], [269, 'excellent'], [270, 'premium'], [410, 'premium']]) {
    scheduler.db.exec('DELETE FROM bot_rewards')
    for (let i = 0; i < count; i++) scheduler.db.prepare('INSERT INTO bot_rewards(room,plan_id,bot_id,at) VALUES(?,?,?,?)')
      .run('room-1', `seed-${i}`, 'bot-a', i)
    assert.deepEqual(scheduler.botLevel('room-1', 'bot-a'), { count, level: count / 10, tier })
    assert.deepEqual(scheduler.botLevel('room-2', 'bot-a'), { count: 0, level: 0, tier: 'normal' })
  }
})

schedulerTest('each important node has one hidden keyword and search/open stay within its group', scheduler => {
  plan(scheduler, { cards: [{ id: 'write', member: 'bot-a', goal: '登录页面整理', dependencies: [] }] })
  const payload = runCard(scheduler, 'plan-1', 'write', 'bot-admin', '修复登录页面问题')
  scheduler.acceptResult('plan-1', 'write', { principal: 'bot-admin', evidence: `principal-result:${digest(payload)}` })
  scheduler.note('plan-1', 'write', { member: 'bot-a', text: '复核登录页面请求' })
  scheduler.consolidate('plan-1', { principal: 'bot-admin', title: '登录页面经验', text: '通过复核请求解决问题' })
  const marks = scheduler.searchMarks('room-1', '登录')
  assert.deepEqual(marks.map(item => item.kind), ['insight', 'note', 'accept', 'result', 'dispatch'])
  assert.equal(new Set(marks.map(item => item.keyword)).size, marks.length)
  const note = marks.find(item => item.kind === 'note')
  assert.match(scheduler.openMark('room-1', note.keyword).content, /复核登录页面请求/)
  assert.equal(scheduler.events('plan-1').some(event => JSON.stringify(event).includes(note.keyword)), false)
  assert.deepEqual(scheduler.searchMarks('other-room', '登录'), [])
  assert.throws(() => scheduler.openMark('other-room', note.keyword), /other_room/)
})

schedulerTest('ordered DAG validates forward references and duplicates', scheduler => {
  plan(scheduler)
  assert.throws(() => plan(scheduler, {
    planId: 'plan-bad',
    cards: [
      { id: 'b', member: 'bot-b', goal: 'b', dependencies: ['a'] },
      { id: 'a', member: 'bot-a', goal: 'a', dependencies: [] },
    ],
  }), error => error instanceof SchedulerError && error.code === 'forward_dependency')
  assert.throws(() => plan(scheduler, {
    planId: 'plan-dup',
    cards: [
      { id: 'a', member: 'bot-a', goal: 'a', dependencies: [] },
      { id: 'a', member: 'bot-b', goal: 'b', dependencies: [] },
    ],
  }), error => error.code === 'duplicate_card')
})

schedulerTest('dispatch follows verified dependencies', scheduler => {
  plan(scheduler)
  assert.deepEqual(scheduler.readyCards('plan-1'), ['design'])
  const claimed = scheduler.claimNext('plan-1', { principal: 'bot-admin' })
  assert.deepEqual(claimed.map(card => card.id), ['design'])
  assert.equal(scheduler.planState('plan-1').in_flight, 1)
  // A second claim does not exceed the dependency or the in-flight slot.
  assert.deepEqual(scheduler.claimNext('plan-1', { principal: 'bot-admin' }), [])
  scheduler.bindReceipt('plan-1', 'design', { receipt: 'r-design' })
  scheduler.observeResult('plan-1', 'design', {
    status: 'settled', terminalEventId: 't-design', member: 'bot-a', receipt: 'r-design', text: 'ok',
  })
  const payload = scheduler.resultPayload('plan-1', 'design')
  scheduler.acceptResult('plan-1', 'design', { principal: 'bot-admin', evidence: `principal-result:${digest(payload)}` })
  assert.deepEqual(scheduler.readyCards('plan-1'), ['build'])
})

schedulerTest('acceptance requires the exact sha256 evidence', scheduler => {
  plan(scheduler, { cards: [{ id: 'a', member: 'bot-a', goal: 'a', dependencies: [] }] })
  runCard(scheduler, 'plan-1', 'a')
  assert.throws(() => scheduler.acceptResult('plan-1', 'a', { principal: 'bot-admin', evidence: 'principal-result:bad' }),
    error => error.code === 'evidence_mismatch')
  const payload = scheduler.resultPayload('plan-1', 'a')
  assert.equal(scheduler.acceptResult('plan-1', 'a', {
    principal: 'bot-admin', evidence: `principal-result:${digest(payload)}`,
  }).state, 'verified')
})

schedulerTest('finish requires all verified and a matching snapshot', scheduler => {
  plan(scheduler, {
    cards: [
      { id: 'a', member: 'bot-a', goal: 'a', dependencies: [] },
      { id: 'b', member: 'bot-b', goal: 'b', dependencies: ['a'] },
    ],
  })
  runCard(scheduler, 'plan-1', 'a')
  const payload = scheduler.resultPayload('plan-1', 'a')
  scheduler.acceptResult('plan-1', 'a', { principal: 'bot-admin', evidence: `principal-result:${digest(payload)}` })
  const snapshot = scheduler.completionSnapshot('plan-1')
  assert.throws(() => scheduler.finishPlan('plan-1', {
    principal: 'bot-admin', expectedSnapshot: snapshot, evidence: `principal-plan:${digest(snapshot)}`,
  }), error => error.code === 'not_all_verified')
  runCard(scheduler, 'plan-1', 'b')
  const bPayload = scheduler.resultPayload('plan-1', 'b')
  scheduler.acceptResult('plan-1', 'b', { principal: 'bot-admin', evidence: `principal-result:${digest(bPayload)}` })
  const finalSnapshot = scheduler.completionSnapshot('plan-1')
  assert.equal(scheduler.finishPlan('plan-1', {
    principal: 'bot-admin', expectedSnapshot: finalSnapshot, evidence: `principal-plan:${digest(finalSnapshot)}`,
  }).status, 'completed')
  const changed = JSON.parse(JSON.stringify(finalSnapshot))
  changed.cards[0].goal = 'tampered'
  assert.throws(() => scheduler.finishPlan('plan-1', {
    principal: 'bot-admin', expectedSnapshot: changed, evidence: `principal-plan:${digest(changed)}`,
  }), error => error.code === 'plan_changed_during_confirmation' || error.code === 'plan_not_open')
})

schedulerTest('owner preflight approval unlocks a card and preserves the result acceptance gate', scheduler => {
  plan(scheduler, {
    cards: [{ id: 'a', member: 'bot-a', goal: 'publish', dependencies: [] }],
    gates: { a: 'Publish this?' },
  })
  assert.deepEqual(scheduler.claimNext('plan-1', { principal: 'bot-admin' }), [])
  scheduler.decidePreflight('plan-1', 'a', { decision: 'approve', note: 'ok', decidedBy: 'user' })
  assert.deepEqual(scheduler.cardComments('plan-1', 'a').map(item => item.text), ['ok'])
  runCard(scheduler, 'plan-1', 'a')
  const payload = scheduler.resultPayload('plan-1', 'a')
  assert.deepEqual(scheduler.pendingConfirmations('plan-1'), [])
  assert.equal(scheduler.acceptResult('plan-1', 'a', {
    principal: 'bot-admin', evidence: `principal-result:${digest(payload)}`,
  }).state, 'verified')
})

schedulerTest('all-card confirmation applies even when one card has a question', scheduler => {
  plan(scheduler, {
    confirmRequired: true,
    gates: { a: 'Check a?' },
    cards: [
      { id: 'a', member: 'bot-a', goal: 'a', dependencies: [] },
      { id: 'b', member: 'bot-b', goal: 'b', dependencies: [] },
    ],
  })
  assert.deepEqual(scheduler.claimNext('plan-1', { principal: 'bot-admin' }), [])
  assert.deepEqual(scheduler.pendingPreflight('plan-1').map(item => item.card_id), ['a', 'b'])
  scheduler.decidePreflight('plan-1', 'b', { decision: 'approve', decidedBy: 'user' })
  const claimed = scheduler.claimNext('plan-1', { principal: 'bot-admin' })
  assert.deepEqual(claimed.map(item => item.id), ['b'])
  scheduler.bindReceipt('plan-1', 'b', { receipt: 'r-b' })
  scheduler.observeResult('plan-1', 'b', { status: 'settled', terminalEventId: 't-b', member: 'bot-b', receipt: 'r-b', text: 'done' })
  const payload = scheduler.resultPayload('plan-1', 'b')
  assert.equal(scheduler.acceptResult('plan-1', 'b', {
    principal: 'bot-admin', evidence: `principal-result:${digest(payload)}`,
  }).state, 'verified')
  assert.equal(scheduler.cardView('plan-1', 'a').state, 'pending')
})

schedulerTest('a required test must have a matching command before creating a plan', scheduler => {
  assert.throws(() => plan(scheduler, {
    testRequiredCards: ['design'], testChecks: {},
  }), error => error.code === 'invalid_test_specification')
  assert.deepEqual(scheduler.listPlans('room-1'), [])
})

schedulerTest('restart makes unfinished running cards explicitly recoverable', scheduler => {
  plan(scheduler, { cards: [{ id: 'a', member: 'bot-a', goal: 'a', dependencies: [] }] })
  scheduler.claimNext('plan-1', { principal: 'bot-admin' })
  scheduler.bindReceipt('plan-1', 'a', { receipt: 'r-a' })
  scheduler.recoverDispatches()
  assert.equal(scheduler.planState('plan-1').cards[0].state, 'unknown')
  assert.equal(scheduler.resolveUnknown('plan-1', 'a', {
    principal: 'bot-admin', decision: 'retry',
  }).state, 'pending')
})

schedulerTest('failing an unknown dispatch stops its dependent chain', scheduler => {
  plan(scheduler, { cards: [
    { id: 'a', member: 'bot-a', goal: 'a', dependencies: [] },
    { id: 'b', member: 'bot-b', goal: 'b', dependencies: ['a'] },
  ] })
  scheduler.claimNext('plan-1', { principal: 'bot-admin' })
  scheduler.markDispatchUnknown('plan-1', 'a', { reason: 'delivery uncertain' })
  scheduler.resolveUnknown('plan-1', 'a', { principal: 'bot-admin', decision: 'fail' })
  assert.deepEqual(scheduler.planState('plan-1').cards.map(card => card.state), ['failed', 'cancelled'])
  assert.deepEqual(scheduler.claimNext('plan-1', { principal: 'bot-admin' }), [])
})

schedulerTest('trusted tests gate acceptance and survive only on the current terminal', scheduler => {
  plan(scheduler, {
    cards: [{ id: 'a', member: 'bot-a', goal: 'a', dependencies: [] }],
    testRequiredCards: ['a'],
    testChecks: { a: { command: 'node -e "process.exit(0)"', workdir: process.cwd() } },
  })
  runCard(scheduler, 'plan-1', 'a')
  const payload = scheduler.resultPayload('plan-1', 'a')
  assert.throws(() => scheduler.acceptResult('plan-1', 'a', {
    principal: 'bot-admin', evidence: `principal-result:${digest(payload)}`,
  }), error => error.code === 'trusted_test_verification_required')
  scheduler.admitTests('plan-1', 'a', { terminal: payload.terminal_event_id })
  assert.equal(scheduler.finishTests('plan-1', 'a', {
    terminal: payload.terminal_event_id, result: { exit_code: 0 },
  }).run.state, 'passed')
  assert.equal(scheduler.acceptResult('plan-1', 'a', {
    principal: 'bot-admin', evidence: `principal-result:${digest(payload)}`,
  }).state, 'verified')
})

schedulerTest('notes feed consolidation and drafts are consumed', scheduler => {
  plan(scheduler, { cards: [{ id: 'a', member: 'bot-a', goal: 'a', dependencies: [] }] })
  runCard(scheduler, 'plan-1', 'a')
  const payload = scheduler.resultPayload('plan-1', 'a')
  scheduler.acceptResult('plan-1', 'a', { principal: 'bot-admin', evidence: `principal-result:${digest(payload)}` })
  assert.deepEqual(scheduler.pendingNotes('plan-1'), ['a'])
  scheduler.note('plan-1', 'a', { member: 'bot-a', text: 'use the real fixture' })
  assert.deepEqual(scheduler.pendingNotes('plan-1'), [])
  assert.equal(scheduler.consolidate('plan-1', {
    principal: 'bot-admin', title: 'lesson', text: 'use the real fixture',
  }).title, 'lesson')
  assert.equal(scheduler.pendingNotes('plan-1').length, 0)
  // Idempotent same content, conflicting content rejected.
  assert.equal(scheduler.consolidate('plan-1', {
    principal: 'bot-admin', title: 'lesson', text: 'use the real fixture',
  }).title, 'lesson')
  assert.throws(() => scheduler.consolidate('plan-1', {
    principal: 'bot-admin', title: 'lesson', text: 'different',
  }), error => error.code === 'insight_conflict')
})

schedulerTest('rework returns a running card to pending without consuming retry budget', scheduler => {
  plan(scheduler, { cards: [{ id: 'a', member: 'bot-a', goal: 'a', dependencies: [] }] })
  runCard(scheduler, 'plan-1', 'a')
  const reworked = scheduler.reworkCard('plan-1', 'a', { principal: 'bot-admin' })
  assert.equal(reworked.state, 'pending')
  assert.equal(reworked.attempts, 1)
  assert.throws(() => scheduler.resultPayload('plan-1', 'a'), error => error.code === 'result_missing')
  runCard(scheduler, 'plan-1', 'a', 'bot-admin', 'second try')
  assert.equal(scheduler.planState('plan-1').cards[0].attempts, 2)
})

schedulerTest('cancel keeps verified cards and reports in-flight receipts', scheduler => {
  plan(scheduler, {
    cards: [
      { id: 'a', member: 'bot-a', goal: 'a', dependencies: [] },
      { id: 'b', member: 'bot-b', goal: 'b', dependencies: [] },
    ],
    concurrency: 2,
  })
  const claimed = scheduler.claimNext('plan-1', { principal: 'bot-admin' })
  assert.equal(claimed.length, 2)
  scheduler.bindReceipt('plan-1', 'a', { receipt: 'r-a' })
  const pending = scheduler.requestCancel('plan-1', { principal: 'bot-admin', reason: 'owner stopped it' })
  assert.equal(pending.status, 'cancelling')
  assert.deepEqual(pending.stop_members, ['bot-a', 'bot-b'])
  assert.equal(scheduler.planState('plan-1').cards.find(card => card.id === 'a').state, 'running')
  scheduler.finishCancel('plan-1', { principal: 'bot-admin' })
  const state = scheduler.planState('plan-1')
  assert.equal(state.status, 'cancelled')
  assert.equal(state.cards.find(card => card.id === 'a').state, 'cancelled')
})

schedulerTest('canonical JSON is key-order independent', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }))
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: 2 }))
})
