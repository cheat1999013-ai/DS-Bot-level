import assert from 'node:assert/strict'
import test from 'node:test'
import { Scheduler, digest } from '../src/host/taskflow/scheduler.js'
import { fixture } from './taskflow-fixture.mjs'

function acceptedPlan(env, id, members = ['bot-a']) {
  const cards = members.map((member, i) => ({ id: `task-${i}`, member, goal: 'isolated completion', dependencies: i ? [`task-${i - 1}`] : [] }))
  env.scheduler.createPlan({ planId: id, room: 'room-1', principal: 'bot-admin', cards, concurrency: 1 })
  for (const card of cards) {
    env.scheduler.claimNext(id, { principal: 'bot-admin' })
    env.scheduler.bindReceipt(id, card.id, { receipt: `${id}-${card.id}` })
    env.scheduler.observeResult(id, card.id, { member: card.member, receipt: `${id}-${card.id}`, status: 'settled', terminalEventId: `${id}-${card.id}-done`, text: 'offline fixture result' })
    const payload = env.scheduler.resultPayload(id, card.id)
    env.scheduler.acceptResult(id, card.id, { principal: 'bot-admin', evidence: `principal-result:${digest(payload)}` })
  }
}
function finish(scheduler, id) {
  const snapshot = scheduler.completionSnapshot(id)
  return scheduler.finishPlan(id, { principal: 'bot-admin', expectedSnapshot: snapshot, evidence: `principal-plan:${digest(snapshot)}` })
}
function seed(scheduler, count, weighted = false) {
  const sql = weighted
    ? 'INSERT INTO bot_rewards(room,plan_id,bot_id,at,points) VALUES(?,?,?,?,?)'
    : 'INSERT INTO bot_rewards(room,plan_id,bot_id,at) VALUES(?,?,?,?)'
  scheduler.write(() => {
    const insert = scheduler.db.prepare(sql)
    for (let i = 0; i < count; i++) {
      const args = ['room-1', `seed-${i}`, 'bot-a', i]
      if (weighted) args.push(i < 160 ? 10 : 1)
      insert.run(...args)
    }
  })
}

test('rewards require successful whole-plan completion and count each executor once', () => {
  const env = fixture()
  try {
    acceptedPlan(env, 'reward-plan', ['bot-a', 'bot-a', 'bot-b', 'bot-admin'])
    assert.deepEqual(env.scheduler.botLevel('room-1', 'bot-a'), { count: 0, level: 0, tier: 'normal' })
    const snapshot = env.scheduler.completionSnapshot('reward-plan')
    assert.throws(() => env.scheduler.finishPlan('reward-plan', { principal: 'bot-admin', expectedSnapshot: snapshot, evidence: 'invalid' }), { code: 'evidence_mismatch' })
    assert.equal(env.scheduler.db.prepare('SELECT COUNT(*) AS n FROM bot_rewards').get().n, 0)
    finish(env.scheduler, 'reward-plan')
    for (const worker of ['bot-a', 'bot-b']) assert.deepEqual(env.scheduler.botLevel('room-1', worker), { count: 1, level: 0.1, tier: 'normal' })
    assert.deepEqual(env.scheduler.botLevel('room-1', 'bot-admin'), { count: 0, level: 0, tier: 'normal' })
    assert.deepEqual(env.scheduler.botLevel('room-2', 'bot-a'), { count: 0, level: 0, tier: 'normal' })
    assert.throws(() => finish(env.scheduler, 'reward-plan'), { code: 'plan_not_open' })
    assert.equal(env.scheduler.botLevel('room-1', 'bot-a').count, 1)
  } finally { env.cleanup() }
})

test('the completion reaching excellent grants 0.1 and subsequent completions grant 0.01', () => {
  const env = fixture()
  try {
    seed(env.scheduler, 159)
    acceptedPlan(env, 'reach-excellent')
    finish(env.scheduler, 'reach-excellent')
    assert.deepEqual(env.scheduler.botLevel('room-1', 'bot-a'), { count: 160, level: 16, tier: 'excellent' })
    acceptedPlan(env, 'excellent-next', ['bot-a', 'bot-a'])
    finish(env.scheduler, 'excellent-next')
    assert.deepEqual(env.scheduler.botLevel('room-1', 'bot-a'), { count: 161, level: 16.01, tier: 'excellent' })
    assert.deepEqual(env.scheduler.db.prepare("SELECT points FROM bot_rewards WHERE plan_id IN ('reach-excellent','excellent-next') ORDER BY points DESC").all().map(x => x.points), [10, 1])
  } finally { env.cleanup() }
})

