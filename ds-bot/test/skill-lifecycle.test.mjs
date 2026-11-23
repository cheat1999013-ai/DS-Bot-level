import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, symlinkSync, renameSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fixture } from './taskflow-fixture.mjs'
import { Knowledge } from '../src/host/taskflow/knowledge.js'
import { contentDigest, skillName } from '../src/host/taskflow/publication.js'
import { knowledgeContext, knowledgeProvider } from '../src/host/taskflow/knowledge-runtime.js'
import { install } from '../src/host/taskflow.js'
import { taskflowProvider } from '../src/host/taskflow-skills.js'

const PERIOD = 5 * 24 * 3600
const quality = value => Object.fromEntries(['scope', 'inputs', 'steps', 'validation', 'prevention', 'boundaries']
  .map(key => [key, { score: value, evidence: value ? `正文中包含${key}对应的操作依据。` : `正文缺少${key}，需要补齐。` }]))
function seed(env, tags = ['设计-UI'], room = 'room-1') {
  const db = env.knowledge
  for (let i = 0; i < 10; i++) db.addInsight({ room, planId: `${room}-${i}`, title: '页面视觉设计', text: `复核页面层次和组件布局，执行统一的设计验收流程 ${i}` })
  const sources = Array.from({length:10}, (_, i) => ({ id:`${room}-${i}`, step:'复核页面层次和组件布局', validation:'执行统一的设计验收流程' }))
  const preview = db.proposeMethod(room, '页面视觉设计', sources)
  const draft = db.proposeMethod(room, '页面视觉设计', sources, preview.digest)
  // Lifecycle fixtures model skills saved before method snapshots existed.
  db.db.prepare('DELETE FROM candidate_method_evidence WHERE candidate_id=?').run(draft.id)
  const text = '按页面目标复核视觉层次和组件布局，核对输入、逐步设计、验证输出并说明失败处理与边界。'
  db.review(draft.id, { kind: 'bot', approved: true, reviewer: 'bot-admin' })
  db.review(draft.id, { kind: 'owner', approved: true, reviewer: 'owner', text, tags })
  return db.consolidate(draft.id, text, tags)
}

test('promotion binds hierarchical tags to approval, searches by parent/child and exports metadata', () => {
  const env = fixture()
  try {
    const skill = seed(env)
    assert.deepEqual(skill.tags, ['设计', '设计-UI'])
    assert.equal(env.knowledge.searchSkills('room-1', 'normal', '', ['设计'])[0].id, skill.id)
    assert.equal(env.knowledge.searchSkills('room-1', 'normal', '', ['设计-UI'])[0].id, skill.id)
    assert.deepEqual(env.knowledge.searchSkills('room-1', 'normal', '', ['代码']), [])
    const publication = env.knowledge.skillPublication('room-1', 'normal', skill.id)
    assert.deepEqual(publication.metadata.tags, ['设计', '设计-UI'])
    assert.match(readFileSync(publication.path, 'utf8'), /tags:.*设计/)
    const result = env.service.skillSearch({ tags: ['设计-UI'] }, env.memberA)
    assert.equal(result.skills[0].id, skill.id)
    assert.deepEqual(env.knowledge.searchSkills('room-2', 'premium', '', ['设计']), [])
  } finally { env.cleanup() }
})

test('ordinary skills get a complete five-day window; duplicate reads count once and automatic assembly is separate', () => {
  const env = fixture(); let now = 1000; env.knowledge.clock = () => now
  try {
    const skill = seed(env)
    env.knowledge.recordSkillUse('room-1', 'bot-a', 'group-a', skill.id, 'call-1')
    env.knowledge.recordSkillUse('room-1', 'bot-a', 'group-a', skill.id, 'call-1')
    env.knowledge.recordSkillLoads('group-a', 'room-1', 'bot-a', [{ name: skillName(skill.id), digest: 'assembled' }])
    now += PERIOD - 1
    assert.deepEqual(env.knowledge.lifecycle.due('room-1'), [])
    now++
    const [cycle] = env.knowledge.lifecycle.due('room-1')
    assert.equal(cycle.uses, 1)
    assert.equal(cycle.assemblies, 1)
    assert.equal(cycle.frequency, 0.5)
    assert.equal(env.knowledge.lifecycle.due('room-1')[0].id, cycle.id)
    assert.throws(() => env.knowledge.lifecycle.rate('room-1', cycle.id, 'bot-admin', { scope: { score: 0, evidence: 'incomplete' } }), /invalid_quality/)
    assert.equal(env.knowledge.lifecycle.pending('room-1').length, 1)
  } finally { env.cleanup() }
})

