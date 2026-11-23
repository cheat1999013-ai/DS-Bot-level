
import { dirname } from 'node:path'
import { renderSkillContent } from '@deepseek-ai/dsh-skill'
import { taskflowProvider } from '../taskflow-skills.js'
import { contentDigest, readPublishedSkill, skillName } from './publication.js'
import { SKILL_PERIOD } from './skill-lifecycle.js'

const providerName = 'ds-bot-group-knowledge'
const skillDescription = row => `${row.title} · ${(row.tags ?? []).join('、') || '待分类'}${row.lifecycle === 'forgetting' ? ' · 待遗忘（仍可调用）' : ''}`
const candidateOf = publication => ({ name: publication.name, description: publication.metadata.title ?? publication.name,
  provider: providerName, source: 'runtime', rank: 500,
  tags: publication.metadata.tags ?? [],
  invocation: { modelInvocable: true, userInvocable: true }, path: publication.path,
  resourceBase: { kind: 'directory', path: dirname(publication.path) }, locator: publication.metadata.id })

export function knowledgeProvider(access) {
  return {
    name: providerName,
    async list() {
      const scope = await access()
      if (!scope) return []
      return scope.knowledge.availableSkills(scope.room.id, scope.tier).map(row => {
        const publication = scope.knowledge.skillPublication(scope.room.id, scope.tier, row.id)
        return { ...candidateOf(publication), description: skillDescription(row) }
      })
    },
    async get(candidate) {
      const scope = await access()
      if (!scope || candidate.name !== skillName(candidate.locator)) return undefined
      const row = scope.knowledge.availableSkills(scope.room.id, scope.tier).find(row => row.id === candidate.locator)
      if (!row) return undefined
      const publication = scope.knowledge.skillPublication(scope.room.id, scope.tier, row.id)
      const content = readPublishedSkill(publication)
      if (scope.botId && scope.sessionId) {
        const key = `${scope.scheduler.currentPlanId(scope.room.id) ?? 'registry'}:${Math.floor(scope.knowledge.clock() / SKILL_PERIOD)}`
        scope.knowledge.recordSkillUse(scope.room.id, scope.botId, scope.sessionId, row.id,
          JSON.stringify([scope.sessionId, scope.botId, key]))
      }
      return { ...candidateOf(publication), description: skillDescription(row), content }
    },
  }
}

const similarity = (query, text) => {
  const chars = new Set(query.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''))
  return [...new Set(text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''))].filter(char => chars.has(char)).length
}

export async function knowledgeContext(scope) {
  const guide = await taskflowProvider().get()
  const loaded = [{ name: guide.name, digest: contentDigest(guide.content) }]
  const blocks = [renderSkillContent(guide)]
  const planId = scope.scheduler.currentPlanId(scope.room.id)
  const plan = planId ? scope.scheduler.planState(planId) : null
  const query = [scope.bot.instructions, scope.bot.role, plan?.goal,
    ...(plan?.cards ?? []).filter(card => card.member === scope.botId).map(card => card.goal)].filter(Boolean).join('\n')
  const rows = scope.knowledge.availableSkills(scope.room.id, scope.tier)
    .sort((a, b) => similarity(query, `${b.tags.join(' ')} ${b.title} ${b.text}`) - similarity(query, `${a.tags.join(' ')} ${a.title} ${a.text}`) || a.id.localeCompare(b.id))
  for (const row of rows.slice(0, 3)) {
    const publication = scope.knowledge.skillPublication(scope.room.id, scope.tier, row.id)
    const content = readPublishedSkill(publication)
    blocks.push(renderSkillContent({ ...candidateOf(publication), content }))
    loaded.push({ name: publication.name, digest: publication.digest })
  }
  return { text: blocks.join('\n\n'), loaded }
}

export function installKnowledgeRuntime(rt, start, state) {
  const mounts = new Map()
  const materials = new WeakMap()
  let stopped = false
  const cachedContext = context => {
    const agent = context.agent
    const material = agent && materials.get(agent)
    if (stopped || !material) return ''
    const caller = state.callerOf(agent.session.id)
    if (caller?.roomId !== material.scope.room.id || caller.botId !== material.scope.botId) return ''
    const { knowledge, scheduler } = material.scope
    const allowed = new Set(knowledge.availableSkills(caller.roomId, scheduler.botLevel(caller.roomId, caller.botId).tier)
      .map(row => skillName(row.id)))
    if (material.loaded.some(skill => skill.name !== 'taskflow' && !allowed.has(skill.name))) {
      throw new Error('skill_access_changed_before_admission')
    }
    return material.text
  }
  const releaseContext = rt.ctx.systemPrompt?.context?.({
    name: providerName, order: 650, text: cachedContext, interpolate: false, required: true,
  })
  const access = async agent => {
    if (stopped) return null
    await rt.load()
    const caller = state.callerOf(agent.session?.id ?? agent.id)
    if (caller?.kind !== 'group') return null
    const service = await start('taskflow_skill_search')
    if (!service?.knowledge) throw new Error('knowledge_unavailable')
    const current = state.callerOf(agent.session?.id ?? agent.id)
    if (!current || current.roomId !== caller.roomId) return null
    return { ...current, sessionId: agent.session?.id ?? agent.id, knowledge: service.knowledge, scheduler: service.scheduler,
      tier: service.scheduler.botLevel(current.room.id, current.botId).tier }
  }
  rt.ctx.on?.('system-prompt/assemble', async (_assembly, context, next) => {
    const agent = context.agent
    if (!agent) return next()
    const scope = await access(agent)
    if (!scope) return next()
    let mount = mounts.get(agent)
    if (!mount) {
      mount = {}
      mounts.set(agent, mount)
      const fiber = agent.ctx.plugin({ name: 'ds-bot-group-knowledge', inject: ['skills'], apply(ctx) {
        ctx.skills.registerProvider(control => {
          mounts.get(agent).invalidate = control.invalidate
          return knowledgeProvider(() => access(agent))
        })
      } })
      mount.fiber = fiber
      try { await fiber.await() } catch (error) {
        mounts.delete(agent)
        await fiber.dispose()
        throw error
      }
    }
    mount.invalidate?.()
    const assembled = await next()
    const current = await access(agent)
    if (!current) return assembled
    const material = await knowledgeContext(current, agent.session.id)
    const admitted = state.callerOf(agent.session.id)
    if (admitted?.roomId !== current.room.id || admitted.botId !== current.botId) return assembled
    const allowed = new Set(current.knowledge.availableSkills(admitted.roomId,
      current.scheduler.botLevel(admitted.roomId, admitted.botId).tier).map(row => skillName(row.id)))
    if (material.loaded.some(skill => skill.name !== 'taskflow' && !allowed.has(skill.name))) {
      throw new Error('skill_access_changed_during_assembly')
    }
    current.knowledge.recordSkillLoads(agent.session.id, current.room.id, current.botId, material.loaded)
    materials.set(agent, { ...material, scope: current })
    return { ...assembled, contexts: [...assembled.contexts.filter(section => section.name !== providerName),
      { name: providerName, text: material.text, interpolate: false }] }
  })
  rt.ctx.effect(() => () => {
    stopped = true
    releaseContext?.()
    for (const { fiber } of mounts.values()) fiber.dispose()
    mounts.clear()
  }, 'ds-bot: group knowledge skills')
}
