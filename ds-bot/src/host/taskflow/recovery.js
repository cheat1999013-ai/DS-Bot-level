// A recovery notification is a bounded task for the real principal, not a new
// assignment for a worker whose delivery is unknown. Reserve before enqueueing.
export function createTaskflowRecovery(rt, state, getScheduler) {
  const identity = (plan, card, kind) => JSON.stringify([plan.room, plan.plan_id, card.id, card.attempts, plan.principal, kind])
  const valid = (scheduler, room, plan, card, kind) => plan.status === 'open' && plan.room === room.id
    && plan.principal === room.admin && state.member(room, room.admin)
    && (kind === 'unknown' ? card.state === 'unknown'
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
        const key = identity(plan, card, kind)
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
        const key = identity(plan, card, kind)
        if (scheduler.events(plan.plan_id).some(event => event.type === 'recovery_wake_reserved' && event.payload?.key === key)) return
        scheduler.event(plan.plan_id, card.id, 'recovery_wake_reserved', { key, principal: room.admin, kind })
        // Keep the original attention audit, including upgrade from notice-only
        // releases, but do not let its old marker suppress the missing delivery.
        scheduler.event(plan.plan_id, card.id, kind === 'unknown' ? 'recovery_attention' : 'dispatch_attention',
          { key, attempts: card.attempts, principal: room.admin })
        return { plan, card, key }
      })
      if (!reserved) return false
      const { plan, card, key } = reserved
      const text = kind === 'unknown'
        ? `任务尚未完成：重启或派工异常后送达状态不明，依赖卡仍在等待。现在由主理核验已有执行与结果。先调用 taskflow_results，planId="${plan.plan_id}"，再检查原执行记录与已有产物；不得未经核实重派或把普通回复当作完成。核验后按证据明确处置并继续原计划；若缺少必要证据，在群里给出具体缺项与可选择的处置，不要只重复这条告警。`
        : `计划尚未完成：有任务卡已满足依赖与审批条件但尚未派出。先调用 taskflow_results，planId="${plan.plan_id}"，核对原计划，再调用 taskflow_dispatch 继续派工；不要新建计划或绕过审批。`
      const scope = { room, botId: room.admin }
      const event = { ...service.taskEvent(scope, plan, card, 'recovery', room.admin), recovery: { key, kind } }
      await service.postToRoom(scope, `[Taskflow ${plan.plan_id}/${card.id}] ${text}`, undefined, event)
      return true
    },
  }
}