test('zero-use high-quality skills score exactly three and remain callable', () => {
  const env = fixture(); let now = 1000; env.knowledge.clock = () => now
  try {
    const skill = seed(env)
    now += PERIOD
    const [cycle] = env.knowledge.lifecycle.due('room-1')
    const rating = env.knowledge.lifecycle.rate('room-1', cycle.id, 'bot-admin', quality(0.5))
    assert.equal(rating.total, 3)
    assert.equal(rating.state, 'active')
    assert.equal(env.knowledge.openSkill('room-1', 'normal', skill.id).lifecycle, 'active')
    assert.deepEqual(env.knowledge.lifecycle.due('room-1'), [])
    assert.equal(env.knowledge.lifecycle.rate('room-1', cycle.id, 'bot-admin', quality(0.5)).total, 3)
    assert.throws(() => env.knowledge.lifecycle.rate('room-1', cycle.id, 'bot-admin', quality(0)), /rating_conflict/)
  } finally { env.cleanup() }
})

test('first low score stays callable in search/open/provider/context; a later high score restores it', async () => {
  const env = fixture(); let now = 1000; env.knowledge.clock = () => now
  try {
    const skill = seed(env)
    now += PERIOD
    const [cycle] = env.knowledge.lifecycle.due('room-1')
    assert.equal(env.knowledge.lifecycle.rate('room-1', cycle.id, 'bot-admin', quality(0)).state, 'forgetting')
    assert.equal(env.knowledge.searchSkills('room-1', 'normal', '页面')[0].lifecycle, 'forgetting')
    assert.equal(env.service.skillOpen({ id: skill.id }, env.memberA).skill.lifecycle, 'forgetting')
    const scope = { room: env.rt.state.rooms['room-1'], bot: env.rt.state.bots['bot-a'], botId: 'bot-a',
      tier: 'normal', scheduler: env.scheduler, knowledge: env.knowledge }
    assert.equal((await knowledgeProvider(async () => scope).list()).length, 1)
    assert.ok((await knowledgeContext(scope)).text.includes('组件布局'))
    assert.equal(env.knowledge.db.prepare('SELECT COUNT(*) AS n FROM skill_uses').get().n, 1)
    const registry = knowledgeProvider(async () => ({ ...scope, sessionId: 'group-a' }))
    const entry = (await registry.list())[0]
    await registry.get(entry)
    await registry.get(entry)
    assert.equal(env.knowledge.db.prepare('SELECT COUNT(*) AS n FROM skill_uses').get().n, 2)
    now += PERIOD
    const [second] = env.knowledge.lifecycle.due('room-1')
    assert.equal(env.knowledge.lifecycle.rate('room-1', second.id, 'bot-admin', quality(0.5)).state, 'active')
    assert.equal(env.knowledge.openSkill('room-1', 'normal', skill.id).lowStreak, 0)
  } finally { env.cleanup() }
})

