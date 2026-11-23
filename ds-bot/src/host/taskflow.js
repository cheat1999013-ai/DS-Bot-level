// Native taskflow: one DS Bot-owned ledger, tool catalog, and authenticated state view.
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BotState } from './taskflow/state.js'
import { Scheduler, digest } from './taskflow/scheduler.js'
import { Knowledge } from './taskflow/knowledge.js'
import { Retention } from './taskflow/retention.js'
import { buildToolDefinitions, TaskflowService } from './taskflow/tools.js'
import { install as installTaskflowSkill } from './taskflow-skills.js'
import { taskflowReference } from '../shared/taskflow-message.js'
import { installKnowledgeRuntime } from './taskflow/knowledge-runtime.js'
import { groupAssignments } from './taskflow/group-activity.js'
import { createTaskflowContinuation } from './taskflow/continuation.js'
import { createTaskflowRecovery, hasExecutingWorker } from './taskflow/recovery.js'
import { installTaskflowMonitor, taskflowRoomEnabled } from './taskflow/monitor.js'
import { install as installSkillIndex } from './skill-index.js'

const READS = new Set(['taskflow_members', 'taskflow_plans', 'taskflow_skill_insights', 'taskflow_status', 'taskflow_results', 'taskflow_sleep_pending',
  'taskflow_memory_search', 'taskflow_memory_open', 'taskflow_skill_candidates', 'taskflow_skill_level',
  'taskflow_skill_search', 'taskflow_skill_open', 'skill_index_search', 'skill_index_status', 'skill_index_classify'])

const ledgerPaths = rt => ({
  legacy: join(rt.home, 'taskflow.sqlite'),
  current: join(rt.taskflowHome ?? join(rt.home, 'plugin-data', 'hermes-bot-taskflow'), 'coordination.sqlite'),
})

