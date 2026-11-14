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
    if (!names.length) return null
    const skills = names.map(name => items[name])
    const signature = createHash('sha256').update(JSON.stringify(skills.map(s => [s.name, s.description, s.content]))).digest('hex')
    return { sessionId, botId, skills, signature }
  }
  const current = agent => {
    const scope = assigned(agent)
    const task = tasks.get(sessionOf(agent))
    return scope && task?.agent.deref() === agent && task.signature === scope.signature ? task : null
  }
  const guidance = scope => [
    'Assigned skills for this Bot: select the skills relevant to the current task before doing task work.',
    `First call ${PREPARE} with their exact names and a reason. It loads the actual instructions. If none apply, pass names: [] and explain why.`,
    'In run_code, only prepare skills in that program and return their instructions. Do task actions in the next model step, after reading them.',
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
    if (decision.kind !== 'allow' || LOOKUPS.has(exec.name)) return decision
    await rt.load()
    if (!assigned(exec.agent)) return decision
    const task = current(exec.agent)
    return task?.loadedAt !== null && task?.loadedAt !== undefined && task.step > task.loadedAt
      ? decision : { kind: 'deny', reason: `Call ${PREPARE} to select and load relevant assigned skills, then read the result before executing task actions in the next model step.` }
  })
  rt.teamTools.push(defineTool({ name: PREPARE,
    description: 'Select and load the assigned skills relevant to this task before task actions. Return and read these instructions before doing work; do not combine preparation and task actions in the same run_code program. Pass no names only when none apply, with a specific reason.',
    parameters: {
      names: { type: 'array', items: { type: 'string' }, required: true, description: 'Exact names of relevant skills assigned to this Bot; no duplicates.' },
      reason: { type: 'string', required: true, description: 'Why these skills apply, or why no assigned skill applies.' },
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
      if (names.some(name => !allowed.has(name))) throw new Error('Select only skills currently assigned to this Bot.')
      if (task.loading) throw new Error('A skill selection for this task is already loading.')
      task.loading = true
      task.loadedAt = null
      task.material = ''
      try {
        if (names.length && !registry) throw new Error('The scoped skill registry is unavailable.')
        await rt.ensureCapabilities(scope.botId, scope.sessionId)
        const blocks = []
        for (const name of names) {
          const skill = await registry.get(name, { scope: exec.agent, signal: exec.signal })
          exec.signal?.throwIfAborted()
          if (!skill || skill.invocation?.modelInvocable === false || skill.content !== allowed.get(name).content) throw new Error(`Assigned skill ${name} is unavailable or shadowed; refresh its assignment.`)
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
