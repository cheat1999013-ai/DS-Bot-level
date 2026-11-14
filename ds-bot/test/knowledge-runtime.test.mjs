import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { BotState } from '../src/host/taskflow/state.js'
const { knowledgeProvider, installKnowledgeRuntime } = await import(process.env.KNOWLEDGE_RUNTIME_SOURCE ?? '../src/host/taskflow/knowledge-runtime.js')
import { contentDigest } from '../src/host/taskflow/publication.js'
import { fixture } from './taskflow-fixture.mjs'

function seed(env) {
  for (let i = 0; i < 10; i++) env.knowledge.addInsight({ room: 'room-1', planId: `source-${i}`,
    title: '登录排查方法', text: `检查登录请求及错误日志以复核失败原因 ${i}` })
  const draft = env.knowledge.candidates('room-1')[0]
  const text = '先检查登录请求及错误日志，再确认失败原因，保留原始响应。'
  env.knowledge.review(draft.id, { kind: 'bot', reviewer: 'Chief', approved: true })
  env.knowledge.review(draft.id, { kind: 'owner', reviewer: 'human-owner', approved: true, text })
  return env.knowledge.consolidate(draft.id, text)
}

test('real SkillRegistry keeps group knowledge in its Agent scope and rechecks withdrawn access', async () => {
  const env = fixture()
  const ctx = new Context()
  const registry = ctx.plugin(SkillRegistry)
  await registry.await()
  const key = {}
  const scoped = createScope(ctx, key)
  try {
    const skill = seed(env)
    let room = 'room-1'
    await scoped.ctx.plugin({ name: 'test-group-knowledge', inject: ['skills'], apply(c) {
      c.skills.registerProvider(() => knowledgeProvider(async () => ({ room: { id: room }, tier: 'normal', knowledge: env.knowledge })))
    } }).await()
    assert.deepEqual(await ctx.skills.list(), [])
    const rows = await ctx.skills.list({ scope: key })
    assert.equal(rows.length, 1)
    assert.match((await ctx.skills.get(rows[0].name, { scope: key })).content, /保留原始响应/)
    room = 'room-2'
    assert.equal(await ctx.skills.get(rows[0].name, { scope: key }), undefined)
    env.knowledge.publishShared('room-1', skill.id, 'human-owner', contentDigest(skill.text), env.knowledge.sourcesDigest('room-1', skill.id))
    assert.match((await ctx.skills.get(rows[0].name, { scope: key })).content, /保留原始响应/)
    env.knowledge.unpublishShared('room-1', skill.id)
    assert.equal(await ctx.skills.get(rows[0].name, { scope: key }), undefined)
  } finally { await scoped.dispose(); await registry.dispose(); env.cleanup() }
})

test('complete custom prompts retain required knowledge through real assembly and admission refresh', async () => {
  const env = fixture()
  const ctx = new Context()
  const registry = ctx.plugin(SkillRegistry)
  const prompts = ctx.plugin(SystemPrompt)
  await registry.await()
  await prompts.await()
  const key = {}
  const scoped = createScope(ctx, key)
  env.rt.ctx = ctx
  try {
    const skill = seed(env)
    await scoped.ctx.plugin({ name: 'complete-persona', inject: ['systemPrompt'], apply(c) {
      c.systemPrompt.section({ name: 'custom', order: 0, text: 'Exact custom persona.', complete: true })
      c.systemPrompt.suppressRuntimeContext()
    } }).await()
    installKnowledgeRuntime(env.rt, async () => env.service, new BotState(env.rt))
    const agent = { id: 'group-a', session: { id: 'group-a' }, ctx: scoped.ctx }
    const context = { agent, scope: key }
    const assembled = await ctx.systemPrompt.assemble(context)
    assert.deepEqual(assembled.sections.map(section => section.text), ['Exact custom persona.'])
    assert.match(assembled.contexts.find(section => section.name === 'ds-bot-group-knowledge').text, /保留原始响应/)
    const refreshed = ctx.systemPrompt.refreshContext(assembled, context)
    assert.match(refreshed.contexts.find(section => section.name === 'ds-bot-group-knowledge').text, /保留原始响应/)
    env.knowledge.publishShared('room-1', skill.id, 'human-owner', contentDigest(skill.text), env.knowledge.sourcesDigest('room-1', skill.id))
    env.rt.groupOwners.set('group-a', { botId: 'bot-a', roomId: 'room-2' })
    const shared = await ctx.systemPrompt.assemble(context)
    assert.match(shared.contexts.find(section => section.name === 'ds-bot-group-knowledge').text, /保留原始响应/)
    env.knowledge.unpublishShared('room-1', skill.id)
    assert.throws(() => ctx.systemPrompt.refreshContext(shared, context), /skill_access_changed_before_admission/)
  } finally { await scoped.dispose(); await prompts.dispose(); await registry.dispose(); env.cleanup() }
})

test('the DSH assembly waterfall loads approved file bodies and records actual assembled digests', async () => {
  const env = fixture()
  const ctx = new Context()
  const registry = ctx.plugin(SkillRegistry)
  await registry.await()
  const key = {}
  const scoped = createScope(ctx, key)
  env.rt.ctx = ctx
  try {
    const skill = seed(env)
    const invoked = []
    env.rt.noteTaskflowSkill = (...args) => invoked.push(args)
    installKnowledgeRuntime(env.rt, async () => env.service, new BotState(env.rt))
    const agent = { id: 'group-a', session: { id: 'group-a' }, ctx: scoped.ctx }
    const base = { sections: [{ name: 'existing', text: 'existing prompt' }], contexts: [], variables: {} }
    const result = await ctx.waterfall('system-prompt/assemble', base, { agent }, async () => base)
    const block = result.contexts.find(section => section.name === 'ds-bot-group-knowledge')
    assert.match(block.text, /保留原始响应/)
    assert.match(block.text, /taskflow_sleep_note/)
    for (const heading of ['做了什么', '为什么这么做', '里面的错误怎么避免', '要在下次任务中做的更好我需要什么']) assert.ok(block.text.includes(`## ${heading}`))
    assert.equal(block.interpolate, false)
    const records = env.knowledge.db.prepare('SELECT room,bot,name,digest FROM skill_loads WHERE session=?').all('group-a')
    assert.equal(records.length, 2)
    assert.deepEqual(invoked, [], 'automatic prompt loading must not be reported as a skill invocation')
    assert.ok(records.every(row => row.room === 'room-1' && row.bot === 'bot-a' && row.digest.length === 64))
    assert.equal((await ctx.skills.list({ scope: key })).length, 1)
    assert.deepEqual(await ctx.skills.list(), [])
    env.rt.state.rooms['room-1'].members = ['bot-admin', 'bot-b']
    const next = await ctx.waterfall('system-prompt/assemble', base, { agent }, async () => base)
    assert.equal(next.contexts.some(section => section.name === 'ds-bot-group-knowledge'), false)
    assert.equal(await ctx.skills.get((await knowledgeProvider(async () => ({ room: {id:'room-1'}, tier:'normal', knowledge:env.knowledge })).list())[0].name, {scope:key}), undefined)
    assert.equal(env.knowledge.db.prepare('SELECT COUNT(*) AS n FROM skill_loads').get().n, 2)
    assert.equal(skill.status, 'approved')
  } finally { await scoped.dispose(); await registry.dispose(); env.cleanup() }
})