async function ledgerFile(rt, locked) {
  const { legacy, current } = ledgerPaths(rt)
  if (locked) return existsSync(current) ? current : existsSync(legacy) ? legacy : null
  mkdirSync(rt.taskflowHome ?? join(rt.home, 'plugin-data', 'hermes-bot-taskflow'), { recursive: true })
  if (!existsSync(legacy)) return current
  const { DatabaseSync, backup } = await import('node:sqlite')
  if (!existsSync(current)) {
    const old = new DatabaseSync(legacy, { readOnly: true })
    try { await backup(old, current) } finally { old.close() }
    const copied = new DatabaseSync(current)
    try {
      if (copied.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('The copied taskflow ledger failed integrity check')
      copied.exec('CREATE TABLE IF NOT EXISTS migration_meta (source TEXT PRIMARY KEY, at REAL NOT NULL)')
      copied.prepare('INSERT OR IGNORE INTO migration_meta(source,at) VALUES(?,?)').run('taskflow.sqlite', Date.now() / 1000)
    } finally { copied.close() }
  } else {
    const copied = new DatabaseSync(current, { readOnly: true })
    try {
      const mark = copied.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='migration_meta'").get()
      if (!mark || !copied.prepare('SELECT 1 FROM migration_meta WHERE source=?').get('taskflow.sqlite')) {
        throw new Error('Taskflow migration is incomplete; keep both databases and repair the copy before starting')
      }
    } finally { copied.close() }
  }
  return current
}

async function requireUserApproval(rt, exec, toolName, reason, zh) {
  const approval = rt.ctx.get?.('approval')
  const agent = exec?.agent ?? exec
  if (!approval?.request || !agent?.session) {
    throw new Error('This action needs the user\'s approval, and approval is unavailable here')
  }
  const outcome = await approval.request({ agent, toolName,
    ...(exec?.callId ? { callId: exec.callId } : {}),
    reason, displayReason: { en: reason, zh },
    ...(exec?.signal ? { signal: exec.signal } : {}),
  })
  if (outcome !== 'allowed-once') throw new Error('The user did not approve this action; nothing was done')
}

export function install(rt) {
  const state = new BotState(rt)
  let scheduler
  let knowledge
  let service
  let schedulerReadOnly = false
  let sweeping = false
  let progressOpening
  rt.taskflowContinuation = createTaskflowContinuation(rt, state, () => scheduler)
  const recovery = createTaskflowRecovery(rt, state, () => scheduler)
  rt.taskflowClaimRecovery = recovery.claim
  rt.taskflowCanDeliverReminder = (room, event) => scheduler && taskflowRoomEnabled(room)
    && room.admin === event.to?.id && scheduler.planState(event.planId).status === 'open'
    && !hasExecutingWorker(rt, scheduler, room)
  const start = async (name) => {
    await rt.load()
    const locked = rt.readOnly() !== undefined
    if (locked && !READS.has(name)) throw new Error(rt.readOnly())
    if (scheduler && schedulerReadOnly && !locked) {
      scheduler.close()
      knowledge?.close()
      scheduler = undefined
      knowledge = undefined
      service = undefined
    }
    if (!scheduler) {
      const file = await ledgerFile(rt, locked)
      if (!file) return null
      const home = rt.taskflowHome ?? join(rt.home, 'plugin-data', 'hermes-bot-taskflow')
      const knowledgePath = join(home, 'knowledge.sqlite')
      scheduler = new Scheduler(file, { recoverOnOpen: !locked, readOnly: locked })
      try { knowledge = locked && !existsSync(knowledgePath) ? null : new Knowledge(knowledgePath, { readOnly: locked }) }
      catch (error) {
        scheduler.close()
        scheduler = undefined
        throw error
      }
      schedulerReadOnly = locked
      service = new TaskflowService({
        botState: state, scheduler, knowledge,
        stopMemberWork: (roomId, memberId) => rt.stopMemberWork(roomId, memberId),
        notifyStart: async ({ scope, member, card }) => {
          await rt.taskflowNotice?.(scope.room, `[任务流] ${member.name} 开始执行 ${card.goal}，模型 ${member.model || '未指定'}`)
        },
        approveTest: async ({ exec, planId, cardId, spec }) => {
          const reason = `Run the taskflow test for ${planId}/${cardId}?\n\n${spec.command}\n\nWorking directory: ${spec.workdir}`
          await requireUserApproval(rt, exec, 'taskflow_verify', reason,
            `运行任务流测试 ${planId}/${cardId}？\n\n${spec.command}\n\n工作目录：${spec.workdir}`)
        },
        approveConfirmation: async ({ exec, planId, cardId, decision, result }) => {
          const reason = `Confirm taskflow ${planId}/${cardId} as ${decision}?\n\n${result.text}`
          await requireUserApproval(rt, exec, 'taskflow_confirm', reason,
            `将任务流 ${planId}/${cardId} 确认为 ${decision}？\n\n${result.text}`)
        },
        approveSkill: async ({ exec, draft, text, sources, tags }) => {
          const evidence = sources.map(source => `• ${source.id} ${source.title}: ${source.text}${source.acceptance ? `（验收：${source.acceptance}）` : ''}${source.method ? `\n方法步骤证据：${source.method.step}\n验证证据：${source.method.validation}` : ''}`).join('\n')
          const details = `Group: ${draft.room}\nTier: ${draft.tier}\nTitle: ${draft.title}\nTags: ${(tags ?? []).join('、')}\nSources:\n${evidence}\n\nReviewed text:\n${text}`
          await requireUserApproval(rt, exec, 'taskflow_skill_consolidate',
            `Approve this Bot-reviewed skill?\n\n${details}`,
            `人工审核这份 Bot 已审核的技能？\n\n${details}`)
        },
        approveShare: async ({ exec, skill, sources, sourcesHash }) => {
          const evidence = sources.map(source => `• ${source.id} ${source.title}\n正文摘录：${source.text}\n验收摘录：${source.acceptance || '未保留验收摘要'}${source.review ? `\n上级 Bot 审核人：${source.review.bot}\n上级人工审核人：${source.review.owner}\n批准正文摘要：${source.review.textDigest}` : ''}\n完整来源摘要：${source.digest}`).join('\n\n')
          const details = `Group: ${skill.room}\nTier: ${skill.tier}\nTitle: ${skill.title}\nTags: ${(skill.tags ?? []).join('、')}\nSources:\n${evidence}\n\nEvidence digest: ${sourcesHash}\n\nReviewed text:\n${skill.text}`
          await requireUserApproval(rt, exec, 'taskflow_skill_publish',
            `Publish this skill to the cross-group shared library?\n\n${details}`,
            `将这份技能发布到跨群共享库？\n\n${details}`)
        },
        post: async ({ scope, text, taskflow, taskflowEvent }) => {
          await rt.load()
          if (rt.readOnly() !== undefined) throw new Error(rt.readOnly())
          const room = state.room(scope.room.id)
          const sender = state.bot(scope.botId)
          if (!room || !room.members.includes(scope.botId) || !sender) throw new Error('The taskflow sender is no longer in this group')
          if (taskflowEvent?.recovery?.kind === 'reminder'
            && !rt.taskflowCanDeliverReminder(room, taskflowEvent)) return false
          if (taskflow && !room.members.includes(taskflow.member)) throw new Error('The taskflow worker is no longer in this group')
          if (taskflowEvent && (taskflowEvent.from?.id !== scope.botId || !room.members.includes(taskflowEvent.to?.id))) {
            throw new Error('The task card sender or recipient is no longer in this group')
          }
          if (taskflow) rt.taskflowQuietWorker?.(room.id, taskflow.member, true)
          try {
            const reference = taskflowEvent ?? taskflowReference(text)
            const event = reference?.planId ? {
              ...reference, event: reference.event ?? 'notice',
              from: reference.from ?? { id: sender.id, name: sender.name },
              to: reference.to ?? { id: room.admin, name: state.admin(room)?.name },
            } : null
            const deliver = event ? rt.postTaskToRoom : rt.postToRoom
            if (typeof deliver !== 'function') throw new Error('Native task delivery is unavailable; ordinary Bot fallback is forbidden')
            return await deliver(room, sender, text, { progress: true,
              ...(event ? { taskflowEvent: event, mentions: { ids: [event.to.id], all: false } } : {}),
              ...(taskflow ? { taskflow } : {}) })
          } catch (error) {
            if (taskflow) rt.taskflowQuietWorker?.(room.id, taskflow.member, false)
            throw error
          }
        },
        log: (_level, message) => rt.warn('ds-bot: %s', message),
      })
      if (!locked) new Retention(scheduler, knowledge).run({ rooms: state.rooms().map(room => room.id) })
    }
    return service
  }

  rt.taskflowRequestGoalReflections = async (roomId, goalId) => {
    const active = await start('taskflow_sleep_note')
    const room = state.room(roomId)
    return active && room ? active.requestGoalReflections(room, goalId) : []
  }

  rt.taskflowEscalate = async ({ roomId, planId, cardId }) => {
    const active = await start('taskflow_results')
    const room = state.room(roomId)
    if (!active || !room) return false
    return recovery.post(active, room, scheduler.planState(planId), cardId, 'exhausted')
  }

  rt.taskflowDispatchScheduled = async spec => {
    const active = await start('taskflow_dispatch')
    if (!active) throw new Error('Taskflow is unavailable')
    const room = state.room(spec.roomId)
    rt.assertGroupScheduleDelivery?.(spec.roomId, { event: 'assigned', schedule: { id: spec.scheduleId },
      from: { id: room?.admin }, to: { id: spec.memberId } })
    return active.dispatchScheduled(spec)
  }

  rt.taskflowTransferPrincipal = (roomId, from, to) => {
    if (!from || from === to) return
    if (rt.readOnly() !== undefined) throw new Error(rt.readOnly())
    if (scheduler) return scheduler.transferPrincipal(roomId, from, to)
    const { legacy, current } = ledgerPaths(rt)
    const file = existsSync(current) ? current : legacy
    if (!existsSync(file)) return
    const db = new Scheduler(file, { recoverOnOpen: false })
    try { return db.transferPrincipal(roomId, from, to) } finally { db.close() }
  }
  rt.taskflowIsQuietWorker = (roomId, botId) => {
    if (scheduler) return scheduler.isAssignedWorker(roomId, botId)
    const { current, legacy } = ledgerPaths(rt)
    const file = existsSync(current) ? current : existsSync(legacy) ? legacy : null
    if (!file) return false
    const db = new Scheduler(file, { readOnly: true, recoverOnOpen: false })
    try { return db.isAssignedWorker(roomId, botId) } finally { db.close() }
  }
  rt.taskflowPreflight = async ({ room: roomId, planId, cardId, decision, note = '' }) => {
    const active = await start('taskflow_confirm')
    if (!active) throw new Error('No taskflow plan exists')
    const room = state.room(roomId)
    if (!room || !room.admin || !room.members.includes(room.admin)) throw new Error('Group leader unavailable')
    const plan = scheduler.planState(planId)
    if (plan.room !== room.id) throw new Error('Plan belongs to another group')
    const card = plan.cards.find(item => item.id === cardId)
    if (!card || !room.members.includes(card.member)) throw new Error('Card worker is no longer in the group')
    const decided = scheduler.decidePreflight(planId, cardId, { decision, note, decidedBy: 'user' })
    const scope = { room, botId: room.admin }
    if (decision === 'approve') return { decided, dispatch: await active.dispatchScope(scope, planId) }
    await active.postToRoom(scope, `@${state.admin(room).name} [Taskflow ${planId}/${cardId}] 群主拒绝执行：${note || '请重新安排。'}`)
      .catch(error => rt.warn('ds-bot: taskflow rejection notice failed: %s', String(error?.message ?? error)))
    return { decided }
  }
  rt.taskflowResultConfirmation = async ({ room: roomId, planId, cardId, decision, note = '', terminal }) => {
    const active = await start('taskflow_confirm')
    if (!active) throw new Error('No taskflow plan exists')
    const room = state.room(roomId)
    if (!room?.admin || !room.members.includes(room.admin)) throw new Error('Group leader unavailable')
    const plan = scheduler.planState(planId)
    if (plan.room !== room.id) throw new Error('Plan belongs to another group')
    if (!room.members.includes(plan.principal) || !state.bot(plan.principal)) throw new Error('Group leader unavailable')
    const pending = scheduler.pendingConfirmations(planId).find(item => item.card_id === cardId)
    if (!pending || pending.terminal !== terminal) throw new Error('Submitted result changed; refresh before deciding')
    const decided = scheduler.decideConfirmation(planId, cardId, {
      principal: plan.principal, decision, note, expectedTerminal: terminal,
    })
    await active.postToRoom({ room, botId: plan.principal },
      `@${state.bot(plan.principal).name} [Taskflow ${planId}/${cardId}] 群主已${decision === 'approve' ? '同意' : '拒绝'}已提交结果；请继续处理。`)
      .catch(error => rt.warn('ds-bot: taskflow result confirmation notice failed: %s', String(error?.message ?? error)))
    return { decided }
  }
  rt.taskflowMemberLeft = async (roomId, botId) => {
    const { current, legacy } = ledgerPaths(rt)
    if (!existsSync(current) && !existsSync(legacy)) return []
    const active = await start('taskflow_submit')
    return active ? scheduler.failMemberCards(roomId, botId) : []
  }
  rt.taskflowMemberLeftNotice = async (roomId, botId, cards) => {
    if (!cards.length) return
    const room = state.room(roomId)
    if (!room?.admin) return
    const active = await start('taskflow_status')
    if (!active) return
    const summary = cards.map(card => `${card.planId}/${card.id}`).join(', ')
    await active.postToRoom({ room, botId: room.admin },
      `@${state.admin(room).name} [Taskflow] Bot ${botId} 已退群，卡片 ${summary} 已停止；请判断是否重新派工。`)
  }
  rt.teamTools.push(...buildToolDefinitions(defineTool, start))
  installTaskflowSkill(rt)
  installKnowledgeRuntime(rt, start, state)
  installSkillIndex(rt, start, state)
  const skillUses = new Map()
  const skillKey = (roomId, botId) => JSON.stringify([roomId, botId])
  rt.noteTaskflowSkill = (roomId, botId, name, at = Date.now()) => {
    if (!roomId || !botId || typeof name !== 'string' || !name || name.length > 256) return
    const key = skillKey(roomId, botId)
    const recent = skillUses.get(key) ?? []
    skillUses.set(key, [{ name, at: at / 1000 }, ...recent])
  }
  const skillNames = (roomId, botId, within = () => true) => [...new Set(
    (skillUses.get(skillKey(roomId, botId)) ?? []).filter(within).map(use => use.name))]
  const usedSkillsFor = (roomId, card) => Number.isFinite(card.started_at)
    ? skillNames(roomId, card.member, use => use.at >= card.started_at && (card.ended_at == null || use.at <= card.ended_at)) : []
  const observedFor = (room, plans = []) => {
    const tasks = groupAssignments(room, rt.state.bots, plans)
    return tasks.map(card => {
      const from = card.source.at
      const next = tasks.filter(other => other.member === card.member && other.source.seq > card.source.seq
        && Number.isFinite(other.source.at) && other.source.at >= from)
        .reduce((end, other) => Math.min(end, other.source.at), Infinity)
      return { ...card, usedSkills: Number.isFinite(from)
        ? skillNames(room.id, card.member, use => use.at >= from && use.at < next) : [] }
    })
  }
  const membersOf = room => {
    if (!room) return {}
    const library = rt.state.capabilities?.items ?? {}
    const work = rt.workView?.() ?? {}
    const hasLevels = scheduler?.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_rewards'").get()
    return Object.fromEntries(state.members(room).map(member => {
      const bot = state.bot(member.id)
      const attached = (bot?.capabilities ?? []).flatMap(name => {
        const item = library[name]
        return item?.kind === 'pack' ? item.items ?? [] : [name]
      })
      const skills = [...new Set(attached.filter(name => library[name]?.kind === 'skill'))]
      const active = work[member.id]
      return [member.id, { id: member.id, name: member.name, avatar: bot?.avatar,
        color: bot?.color, model: member.model, skills, usedSkills: skillNames(room.id, member.id),
        level: hasLevels ? scheduler.botLevel(room.id, member.id) : null,
        tool: active?.roomId === room.id ? active.tool ?? null : null }]
    }))
  }
  rt.taskflowView = async ({ room: ref, all = false, timelineBefore = null, currentOnly = false } = {}) => {
    const active = await start('taskflow_status')
    const rooms = state.rooms()
    const scopeAll = all === true
    const selected = scopeAll ? null : ref ? state.room(ref) : null
    if (ref && !scopeAll && !selected) throw new Error('Unknown group chat')
    if (!active) {
      const room = selected ?? rooms[0] ?? null
      return { generatedAt: Date.now(), rooms: rooms.map(item => ({ id: item.id, name: item.name, admin: state.member(item, item.admin)?.id ?? null, planId: null, planStatus: null })),
        room: room ? { id: room.id, name: room.name, admin: state.member(room, room.admin)?.id ?? null, adminName: state.admin(room)?.name ?? null } : null,
        membersByRoom: Object.fromEntries((scopeAll ? rooms : [room]).filter(Boolean).map(item => [item.id, membersOf(item)])),
        members: scopeAll ? Object.assign({}, ...rooms.map(membersOf)) : membersOf(room), plan: null, plans: [], timeline: [],
        observedTasks: (scopeAll ? rooms : [room]).filter(Boolean).flatMap(item => observedFor(item)) }
    }
    const listed = (scopeAll ? rooms : [selected ?? rooms.find(item => scheduler.currentPlanId(item.id)) ?? rooms[0]].filter(Boolean))
      .flatMap(item => scheduler.listPlans(item.id).map(plan => ({ ...plan, roomName: item.name })))
      .sort((a, b) => b.created_at - a.created_at).slice(0, 20)
    const planId = !scopeAll && selected ? scheduler.currentPlanId(selected.id) ?? listed[0]?.plan_id : listed[0]?.plan_id
    const room = planId ? state.room(listed.find(item => item.plan_id === planId)?.room ?? selected?.id) : selected ?? rooms[0] ?? null
    const plans = scopeAll ? listed : room ? scheduler.listPlans(room.id) : []
    const decoratePlan = (id, origin) => {
      const plan = active.decorate(scheduler.planState(id), origin)
      const accepted = new Set(scheduler.events(id)
        .filter(event => event.type === 'result_accepted').map(event => event.card_id))
      plan.cards = plan.cards.map(card => {
        card.usedSkills = usedSkillsFor(origin.id, card)
        card.comments = scheduler.cardComments(id, card.id)
        try {
          const payload = scheduler.resultPayload(id, card.id)
          card.result = payload.text.slice(0, 4000)
          card.result_status = payload.status
          if (accepted.has(card.id)) card.evidence = `principal-result:${digest(payload)}`
        } catch { /* not submitted */ }
        try {
          const test = scheduler.testStatus(id, card.id)
          if (test.required || test.run) card.test = test
        } catch { /* no test */ }
        return card
      })
      plan.pending_confirmations = [...scheduler.pendingPreflight(id), ...scheduler.pendingConfirmations(id)].map(item => ({
        ...item, stage: item.stage ?? 'after_result',
        ...(item.terminal ? { result: scheduler.resultPayload(id, item.card_id).text } : {}),
        member_name: state.member(origin, item.member)?.name ?? item.member,
      }))
      plan.insight = scheduler.planInsight(id)
      return plan
    }
    const plan = planId ? decoratePlan(planId, room) : null
    const currentPlans = scopeAll ? rooms.flatMap(origin => {
      const current = scheduler.currentPlanId(origin.id)
      return current ? [{ origin, id: current }] : []
    }) : []
    const fullPlans = scopeAll ? [
      ...listed.map(item => item.plan_id === planId ? plan : decoratePlan(item.plan_id, state.room(item.room))),
      ...currentPlans.filter(item => !listed.some(plan => plan.plan_id === item.id && plan.room === item.origin.id))
        .map(item => decoratePlan(item.id, item.origin)),
    ] : undefined
    const timelineRooms = scopeAll ? rooms.map(item => item.id) : room ? [room.id] : []
    const planIds = currentOnly === true ? (scopeAll ? currentPlans.map(item => item.id) : planId ? [planId] : []) : null
    const page = scheduler.timelinePage(timelineRooms, { before: timelineBefore, planIds })
    return {
      generatedAt: Date.now(),
      rooms: rooms.map(item => {
        const current = scheduler.currentPlanId(item.id)
        return { id: item.id, name: item.name, admin: state.member(item, item.admin)?.id ?? null, planId: current,
          planStatus: current ? scheduler.planState(current).status : null }
      }),
      room: room ? { id: room.id, name: room.name, admin: state.member(room, room.admin)?.id ?? null, adminName: state.admin(room)?.name ?? null } : null,
      plan, fullPlans,
      observedTasks: (scopeAll ? rooms : [room]).filter(Boolean).flatMap(item => observedFor(item,
        scheduler.listPlans(item.id).map(saved => scheduler.planState(saved.plan_id)))),
      membersByRoom: Object.fromEntries((scopeAll ? rooms : [room]).filter(Boolean).map(item => [item.id, membersOf(item)])),
      members: scopeAll ? Object.assign({}, ...rooms.filter(item => item.id !== room?.id).map(membersOf), membersOf(room)) : membersOf(room),
      plans: plans.map(item => ({ plan_id: item.plan_id, status: item.status, card_count: item.card_count,
        verified_count: item.verified_count, created_at: item.created_at, room: item.room, roomName: item.roomName })),
      timelineNext: page.next,
      timelinePlanIds: scheduler.timelinePlanIds(timelineRooms),
      timeline: page.events.map(event => {
        const origin = state.room(event.room)
        return { ...event, room_name: origin?.name ?? event.room,
          member_name: event.member ? state.member(origin, event.member)?.name ?? event.member : null,
          principal_name: state.bot(event.principal)?.name ?? event.principal }
      }),
    }
  }
  rt.taskflowRecordProgress = (roomId, botId) => {
    if (rt.readOnly() !== undefined) return
    try {
      if (scheduler && !schedulerReadOnly) {
        scheduler.touchMemberProgress(roomId, botId)
        return
      }
      const { current, legacy } = ledgerPaths(rt)
      if (!existsSync(current) && !existsSync(legacy)) return
      progressOpening ??= start('taskflow_submit').finally(() => { progressOpening = undefined })
      void progressOpening.then(active => {
        if (active) scheduler.touchMemberProgress(roomId, botId)
      }).catch(error => rt.warn('ds-bot: taskflow progress: %s', String(error?.message ?? error)))
    } catch (error) { rt.warn('ds-bot: taskflow progress: %s', String(error?.message ?? error)) }
  }
  rt.taskflowSweep = async () => {
    if (sweeping || rt.readOnly() !== undefined) return []
    const { current, legacy } = ledgerPaths(rt)
    if (!existsSync(current) && !existsSync(legacy)) return []
    sweeping = true
    try {
      const active = await start('taskflow_submit')
      if (!active) return []
      const handled = []
      for (const room of state.rooms()) {
        if (!taskflowRoomEnabled(room) || !room.admin || !state.member(room, room.admin)) continue
        for (const saved of scheduler.listPlans(room.id).filter(plan => plan.status === 'open')) {
          const plan = scheduler.planState(saved.plan_id)
          if (plan.principal !== room.admin) continue
          for (const card of plan.cards.filter(card => card.state === 'running' && !card.terminal_event_id)) {
            if (await recovery.post(active, room, plan, card.id, 'exhausted')) {
              handled.push({ planId: plan.plan_id, cardId: card.id, state: 'running', attention: true })
            }
          }
          for (const card of plan.cards.filter(card => card.state === 'unknown')) {
            if (await recovery.post(active, room, plan, card.id, 'unknown')) {
              handled.push({ planId: plan.plan_id, cardId: card.id, state: 'unknown', attention: true })
            }
          }
          if (scheduler.inFlight(plan.plan_id) === 0) {
            const cardId = scheduler.readyCards(plan.plan_id)[0]
            if (cardId && await recovery.post(active, room, plan, cardId, 'pending')) {
              handled.push({ planId: plan.plan_id, state: 'pending', attention: true })
            }
          }

        }
      }
      for (const cycle of knowledge.lifecycle.due()) {
        const room = state.room(cycle.room)
        if (!room?.admin || !room.members.includes(room.admin)) continue
        if (cycle.notified_at && knowledge.clock() - cycle.notified_at < 3600) continue
        try {
          await active.postToRoom({ room, botId: room.admin },
            `@${state.admin(room).name} [技能五天评分] ${cycle.title} 评分窗口 ${cycle.id} 已到期。请用 taskflow_skill_score 查看并按六项质量依据提交；调用频次由宿主核算，待遗忘技能本轮仍可调用，精品技能免评分和自动遗忘淘汰。`)
          knowledge.lifecycle.markNotified(cycle.id)
          handled.push({ skillId: cycle.skill_id, cycleId: cycle.id, state: 'awaiting_skill_score' })
        } catch (error) { rt.warn('ds-bot: skill scoring notice: %s', String(error?.message ?? error)) }
      }
      for (const plan of scheduler.cancellingPlans()) {
        const room = state.room(plan.room)
        if (!taskflowRoomEnabled(room) || room.admin !== plan.principal || !room.members.includes(plan.principal)) continue
        try {
          const pending = scheduler.requestCancel(plan.plan_id, { principal: plan.principal, reason: plan.cancel_reason })
          for (const member of pending.stop_members) await rt.stopMemberWork(plan.room, member)
          scheduler.finishCancel(plan.plan_id, { principal: plan.principal })
          handled.push({ planId: plan.plan_id, state: 'cancelled' })
          await active.postToRoom({ room, botId: plan.principal },
            `@${state.admin(room).name} [Taskflow ${plan.plan_id}] 取消已恢复并完成：${plan.cancel_reason}`)
            .catch(error => rt.warn('ds-bot: taskflow cancellation notice failed: %s', String(error?.message ?? error)))
        } catch (error) {
          rt.warn('ds-bot: taskflow cancellation recovery: %s', String(error?.message ?? error))
        }
      }
      for (const card of scheduler.stalledCards()) {
        const room = state.room(card.room)
        if (!taskflowRoomEnabled(room) || !room?.admin) continue
        const scope = { room, botId: room.admin }
        if (card.state === 'dispatching') {
          scheduler.markDispatchUnknown(card.planId, card.cardId, { reason: 'dispatch not acknowledged within five minutes; delivery uncertain' })
          handled.push({ ...card, state: 'unknown' })
          await active.postToRoom(scope, `@${state.admin(room).name} [Taskflow ${card.planId}/${card.cardId}] 派工回执超时，送达状态不明；请核实后再决定是否重派。`)
            .catch(error => rt.warn('ds-bot: taskflow sweep notice failed: %s', String(error?.message ?? error)))
          continue
        }
        await rt.stopMemberWork(card.room, card.member)
        if (!scheduler.stalledCards().some(item => item.planId === card.planId && item.cardId === card.cardId && item.state === 'running')) continue
        scheduler.failCard(card.planId, card.cardId, { reason: 'no result or progress for one hour' })
        const failure = scheduler.settleFailure(card.planId, card.cardId)
        handled.push({ ...card, state: failure.state })
        const reasons = scheduler.failureReasons(card.planId, card.cardId).map((reason, index) => `${index + 1}. ${reason}`).join('；')
        await active.postToRoom(scope, `@${state.admin(room).name} [Taskflow ${card.planId}/${card.cardId}] 一小时无进展，已停止当前执行；${failure.state === 'pending' ? `第 ${failure.attempts}/${failure.limit} 次失败，正在自动重试` : `重试耗尽：${reasons}；依赖卡已停止，请决定重派或取消`}。`)
          .catch(error => rt.warn('ds-bot: taskflow sweep notice failed: %s', String(error?.message ?? error)))
        if (failure.state === 'pending') await active.dispatchScope(scope, card.planId)
      }
      return handled
    } finally { sweeping = false }
  }
  installTaskflowMonitor(rt, {
    rooms: () => state.rooms(),
    openPlans: async roomId => {
      const { current, legacy } = ledgerPaths(rt)
      if (!existsSync(current) && !existsSync(legacy)) return []
      const active = await start('taskflow_results')
      if (!active || rt.readOnly() !== undefined) return []
      return scheduler.listPlans(roomId).filter(plan => plan.status === 'open')
    },
    remind: async (room, saved) => {
      const active = await start('taskflow_results')
      if (!active || !taskflowRoomEnabled(room)) return false
      const plan = scheduler.planState(saved.plan_id)
      const card = plan.cards.find(card => card.state !== 'verified') ?? plan.cards[0]
      return card ? recovery.post(active, room, plan, card.id, 'reminder') : false
    },
  })
  rt.ctx.effect(() => {
    const timer = setInterval(() => {
      void rt.taskflowSweep().catch(error => rt.warn('ds-bot: taskflow sweep: %s', String(error?.message ?? error)))
      try { if (scheduler && !schedulerReadOnly && rt.readOnly() === undefined) {
        new Retention(scheduler, knowledge).run({ rooms: state.rooms().map(room => room.id) })
      } }
      catch (error) { rt.warn('ds-bot: taskflow retention: %s', String(error?.message ?? error)) }
    }, 5 * 60 * 1000)
    return () => {
      clearInterval(timer)
      const ledger = scheduler
      const library = knowledge
      scheduler = undefined
      knowledge = undefined
      service = undefined
      ledger?.close()
      library?.close()
    }
  }, 'ds-bot: taskflow ledgers')
}
