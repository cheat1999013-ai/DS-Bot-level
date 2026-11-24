// A recovery notification is a bounded task for the real principal, not a new
// assignment for a worker whose delivery is unknown. Reserve before enqueueing.
import { taskflowRoomEnabled } from './monitor.js'

export function hasExecutingWorker(rt, scheduler, room) {
  return scheduler.executingMembers(room.id).some(member => member !== room.admin
    && room.members.includes(member) && rt.live?.get(room.sessions?.[member])?.turn !== undefined)
}

export function createTaskflowRecovery(rt, state, getScheduler) {
  const identity = (plan, card, kind, period) => JSON.stringify([
    plan.room, plan.plan_id, card.id, card.attempts, plan.principal, kind,
    ...(kind === 'reminder' ? [period] : []),
  ])
  const exhausted = (scheduler, plan, card) => {
    const key = JSON.stringify([plan.room, plan.plan_id, card.member, card.id, card.attempts, 'submit'])
    return card.state === 'running' && !card.terminal_event_id && scheduler.events(plan.plan_id)
      .some(event => event.type === 'continuation_exhausted' && event.payload?.key === key)
  }
  const valid = (scheduler, room, plan, card, kind) => plan.status === 'open' && plan.room === room.id
    && taskflowRoomEnabled(room)
    && plan.principal === room.admin && state.member(room, room.admin)
    && (kind === 'unknown' ? card.state === 'unknown'
      : kind === 'reminder' ? !hasExecutingWorker(rt, scheduler, room)
      : kind === 'exhausted' ? exhausted(scheduler, plan, card)
      : kind === 'pending' && card.state === 'pending' && scheduler.inFlight(plan.plan_id) === 0
        && scheduler.readyCards(plan.plan_id).includes(card.id))
  return {
    claim(roomId, sender, event) {
      if (rt.readOnly() !== undefined || event?.event !== 'recovery') return false
      const scheduler = getScheduler(), room = state.room(roomId)
      if (!scheduler || !room || sender !== room.admin || event.from?.id !== room.admin || event.to?.id !== room.admin) return false
      return scheduler.write(() => {
        let plan
        try { plan = scheduler.planState(event.planId) } catch { return false }
        const card = plan.cards.find(card => card.id === event.cardId)
        const kind = event.recovery?.kind
        if (!card || !valid(scheduler, room, plan, card, kind)) return false
        if (kind === 'reminder' && !Number.isSafeInteger(event.recovery?.period)) return false
        const key = identity(plan, card, kind, event.recovery?.period)
        if (event.recovery?.key !== key) return false
        const events = scheduler.events(plan.plan_id).filter(event => event.payload?.key === key)
        if (!events.some(event => event.type === 'recovery_wake_reserved') || events.some(event => event.type === 'recovery_wake_claimed')) return false
        scheduler.event(plan.plan_id, card.id, 'recovery_wake_claimed', { key, principal: room.admin })
        return true
      })
    },
    async post(service, room, saved, cardId, kind) {
      const scheduler = getScheduler()
      if (!scheduler || rt.readOnly() !== undefined) return false
      const reserved = scheduler.write(() => {
        const plan = scheduler.planState(saved.plan_id)
        const card = plan.cards.find(card => card.id === cardId)
        if (!card || !valid(scheduler, room, plan, card, kind)) return
        const events = scheduler.events(plan.plan_id)
        const period = kind === 'reminder' ? Math.floor(scheduler.clock() / 300) : undefined
        if (kind === 'reminder') {
          const last = Math.max(plan.created_at, ...events.filter(event => event.type === 'recovery_wake_reserved'
            && event.payload?.principal === room.admin).map(event => event.at))
          if (scheduler.clock() - last < 300) return
        }
        const key = identity(plan, card, kind, period)
        if (events.some(event => event.type === 'recovery_wake_reserved' && event.payload?.key === key)) return
        scheduler.event(plan.plan_id, card.id, 'recovery_wake_reserved', { key, principal: room.admin, kind })
        // Keep the original attention audit, including upgrade from notice-only
        // releases, but do not let its old marker suppress the missing delivery.
        scheduler.event(plan.plan_id, card.id, kind === 'pending' ? 'dispatch_attention' : 'recovery_attention',
          { key, attempts: card.attempts, principal: room.admin })
        return { plan, card, key, period }
      })
      if (!reserved) return false
      const { plan, card, key, period } = reserved
      const text = kind === 'reminder'
        ? `五分钟任务检查：原计划尚未完成。先调用 taskflow_results，planId="${plan.plan_id}"，核对所有原卡的最新状态；对未提交的执行卡，催促对应执行者在原任务中继续推进并用 taskflow_submit 提交真实结果，不重复外部操作或新建计划。已有结果时及时核验并验收或返工；全卡已验收则核对总条件后调用 taskflow_finish。审批等待时说明所需决定，不绕过审批；送达 unknown 时先核实，不盲目重派。向用户说明真实进展或具体阻塞。计划完成后停止催办。`
        : kind === 'exhausted'
        ? `执行者回合已经结束，自动续执行额度已耗尽，但原任务没有提交结果，整个计划仍未完成。先调用 taskflow_results，planId="${plan.plan_id}"，核实 ${card.id} 的原执行记录和已有产物；依据证据要求原执行者补交，或明确说明阻塞并决定取消。不得伪造结果、放行依赖卡、重复外部操作或把本次通知当作完成。请向用户交代当前状态与下一步，不要只重复告警。`
        : kind === 'unknown'
        ? `任务尚未完成：重启或派工异常后送达状态不明，依赖卡仍在等待。现在由主理核验已有执行与结果。先调用 taskflow_results，planId="${plan.plan_id}"，再检查原执行记录与已有产物；不得未经核实重派或把普通回复当作完成。核验后立即处置原卡：已有派发回执且原执行者仍在工作或已有产物时，请原执行者用 taskflow_submit 提交原卡；确认原执行已停止且没有可提交结果、重跑不会重复外部操作时，用 taskflow_retry（decision=retry）重派原卡。若证据不足，明确缺哪项证据及下一步核验动作。`
        : `计划尚未完成：有任务卡已满足依赖与审批条件但尚未派出。先调用 taskflow_results，planId="${plan.plan_id}"，核对原计划，再调用 taskflow_dispatch 继续派工；不要新建计划或绕过审批。`
      const scope = { room, botId: room.admin }
      const event = { ...service.taskEvent(scope, plan, card, 'recovery', room.admin),
        recovery: { key, kind, ...(kind === 'reminder' ? { period } : {}) } }
      return (await service.postToRoom(scope, `[Taskflow ${plan.plan_id}/${card.id}] ${text}`, undefined, event)) !== false
    },
  }
}