test('two distinct low cycles retire shared/local access and delete only owned publications, not provenance', async () => {
  const env = fixture(); let now = 1000; env.knowledge.clock = () => now
  try {
    const skill = seed(env)
    const local = env.knowledge.skillPublication('room-1', 'normal', skill.id)
    const shared = env.knowledge.publishShared('room-1', skill.id, 'owner', contentDigest(skill.text), env.knowledge.sourcesDigest('room-1', skill.id))
    const sources = env.knowledge.reviewEvidence('room-1', skill.id)
    for (let i = 0; i < 2; i++) {
      now += PERIOD
      const [cycle] = env.knowledge.lifecycle.due('room-1')
      env.knowledge.lifecycle.rate('room-1', cycle.id, 'bot-admin', quality(0))
    }
    assert.deepEqual(env.knowledge.availableSkills('room-1', 'normal'), [])
    assert.deepEqual(env.knowledge.availableSkills('room-2', 'normal'), [])
    assert.throws(() => env.knowledge.openSkill('room-1', 'normal', skill.id), /skill_not_accessible/)
    env.knowledge.syncPublications()
    assert.equal(existsSync(local.path), false)
    assert.equal(existsSync(shared.path), false)
    assert.deepEqual(env.knowledge.reviewEvidence('room-1', skill.id), sources)
    assert.equal(env.knowledge.lifecycle.history('room-1', skill.id).length, 2)
    env.knowledge.syncPublications()
    assert.equal(existsSync(local.path), false)
  } finally { env.cleanup() }
})

test('retirement preserves manually changed files and reports the cleanup conflict', () => {
  const env = fixture(); let now = 1000; env.knowledge.clock = () => now
  try {
    const skill = seed(env)
    const publication = env.knowledge.skillPublication('room-1', 'normal', skill.id)
    writeFileSync(publication.path, '用户手工修改的技能文件')
    for (let i = 0; i < 2; i++) {
      now += PERIOD
      env.knowledge.lifecycle.rate('room-1', env.knowledge.lifecycle.due('room-1')[0].id, 'bot-admin', quality(0))
    }
    const cleanup = env.knowledge.lifecycle.cleanup()
    assert.ok(cleanup.some(item => item.error === 'publication_conflict'))
    assert.equal(readFileSync(publication.path, 'utf8'), '用户手工修改的技能文件')
    assert.deepEqual(env.knowledge.availableSkills('room-1', 'premium'), [])
  } finally { env.cleanup() }
})

test('restart and long offline gap cannot turn one overdue cycle into two consecutive low scores', () => {
  const env = fixture(); let now = 1000; env.knowledge.clock = () => now
  let reopened
  try {
    seed(env)
    now += PERIOD * 10
    const [cycle] = env.knowledge.lifecycle.due('room-1')
    reopened = new Knowledge(join(env.rt.taskflowHome, 'knowledge.sqlite'), { clock: () => now })
    assert.equal(reopened.lifecycle.due('room-1')[0].id, cycle.id)
    reopened.lifecycle.rate('room-1', cycle.id, 'bot-admin', quality(0))
    assert.deepEqual(reopened.lifecycle.due('room-1'), [])
    now += PERIOD - 1
    assert.deepEqual(reopened.lifecycle.due('room-1'), [])
    now++
    assert.equal(reopened.lifecycle.due('room-1').length, 1)
  } finally { reopened?.close(); env.cleanup() }
})

test('rating requires current source leader, binds exact body, and rejects changed skills without retiring them', () => {
  const env = fixture(); let now = 1000; env.knowledge.clock = () => now
  try {
    const skill = seed(env)
    now += PERIOD
    const [cycle] = env.knowledge.lifecycle.due('room-1')
    assert.throws(() => env.service.skillScore({ cycleId: cycle.id, ratings: quality(0) }, env.memberA), /leader|principal|admin/i)
    env.knowledge.db.prepare('UPDATE candidates SET text=? WHERE id=?').run('changed during review', skill.id)
    assert.throws(() => env.knowledge.lifecycle.rate('room-1', cycle.id, 'bot-admin', quality(0)), /skill_changed/)
    assert.equal(env.knowledge.lifecycle.catalog(skill.id).lifecycle, 'active')
  } finally { env.cleanup() }
})