test('weighted reward totals enforce exact premium threshold and continue at 0.01', () => {
  const env = fixture()
  try {
    seed(env.scheduler, 1259, true)
    assert.deepEqual(env.scheduler.botLevel('room-1', 'bot-a'), { count: 1259, level: 26.99, tier: 'excellent' })
    acceptedPlan(env, 'reach-premium')
    finish(env.scheduler, 'reach-premium')
    assert.deepEqual(env.scheduler.botLevel('room-1', 'bot-a'), { count: 1260, level: 27, tier: 'premium' })
    acceptedPlan(env, 'premium-next')
    finish(env.scheduler, 'premium-next')
    assert.deepEqual(env.scheduler.botLevel('room-1', 'bot-a'), { count: 1261, level: 27.01, tier: 'premium' })
    const reader = new Scheduler(env.scheduler.path, { readOnly: true })
    try { assert.deepEqual(reader.botLevel('room-1', 'bot-a'), { count: 1261, level: 27.01, tier: 'premium' }) }
    finally { reader.close() }
  } finally { env.cleanup() }
})

test('cancelled plans with accepted cards grant no new rewards', () => {
  const env = fixture()
  try {
    acceptedPlan(env, 'cancel-reward')
    env.scheduler.requestCancel('cancel-reward', { principal: 'bot-admin', reason: 'cancel fixture' })
    env.scheduler.finishCancel('cancel-reward', { principal: 'bot-admin' })
    assert.deepEqual(env.scheduler.botLevel('room-1', 'bot-a'), { count: 0, level: 0, tier: 'normal' })
  } finally { env.cleanup() }
})

test('old rewards preserve earned level through read-only reads and one-time writable migration', () => {
  const env = fixture()
  try {
    if (env.scheduler.db.prepare('PRAGMA table_info(bot_rewards)').all().some(row => row.name === 'points')) env.scheduler.db.exec('ALTER TABLE bot_rewards DROP COLUMN points')
    seed(env.scheduler, 270)
    const reader = new Scheduler(env.scheduler.path, { readOnly: true })
    try {
      assert.deepEqual(reader.botLevel('room-1', 'bot-a'), { count: 270, level: 27, tier: 'premium' })
      assert.equal(reader.db.prepare('PRAGMA table_info(bot_rewards)').all().some(row => row.name === 'points'), false)
    } finally { reader.close() }
    let writer = new Scheduler(env.scheduler.path, { recoverOnOpen: false })
    try {
      assert.deepEqual(writer.botLevel('room-1', 'bot-a'), { count: 270, level: 27, tier: 'premium' })
      acceptedPlan({ scheduler: writer }, 'legacy-next')
      finish(writer, 'legacy-next')
    } finally { writer.close() }
    writer = new Scheduler(env.scheduler.path, { recoverOnOpen: false })
    try { assert.deepEqual(writer.botLevel('room-1', 'bot-a'), { count: 271, level: 27.01, tier: 'premium' }) }
    finally { writer.close() }
  } finally { env.cleanup() }
})

test('completion preserves an existing legacy reward for the same plan without double-counting', () => {
  const env = fixture()
  try {
    acceptedPlan(env, 'legacy-open')
    env.scheduler.db.prepare('INSERT OR IGNORE INTO bot_rewards(room,plan_id,bot_id,at) VALUES(?,?,?,?)').run('room-1', 'legacy-open', 'bot-a', 1)
    finish(env.scheduler, 'legacy-open')
    assert.deepEqual(env.scheduler.botLevel('room-1', 'bot-a'), { count: 1, level: 0.1, tier: 'normal' })
  } finally { env.cleanup() }
})

test('an already-open legacy reader observes rewards after the writer migrates the ledger', () => {
  const env = fixture()
  let reader, writer
  try {
    env.scheduler.db.exec('ALTER TABLE bot_rewards DROP COLUMN points')
    seed(env.scheduler, 160)
    reader = new Scheduler(env.scheduler.path, { readOnly: true })
    assert.equal(reader.botLevel('room-1', 'bot-a').level, 16)
    writer = new Scheduler(env.scheduler.path, { recoverOnOpen: false })
    acceptedPlan({ scheduler: writer }, 'reader-upgrade')
    finish(writer, 'reader-upgrade')
    assert.deepEqual(reader.botLevel('room-1', 'bot-a'), { count: 161, level: 16.01, tier: 'excellent' })
  } finally { writer?.close(); reader?.close(); env.cleanup() }
})
