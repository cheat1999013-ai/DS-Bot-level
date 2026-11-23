import { createHash } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { renderSkillContent } from '@deepseek-ai/dsh-skill'

const PREPARE = 'prepare_bot_skills'
const LOOKUPS = new Set([PREPARE, 'skill', 'list_capabilities', 'list_bots', 'run_code'])
const BUDGET = 64 * 1024

export function install(rt) {
  const { ctx } = rt
  const tasks = new Map()
  let registry = null
  const sessionOf = agent => agent?.session?.id ?? agent?.id
  const assigned = agent => {
    const sessionId = sessionOf(agent)
    if (!rt.isBotSession(sessionId)) return null
    const botId = rt.selfOf(sessionId)
    const bot = rt.botOf(botId)
    if (!bot) return null
    const items = rt.state.capabilities?.items ?? {}
    const names = [...rt.expandCapabilities(bot.capabilities ?? [])].filter(name => items[name]?.kind === 'skill')
    const skills = Object.values(items).filter(item => item?.kind === 'skill' && item.name && item.content)
    if (!skills.length) return null
    const owner = rt.groupOwners?.get(sessionId)
    const goal = owner ? rt.roomOf?.(owner.roomId)?.goal : null
    const stage = goal?.stages?.[goal.current]
    const work = goal ? [goal.id, goal.status, goal.objective, goal.acceptance, goal.constraints, goal.current,
      stage && [stage.id, stage.title, stage.acceptance, stage.reworks, stage.feedback,
        (stage.tasks ?? []).filter(task => task.botId === botId).map(task => [task.id, task.task])]] : null
    const signature = createHash('sha256').update(JSON.stringify([names, skills.map(s => [s.name, s.description, s.content]), work])).digest('hex')
    return { sessionId, botId, skills, attached: new Set(names), signature }
  }
  const current = agent => {
    const scope = assigned(agent)
    const task = tasks.get(sessionOf(agent))
    return scope && task?.agent.deref() === agent && task.signature === scope.signature ? task : null
  }
  const guidance = scope => [
    'Shared skills for this Bot: consider the task objective, current stage, skill scope, verification and failure boundaries before selecting instructions.',
    `First call ${PREPARE} with exact relevant names and a reason. Read the returned instructions before doing task work. If none apply, pass names: [] and explain why.`,
    `When the task changes stage, encounters an unexpected failure, or needs a different output, reassess the catalog and call ${PREPARE} again for the newly applicable skills before that work. Do not select a skill solely by its name; use its description and actual instructions.`,
    `When only run_code is available, use it to call ${PREPARE} and return its instructions; perform task actions in a later model step after reading the result.`,
    ...scope.skills.map(skill => `- ${skill.name}: ${skill.description ?? ''}`),
  ].join('\n')
  const release = ctx.systemPrompt.context({ name: 'ds-bot-selected-skills', order: 640, required: true, interpolate: false,
    text: ({ agent }) => {
      const scope = assigned(agent)
      if (!scope) return ''
      const task = current(agent)
      return [guidance(scope), task?.material ?? ''].filter(Boolean).join('\n\n')
    },
  })
  ctx.inject({ skills: null }, scope => {
    registry = scope.skills
    scope.effect(() => () => { registry = null; tasks.clear() })
  })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') tasks.delete(session.id)
  })
  ctx.on('agent/pre-step', async function assignedSkillStep({ agent, turn, step, messages }, next) {
    await rt.load()
    const scope = assigned(agent)
    if (scope) {
      let task = current(agent)
      const newWork = messages.some(message => message.source?.kind === 'user' || message.source?.taskflowEvent?.event === 'assigned')
      if (!task || task.turn !== turn || newWork) {
        task = { agent: new WeakRef(agent), signature: scope.signature, turn, step, loadedAt: null, material: '', selected: [] }
        tasks.set(scope.sessionId, task)
      } else task.step = step
    }
    return next()
  })
  ctx.on('tools/pre-execute', async function assignedSkillGate(exec, next) {
    const decision = await next()
    if (decision.kind !== 'allow' || LOOKUPS.has(exec.name) || exec.name.startsWith('taskflow_')) return decision
    await rt.load()
    if (!assigned(exec.agent)) return decision
    const task = current(exec.agent)
    return task?.loadedAt !== null && task?.loadedAt !== undefined && task.step > task.loadedAt
      ? decision : { kind: 'deny', reason: `Call ${PREPARE} to select and load relevant shared skills, then read the result before executing task actions in the next model step.` }
  })
  rt.teamTools.push(defineTool({ name: PREPARE,
    description: 'Select and load shared skills relevant to this task before task actions. Return and read the instructions before doing work in a later model step. Pass no names only when none apply, with a specific reason.',
    parameters: {
      names: { type: 'array', items: { type: 'string' }, required: true, description: 'Exact names of relevant shared skills; no duplicates.' },
      reason: { type: 'string', required: true, description: 'Why these skills apply, or why no shared skill applies.' },
    },
    output: { schema: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' }, required: true }, reason: { type: 'string', required: true }, instructions: { type: 'string', required: true } }, additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: value.instructions || `No assigned skill applies: ${value.reason}` }] },
    async execute(args, exec) {
      await rt.load()
      const scope = assigned(exec.agent)
      const task = current(exec.agent)
      if (!scope || !task) throw new Error('Select skills from the active Bot task step.')
      const names = args.names
      const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
      if (!Array.isArray(names) || names.some(name => typeof name !== 'string') || new Set(names).size !== names.length || !reason) throw new Error('Give unique exact skill names and a nonempty relevance reason.')
      const allowed = new Map(scope.skills.map(skill => [skill.name, skill]))
      if (names.some(name => !allowed.has(name))) throw new Error('Select only skills in the shared skill library.')
      if (task.loading) throw new Error('A skill selection for this task is already loading.')
      task.loading = true
      task.loadedAt = null
      task.material = ''
      try {
        if (names.some(name => scope.attached.has(name)) && !registry) throw new Error('The scoped skill registry is unavailable.')
        await rt.ensureCapabilities(scope.sessionId)
        const blocks = []
        for (const name of names) {
          const item = allowed.get(name)
          const skill = scope.attached.has(name) ? await registry.get(name, { scope: exec.agent, signal: exec.signal }) : { ...item, provider: 'ds-bot-shared-capabilities' }
          exec.signal?.throwIfAborted()
          if (!skill || skill.invocation?.modelInvocable === false || skill.content !== item.content) throw new Error(`Assigned skill ${name} is unavailable or shadowed; refresh its assignment.`)
          blocks.push(renderSkillContent(skill))
        }
        const material = blocks.join('\n\n')
        if (Buffer.byteLength(material, 'utf8') > BUDGET) throw new Error('Selected skill instructions exceed the task context budget; choose a smaller relevant set.')
        if (current(exec.agent) !== task) throw new Error('Task or skill assignments changed while loading; select again.')
        task.material = material
        task.selected = [...names]
        task.loadedAt = task.step
        const owner = rt.groupOwners.get(scope.sessionId)
        for (const name of names) if (owner) rt.noteTaskflowSkill?.(owner.roomId, scope.botId, name)
        return { names, reason, instructions: material }
      } finally { task.loading = false }
    },
  }))
  ctx.effect(() => () => { release(); tasks.clear() }, 'ds-bot: assigned skill preparation')
}
