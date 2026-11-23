import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
const { install } = await import(process.env.TASKFLOW_HOST_SOURCE ?? '../src/host/taskflow.js')
import { mentionsIn } from '../src/host/groups.js'
import { taskflowProvider } from '../src/host/taskflow-skills.js'
import { fixture } from './taskflow-fixture.mjs'
import { contentDigest } from '../src/host/taskflow/publication.js'

test('repeated skill calls do not erase another skill already used by this bot', async () => {
  const env = fixture(), effects = []
  env.rt.ctx.effect = register => effects.push(register())
  env.rt.ctx.inject = (_services, register) => register({ skills: { registerProvider() {} } })
  try {
    install(env.rt)
    env.rt.noteTaskflowSkill('room-1', 'bot-a', 'first-unassigned', 1000000)
    for (let index = 0; index < 25; index++) env.rt.noteTaskflowSkill('room-1', 'bot-a', 'repeated-unassigned', 1001000 + index)
    assert.deepEqual((await env.rt.taskflowView({ room: 'room-1' })).members['bot-a'].usedSkills,
      ['repeated-unassigned', 'first-unassigned'])
  } finally {
    for (const dispose of effects) dispose?.()
    env.cleanup()
  }
})

for (const output of ['member', 'observed']) test(`unassigned skill calls reach the ${output} board projection without leaking another group or task`, async () => {
  const env = fixture(), effects = []
  env.rt.ctx.effect = register => effects.push(register())
  env.rt.ctx.inject = (_services, register) => register({ skills: { registerProvider() {} } })
  env.rt.state.rooms['room-1'].log = [
    { seq: 1, botId: 'bot-admin', text: '@Writer 请撰写第一篇', at: 1000 },
    { seq: 2, botId: 'bot-a', text: '收到第一篇任务', at: 1001 },
    { seq: 3, botId: 'bot-admin', text: '@Writer 请撰写第二篇', at: 1010 },
  ]
  try {
    install(env.rt)
    env.rt.noteTaskflowSkill('room-1', 'bot-a', 'before-task', 999000)
    env.rt.noteTaskflowSkill('room-1', 'bot-a', 'first-unassigned', 1005000)
    env.rt.noteTaskflowSkill('room-1', 'bot-a', 'second-unassigned', 1012000)
    env.rt.noteTaskflowSkill('room-2', 'bot-a', 'foreign-group', 1013000)
    const view = await env.rt.taskflowView({ room: 'room-1' })
    assert.deepEqual(view.members['bot-a'].skills, [])
    if (output === 'member') assert.deepEqual(view.members['bot-a'].usedSkills,
      ['second-unassigned', 'first-unassigned', 'before-task'])
    else {
      assert.deepEqual(view.observedTasks.find(card => card.source.seq === 1).usedSkills, ['first-unassigned'])
      assert.deepEqual(view.observedTasks.find(card => card.source.seq === 3).usedSkills, ['second-unassigned'])
    }
  } finally {
    for (const dispose of effects) dispose?.()
    env.cleanup()
  }
})

