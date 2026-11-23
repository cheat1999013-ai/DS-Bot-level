/**
 * Model-facing tools for DS Bot's native taskflow.
 *
 * The tools join DS Bot's own scoped teamTools catalog. Identity comes from
 * the live roster's Session ownership; tool arguments never carry caller identity.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { SchedulerError, digest } from './scheduler.js'
import { contentDigest, readPublishedSkill } from './publication.js'
import { skillTags, tagsDigest, QUALITY_KEYS } from './skill-lifecycle.js'
import { taskflowRoomEnabled } from './monitor.js'
import { defineTool } from '@deepseek-ai/dsh-tools'

const OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

const GROUP = { type: 'string', description: 'Exact group chat name; optional inside that group' }
const PLAN = { type: 'string', description: 'Plan id; defaults to the current plan of this group' }
const CARD = { type: 'string', required: true, description: 'Card id from the plan' }
const STATUS = { type: 'string', enum: ['settled', 'failed'], description: 'settled (default) or failed' }
const SKILL_TAGS = { type: 'array', items: { type: 'string' }, description: '分类标签，例如设计-UI、设计-网页、设计-图像、设计-电商图像、代码-前端；自动补齐父类，可按任务扩展。' }
const REFLECTION_HEADINGS = ['做了什么', '为什么这么做', '里面的错误怎么避免', '要在下次任务中做的更好我需要什么']
const REFLECTION_TEXT = { type: 'string', required: true,
  description: `默认只写三个 Markdown 二级标题，按顺序为“做了什么”“为什么这么做”“要在下次任务中做的更好我需要什么”。有实际错误或弯路时，在最后一段之前加“里面的错误怎么避免”，写明原因和预防措施。无实际错误时直接省略此段。围绕本卡的具体判断、证据和核验方法写，每段内容必须真实且非空。` }

function reflectionText(body) {
  const value = typeof body === 'string' ? body.trim() : ''
  const headings = [...value.matchAll(/^##[ \t]+(.+?)[ \t]*\r?$/gm)]
  const expected = headings.length === 3 ? REFLECTION_HEADINGS.filter((_, index) => index !== 2) : REFLECTION_HEADINGS
  const valid = headings.length === expected.length && headings[0]?.index === 0 && headings.every((heading, index) => {
    const end = headings[index + 1]?.index ?? value.length
    return heading[1] === expected[index] && value.slice(heading.index + heading[0].length, end).trim().length > 0
  })
  if (!valid) throw new SchedulerError('invalid_reflection_format',
    '心得须按顺序填写做了什么、为什么这么做和下次需要什么；发生错误时可在第三段填写错误及避免方法，各段必须非空。')
  return value
}

function reflectionFingerprint(body) {
  const sections = body.split(/^##[ \t]+[^\r\n]+\r?$/m).slice(1)
    .map(section => section.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''))
  return sections.map(section => {
    const grams = new Set()
    for (let i = 0; i + 3 <= section.length; i++) grams.add(section.slice(i, i + 3))
    return { section, grams }
  })
}

function duplicateReflection(left, right) {
  if (left.length !== right.length) return false
  let common = 0
  let total = 0
  let exact = true
  for (const [index, a] of left.entries()) {
    const b = right[index]
    if (a.section === b.section) {
      common += a.grams.size
      total += 2 * a.grams.size
      continue
    }
    exact = false
    const size = a.grams.size + b.grams.size
    let shared = 0
    for (const gram of a.grams) if (b.grams.has(gram)) shared++
    if (!size || 2 * shared < 0.55 * size) return false
    common += shared
    total += size
  }
  return exact || (total >= 60 && 2 * common >= 0.85 * total)
}

const TOOLS = [
  {
    name: 'taskflow_members',
    audience: 'leader',
    description: '主理用：查看本群成员、角色、模型和群管理员。拆分任务前先看它，按分工派活；能力标签不等于 Bot 真有对应工具或权限。',
    parameters: { group: GROUP },
    handler: (service, args, exec) => service.members(args, exec),
  },
  {
    name: 'taskflow_plan',
    audience: 'leader',
    description: '主理用：把群主这次的需求拆成有序依赖图（1–32 张卡）。不派工；只有必须等前一步完成才能开始的子任务才写 dependencies，互不依赖的留空。member 填群成员名字或 id；不能派给自己。可选 confirm 写清该卡开始前群主必须确认什么；可选 testRequiredCards + testChecks 为该卡配置独立验收测试。',
    parameters: {
      group: GROUP,
      planId: { type: 'string', description: 'Optional plan id; a UUID is generated when omitted' },
      goal: { type: 'string', required: true, description: 'The overall goal of this plan' },
      children: {
        type: 'array', required: true,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string' },
            member: { type: 'string' },
            goal: { type: 'string' },
            dependencies: { type: 'array', items: { type: 'string' } },
            confirm: { type: 'string', description: 'Optional owner confirmation question for this card (<=500 chars)' },
          },
        },
      },
      concurrency: { type: 'integer', description: '1–6 cards in flight, default 3' },
      retryLimit: { type: 'integer', description: '0–5 retries per card, default 1' },
      confirmRequired: { type: 'boolean', description: 'Require the principal to confirm every card before acceptance' },
      testRequiredCards: { type: 'array', items: { type: 'string' }, description: 'Cards that require a trusted test before acceptance' },
      testChecks: { type: 'object', additionalProperties: true, description: 'Map card id to {command, workdir}; workdir must be an existing absolute directory' },
      workdir: { type: 'string', description: 'Optional absolute working directory shown to executors' },
    },
    handler: (service, args, exec) => service.plan(args, exec),
  },
  {
    name: 'taskflow_dispatch',
    audience: 'leader',
    description: '主理用：按依赖和并发派出所有就绪卡。派工实际在群里 @ 执行 Bot；无依赖的卡同时执行，有依赖的等前置验收后自动释放。同一成员同时最多一张卡。',
    parameters: { group: GROUP, planId: PLAN },
    handler: (service, args, exec) => service.dispatch(args, exec),
  },
  {
    name: 'taskflow_plans',
    audience: 'leader',
    description: '主理用：列出本群最近最多20个正式计划及其目标和状态，核对近期后续任务；不包含更早历史。',
    parameters: { group: GROUP },
    handler: (service, args, exec) => service.plans(args, exec),
  },
  {
    name: 'taskflow_status',
    audience: 'any',
    description: '读取本群当前任务流计划：卡片状态、依赖、就绪卡、并发和等待确认项。',
    parameters: { group: GROUP, planId: PLAN },
    handler: (service, args, exec) => service.status(args, exec),
  },
  {
    name: 'taskflow_results',
    audience: 'any',
    description: '读取每张卡的真实提报、验收证据、测试与确认状态，以及全卡验收后的完成快照。主理人据此逐卡验收。',
    parameters: { group: GROUP, planId: PLAN },
    handler: (service, args, exec) => service.results(args, exec),
  },
  {
    name: 'taskflow_accept',
    audience: 'leader',
    description: '主理用：验收一张已提报的卡。证据由宿主按提报内容计算 sha256，无需手填；验收后自动释放后继卡。测试未通过或确认门未批准时会被拒绝。',
    parameters: { group: GROUP, planId: PLAN, cardId: CARD },
    handler: (service, args, exec) => service.accept(args, exec),
  },
  {
    name: 'taskflow_reject',
    audience: 'leader',
    description: '主理用：打回一张已提报的卡，写清原因；卡回到待派工，重新派给同一执行者。',
    parameters: { group: GROUP, planId: PLAN, cardId: CARD, reason: { type: 'string', required: true } },
    handler: (service, args, exec) => service.reject(args, exec),
  },
  {
    name: 'taskflow_retry',
    audience: 'leader',
    description: '主理用：重试失败卡，或决定崩溃后状态 unknown 的卡的处置（retry 重新派工 / fail 记为失败）。重试受 retryLimit 约束。',
    parameters: { group: GROUP, planId: PLAN, cardId: CARD, decision: { type: 'string', enum: ['retry', 'fail'] } },
    handler: (service, args, exec) => service.retry(args, exec),
  },
  {
    name: 'taskflow_verify',
    audience: 'leader',
    description: '主理用：对已提报且配置了测试的卡运行独立测试命令。必须先由用户逐次批准准确命令和工作目录；拒绝则不准入、不执行。仅 exit_code=0 且无 error 记为 passed。',
    parameters: { group: GROUP, planId: PLAN, cardId: CARD },
    handler: (service, args, exec) => service.verify(args, exec),
  },
  {
    name: 'taskflow_confirm',
    audience: 'leader',
    description: '主理用：对等待确认门的卡请求用户批准 approve 或 reject 决定。审批绑定当前提报；用户拒绝则不写入决定，重试后需重新确认。',
    parameters: {
      group: GROUP, planId: PLAN, cardId: CARD,
      decision: { type: 'string', required: true, enum: ['approve', 'reject'] },
      note: { type: 'string' },
    },
    handler: (service, args, exec) => service.confirm(args, exec),
  },
  {
    name: 'taskflow_submit',
    audience: 'member',
    description: '执行 Bot 用：提交自己卡的结果。planId/cardId 用派工消息里的值；settled 表示完成，failed 表示失败。只有该卡的执行者能提交。',
    parameters: { group: GROUP, planId: PLAN, cardId: CARD, result: { type: 'string', required: true }, status: STATUS },
    handler: (service, args, exec) => service.submit(args, exec),
  },
  {
    name: 'taskflow_finish',
    audience: 'leader',
    description: '主理用：全部卡验收后完成当前计划。快照与证据由宿主计算并 CAS 校验。多阶段项目的关联计划完成后继续推进项目，心得等 group_goal complete。',
    parameters: { group: GROUP, planId: PLAN },
    handler: (service, args, exec) => service.finish(args, exec),
  },
  {
    name: 'taskflow_cancel',
    audience: 'leader',
    description: '主理用：计划确定做不下去时取消。未验收卡取消，已验收保留；reason 写清原因并随后在群里告诉群主。',
    parameters: { group: GROUP, planId: PLAN, reason: { type: 'string', required: true } },
    handler: (service, args, exec) => service.cancel(args, exec),
  },
  {
    name: 'taskflow_sleep_note',
    audience: 'member',
    description: '执行 Bot 用：为自己已提报的卡写心得。同计划里已有高度重复心得时，收到 note_duplicate 后按本卡的实际判断、证据和核验方法重写，再提交原卡。无实际错误时省略错误段。真实心得可替换自动占位。',
    parameters: { group: GROUP, planId: PLAN, cardId: CARD, text: REFLECTION_TEXT },
    handler: async (service, args, exec) => {
      const result = service.sleepNote(args, exec)
      return { ...result, notification: await service.notifySavedNote(args, exec, result.note) }
    },
  },
  {
    name: 'taskflow_sleep_pending',
    audience: 'leader',
    description: '主理用：查看哪些已终局卡还没有心得，以及已有心得草稿。全部写完后才能汇总。',
    parameters: { group: GROUP, planId: PLAN },
    handler: (service, args, exec) => service.sleepPending(args, exec),
  },
  {
    name: 'taskflow_sleep_consolidate',
    audience: 'leader',
    description: '主理用：按做法、原因、需要分别去重合并执行者心得；仅在有真实错误或弯路时归纳错误及避免方法（<=12000 字节）。保留事实和需求的来源，不编造历史缺失内容；全卡验收且无缺心得时才能消费草稿，重复同样内容幂等。',
    parameters: { group: GROUP, planId: PLAN, title: { type: 'string', required: true }, text: REFLECTION_TEXT },
    handler: (service, args, exec) => service.sleepConsolidate(args, exec),
  },
  {
    name: 'taskflow_memory_search',
    audience: 'member',
    description: '在当前群的隐藏索引里搜索重要节点；返回关键词和摘要，不显示其他群内容。先搜索，再按精确关键词打开。',
    parameters: { query: { type: 'string', required: true } },
    handler: (service, args, exec) => service.memorySearch(args, exec),
  },
  {
    name: 'taskflow_memory_open',
    audience: 'member',
    description: '按当前群隐藏索引中搜索出的精确关键词打开原始节点内容；归档明细清理后只显示标记过的摘要。',
    parameters: { keyword: { type: 'string', required: true } },
    handler: (service, args, exec) => service.memoryOpen(args, exec),
  },
  {
    name: 'taskflow_skill_insights', audience: 'leader',
    description: '主理分页读取本群汇总心得和来源占用状态，按具体可复用方法判断，不按文章选题凑数。',
    parameters: { offset: { type: 'integer' } }, handler: (service, args, exec) => service.skillInsights(args, exec),
  },
  {
    name: 'taskflow_skill_propose_method', audience: 'leader',
    description: '主理先预览普通技能方法证据；确认同一方法后，携带返回的 previewDigest 再次调用创建草稿。保留 Bot 和人工审核。',
    parameters: { title: { type: 'string', required: true }, previewDigest: { type: 'string' }, sources: { type: 'array', required: true,
      items: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, step: { type: 'string', required: true }, validation: { type: 'string', required: true },
      } } } }, handler: (service, args, exec) => service.skillProposeMethod(args, exec),
  },
  {
    name: 'taskflow_skill_candidates', audience: 'leader',
    description: '查看当前群待审核技能草稿、等级和独立来源。仅当前主理可见，不会自动装备。',
    parameters: {}, handler: (service, args, exec) => service.skillCandidates(args, exec),
  },
  {
    name: 'taskflow_skill_review', audience: 'leader',
    description: '当前主理 Bot 审核本群技能草稿；人工审核在归纳正文前另行请求。',
    parameters: { id: { type: 'string', required: true }, approved: { type: 'boolean', required: true } },
    handler: (service, args, exec) => service.skillReview(args, exec),
  },
  {
    name: 'taskflow_skill_consolidate', audience: 'leader',
    description: 'Bot 审核通过后提交去重正文及大类/细分类标签，向群主展示正文与标签请求人工审核；同意后才晋升。标签要反映真实用途，执行者可据此查找技能。',
    parameters: { id: { type: 'string', required: true }, text: { type: 'string', required: true }, tags: { ...SKILL_TAGS, required: true } },
    handler: (service, args, exec) => service.skillConsolidate(args, exec),
  },
  {
    name: 'taskflow_skill_publish', audience: 'leader',
    description: '将本群已双审技能发布到跨群共享库；宿主展示准确正文并请求人工批准后才发布。',
    parameters: { id: { type: 'string', required: true } },
    handler: (service, args, exec) => service.skillPublish(args, exec),
  },
  {
    name: 'taskflow_skill_unpublish', audience: 'leader',
    description: '撤回本群技能的跨群共享；之后的检索、精确打开和模型请求均重新检查权限。',
    parameters: { id: { type: 'string', required: true } },
    handler: (service, args, exec) => service.skillUnpublish(args, exec),
  },
  {
    name: 'taskflow_skill_level', audience: 'member',
    description: '查看当前群自身的已计分计划数与 Bot 等级；整个计划成功完成才给执行 Bot 计分，同一计划每个执行 Bot 最多一次，普通阶段加 0.1 级，优良及精品阶段加 0.01 级。',
    parameters: {}, handler: (service, args, exec) => service.skillLevel(args, exec),
  },
  {
    name: 'taskflow_skill_search', audience: 'member',
    description: '按分类标签及关键词搜索符合本群/等级权限的已审核技能；大类涵盖细类，返回标签、评分和待遗忘状态。待遗忘仍可用，淘汰不可用。先搜索再打开。',
    parameters: { query: { type: 'string' }, tags: SKILL_TAGS },
    handler: (service, args, exec) => service.skillSearch(args, exec),
  },
  {
    name: 'taskflow_skill_open', audience: 'member',
    description: '在当前群按 ID 打开已审核且符合自身等级的技能正文。',
    parameters: { id: { type: 'string', required: true } },
    handler: (service, args, exec) => service.skillOpen(args, exec),
  },
  {
    name: 'taskflow_skill_score', audience: 'leader',
    description: '当前主理查看本群普通、优良技能到期的五天评分窗口；精品技能免评分且不会自动遗忘或淘汰。无参数返回待评分正文/调用频次。提交cycleId及六项ratings，每项score只能0或0.5并附正文依据/缺失说明：scope适用场景、inputs输入前提、steps执行步骤、validation验收、prevention错误预防、boundaries边界。宿主统计频次2分+质量3分。低于3首次待遗忘仍可用，下一独立五天周期仍低于3则淘汰删除自有文件；不许编造调用或质量依据。',
    parameters: { cycleId: { type: 'string' }, ratings: { type: 'object', additionalProperties: false,
      properties: Object.fromEntries(QUALITY_KEYS.map(key => [key, { type: 'object', required: true, additionalProperties: false,
        properties: { score: { type: 'number', enum: [0, 0.5], required: true }, evidence: { type: 'string', required: true } } }])) } },
    handler: (service, args, exec) => service.skillScore(args, exec),
  },
]

export const TOOL_COUNT = TOOLS.length

export function buildToolDefinitions(define = defineTool, service = null) {
  return TOOLS.map(tool => define({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    output: OUTPUT,
    async execute(args, exec) {
      try {
        const active = typeof service === 'function' ? await service(tool.name) : service
        if (!active) throw new SchedulerError('no_current_plan', 'This read-only host has no taskflow ledger yet')
        const value = await tool.handler(active, args ?? {}, exec)
        return JSON.stringify({ success: true, ...value }, null, 2)
      } catch (error) {
        if (error instanceof SchedulerError) {
          return JSON.stringify({ success: false, error: error.code, message: error.message }, null, 2)
        }
        return JSON.stringify({ success: false, error: 'taskflow_error', message: String(error?.message ?? error) }, null, 2)
      }
    },
  }))
}

export class TaskflowService {
  constructor({ botState, scheduler, knowledge, post, stopMemberWork, notifyStart = async () => {}, approveTest = async () => {
    throw new SchedulerError('approval_required', 'The user must approve this test command before it runs')
  }, approveConfirmation = async () => {
    throw new SchedulerError('approval_required', 'The user must approve this confirmation')
  }, approveSkill = async () => {
    throw new SchedulerError('approval_required', 'The human owner must approve the skill text')
  }, approveShare = async () => {
    throw new SchedulerError('approval_required', 'The human owner must approve sharing this skill')
  }, log = () => {} }) {
    this.botState = botState
    this.scheduler = scheduler
    this.knowledge = knowledge
    this.post = post
    this.stopMemberWork = stopMemberWork
    this.notifyStart = notifyStart
    this.approveTest = approveTest
    this.approveConfirmation = approveConfirmation
    this.approveSkill = approveSkill
    this.approveShare = approveShare
    this.log = log
  }

  sessionOf(agent) {
    return agent?.session?.id ?? agent?.id ?? null
  }

  callerOf(agent) {
    return this.botState.callerOf(this.sessionOf(agent))
  }

  visible(audience, agent) {
    try {
      const caller = this.callerOf(agent)
      if (!caller) return false
      if (caller.kind !== 'group') return false
      if (audience === 'any') return true
      if (!caller.room) return false
      if (audience === 'member') return caller.room.members?.includes(caller.botId) === true
      return caller.room.admin === caller.botId
    } catch {
      return false
    }
  }

  scope(exec, group, { leader = false } = {}) {
    const agent = exec?.agent ?? exec
    const caller = this.callerOf(agent)
    if (!caller) throw new SchedulerError('not_a_bot_session', 'Only a DS Bot session can use taskflow')
    if (caller.kind !== 'group') throw new SchedulerError('group_session_required', 'Use your group session for taskflow')
    const room = this.botState.roomFor(caller, group)
    if (!room) {
      throw new SchedulerError('group_required', 'Name the exact group chat when calling outside it')
    }
    if (!room.members?.includes(caller.botId)) {
      throw new SchedulerError('member_not_in_room', `You are not a member of "${room.name}"`)
    }
    if (leader && room.admin !== caller.botId) {
      const admin = this.botState.admin(room)
      throw new SchedulerError('leader_only', `Only the group admin${admin ? ` (${admin.name})` : ''} can run this operation`)
    }
    return { ...caller, room }
  }

  planFor(scope, planId) {
    const explicit = typeof planId === 'string' && planId.trim() !== '' ? planId.trim() : null
    const id = explicit ?? this.scheduler.currentPlanId(scope.room.id)
      ?? (typeof scope.room.taskflowPlanId === 'string' ? scope.room.taskflowPlanId : null)
    if (!id) throw new SchedulerError('no_current_plan', 'This group has no taskflow plan; create one with taskflow_plan')
    const state = this.scheduler.planState(id)
    if (state.room !== scope.room.id) throw new SchedulerError('plan_other_room', 'This plan belongs to another group')
    return state
  }

  reflectionGoal(room, plan) {
    const goals = [room.goal, ...(room.pastGoals ?? [])].filter(Boolean)
    if (plan.group_goal_id !== null) {
      return plan.group_goal_id ? goals.find(goal => goal.id === plan.group_goal_id) ?? { id: plan.group_goal_id } : null
    }
    if (this.scheduler.scheduledOrigin(plan.plan_id)) return null
    // Legacy plans have no explicit binding. Match the goal's recorded lifetime.
    const createdAt = plan.created_at * 1000
    return goals.find(goal => createdAt >= goal.createdAt && (goal.endedAt == null || createdAt <= goal.endedAt)) ?? null
  }

  reflectionDeferred(room, plan) {
    if (plan.reflection_released) return plan.status !== 'completed'
    const goal = this.reflectionGoal(room, plan)
    return goal !== null && (goal.status !== 'complete' || plan.status !== 'completed')
  }

  requireReflectionReady(room, plan) {
    if (this.reflectionDeferred(room, plan)) {
      throw new SchedulerError('reflection_deferred', '请等所属项目通过总验收并完成本计划，再写或汇总心得。阶段验收后继续推进项目。')
    }
  }

  decorate(state, room) {
    if (!state) return null
    const names = this.botState.names(room)
    const admin = this.botState.admin(room)
    const scheduled = this.scheduler.scheduledOrigin(state.plan_id)
    return {
      ...state,
      ...(scheduled ? { schedule: { id: scheduled.schedule_id, occurrenceAt: scheduled.occurrence_at } } : {}),
      principal_name: names[state.principal] ?? admin?.name ?? state.principal,
      room_name: room.name,
      cards: state.cards.map(card => ({
        ...card,
        member_name: names[card.member] ?? card.member,
        confirm: card.confirm ?? this.scheduler.cardGate(state.plan_id, card.id),
      })),
      ready: state.ready ?? [],
    }
  }

  card(scope, state, cardId) {
    const card = state.cards.find(item => item.id === cardId)
    if (!card) throw new SchedulerError('card_not_found', `No card ${cardId} in plan ${state.plan_id}`)
    return card
  }

  async postToRoom(scope, text, taskflow, taskflowEvent) {
    const sessionId = this.botState.groupSessionId(scope.room)
    if (!sessionId) {
      throw new SchedulerError('group_session_missing', `Group "${scope.room.name}" has no chat session yet; open it once in DS Bot, then retry`)
    }
    if (taskflowEvent?.schedule) {
      const prefix = `@${taskflowEvent.to.name} `
      if (text.startsWith(prefix)) text = text.slice(prefix.length)
    }
    return this.post({ scope, text, taskflow, taskflowEvent, requestId: randomUUID() })
  }

  taskEvent(scope, state, card, event, recipient) {
    const from = this.botState.member(scope.room, scope.botId)
    const to = this.botState.member(scope.room, recipient)
    if (!from || !to) throw new SchedulerError('member_not_in_room', 'The task sender and recipient must still be group members')
    const scheduled = this.scheduler.scheduledOrigin(state.plan_id)
    return { planId: state.plan_id, cardId: card.id, event, goal: card.goal,
      ...(scheduled ? { schedule: { id: scheduled.schedule_id, occurrenceAt: scheduled.occurrence_at } } : {}),
      from: { id: from.id, name: from.name }, to: { id: to.id, name: to.name } }
  }

  taskText(scope, state, card) {
    const lines = [
      `@${card.member_name ?? this.botState.names(scope.room)[card.member] ?? card.member} [Taskflow ${state.plan_id}/${card.id}]`,
      card.goal,
    ]
    const workdir = this.scheduler.workdir(state.plan_id)
    if (workdir) lines.push(`工作目录: ${workdir}`)
    if (Array.isArray(card.dependencies) && card.dependencies.length > 0) {
      lines.push(`前置卡（已验收）: ${card.dependencies.join(', ')}`)
    }
    lines.push(`完成后调用 taskflow_submit，参数 planId="${state.plan_id}"、cardId="${card.id}"，result 写真实结果；失败则 status="failed"。`)
    return lines.join('\n')
  }

  async dispatchScope(scope, planId) {
    const state = this.planFor(scope, planId)
    if (state.status !== 'open') throw new SchedulerError('plan_not_open', `Plan ${state.plan_id} is ${state.status}`)
    if (scope.botId !== scope.room.admin || scope.botId !== state.principal || !this.botState.admin(scope.room)) {
      throw new SchedulerError('leader_only', 'Only the current group principal can dispatch this plan')
    }
    const claimed = this.scheduler.claimNext(state.plan_id, { principal: scope.botId })
    const sent = []
    const held = []
    const active = new Set(state.cards.filter(card => ['running', 'dispatching', 'unknown'].includes(card.state)).map(card => card.member))
    for (const card of claimed) {
      const member = this.botState.member(scope.room, card.member)
      if (!member) {
        if (this.scheduler.scheduledOrigin(state.plan_id)) {
          const error = new SchedulerError('taskflow_delivery_cancelled', 'Scheduled executor left the group before delivery')
          this.scheduler.reclaimScheduledUnsent(state.plan_id, card.id, error.message)
          throw error
        }
        try { this.scheduler.releaseUnsent(state.plan_id, card.id) } catch { /* keep state */ }
        held.push({ id: card.id, reason: 'member left the group' })
        continue
      }
      if (active.has(card.member)) {
        try { this.scheduler.releaseUnsent(state.plan_id, card.id) } catch { /* keep state */ }
        held.push({ id: card.id, reason: 'member already has a card in flight' })
        continue
      }
      const decoratedCard = { ...card, member_name: member.name }
      try {
        await this.postToRoom(scope, this.taskText(scope, state, decoratedCard), { planId: state.plan_id, cardId: card.id, member: card.member },
          this.taskEvent(scope, state, decoratedCard, 'assigned', card.member))
      } catch (error) {
        if (error?.code === 'taskflow_delivery_cancelled') {
          if (this.scheduler.scheduledOrigin(state.plan_id)) {
            this.scheduler.reclaimScheduledUnsent(state.plan_id, card.id, error.message)
            throw error
          }
          try { this.scheduler.releaseUnsent(state.plan_id, card.id) } catch { /* keep state */ }
          held.push({ id: card.id, reason: String(error.message) })
          continue
        }
        const reason = `delivery uncertain: ${error?.message ?? error}`
        this.scheduler.markDispatchUnknown(state.plan_id, card.id, { reason })
        held.push({ id: card.id, reason })
        continue
      }
      const receipt = `dsh:${randomUUID()}`
      try {
        this.scheduler.bindReceipt(state.plan_id, card.id, { receipt })
      } catch (error) {
        // The message is out; leave the card for the principal to resolve.
        this.log('warn', `taskflow: posted ${card.id} but could not bind receipt: ${error?.message ?? error}`)
        held.push({ id: card.id, reason: `receipt bind failed after posting: ${error?.message ?? error}` })
        continue
      }
      active.add(card.member)
      sent.push({ id: card.id, member: member.name, receipt })
      await this.notifyStart({ scope, member, card }).catch(error => {
        this.log('warn', `taskflow: start notice failed for ${card.id}: ${error?.message ?? error}`)
      })
    }
    return { sent, held, plan: this.decorate(this.scheduler.planState(state.plan_id), scope.room) }
  }

  // ---- tools ---------------------------------------------------------------

  members(args, exec) {
    const scope = this.scope(exec, args.group, { leader: false })
    const members = this.botState.members(scope.room)
    const admin = members.find(member => member.admin)
    return {
      room: { id: scope.room.id, name: scope.room.name, admin: admin?.name ?? null, admin_id: admin?.id ?? null },
      members: members.map(member => ({
        id: member.id, name: member.name, role: member.role, model: member.model,
        admin: member.admin, private: member.private,
        instructions: String(member.instructions ?? '').split('\n')[0].slice(0, 200),
      })),
    }
  }

  plan(args, exec) {
    const scope = this.scope(exec, args.group, { leader: true })
    return this.planScope(args, scope)
  }

  async dispatchScheduled({ scheduleId, occurrenceAt, roomId, memberId, title, prompt }) {
    const room = this.botState.room(roomId)
    if (!room || !room.members.includes(room.admin) || !this.botState.bot(room.admin)) {
      throw new SchedulerError('leader_only', 'A scheduled group task needs a current group principal')
    }
    if (!taskflowRoomEnabled(room)) throw new SchedulerError('group_task_disabled', 'Group taskflow is disabled or paused')
    if (!this.botState.member(room, memberId)) throw new SchedulerError('member_not_in_room', 'The scheduled executor is no longer a group member')
    if (typeof scheduleId !== 'string' || !scheduleId.trim() || scheduleId !== scheduleId.trim()
      || typeof occurrenceAt !== 'string' || !Number.isFinite(Date.parse(occurrenceAt))
      || new Date(occurrenceAt).toISOString() !== occurrenceAt) {
      throw new SchedulerError('invalid_occurrence', 'A scheduled task needs its actual schedule id and canonical occurrence time')
    }
    const previous = this.scheduler.scheduledOccurrence(scheduleId, occurrenceAt)
    if (previous && previous.room !== room.id) throw new SchedulerError('plan_other_room', 'This scheduled occurrence belongs to another group')
    if (previous && !this.scheduler.scheduledRetryable(previous.plan_id)) {
      return { duplicate: true, planId: previous.plan_id }
    }
    const scope = { kind: 'group', room, botId: room.admin, bot: this.botState.bot(room.admin) }
    const planId = previous ? `scheduled-${digest([scheduleId, occurrenceAt, randomUUID()])}` : `scheduled-${digest([scheduleId, occurrenceAt])}`
    this.planScope({ planId, goal: title, children: [{ id: 'scheduled-task', member: memberId, goal: prompt, dependencies: [] }] },
      scope, { scheduleId, occurrenceAt, ...(previous ? { retryOf: previous.plan_id } : {}) })
    return this.dispatchScope(scope, planId)
  }

  planScope(args, scope, scheduled = null) {
    const children = Array.isArray(args.children) ? args.children : []
    const members = this.botState.members(scope.room)
    const byRef = new Map()
    for (const member of members) {
      byRef.set(member.id, member)
      byRef.set(member.name, member)
      byRef.set(member.name.toLowerCase(), member)
    }
    const normalized = []
    const gates = {}
    for (const [index, child] of children.entries()) {
      const member = byRef.get(child?.member) ?? byRef.get(String(child?.member ?? '').toLowerCase())
      if (!member) throw new SchedulerError('member_not_in_room', `Card #${index + 1}: "${child?.member}" is not a member of "${scope.room.name}"`)
      if (member.id === scope.botId) throw new SchedulerError('leader_cannot_assign_self', 'The principal cannot assign a card to itself')
      normalized.push({
        id: String(child?.id ?? ''),
        member: member.id,
        goal: String(child?.goal ?? ''),
        dependencies: Array.isArray(child?.dependencies) ? child.dependencies.map(String) : [],
      })
      if (typeof child?.confirm === 'string' && child.confirm.trim() !== '') gates[String(child.id ?? '')] = child.confirm.trim()
    }
    let workdir = null
    if (typeof args.workdir === 'string' && args.workdir.trim() !== '') {
      workdir = args.workdir.trim()
      if (!isAbsolute(workdir) || !existsSync(workdir) || !statSync(workdir).isDirectory()) {
        throw new SchedulerError('invalid_workdir', 'workdir must be an existing absolute directory')
      }
    }
    const planId = typeof args.planId === 'string' && args.planId.trim() !== '' ? args.planId.trim() : randomUUID()
    const openId = this.scheduler.currentPlanId(scope.room.id)
    if (openId && openId !== planId) {
      try {
        if (this.scheduler.planState(openId).status === 'open') {
          throw new SchedulerError('plan_already_open', `This group already has an open plan ${openId}; finish or cancel it first`)
        }
      } catch (error) {
        if (error instanceof SchedulerError && error.code === 'plan_already_open') throw error
      }
    }
    const goal = scope.room.goal
    const groupGoalId = !scheduled && ['drafting', 'active', 'paused'].includes(goal?.status) ? goal.id : ''
    const state = this.scheduler.createPlan({
      planId, room: scope.room.id, principal: scope.botId, goal: args.goal, groupGoalId,
      cards: normalized,
      concurrency: args.concurrency ?? 3,
      retryLimit: args.retryLimit ?? 1,
      testRequiredCards: args.testRequiredCards ?? [],
      testChecks: args.testChecks ?? {},
      confirmRequired: args.confirmRequired === true,
      gates,
      workdir,
      scheduled,
    })
    return {
      plan: this.decorate(state, scope.room),
      needs_owner_confirm: Object.keys(gates),
      next: 'Call taskflow_dispatch to send the ready cards; dependent cards follow verified results.',
    }
  }

  async dispatch(args, exec) {
    const scope = this.scope(exec, args.group, { leader: true })
    const state = this.planFor(scope, args.planId)
    const result = await this.dispatchScope(scope, state.plan_id)
    return result
  }

  plans(args, exec) {
    const scope = this.scope(exec, args.group, { leader: true })
    return { plans: this.scheduler.listPlans(scope.room.id), limit: 20, autoFollowUpEnabled: taskflowRoomEnabled(scope.room) }
  }

  status(args, exec) {
    const scope = this.scope(exec, args.group, { leader: false })
    const state = this.planFor(scope, args.planId)
    return { plan: this.decorate(state, scope.room) }
  }

  results(args, exec) {
    const scope = this.scope(exec, args.group, { leader: false })
    const state = this.planFor(scope, args.planId)
    const rows = []
    for (const card of state.cards) {
      const row = {
        card_id: card.id, member: card.member,
        member_name: this.botState.member(scope.room, card.member)?.name ?? card.member,
        state: card.state, attempts: card.attempts, dependencies: card.dependencies,
        goal: card.goal, fail_reason: card.fail_reason,
      }
      try {
        const payload = this.scheduler.resultPayload(state.plan_id, card.id)
        row.result = { status: payload.status, text: payload.text.slice(0, 8000), terminal_event_id: payload.terminal_event_id }
        row.evidence = `principal-result:${digest(payload)}`
      } catch { /* no result yet */ }
      try {
        const test = this.scheduler.testStatus(state.plan_id, card.id)
        if (test.required || test.run) row.test = test
      } catch { /* no test */ }
      if (card.confirm) row.confirm = card.confirm
      rows.push(row)
    }
    const allVerified = state.cards.every(card => card.state === 'verified')
    return {
      plan: this.decorate(state, scope.room),
      results: rows,
      pending_confirmations: this.scheduler.pendingConfirmations(state.plan_id).map(item => ({
        ...item, member_name: this.botState.member(scope.room, item.member)?.name ?? item.member,
      })),
      finish: allVerified && state.status === 'open' ? {
        snapshot: this.scheduler.completionSnapshot(state.plan_id),
        evidence: `principal-plan:${digest(this.scheduler.completionSnapshot(state.plan_id))}`,
      } : null,
    }
  }

  async accept(args, exec) {
    const scope = this.scope(exec, args.group, { leader: true })
    const state = this.planFor(scope, args.planId)
    const card = this.card(scope, state, args.cardId)
    const payload = this.scheduler.resultPayload(state.plan_id, card.id)
    const evidence = `principal-result:${digest(payload)}`
    const accepted = this.scheduler.acceptResult(state.plan_id, card.id, { principal: scope.botId, evidence })
    const dispatch = await this.dispatchScope(scope, state.plan_id)
    return { accepted, dispatch }
  }

  async reject(args, exec) {
    const scope = this.scope(exec, args.group, { leader: true })
    const state = this.planFor(scope, args.planId)
    const card = this.card(scope, state, args.cardId)
    const reason = String(args.reason ?? '').trim()
    if (reason === '') throw new SchedulerError('invalid_text', 'reason is required')
    const changed = this.scheduler.reworkCard(state.plan_id, card.id, { principal: scope.botId })
    const member = this.botState.member(scope.room, card.member)
    if (member) {
      await this.postToRoom(scope, `@${member.name} [Taskflow ${state.plan_id}/${card.id}] 被打回重做：${reason}`).catch(error => {
        this.log('warn', `taskflow: rework notice failed: ${error?.message ?? error}`)
      })
    }
    const dispatch = await this.dispatchScope(scope, state.plan_id)
    return { reworked: changed, dispatch }
  }

  async retry(args, exec) {
    const scope = this.scope(exec, args.group, { leader: true })
    const state = this.planFor(scope, args.planId)
    const card = this.card(scope, state, args.cardId)
    let changed
    if (card.state === 'unknown') {
      changed = this.scheduler.resolveUnknown(state.plan_id, card.id, { principal: scope.botId, decision: args.decision === 'fail' ? 'fail' : 'retry' })
    } else {
      changed = this.scheduler.retryCard(state.plan_id, card.id, { principal: scope.botId })
    }
    const dispatch = changed.state === 'pending' ? await this.dispatchScope(scope, state.plan_id) : null
    return { changed, dispatch }
  }

  async verify(args, exec) {
    const scope = this.scope(exec, args.group, { leader: true })
    const state = this.planFor(scope, args.planId)
    const card = this.card(scope, state, args.cardId)
    const spec = this.scheduler.childTestSpec(state.plan_id, card.id)
    const payload = this.scheduler.resultPayload(state.plan_id, card.id)
    const terminal = payload.terminal_event_id
    await this.approveTest({ exec, planId: state.plan_id, cardId: card.id, spec })
    this.scheduler.admitTests(state.plan_id, card.id, { terminal })
    const outcome = await runTest(spec.command, spec.workdir, 60_000)
    return {
      test: this.scheduler.finishTests(state.plan_id, card.id, { terminal, result: outcome }),
      outcome,
    }
  }

  async confirm(args, exec) {
    const scope = this.scope(exec, args.group, { leader: true })
    const state = this.planFor(scope, args.planId)
    const card = this.card(scope, state, args.cardId)
    const result = this.scheduler.resultPayload(state.plan_id, card.id)
    await this.approveConfirmation({ exec, planId: state.plan_id, cardId: card.id, decision: args.decision, result })
    return { decision: this.scheduler.decideConfirmation(state.plan_id, args.cardId, {
      principal: scope.botId, decision: args.decision, note: args.note ?? '', expectedTerminal: result.terminal_event_id,
    }) }
  }

  async submit(args, exec) {
    const scope = this.scope(exec, args.group, { leader: false })
    let state = this.planFor(scope, args.planId)
    let card = this.card(scope, state, args.cardId)
    if (card.member !== scope.botId) throw new SchedulerError('not_card_executor', `Card ${card.id} belongs to ${card.member}`)
    // A group mention can start this turn before dispatch finishes binding.
    for (let attempt = 0; card.state === 'dispatching' && attempt < 50; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100))
      state = this.planFor(scope, args.planId)
      card = this.card(scope, state, args.cardId)
    }
    if (card.state !== 'running' || !card.receipt) {
      throw new SchedulerError('card_not_running', `Card ${card.id} is ${card.state}; retry once dispatch finishes`)
    }
    const status = args.status === 'failed' ? 'failed' : 'settled'
    const observed = this.scheduler.observeResult(state.plan_id, card.id, {
      status,
      terminalEventId: `dsh:${randomUUID()}`,
      member: scope.botId,
      receipt: card.receipt,
      text: String(args.result ?? ''),
    })
    const result = this.scheduler.resultPayload(state.plan_id, card.id)
    const failure = status === 'failed' ? this.scheduler.settleFailure(state.plan_id, card.id) : null
    const admin = this.botState.admin(scope.room)
    if (admin) {
      const reasons = failure?.state === 'failed'
        ? this.scheduler.failureReasons(state.plan_id, card.id).map((reason, index) => `${index + 1}. ${reason}`).join('；')
        : ''
      const message = status === 'settled' ? '已提报，等待逐卡验收' : failure.state === 'pending'
        ? `第 ${failure.attempts}/${failure.limit} 次执行失败：${String(args.result ?? '').slice(0, 250)}；正在自动重试`
        : `重试耗尽（${failure.attempts}/${failure.limit}）：${reasons}；依赖卡已停止，请决定重派或取消`
      await this.postToRoom(scope, `@${admin.name} [Taskflow ${state.plan_id}/${card.id}] ${message}。\n\n${result.text}`, undefined,
        this.taskEvent(scope, state, card, status === 'settled' ? 'submitted' : 'failed', scope.room.admin))
        .catch(error => this.log('warn', `taskflow: result notice failed: ${error?.message ?? error}`))
    }
    let dispatch = null
    if (failure?.state === 'pending') {
      const room = this.botState.room(state.room)
      const current = this.scheduler.planState(state.plan_id)
      if (room && current.status === 'open' && this.botState.admin(room)?.id === current.principal) {
        dispatch = await this.dispatchScope({ room, botId: current.principal }, state.plan_id)
      }
    }
    return {
      observed, dispatch,
      evidence: status === 'settled' ? `principal-result:${digest(this.scheduler.resultPayload(state.plan_id, card.id))}` : null,
    }
  }

  finish(args, exec) {
    const scope = this.scope(exec, args.group, { leader: true })
    const state = this.planFor(scope, args.planId)
    const snapshot = this.scheduler.completionSnapshot(state.plan_id)
    const evidence = `principal-plan:${digest(snapshot)}`
    const finished = this.scheduler.finishPlan(state.plan_id, {
      principal: scope.botId, expectedSnapshot: snapshot, evidence,
    })
    const deferred = this.reflectionDeferred(scope.room, finished)
    return { finished, plan: this.decorate(finished, scope.room),
      next: deferred ? 'group_goal' : 'taskflow_sleep_consolidate',
      followUp: `${deferred ? '本阶段已验收。项目总验收前不要安排、撰写或汇总心得。' : `旧计划 ${state.plan_id} 已完成；后续调用 taskflow_sleep_pending 和 taskflow_sleep_consolidate 时必须显式传入该 planId，即使期间创建了新计划。`} 结合已验收结果和用户整体目标，主动判断是否需要其他合适成员继续；调用 taskflow_plans 核对本群最近20个计划和 autoFollowUpEnabled。若 autoFollowUpEnabled 为 false 则不自动新建或派发后续计划；结果不含更早历史，不能据此断言绝无重复。遵守用户限定、审批及未知送达约束，确需继续时创建并派发后续计划；无后续或受阻时说明原因。` }
  }

  async cancel(args, exec) {
    const scope = this.scope(exec, args.group, { leader: true })
    const state = this.planFor(scope, args.planId)
    const reason = String(args.reason ?? '').trim()
    if (reason === '') throw new SchedulerError('invalid_text', 'reason is required')
    const pending = this.scheduler.requestCancel(state.plan_id, { principal: scope.botId, reason })
    if (pending.stop_members.length && typeof this.stopMemberWork !== 'function') {
      throw new SchedulerError('stop_unavailable', 'Cannot stop running group work; cancellation remains pending')
    }
    const failures = []
    for (const memberId of pending.stop_members) {
      try {
        await this.stopMemberWork(scope.room.id, memberId)
      } catch (error) {
        failures.push(error)
        this.log('warn', `taskflow: stop for ${memberId} failed: ${error?.message ?? error}`)
      }
    }
    if (failures.length) throw failures[0]
    const canceled = this.scheduler.finishCancel(state.plan_id, { principal: scope.botId })
    const admin = this.botState.admin(scope.room)
    if (admin) {
      await this.postToRoom(scope, `@${admin.name} [Taskflow ${state.plan_id}] 已取消：${reason}`)
        .catch(error => this.log('warn', `taskflow: cancel notice failed: ${error?.message ?? error}`))
    }
    return { canceled, next: 'Tell the owner in the group why the plan was cancelled' }
  }

  async requestGoalReflections(room, goalId) {
    const goal = room.goal
    if (goal?.id !== goalId || goal.status !== 'complete') return []
    const eligible = this.scheduler.plansAwaitingReflection(room.id)
      .filter(plan => !plan.reflection_released && this.reflectionGoal(room, plan)?.id === goalId)
    this.scheduler.releaseReflections(room.id, goalId, eligible)
    if (!taskflowRoomEnabled(room)) return []
    const scope = { room, botId: room.admin }
    const plans = []
    for (const plan of eligible) {
      if (plan.status !== 'completed') continue
      plans.push(plan.plan_id)
      for (const cardId of this.scheduler.pendingNotes(plan.plan_id)) {
        try {
          const card = this.scheduler.cardView(plan.plan_id, cardId)
          const event = this.taskEvent(scope, plan, card, 'notice', card.member)
          await this.postToRoom(scope, `@${event.to.name} [Taskflow ${plan.plan_id}/${card.id}] 项目已通过总验收。请用 taskflow_sleep_note 为这张卡提交心得。`, undefined, event)
        } catch (error) {
          this.log('warn', `taskflow: project reflection request failed: ${error?.message ?? error}`)
        }
      }
    }
    return plans
  }

  sleepNote(args, exec) {
    const scope = this.scope(exec, args.group, { leader: false })
    const state = this.planFor(scope, args.planId)
    this.requireReflectionReady(scope.room, state)
    const text = reflectionText(args.text)
    const fingerprint = reflectionFingerprint(text)
    return { note: this.scheduler.note(state.plan_id, args.cardId, {
      member: scope.botId, text,
      isDuplicate: peer => duplicateReflection(fingerprint, reflectionFingerprint(peer)),
    }) }
  }

  async notifySavedNote(args, exec, note) {
    try {
      const scope = this.scope(exec, args.group, { leader: false })
      const state = this.planFor(scope, args.planId)
      const card = this.card(scope, state, args.cardId)
      const admin = this.botState.member(scope.room, scope.room.admin)
      if (!admin) throw new SchedulerError('member_not_in_room', 'The principal left the group')
      await this.postToRoom(scope, `@${admin.name} [Taskflow ${state.plan_id}/${card.id}] 心得已保存，等待主理汇总。\n\n${note.text}`, undefined,
        this.taskEvent(scope, state, card, 'reflection', scope.room.admin))
      return { sent: true }
    } catch (error) {
      this.log('warn', `taskflow: note saved but notification failed: ${error?.message ?? error}`)
      return { sent: false, reason: String(error?.message ?? error) }
    }
  }

  sleepPending(args, exec) {
    const scope = this.scope(exec, args.group, { leader: true })
    const state = this.planFor(scope, args.planId)
    if (this.reflectionDeferred(scope.room, state)) {
      return { plan_id: state.plan_id, deferred: true, pending_cards: [], notes: [], insight: null }
    }
    return {
      plan_id: state.plan_id,
      pending_cards: this.scheduler.pendingNotes(state.plan_id),
      notes: this.scheduler.listNotes(state.plan_id),
      insight: this.scheduler.planInsight(state.plan_id),
    }
  }

  sleepConsolidate(args, exec) {
    const scope = this.scope(exec, args.group, { leader: true })
    const state = this.planFor(scope, args.planId)
    this.requireReflectionReady(scope.room, state)
    if (!this.knowledge) throw new SchedulerError('knowledge_unavailable', 'The long-term knowledge database is unavailable')
    const text = reflectionText(args.text)
    this.knowledge.stageSources(scope.room.id, state.plan_id, this.scheduler.listNotes(state.plan_id))
    const insight = this.scheduler.consolidate(state.plan_id, {
      principal: scope.botId, title: String(args.title ?? ''), text,
    })
    const accepted = state.cards.filter(card => card.state === 'verified').map(card => card.goal).join('；')
    this.knowledge.addInsight({ room: scope.room.id, planId: state.plan_id,
      title: insight.title, text: insight.text, acceptance: accepted })
    return { insight, publication: this.knowledge.insightPublication(scope.room.id, state.plan_id) }
  }

  skillInsights(args, exec) {
    const scope = this.scope(exec, undefined, { leader: true })
    if (scope.kind !== 'group') throw new SchedulerError('group_session_required', 'Use your group session')
    if (!this.knowledge) throw new SchedulerError('knowledge_unavailable', 'The long-term knowledge database is unavailable')
    return this.knowledge.methodInsights(scope.room.id, args.offset ?? 0)
  }

  skillProposeMethod(args, exec) {
    const scope = this.scope(exec, undefined, { leader: true })
    if (scope.kind !== 'group') throw new SchedulerError('group_session_required', 'Use your group session')
    if (!this.knowledge) throw new SchedulerError('knowledge_unavailable', 'The long-term knowledge database is unavailable')
    const result = this.knowledge.proposeMethod(scope.room.id, args.title, args.sources, args.previewDigest)
    return result.status === 'preview' ? { preview: result } : { draft: result }
  }

  skillCandidates(args, exec) {
    const scope = this.scope(exec, undefined, { leader: true })
    if (scope.kind !== 'group') throw new SchedulerError('group_session_required', 'Use your group session')
    return { drafts: this.knowledge?.candidates(scope.room.id).filter(row => row.status === 'draft') ?? [] }
  }

  skillReview(args, exec) {
    const scope = this.scope(exec, undefined, { leader: true })
    if (scope.kind !== 'group') throw new SchedulerError('group_session_required', 'Use your group session')
    const draft = this.knowledge?.candidates(scope.room.id).find(row => row.id === args.id)
    if (!draft) throw new SchedulerError('skill_not_found', 'No draft in this group')
    return { draft: this.knowledge.review(draft.id, { kind: 'bot', reviewer: scope.botId, approved: args.approved }) }
  }

  async skillConsolidate(args, exec) {
    const scope = this.scope(exec, undefined, { leader: true })
    if (scope.kind !== 'group') throw new SchedulerError('group_session_required', 'Use your group session')
    const draft = this.knowledge?.candidates(scope.room.id).find(row => row.id === args.id)
    const body = String(args.text ?? '').trim()
    const tags = skillTags(args.tags, { required: true })
    if (draft?.status === 'approved' && draft.text === body) {
      if (tagsDigest(draft.tags) !== tagsDigest(tags)) throw new SchedulerError('skill_tags_conflict', 'The approved classification differs')
      return { skill: draft, publication: this.knowledge.skillPublication(scope.room.id, draft.tier, draft.id) }
    }
    if (!draft || draft.status !== 'draft' || !draft.bot_review) {
      throw new SchedulerError('bot_review_required', 'The current group leader must approve this draft first')
    }
    if (!body || body.length > 12000) throw new SchedulerError('invalid_text', 'Provide reviewed skill text')
    if (!draft.owner_review) {
      const sources = this.knowledge.reviewEvidence(scope.room.id, draft.id)
      await this.approveSkill({ exec, draft, text: body, tags: [...tags], sources })
      const current = this.knowledge.candidates(scope.room.id).find(row => row.id === draft.id)
      const caller = this.scope(exec, undefined, { leader: true })
      if (caller.room.id !== scope.room.id || caller.botId !== scope.botId || this.botState.room(scope.room.id)?.admin !== scope.botId || current?.status !== 'draft'
        || current.bot_review !== draft.bot_review || current.owner_review !== null
        || JSON.stringify(this.knowledge.reviewEvidence(scope.room.id, draft.id)) !== JSON.stringify(sources)) {
        throw new SchedulerError('draft_changed_during_approval', 'Review changed while awaiting human approval')
      }
      this.knowledge.review(draft.id, { kind: 'owner', reviewer: 'human-owner', approved: true, text: body, tags })
    }
    const skill = this.knowledge.consolidate(draft.id, body, tags)
    return { skill, publication: this.knowledge.skillPublication(scope.room.id, skill.tier, skill.id) }
  }

  async skillPublish(args, exec) {
    const scope = this.scope(exec, undefined, { leader: true })
    const skill = this.knowledge.openSkill(scope.room.id, 'premium', args.id)
    if (skill.room !== scope.room.id) throw new SchedulerError('skill_not_accessible', 'Only its source group may publish this skill')
    const hash = contentDigest(skill.text)
    const sources = this.knowledge.reviewEvidence(scope.room.id, skill.id)
    const sourcesHash = this.knowledge.sourcesDigest(scope.room.id, skill.id)
    await this.approveShare({ exec, skill, sources, sourcesHash })
    const current = this.scope(exec, undefined, { leader: true })
    if (current.room.id !== scope.room.id || current.botId !== scope.botId) {
      throw new SchedulerError('caller_changed_during_approval', 'The sharing caller changed while awaiting approval')
    }
    return { publication: this.knowledge.publishShared(scope.room.id, skill.id, 'human-owner', hash, sourcesHash) }
  }

  skillUnpublish(args, exec) {
    const scope = this.scope(exec, undefined, { leader: true })
    return this.knowledge.unpublishShared(scope.room.id, args.id)
  }

  skillLevel(_args, exec) {
    const scope = this.scope(exec)
    if (scope.kind !== 'group') throw new SchedulerError('group_session_required', 'Use your group session')
    return { level: this.scheduler.botLevel(scope.room.id, scope.botId) }
  }

  skillSearch(args, exec) {
    const scope = this.scope(exec)
    if (scope.kind !== 'group') throw new SchedulerError('group_session_required', 'Use your group session')
    const level = this.scheduler.botLevel(scope.room.id, scope.botId)
    return { level, skills: this.knowledge?.searchSkills(scope.room.id, level.tier, args.query, args.tags) ?? [] }
  }

  skillOpen(args, exec) {
    const scope = this.scope(exec)
    if (scope.kind !== 'group') throw new SchedulerError('group_session_required', 'Use your group session')
    const level = this.scheduler.botLevel(scope.room.id, scope.botId)
    if (!this.knowledge) throw new SchedulerError('skill_not_accessible', 'No approved skill in this group')
    const skill = this.knowledge.openSkill(scope.room.id, level.tier, args.id)
    const publication = this.knowledge.skillPublication(scope.room.id, level.tier, args.id)
    const content = readPublishedSkill(publication)
    const session = exec.session?.id ?? exec.agent?.session?.id ?? exec.agent?.id ?? scope.botId
    const key = exec.callId ?? exec.toolCallId ?? exec.requestId ?? randomUUID()
    this.knowledge.recordSkillUse(scope.room.id, scope.botId, session, skill.id, JSON.stringify([session, scope.botId, key]))
    return { level, skill, publication: { path: publication.path, digest: publication.digest }, content }
  }

  skillScore(args, exec) {
    const scope = this.scope(exec, undefined, { leader: true })
    if (scope.kind !== 'group') throw new SchedulerError('group_session_required', 'Score in the source group')
    if (!this.knowledge) throw new SchedulerError('knowledge_unavailable', 'The long-term knowledge database is unavailable')
    if (!args.cycleId) {
      if (args.ratings) throw new SchedulerError('cycle_required', 'Select the exact pending cycle')
      return { pending: this.knowledge.lifecycle.due(scope.room.id) }
    }
    const rating = this.knowledge.lifecycle.rate(scope.room.id, args.cycleId, scope.botId, args.ratings)
    return { rating, cleanup: this.knowledge.lifecycle.cleanup() }
  }

  memorySearch(args, exec) {
    const scope = this.scope(exec)
    if (scope.kind !== 'group') throw new SchedulerError('group_session_required', 'Search from your current group session')
    const current = this.scheduler.searchMarks(scope.room.id, args.query)
    const archived = this.knowledge?.searchArchivedMarks(scope.room.id, args.query) ?? []
    const seen = new Set(current.map(mark => mark.keyword))
    return { matches: [...current, ...archived.filter(mark => !seen.has(mark.keyword))] }
  }

  memoryOpen(args, exec) {
    const scope = this.scope(exec)
    if (scope.kind !== 'group') throw new SchedulerError('group_session_required', 'Open from your current group session')
    try { return { node: this.scheduler.openMark(scope.room.id, args.keyword) } }
    catch (error) {
      if (!(error instanceof SchedulerError) || !['mark_not_found', 'node_not_found'].includes(error.code)) throw error
      if (!this.knowledge) throw error
      return { node: this.knowledge.openArchivedMark(scope.room.id, args.keyword) }
    }
  }
}

function runTest(command, workdir, timeoutMs) {
  return new Promise(resolve => {
    let child
    let settled = false
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try { child?.kill('SIGKILL') } catch { /* already gone */ }
      finish({ exit_code: null, error: `test timeout after ${timeoutMs} ms` })
    }, timeoutMs)
    try {
      child = spawn(command, { cwd: workdir, shell: true, windowsHide: true, stdio: 'ignore' })
      child.once('error', error => finish({ exit_code: null, error: error.message }))
      child.once('exit', (code, signal) => finish({ exit_code: code, ...(signal ? { error: `signal:${signal}` } : {}) }))
    } catch (error) {
      finish({ exit_code: null, error: error.message })
    }
  })
}