test('native sweep notifies once and scoring is restricted to the live source principal', async () => {
  const env = fixture()
  const effects = []; const posts = []
  env.rt.ctx.effect = register => effects.push(register())
  env.rt.postToRoom = async (_room, _sender, text) => posts.push(text)
  try {
    const skill = seed(env)
    env.knowledge.db.prepare('UPDATE skill_catalog SET next_due=0 WHERE skill_id=?').run(skill.id)
    install(env.rt)
    await env.rt.taskflowSweep()
    assert.equal(posts.length, 1)
    assert.match(posts[0], /@Chief.*技能五天评分/)
    await env.rt.taskflowSweep()
    assert.equal(posts.length, 1)
    const score = env.rt.teamTools.find(tool => tool.name === 'taskflow_skill_score')
    const pending = JSON.parse(await score.execute({}, { agent: env.admin }))
    assert.equal(pending.success, true)
    assert.equal(pending.pending.length, 1)
    env.rt.state.rooms['room-1'].admin = 'bot-b'
    const denied = JSON.parse(await score.execute({ cycleId: pending.pending[0].id, ratings: quality(0) }, { agent: env.admin }))
    assert.equal(denied.error, 'leader_only')
    const rated = JSON.parse(await score.execute({ cycleId: pending.pending[0].id, ratings: quality(0.5) }, { agent: env.memberB }))
    assert.equal(rated.rating.total, 3)
  } finally { for (const dispose of effects) dispose?.(); env.cleanup() }
})

test('the actual open service counts successful authorized reads and deduplicates a trusted request', () => {
  const env = fixture()
  try {
    const skill = seed(env)
    const request = { agent: env.memberA, callId: 'same-model-call' }
    env.service.skillOpen({ id: skill.id }, request)
    env.service.skillOpen({ id: skill.id }, request)
    assert.equal(env.knowledge.db.prepare('SELECT COUNT(*) AS n FROM skill_uses').get().n, 1)
    env.service.plan({ group: 'IT-create', goal: 'active plan for usage identities',
      children: [{ id: 'work', member: 'Writer', goal: 'work', dependencies: [] }] }, env.admin)
    env.service.skillOpen({ id: skill.id }, { agent: env.memberA, callId: 'plan-call-a' })
    env.service.skillOpen({ id: skill.id }, { agent: env.memberA, callId: 'plan-call-b' })
    env.service.skillOpen({ id: skill.id }, { agent: env.memberA, callId: 'plan-call-a' })
    assert.equal(env.knowledge.db.prepare('SELECT COUNT(*) AS n FROM skill_uses').get().n, 3)
    const file = env.knowledge.skillPublication('room-1', 'normal', skill.id)
    writeFileSync(file.path, '人工改动')
    assert.throws(() => env.service.skillOpen({ id: skill.id }, { agent: env.memberA, requestId: 'failed-request' }), /publication_conflict/)
    assert.equal(env.knowledge.db.prepare('SELECT COUNT(*) AS n FROM skill_uses').get().n, 3)
    assert.throws(() => env.service.skillOpen({ id: skill.id }, env.outsider), /Bot session/)
  } finally { env.cleanup() }
})

test('retirement refuses a linked directory and never deletes its external target', () => {
  const env = fixture(); let now = 1000; env.knowledge.clock = () => now
  let link
  try {
    const skill = seed(env)
    const publication = env.knowledge.skillPublication('room-1', 'normal', skill.id)
    const external = join(env.rt.home, 'manual-skill')
    renameSync(publication.directory, external)
    symlinkSync(external, publication.directory, process.platform === 'win32' ? 'junction' : 'dir')
    link = publication.directory
    for (let i = 0; i < 2; i++) {
      now += PERIOD
      env.knowledge.lifecycle.rate('room-1', env.knowledge.lifecycle.due('room-1')[0].id, 'bot-admin', quality(0))
    }
    assert.equal(env.knowledge.lifecycle.cleanup()[0].error, 'publication_conflict')
    assert.ok(existsSync(join(external, 'SKILL.md')))
  } finally { if (link) rmdirSync(link); env.cleanup() }
})