test('native DS Bot registers 27 scoped tools and serves its own taskflow state', async () => {
  const env = fixture()
  const effects = []
  const posts = []
  const skills = []
  env.rt.ctx.effect = register => effects.push(register())
  env.rt.ctx.inject = (_services, register) => register({ skills: { registerProvider: factory => skills.push(factory()) } })
  env.rt.postTaskToRoom = async (room, sender, text, extra) => posts.push({ room, sender, text, extra })
  env.rt.state.capabilities = { items: { draft: { kind: 'skill' }, suite: { kind: 'pack', items: ['draft'] } } }
  env.rt.state.bots['bot-a'].capabilities = ['suite']
  env.rt.state.bots['bot-a'].avatar = { shape: 'fox', image: 'data:image/png;base64,AA==' }
  env.rt.state.bots['bot-a'].color = 'violet'
  env.rt.workView = () => ({ 'bot-a': { roomId: 'room-1', tool: 'write_file' },
    'bot-b': { roomId: 'room-2', tool: 'unrelated' } })
  try {
    install(env.rt)
    assert.equal(skills.length, 1)
    assert.equal((await skills[0].list())[0].name, 'taskflow')
    assert.match((await skills[0].get()).content, /taskflow_dispatch/)
    assert.deepEqual(env.rt.teamTools.map(tool => tool.name), [
      'taskflow_members', 'taskflow_plan', 'taskflow_dispatch', 'taskflow_plans', 'taskflow_status', 'taskflow_results',
      'taskflow_accept', 'taskflow_reject', 'taskflow_retry', 'taskflow_verify', 'taskflow_confirm',
      'taskflow_submit', 'taskflow_finish', 'taskflow_cancel', 'taskflow_sleep_note',
      'taskflow_sleep_pending', 'taskflow_sleep_consolidate', 'taskflow_memory_search', 'taskflow_memory_open',
      'taskflow_skill_insights', 'taskflow_skill_propose_method', 'taskflow_skill_candidates', 'taskflow_skill_review', 'taskflow_skill_consolidate',
      'taskflow_skill_publish', 'taskflow_skill_unpublish',
      'taskflow_skill_level', 'taskflow_skill_search', 'taskflow_skill_open', 'taskflow_skill_score',
      ...JSON.parse(process.env.TASKFLOW_EXTRA_TOOLS ?? '["skill_index_search","skill_index_status","skill_index_classify","skill_index_merge"]'),
    ])
    assert.equal((await env.rt.taskflowView()).plan, null)
    const tool = name => env.rt.teamTools.find(item => item.name === name)
    const planned = JSON.parse(await tool('taskflow_plan').execute({ group: 'IT-create', goal: 'native goal',
      children: [{ id: 'write', member: 'Writer', goal: 'do it', dependencies: [] }] }, { agent: env.admin }))
    assert.equal(planned.success, true)
    assert.equal(planned.plan.goal, 'native goal')
    const denied = JSON.parse(await tool('taskflow_plan').execute({ group: 'IT-create', goal: 'fake',
      children: [{ id: 'fake', member: 'Writer', goal: 'fake', dependencies: [] }] }, { agent: env.memberA }))
    assert.equal(denied.error, 'leader_only')
    const dispatch = JSON.parse(await tool('taskflow_dispatch').execute({ group: 'IT-create' }, { agent: env.admin }))
    assert.equal(dispatch.sent.length, 1)
    assert.equal(env.rt.taskflowIsQuietWorker('room-1', 'bot-a'), true)
    assert.equal(posts[0].sender.name, 'Chief')
    assert.equal(posts[0].extra.progress, true)
    assert.match(posts[0].text, /^@Writer \[Taskflow/)
    const called = mentionsIn(posts[0].text, Object.values(env.rt.state.bots)).found
    assert.deepEqual(called.map(bot => bot.id), ['bot-a'])
    const view = await env.rt.taskflowView({ room: 'room-1' })
    assert.equal(view.plan.cards[0].state, 'running')
    assert.equal(view.plan.goal, 'native goal')
    assert.equal(view.plan.cards[0].member, 'bot-a')
    assert.equal(view.members['bot-a'].name, 'Writer')
    assert.equal(view.members['bot-a'].id, 'bot-a')
    assert.deepEqual(view.members['bot-a'].avatar, { shape: 'fox', image: 'data:image/png;base64,AA==' })
    assert.equal(view.members['bot-a'].color, 'violet')
    assert.equal((await env.rt.taskflowView({ all: true })).members['bot-a'].avatar.shape, 'fox')
    assert.equal(view.members['bot-a'].model, 'm')
    assert.deepEqual(view.members['bot-a'].skills, ['draft'])
    assert.equal(view.members['bot-a'].tool, 'write_file')
    assert.equal(view.members['bot-b'].tool, null)
    assert.deepEqual(view.plan.cards[0].usedSkills, [])
    env.rt.noteTaskflowSkill('room-2', 'bot-a', 'other')
    env.rt.noteTaskflowSkill('room-1', 'bot-b', 'other')
    env.rt.noteTaskflowSkill('room-1', 'bot-a', 'draft')
    env.rt.noteTaskflowSkill('room-1', 'bot-a', 'another-skill')
    assert.deepEqual((await env.rt.taskflowView({ room: 'room-1' })).plan.cards[0].usedSkills, ['another-skill', 'draft'])
    assert.equal(posts.length, 1)
    const found = JSON.parse(await tool('taskflow_memory_search').execute({ query: 'do it' }, { agent: env.memberA }))
    assert.equal(found.matches.length, 1)
    const opened = JSON.parse(await tool('taskflow_memory_open').execute({ keyword: found.matches[0].keyword }, { agent: env.memberA }))
    assert.match(opened.node.content, /do it/)
    assert.equal(posts[0].text.includes(found.matches[0].keyword), false)
    const own = JSON.parse(await tool('taskflow_memory_open').execute({ keyword: found.matches[0].keyword }, { agent: { session: { id: 'own-a' } } }))
    assert.equal(own.error, 'group_session_required')
    assert.deepEqual(env.rt.state.rooms['room-1'].sessions,
      { 'bot-admin': 'group-admin', 'bot-a': 'group-a', 'bot-b': 'group-b' })
    const submitted = JSON.parse(await tool('taskflow_submit').execute({ planId: planned.plan.plan_id,
      cardId: 'write', result: 'written' }, { agent: env.memberA }))
    assert.equal(submitted.observed.status, 'settled')
    const awaiting = await env.rt.taskflowView({ room: 'room-1' })
    assert.equal(awaiting.plan.cards[0].result, 'written')
    assert.equal(awaiting.plan.cards[0].evidence, undefined)
    const accepted = JSON.parse(await tool('taskflow_accept').execute({ planId: planned.plan.plan_id,
      cardId: 'write' }, { agent: env.admin }))
    assert.equal(accepted.accepted.state, 'verified')
    assert.equal(env.rt.taskflowIsQuietWorker('room-1', 'bot-a'), false)
    assert.match((await env.rt.taskflowView({ room: 'room-1' })).plan.cards[0].evidence, /^principal-result:/)
    await assert.rejects(() => env.rt.taskflowView({ room: 'other-room' }), /Unknown group/)
    const unrelated = JSON.parse(await tool('taskflow_status').execute({}, { agent: env.outsider }))
    assert.equal(unrelated.error, 'not_a_bot_session')
  } finally {
    for (const dispose of effects) dispose?.()
    assert.doesNotThrow(() => env.rt.taskflowIsQuietWorker('room-1', 'bot-a'))
    env.cleanup()
  }
})

test('the owner page decides before dispatch and stores its note on the original card', async () => {
  const env = fixture()
  const effects = []
  const posts = []
  env.rt.ctx.effect = register => effects.push(register())
  env.rt.ctx.inject = (_services, register) => register({ skills: { registerProvider: () => {} } })
  env.rt.postTaskToRoom = async (_room, _sender, text) => posts.push(text)
  try {
    install(env.rt)
    const planTool = env.rt.teamTools.find(tool => tool.name === 'taskflow_plan')
    const dispatchTool = env.rt.teamTools.find(tool => tool.name === 'taskflow_dispatch')
    const planned = JSON.parse(await planTool.execute({ group: 'IT-create', goal: 'two gated tasks',
      children: [
        { id: 'a', member: 'Writer', goal: 'publish', dependencies: [], confirm: 'Publish now?' },
        { id: 'b', member: 'Reviewer', goal: 'spend', dependencies: [], confirm: 'Spend now?' },
      ] }, { agent: env.admin }))
    const planId = planned.plan.plan_id
    assert.deepEqual(JSON.parse(await dispatchTool.execute({ planId }, { agent: env.admin })).sent, [])
    assert.equal(posts.length, 0)
    const before = await env.rt.taskflowView({ room: 'room-1' })
    assert.deepEqual(before.plan.pending_confirmations.map(item => item.card_id), ['a', 'b'])
    await assert.rejects(() => env.rt.taskflowPreflight({ room: 'room-2', planId, cardId: 'a', decision: 'approve' }), /another group/)
    await env.rt.taskflowPreflight({ room: 'room-1', planId, cardId: 'b', decision: 'reject', note: 'Not now' })
    assert.match(posts[0], /^@Chief/)
    const approved = await env.rt.taskflowPreflight({ room: 'room-1', planId, cardId: 'a', decision: 'approve', note: 'Use a draft first' })
    assert.equal(approved.dispatch.sent.length, 1)
    assert.match(posts[1], /^@Writer/)
    const after = await env.rt.taskflowView({ room: 'room-1' })
    assert.equal(after.plan.cards.find(card => card.id === 'a').state, 'running')
    assert.deepEqual(after.plan.cards.find(card => card.id === 'a').comments.map(item => item.text), ['Use a draft first'])
    assert.equal(after.plan.cards.find(card => card.id === 'b').state, 'pending')
    await assert.rejects(() => env.rt.taskflowPreflight({ room: 'room-1', planId, cardId: 'a', decision: 'approve' }), /card_not_waiting|running/)
  } finally {
    for (const dispose of effects) dispose?.()
    env.cleanup()
  }
})

test('a worker leaving a room fails its live card and alerts the principal', async () => {
  const env = fixture()
  const effects = []
  const posts = []
  env.rt.ctx.effect = register => effects.push(register())
  env.rt.ctx.inject = (_services, register) => register({ skills: { registerProvider: () => {} } })
  env.rt.postTaskToRoom = async (_room, _sender, text) => posts.push(text)
  try {
    install(env.rt)
    const planTool = env.rt.teamTools.find(tool => tool.name === 'taskflow_plan')
    const dispatchTool = env.rt.teamTools.find(tool => tool.name === 'taskflow_dispatch')
    const planned = JSON.parse(await planTool.execute({ group: 'IT-create', goal: 'write and review',
      children: [
        { id: 'write', member: 'Writer', goal: 'write', dependencies: [] },
        { id: 'review', member: 'Reviewer', goal: 'review', dependencies: ['write'] },
      ] }, { agent: env.admin }))
    const planId = planned.plan.plan_id
    await dispatchTool.execute({ planId }, { agent: env.admin })
    const affected = await env.rt.taskflowMemberLeft('room-1', 'bot-a')
    assert.deepEqual(affected.map(item => item.id), ['write'])
    assert.equal(env.scheduler.cardView(planId, 'write').state, 'failed')
    assert.equal(env.scheduler.cardView(planId, 'review').state, 'cancelled')
    env.rt.postToRoom = async (_room, _sender, text) => posts.push(text)
    await env.rt.taskflowMemberLeftNotice('room-1', 'bot-a', affected)
    assert.match(posts.at(-1), /^@Chief/)
  } finally {
    for (const dispose of effects) dispose?.()
    env.cleanup()
  }
})

test('sweep preserves a result submitted while stopping a stalled worker', async () => {
  const env = fixture()
  const effects = []
  env.rt.ctx.effect = register => effects.push(register())
  env.rt.postTaskToRoom = async () => {}
  try {
    install(env.rt)
    const tool = name => env.rt.teamTools.find(item => item.name === name)
    const planned = JSON.parse(await tool('taskflow_plan').execute({ group: 'IT-create', goal: 'review later',
      children: [{ id: 'write', member: 'Writer', goal: 'write', dependencies: [] }],
    }, { agent: env.admin }))
    const planId = planned.plan.plan_id
    await tool('taskflow_dispatch').execute({ planId }, { agent: env.admin })
    env.scheduler.db.prepare('UPDATE cards SET started_at=? WHERE plan_id=? AND card_id=?')
      .run(Date.now() / 1000 - 3601, planId, 'write')
    env.rt.stopMemberWork = async () => {
      const result = JSON.parse(await tool('taskflow_submit').execute({ planId, cardId: 'write', result: 'done' },
        { agent: env.memberA }))
      assert.equal(result.observed.status, 'settled')
    }
    assert.deepEqual(await env.rt.taskflowSweep(), [])
    assert.equal(env.scheduler.cardView(planId, 'write').state, 'running')
    assert.equal(env.scheduler.resultPayload(planId, 'write').text, 'done')
  } finally {
    for (const dispose of effects) dispose?.()
    env.cleanup()
  }
})

test('bundled taskflow skill describes the native ledger', async () => {
  const provider = taskflowProvider()
  assert.equal((await provider.list())[0].provider, 'ds-bot-taskflow')
  assert.match((await provider.get()).content, /taskflow_finish/)
})

test('native sharing approval displays source bodies and acceptance evidence', async () => {
  const env = fixture()
  const effects = []
  const requests = []
  env.rt.ctx.effect = register => effects.push(register())
  env.rt.ctx.get = name => name === 'approval' ? { request: async params => {
    requests.push(params)
    return 'allowed-once'
  } } : undefined
  try {
    for (let i = 0; i < 10; i++) env.knowledge.addInsight({ room: 'room-1', planId: `public-source-${i}`,
      title: '可审核的来源标题', text: `可审核的来源正文和操作步骤，逐项复核日志与验收结果 ${i}`, acceptance: '逐卡验收证据：日志检查通过' })
    const sources = Array.from({length:10}, (_, i) => ({ id:`public-source-${i}`, step:'可审核的来源正文和操作步骤', validation:'逐项复核日志与验收结果' }))
    const preview = env.knowledge.proposeMethod('room-1', '可审核的来源标题', sources)
    const draft = env.knowledge.proposeMethod('room-1', '可审核的来源标题', sources, preview.digest)
    env.knowledge.review(draft.id, { kind: 'bot', reviewer: 'bot-admin', approved: true })
    env.knowledge.review(draft.id, { kind: 'owner', reviewer: 'human-owner', approved: true, text: '共享检查流程' })
    env.knowledge.consolidate(draft.id, '共享检查流程')
    install(env.rt)
    const tool = env.rt.teamTools.find(item => item.name === 'taskflow_skill_publish')
    const result = JSON.parse(await tool.execute({ id: draft.id }, { agent: env.admin }))
    assert.equal(result.success, true)
    assert.equal(requests.length, 1)
    assert.match(requests[0].reason, /可审核的来源标题/)
    assert.match(requests[0].reason, /可审核的来源正文/)
    assert.match(requests[0].reason, /逐卡验收证据：日志检查通过/)
    assert.match(requests[0].reason, /Evidence digest:/)
  } finally { for (const dispose of effects) dispose?.(); env.cleanup() }
})

test('native higher-tier sharing displays the parent Bot and owner reviews', async () => {
  const env = fixture()
  const effects = []
  const requests = []
  env.rt.ctx.effect = register => effects.push(register())
  env.rt.ctx.get = name => name === 'approval' ? { request: async params => {
    requests.push(params)
    return 'allowed-once'
  } } : undefined
  try {
    install(env.rt)
    for (const [tier, parentTier] of [['excellent', 'normal'], ['premium', 'excellent']]) {
      const id = `sharing-${tier}`
      env.knowledge.db.prepare('INSERT INTO candidates(id,room,tier,title,at) VALUES(?,?,?,?,?)')
        .run(id, 'room-1', tier, `共享 ${tier}`, 1)
      for (let i = 0; i < 10; i++) {
        const source = `parent-${tier}-${i}`
        const body = `上级技能正文 ${tier} ${i}`
        env.knowledge.db.prepare('INSERT INTO candidates(id,room,tier,title,text,status,bot_review,owner_review,owner_text_hash,at) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(source, 'room-1', parentTier, '上级来源技能', body, 'approved', '上级机器人审核人', '上级人工审核人', contentDigest(body), 1)
        env.knowledge.db.prepare('INSERT INTO candidate_sources(room,tier,source_id,candidate_id) VALUES(?,?,?,?)')
          .run('room-1', tier, source, id)
      }
      const text = `共享上级审核证据 ${tier}`
      env.knowledge.review(id, { kind: 'bot', reviewer: 'bot-admin', approved: true })
      env.knowledge.review(id, { kind: 'owner', reviewer: 'human-owner', approved: true, text })
      env.knowledge.consolidate(id, text)
      const tool = env.rt.teamTools.find(item => item.name === 'taskflow_skill_publish')
      assert.equal(JSON.parse(await tool.execute({ id }, { agent: env.admin })).success, true)
      const reason = requests.at(-1).reason
      assert.match(reason, /上级机器人审核人/)
      assert.match(reason, /上级人工审核人/)
      assert.match(reason, /批准正文摘要/)
    }
  } finally { for (const dispose of effects) dispose?.(); env.cleanup() }
})

test('the taskflow view returns each member level from the selected group', async () => {
  const env = fixture()
  const effects = []
  env.rt.ctx.effect = register => effects.push(register())
  try {
    const reward = env.scheduler.db.prepare('INSERT INTO bot_rewards(room,plan_id,bot_id,at) VALUES(?,?,?,?)')
    for (let i = 0; i < 160; i++) reward.run('room-1', `fixture-one-${i}`, 'bot-a', 1)
    for (let i = 0; i < 270; i++) reward.run('room-2', `fixture-two-${i}`, 'bot-a', 1)
    install(env.rt)
    const first = await env.rt.taskflowView({ room: 'room-1' })
    const second = await env.rt.taskflowView({ room: 'room-2' })
    assert.deepEqual(first.members['bot-a'].level, { count: 160, level: 16, tier: 'excellent' })
    assert.deepEqual(second.members['bot-a'].level, { count: 270, level: 27, tier: 'premium' })
    assert.deepEqual(first.members['bot-admin'].level, { count: 0, level: 0, tier: 'normal' })
  } finally { for (const dispose of effects) dispose?.(); env.cleanup() }
})

test('an old read-only ledger reports unknown levels without inventing zero or migrating', async () => {
  const env = fixture()
  const effects = []
  env.rt.ctx.effect = register => effects.push(register())
  try {
    env.scheduler.db.exec('DROP TABLE bot_rewards')
    env.rt.readOnly = () => 'Another host owns writes'
    install(env.rt)
    const view = await env.rt.taskflowView({ room: 'room-1' })
    assert.equal(view.members['bot-a'].level, null)
    assert.equal(env.scheduler.db.prepare("SELECT name FROM sqlite_master WHERE name='bot_rewards'").get(), undefined)
  } finally { for (const dispose of effects) dispose?.(); env.cleanup() }
})

test('native verification requires user approval for the exact stored command', async () => {
  const env = fixture()
  const effects = []
  env.rt.ctx.effect = register => effects.push(register())
  try {
    install(env.rt)
    const tool = name => env.rt.teamTools.find(item => item.name === name)
    const planned = JSON.parse(await tool('taskflow_plan').execute({ group: 'IT-create', goal: 'check',
      children: [{ id: 'check', member: 'Writer', goal: 'check', dependencies: [] }],
      testRequiredCards: ['check'], testChecks: { check: { command: 'node -e "process.exit(0)"', workdir: env.rt.home } },
    }, { agent: env.admin }))
    assert.equal(planned.success, true)
    const planId = planned.plan.plan_id
    await tool('taskflow_dispatch').execute({ planId }, { agent: env.admin })
    await tool('taskflow_submit').execute({ planId, cardId: 'check', result: 'ready' }, { agent: env.memberA })
    const verify = () => tool('taskflow_verify').execute({ planId, cardId: 'check' }, { agent: env.admin })
    const unavailable = JSON.parse(await verify())
    assert.equal(unavailable.success, false)
    assert.match(unavailable.message, /approval is unavailable/)
    assert.equal(env.scheduler.testStatus(planId, 'check').run, null)
    const requests = []
    env.rt.ctx.get = name => name === 'approval' ? { request: async params => {
      requests.push(params)
      return requests.length === 1 ? 'rejected' : 'allowed-once'
    } } : undefined
    const rejected = JSON.parse(await verify())
    assert.equal(rejected.success, false)
    assert.equal(env.scheduler.testStatus(planId, 'check').run, null)
    assert.match(requests[0].reason, /node -e "process.exit\(0\)"/)
    assert.match(requests[0].reason, /Working directory:/)
    const allowed = JSON.parse(await verify())
    assert.equal(allowed.test.run.state, 'passed')
    assert.equal(requests.length, 2)
  } finally {
    for (const dispose of effects) dispose?.()
    env.cleanup()
  }
})

test('a legacy in-flight confirmation still requires approval and preserves a rejected decision as pending', async () => {
  const env = fixture()
  const effects = []
  env.rt.ctx.effect = register => effects.push(register())
  env.rt.postTaskToRoom = async () => {}
  try {
    install(env.rt)
    const tool = name => env.rt.teamTools.find(item => item.name === name)
    const planned = JSON.parse(await tool('taskflow_plan').execute({ group: 'IT-create', goal: 'confirm',
      children: [{ id: 'publish', member: 'Writer', goal: 'publish', dependencies: [] }],
    }, { agent: env.admin }))
    const planId = planned.plan.plan_id
    await tool('taskflow_dispatch').execute({ planId }, { agent: env.admin })
    env.scheduler.db.prepare('INSERT INTO card_gates(plan_id,card_id,question) VALUES(?,?,?)').run(planId, 'publish', 'Legacy approval?')
    await tool('taskflow_submit').execute({ planId, cardId: 'publish', result: 'ready for publication' }, { agent: env.memberA })
    const confirm = () => tool('taskflow_confirm').execute({ planId, cardId: 'publish', decision: 'approve' }, { agent: env.admin })
    assert.equal(JSON.parse(await confirm()).success, false)
    assert.equal(env.scheduler.pendingConfirmations(planId).length, 1)
    const requests = []
    env.rt.ctx.get = name => name === 'approval' ? { request: async params => {
      requests.push(params)
      return requests.length === 1 ? 'rejected' : 'allowed-once'
    } } : undefined
    assert.equal(JSON.parse(await confirm()).success, false)
    assert.equal(env.scheduler.pendingConfirmations(planId).length, 1)
    assert.match(requests[0].reason, /ready for publication/)
    assert.match(requests[0].reason, /as approve/)
    assert.equal(JSON.parse(await confirm()).decision.decision, 'approve')
    assert.equal(env.scheduler.pendingConfirmations(planId).length, 0)
  } finally {
    for (const dispose of effects) dispose?.()
    env.cleanup()
  }
})

test('the owner page confirms the exact legacy submitted result and rejects stale or foreign decisions', async () => {
  const env = fixture()
  const effects = []
  const posts = []
  env.rt.ctx.effect = register => effects.push(register())
  env.rt.postTaskToRoom = async (_room, _sender, text) => posts.push(text)
  try {
    install(env.rt)
    const tool = name => env.rt.teamTools.find(item => item.name === name)
    const planned = JSON.parse(await tool('taskflow_plan').execute({ group: 'IT-create', goal: 'confirm',
      children: [{ id: 'publish', member: 'Writer', goal: 'publish', dependencies: [] }],
    }, { agent: env.admin }))
    const planId = planned.plan.plan_id
    await tool('taskflow_dispatch').execute({ planId }, { agent: env.admin })
    env.scheduler.db.prepare('INSERT INTO card_gates(plan_id,card_id,question) VALUES(?,?,?)').run(planId, 'publish', 'Legacy approval?')
    await tool('taskflow_submit').execute({ planId, cardId: 'publish', result: 'ready for publication' }, { agent: env.memberA })
    const view = await env.rt.taskflowView({ room: 'room-1' })
    const [pending] = view.plan.pending_confirmations
    assert.equal(pending.stage, 'after_result')
    assert.equal(pending.result, 'ready for publication')
    const request = { room: 'room-1', planId, cardId: 'publish', decision: 'approve', terminal: pending.terminal }
    await assert.rejects(env.rt.taskflowResultConfirmation({ ...request, terminal: 'stale' }), /changed/)
    await assert.rejects(env.rt.taskflowResultConfirmation({ ...request, room: 'room-2' }), /another group/)
    assert.equal(env.scheduler.pendingConfirmations(planId).length, 1)
    assert.equal((await env.rt.taskflowResultConfirmation(request)).decided.decision, 'approve')
    assert.equal(env.scheduler.pendingConfirmations(planId).length, 0)
    assert.match(posts.at(-1), /^@Chief/)
  } finally {
    for (const dispose of effects) dispose?.()
    env.cleanup()
  }
})

test('an approval for an earlier result cannot confirm a different terminal', async () => {
  const env = fixture()
  const effects = []
  env.rt.ctx.effect = register => effects.push(register())
  try {
    install(env.rt)
    const tool = name => env.rt.teamTools.find(item => item.name === name)
    const planned = JSON.parse(await tool('taskflow_plan').execute({ group: 'IT-create', goal: 'confirm',
      children: [{ id: 'publish', member: 'Writer', goal: 'publish', dependencies: [] }],
    }, { agent: env.admin }))
    const planId = planned.plan.plan_id
    await tool('taskflow_dispatch').execute({ planId }, { agent: env.admin })
    env.scheduler.db.prepare('INSERT INTO card_gates(plan_id,card_id,question) VALUES(?,?,?)').run(planId, 'publish', 'Legacy approval?')
    await tool('taskflow_submit').execute({ planId, cardId: 'publish', result: 'first result' }, { agent: env.memberA })
    const current = env.scheduler.resultPayload(planId, 'publish')
    env.rt.ctx.get = name => name === 'approval' ? { request: async () => {
      env.scheduler.db.prepare('UPDATE results SET terminal_event_id=? WHERE plan_id=? AND card_id=?')
        .run('changed-terminal', planId, 'publish')
      return 'allowed-once'
    } } : undefined
    const answer = JSON.parse(await tool('taskflow_confirm').execute({ planId, cardId: 'publish', decision: 'approve' }, { agent: env.admin }))
    assert.equal(answer.error, 'result_changed_during_confirmation')
    assert.notEqual(env.scheduler.resultPayload(planId, 'publish').terminal_event_id, current.terminal_event_id)
    assert.equal(env.scheduler.confirmations(planId).length, 0)
  } finally {
    for (const dispose of effects) dispose?.()
    env.cleanup()
  }
})

test('native tool refuses writes while DS Bot is read-only', async () => {
  const env = fixture()
  try {
    env.rt.readOnly = () => 'Another host owns the team'
    install(env.rt)
    const result = JSON.parse(await env.rt.teamTools.find(item => item.name === 'taskflow_plan').execute({ goal: 'blocked', children: [] }, { agent: env.admin }))
    assert.equal(result.success, false)
    assert.match(result.message, /Another host/)
  } finally { env.cleanup() }
})

test('read-only DS Bot can show the persisted board without modifying the ledger', async () => {
  const env = fixture()
  const effects = []
  env.rt.ctx.effect = register => effects.push(register())
  try {
    env.scheduler.createPlan({ planId: 'saved', room: 'room-1', principal: 'bot-admin', goal: 'persisted goal',
      cards: [{ id: 'write', member: 'bot-a', goal: 'do it', dependencies: [] }] })
    const before = env.scheduler.events('saved').length
    env.rt.readOnly = () => 'Another host owns the team'
    install(env.rt)
    const board = await env.rt.taskflowView({ room: 'room-1' })
    assert.equal(board.plan.goal, 'persisted goal')
    const recent = JSON.parse(await env.rt.teamTools.find(tool => tool.name === 'taskflow_plans')
      .execute({ group: 'IT-create' }, { agent: env.admin }))
    assert.equal(recent.success, true)
    assert.deepEqual(recent.plans.map(plan => plan.plan_id), ['saved'])
    assert.equal(env.scheduler.events('saved').length, before)
  } finally {
    for (const dispose of effects) dispose?.()
    env.cleanup()
  }
})

test('read-only DS Bot without a ledger shows an empty board', async () => {
  const env = fixture()
  const effects = []
  env.rt.ctx.effect = register => effects.push(register())
  try {
    env.rt.home = join(env.rt.home, 'unused')
    env.rt.taskflowHome = join(env.rt.home, 'plugin-data', 'hermes-bot-taskflow')
    env.rt.readOnly = () => 'Another host owns the team'
    install(env.rt)
    const board = await env.rt.taskflowView({ room: 'room-1' })
    assert.equal(board.plan, null)
    assert.equal(board.room.id, 'room-1')
    const result = JSON.parse(await env.rt.teamTools.find(tool => tool.name === 'taskflow_status')
      .execute({ group: 'IT-create' }, { agent: env.admin }))
    assert.equal(result.error, 'no_current_plan')
  } finally {
    for (const dispose of effects) dispose?.()
    env.cleanup()
  }
})
