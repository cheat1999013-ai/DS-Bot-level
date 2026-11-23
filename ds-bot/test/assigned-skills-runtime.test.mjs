import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import { install } from '../src/host/assigned-skills.js'

async function fixture(t) {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry).await()
  await ctx.plugin(SystemPrompt).await()
  const items = {
    writing: { name: 'writing', kind: 'skill', description: 'Write reports', content: 'SELECTED BODY: verify sources before writing.' },
    drawing: { name: 'drawing', kind: 'skill', description: 'Draw pictures', content: 'UNSELECTED BODY: select a drawing medium.' },
  }
  const bot = { id: 'worker', capabilities: ['writing', 'drawing'] }
  const owned = new Set(['group-worker', 'own-worker'])
  const loaded = []
  const room = { id: 'group', goal: { id: 'goal-1', status: 'active', objective: 'Create a report', acceptance: 'Verified', constraints: [], current: 0,
    stages: [{ id: 'stage-1', title: 'Draft', acceptance: 'Sources', reworks: 0, tasks: [{ botId: 'worker', task: 'Write report' }] }] } }
  const rt = { ctx, state: { capabilities: { items } }, teamTools: [], load: async () => {}, roomOf: id => id === room.id ? room : undefined,
    isBotSession: id => owned.has(id), selfOf: id => owned.has(id) ? bot.id : undefined,
    botOf: id => id === bot.id ? bot : undefined, expandCapabilities: names => new Set(names),
    ensureCapabilities: async () => {}, groupOwners: new Map([['group-worker', { roomId: 'group', botId: bot.id }]]),
    noteTaskflowSkill: (...args) => loaded.push(args),
  }
  const scopes = []
  const makeAgent = async (id, register = true) => {
    const agent = { id, session: { id } }
    const scope = createScope(ctx, agent)
    agent.ctx = scope.ctx
    scopes.push(scope)
    if (register) await scope.ctx.plugin({ name: `assigned-${id}`, inject: ['skills'], apply(c) {
      for (const item of Object.values(items)) c.skills.register({ name: item.name, description: item.description, source: 'runtime', content: item.content })
    } }).await()
    return agent
  }
  const agent = await makeAgent('group-worker')
  install(rt)
  t.after(async () => { for (const scope of scopes.reverse()) await scope.dispose(); await ctx.fiber.dispose() })
  const step = (number, { actor = agent, turn = 1, messages = [] } = {}) => ctx.waterfall('agent/pre-step',
    { agent: actor, turn, step: number, messages, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
  const gate = (name = 'write', actor = agent) => ctx.waterfall('tools/pre-execute', { name, agent: actor, arguments: {} }, async () => ({ kind: 'allow' }))
  const prepare = (names, reason = 'Relevant to this writing task.', actor = agent) => rt.teamTools.find(tool => tool.name === 'prepare_bot_skills').execute({ names, reason }, { agent: actor, signal: new AbortController().signal })
  const assemble = (actor = agent) => ctx.systemPrompt.assemble({ agent: actor, scope: actor })
  return { ctx, rt, room, bot, items, owned, loaded, agent, makeAgent, step, gate, prepare, assemble }
}

test('skill guidance instructs stage-specific reassessment without fabricating loads', async t => {
  const f = await fixture(t)
  await f.step(0)
  const text = (await f.assemble()).contexts.find(row => row.name === 'ds-bot-selected-skills').text
  assert.match(text, /task objective.*stage/i)
  assert.match(text, /when the task changes stage/i)
  assert.match(text, /scope.*verification.*failure/i)
  assert.deepEqual(f.loaded, [])
  await f.prepare(['writing'])
  await f.step(1)
  const next = await f.prepare(['drawing'])
  assert.match(next.instructions, /UNSELECTED BODY/)
  assert.deepEqual(f.loaded, [['group', 'worker', 'writing'], ['group', 'worker', 'drawing']])
})

test('PTC transport allows preparation while guarding same-step inner task actions', async t => {
  const f = await fixture(t)
  await f.step(0)
  assert.equal((await f.gate('run_code')).kind, 'allow')
  assert.equal((await f.gate('write')).kind, 'deny')
  await f.prepare(['writing'])
  assert.equal((await f.gate('write')).kind, 'deny')
  await f.step(1)
  assert.equal((await f.gate('write')).kind, 'allow')
})

test('changed goal stage invalidates prior selection without resetting on status bookkeeping', async t => {
  const f = await fixture(t)
  await f.step(0)
  await f.prepare(['writing'])
  await f.step(1)
  f.room.goal.revision = 99
  assert.equal((await f.gate()).kind, 'allow')
  f.room.goal.stages[0].reworks++
  assert.equal((await f.gate()).kind, 'deny')
  await f.step(2)
  await f.prepare(['drawing'])
  await f.step(3)
  assert.equal((await f.gate()).kind, 'allow')
  f.room.goal.stages.push({ id: 'stage-2', title: 'Review', acceptance: 'Verified', reworks: 0, tasks: [{ botId: 'worker', task: 'Review' }] })
  f.room.goal.current = 1
  assert.equal((await f.gate()).kind, 'deny')
})

test('taskflow coordination remains available before skill preparation', async t => {
  const f = await fixture(t)
  await f.step(0)
  for (const name of ['taskflow_members', 'taskflow_results', 'taskflow_plan', 'taskflow_dispatch', 'taskflow_submit', 'taskflow_accept', 'taskflow_finish']) {
    assert.equal((await f.gate(name)).kind, 'allow', `${name} must not be blocked`)
  }
  assert.equal((await f.gate('write')).kind, 'deny')
})

test('Bot can select a shared skill without assigning it or attaching its MCP', async t => {
  const f = await fixture(t)
  f.bot.capabilities = []
  await f.step(0)
  const result = await f.prepare(['writing'])
  assert.match(result.instructions, /SELECTED BODY/)
  assert.deepEqual(f.bot.capabilities, [])
  await f.step(1)
  assert.equal((await f.gate()).kind, 'allow')
})

test('selected bodies load through the real scoped registry and remain in required prompt refresh', async t => {
  const f = await fixture(t)
  await f.agent.ctx.plugin({ name: 'complete-skill-persona', inject: ['systemPrompt'], apply(c) {
    c.systemPrompt.section({ name: 'persona', order: 0, complete: true, text: 'Complete Bot persona.' })
    c.systemPrompt.suppressRuntimeContext()
  } }).await()
  await f.step(0)
  assert.equal((await f.gate()).kind, 'deny')
  const result = await f.prepare(['writing'])
  assert.deepEqual(result.names, ['writing'])
  assert.match(result.instructions, /SELECTED BODY/)
  assert.doesNotMatch(result.instructions, /UNSELECTED BODY/)
  const assembled = await f.assemble()
  const section = assembled.contexts.find(row => row.name === 'ds-bot-selected-skills')
  assert.match(section.text, /SELECTED BODY/)
  assert.doesNotMatch(section.text, /UNSELECTED BODY/)
  const refreshed = f.ctx.systemPrompt.refreshContext(assembled, { agent: f.agent, scope: f.agent })
  assert.match(refreshed.contexts.find(row => row.name === section.name).text, /SELECTED BODY/)
  assert.deepEqual(f.loaded, [['group', 'worker', 'writing']])
  assert.equal((await f.gate()).kind, 'deny', 'A PTC subcall must not work before the model reads the returned instructions')
  await f.step(1)
  assert.equal((await f.gate()).kind, 'allow')
})

test('selection is isolated between own chat and group and resets for the next task', async t => {
  const f = await fixture(t)
  await f.step(0)
  await f.prepare(['writing'])
  await f.step(1)
  const own = await f.makeAgent('own-worker')
  await f.step(0, { actor: own })
  assert.equal((await f.gate('write', own)).kind, 'deny')
  assert.doesNotMatch((await f.assemble(own)).contexts.map(row => row.text).join('\n'), /SELECTED BODY/)
  assert.equal((await f.gate()).kind, 'allow')
  await f.step(0, { turn: 2 })
  assert.equal((await f.gate()).kind, 'deny')
  assert.doesNotMatch((await f.assemble()).contexts.map(row => row.text).join('\n'), /SELECTED BODY/)
})

test('irrelevant skills can be skipped only with an explicit reason and no fabricated load', async t => {
  const f = await fixture(t)
  await f.step(0)
  await assert.rejects(f.prepare([], ' '), /reason/)
  const result = await f.prepare([], 'This is a factual greeting, neither reporting nor drawing applies.')
  assert.equal(result.instructions, '')
  assert.deepEqual(f.loaded, [])
  await f.step(1)
  assert.equal((await f.gate()).kind, 'allow')
})

test('unknown, duplicate and unavailable assigned skill selections cannot authorize work', async t => {
  const f = await fixture(t)
  await f.step(0)
  await assert.rejects(f.prepare(['unknown']), /shared skill library/)
  await assert.rejects(f.prepare(['writing', 'writing']), /unique/)
  f.bot.capabilities = ['drawing']
  await assert.rejects(f.prepare(['writing']), /active Bot task/)
  await f.step(1)
  const unassigned = await f.prepare(['writing'])
  assert.match(unassigned.instructions, /SELECTED BODY/)
  const own = await f.makeAgent('own-worker', false)
  await f.step(0, { actor: own })
  await assert.rejects(f.prepare(['drawing'], 'Relevant drawing task.', own), /unavailable or shadowed/)
  assert.equal((await f.gate('write', own)).kind, 'deny')
})

test('assignment withdrawal, changed bodies and new work invalidate previous selection', async t => {
  const f = await fixture(t)
  await f.step(0)
  await f.prepare(['writing'])
  await f.step(1)
  f.items.writing.content = 'Changed body after selection.'
  assert.equal((await f.gate()).kind, 'deny')
  assert.doesNotMatch((await f.assemble()).contexts.map(row => row.text).join('\n'), /SELECTED BODY/)
  f.items.writing.content = 'SELECTED BODY: verify sources before writing.'
  await f.step(2, { messages: [{ source: { kind: 'user' }, content: [] }] })
  assert.equal((await f.gate()).kind, 'deny')
  f.owned.delete('group-worker')
  await assert.rejects(f.prepare(['writing']), /active Bot task/)
})

test('a delayed or concurrent selection cannot publish instructions after the assignment changes', async t => {
  const f = await fixture(t)
  await f.step(0)
  let release
  let entered
  const started = new Promise(resolve => { entered = resolve })
  f.rt.ensureCapabilities = () => new Promise(resolve => { release = resolve; entered() })
  const pending = f.prepare(['writing'])
  await started
  await assert.rejects(f.prepare(['drawing']), /already loading/)
  f.bot.capabilities = ['drawing']
  release()
  await assert.rejects(pending, /changed while loading/)
  assert.equal((await f.gate()).kind, 'deny')
  assert.doesNotMatch((await f.assemble()).contexts.map(row => row.text).join('\n'), /SELECTED BODY/)
  assert.deepEqual(f.loaded, [])
})

test('an oversized selection fails visibly without admitting partial instructions', async t => {
  const f = await fixture(t)
  f.items.writing.content = 'x'.repeat(70_000)
  const own = await f.makeAgent('own-worker')
  await f.step(0, { actor: own })
  await assert.rejects(f.prepare(['writing'], 'Report task.', own), /context budget/)
  await f.step(1, { actor: own })
  assert.equal((await f.gate('write', own)).kind, 'deny')
  assert.deepEqual(f.loaded, [])
})