test('older read-only ledger skills remain unclassified and accessible without schema writes', () => {
  const env = fixture(); let reader
  try {
    const skill = seed(env, [])
    env.knowledge.db.exec('DROP TABLE skill_cycles; DROP TABLE skill_uses; DROP TABLE skill_catalog')
    reader = new Knowledge(join(env.rt.taskflowHome, 'knowledge.sqlite'), { readOnly: true })
    assert.deepEqual(reader.availableSkills('room-1', 'normal')[0].tags, [])
    assert.deepEqual(reader.lifecycle.due('room-1'), [])
    assert.equal(reader.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='skill_catalog'").get().n, 0)
    assert.equal(reader.openSkill('room-1', 'normal', skill.id).id, skill.id)
  } finally { reader?.close(); env.cleanup() }
})

test('read-only publication supports old ledger without method evidence table', () => {
  const env = fixture(); let reader
  try {
    const skill = seed(env, [])
    env.knowledge.skillPublication('room-1', 'normal', skill.id)
    env.knowledge.db.exec('DROP TABLE candidate_method_evidence')
    reader = new Knowledge(join(env.rt.taskflowHome, 'knowledge.sqlite'), { readOnly: true })
    assert.equal(reader.skillPublication('room-1', 'normal', skill.id).metadata.id, skill.id)
  } finally { reader?.close(); env.cleanup() }
})

test('premium skills never enter scoring or automatic retirement and retain their publications', async () => {
  const env = fixture(); let now = 1000; env.knowledge.clock = () => now
  try {
    const skill = seed(env)
    env.knowledge.db.prepare("UPDATE candidates SET tier='premium' WHERE id=?").run(skill.id)
    const publication = env.knowledge.skillPublication('room-1', 'premium', skill.id)
    for (let i = 0; i < 3; i++) {
      now += PERIOD
      assert.deepEqual(env.knowledge.lifecycle.due('room-1'), [])
      assert.deepEqual(env.service.skillScore({}, env.admin).pending, [])
      env.knowledge.syncPublications()
      assert.ok(existsSync(publication.path))
    }
    const retained = env.knowledge.openSkill('room-1', 'premium', skill.id)
    assert.equal(retained.scoringExempt, true)
    assert.equal(retained.nextDue, null)
    assert.equal(retained.lifecycle, 'active')
    const scope = { room: env.rt.state.rooms['room-1'], bot: env.rt.state.bots['bot-admin'], botId: 'bot-admin',
      tier: 'premium', scheduler: env.scheduler, knowledge: env.knowledge }
    assert.equal((await knowledgeProvider(async () => scope).list()).length, 1)
    assert.equal(publication.metadata.scoringExempt, true)
    assert.throws(() => env.service.skillOpen({ id: skill.id }, env.memberA), /skill_not_accessible/)
  } finally { env.cleanup() }
})

test('upgrading a three-day ledger extends ordinary due time only once and invalidates old pending windows', () => {
  const env = fixture(); let now = 1000; env.knowledge.clock = () => now
  let reopened
  try {
    const skill = seed(env)
    const oldPeriod = 3 * 24 * 3600
    const oldDue = now + oldPeriod
    const columns = env.knowledge.db.prepare('PRAGMA table_info(skill_catalog)').all()
    if (columns.some(column => column.name === 'period')) env.knowledge.db.exec('ALTER TABLE skill_catalog DROP COLUMN period')
    env.knowledge.db.prepare('UPDATE skill_catalog SET next_due=? WHERE skill_id=?').run(oldDue, skill.id)
    now = oldDue
    env.knowledge.db.prepare(`INSERT INTO skill_cycles(id,skill_id,room,version,start_at,end_at,uses,assemblies,frequency)
      VALUES(?,?,?,?,?,?,0,0,0)`).run('old-three-day', skill.id, 'room-1', 'old-version', 1000, now)
    reopened = new Knowledge(join(env.rt.taskflowHome, 'knowledge.sqlite'), { clock: () => now })
    assert.equal(reopened.lifecycle.catalog(skill.id).nextDue, 1000 + PERIOD)
    assert.deepEqual(reopened.lifecycle.pending('room-1'), [])
    assert.equal(reopened.db.prepare('SELECT status FROM skill_cycles WHERE id=?').get('old-three-day').status, 'superseded')
    assert.throws(() => reopened.lifecycle.rate('room-1', 'old-three-day', 'bot-admin', quality(0)), /rating_not_pending/)
    assert.deepEqual(reopened.lifecycle.due('room-1'), [])
    reopened.close(); reopened = null
    reopened = new Knowledge(join(env.rt.taskflowHome, 'knowledge.sqlite'), { clock: () => now })
    assert.equal(reopened.lifecycle.catalog(skill.id).nextDue, 1000 + PERIOD)
    now = 1000 + PERIOD - 1
    assert.deepEqual(reopened.lifecycle.due('room-1'), [])
    now++
    assert.equal(reopened.lifecycle.due('room-1').length, 1)
  } finally { reopened?.close(); env.cleanup() }
})

test('upgrading exempts previously forgetting premium skills and rejects their queued rating', () => {
  const env = fixture(); let now = 1000; env.knowledge.clock = () => now
  let reopened
  try {
    const skill = seed(env)
    now += PERIOD
    const [cycle] = env.knowledge.lifecycle.due('room-1')
    env.knowledge.db.prepare("UPDATE skill_catalog SET lifecycle='forgetting',low_streak=1,score=0 WHERE skill_id=?").run(skill.id)
    env.knowledge.db.prepare("UPDATE candidates SET tier='premium' WHERE id=?").run(skill.id)
    reopened = new Knowledge(join(env.rt.taskflowHome, 'knowledge.sqlite'), { clock: () => now })
    assert.deepEqual(reopened.lifecycle.pending('room-1'), [])
    assert.deepEqual(reopened.lifecycle.due(), [])
    assert.throws(() => reopened.lifecycle.rate('room-1', cycle.id, 'bot-admin', quality(0)), /skill_scoring_exempt/)
    const catalog = reopened.lifecycle.catalog(skill.id)
    assert.equal(catalog.lifecycle, 'active')
    assert.equal(catalog.lowStreak, 0)
    assert.equal(catalog.score, null)
    assert.equal(catalog.nextDue, null)
    assert.equal(reopened.lifecycle.history('room-1', skill.id).length, 0)
    reopened.syncPublications()
    assert.ok(existsSync(reopened.skillPublication('room-1', 'premium', skill.id).path))
  } finally { reopened?.close(); env.cleanup() }
})

test('the cleanup retry cannot delete a premium skill left retired by an old writer', () => {
  const env = fixture()
  try {
    const skill = seed(env)
    const publication = env.knowledge.skillPublication('room-1', 'normal', skill.id)
    env.knowledge.db.prepare("UPDATE candidates SET tier='premium' WHERE id=?").run(skill.id)
    env.knowledge.db.prepare("UPDATE skill_catalog SET lifecycle='retired',cleanup_done=0 WHERE skill_id=?").run(skill.id)
    assert.deepEqual(env.knowledge.lifecycle.cleanup(), [])
    assert.ok(existsSync(publication.path))
  } finally { env.cleanup() }
})

test('excellent skills retain five-day scoring while native sweep never notifies premium scoring', async () => {
  const env = fixture(); let now = 1000; env.knowledge.clock = () => now
  const effects = []; const posts = []
  env.rt.ctx.effect = register => effects.push(register())
  env.rt.postToRoom = async (_room, _sender, text) => posts.push(text)
  try {
    const skill = seed(env)
    env.knowledge.db.prepare("UPDATE candidates SET tier='excellent' WHERE id=?").run(skill.id)
    now += PERIOD - 1
    assert.deepEqual(env.knowledge.lifecycle.due('room-1'), [])
    now++
    const [cycle] = env.knowledge.lifecycle.due('room-1')
    assert.equal(cycle.end_at - cycle.start_at, PERIOD)
    assert.equal(env.knowledge.lifecycle.rate('room-1', cycle.id, 'bot-admin', quality(0)).state, 'forgetting')
    env.knowledge.db.prepare("UPDATE candidates SET tier='premium' WHERE id=?").run(skill.id)
    now += PERIOD
    install(env.rt)
    await env.rt.taskflowSweep()
    assert.deepEqual(posts, [])
    assert.deepEqual(env.knowledge.lifecycle.due(), [])
    const guide = await taskflowProvider().get()
    assert.match(guide.content, /五天（120小时）/)
    assert.match(guide.content, /精品技能.*不采用本评分制度/)
    const tool = env.rt.teamTools.find(tool => tool.name === 'taskflow_skill_score')
    assert.match(tool.description, /五天评分/)
    assert.match(tool.description, /精品技能免评分/)
  } finally { for (const dispose of effects) dispose?.(); env.cleanup() }
})
