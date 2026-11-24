// Only ledger-backed obligations can extend a task turn. Never infer completion
// or permission from prose, and never restart an unknown delivery.
import { taskflowRoomEnabled } from './monitor.js'

export function createTaskflowContinuation(rt, state, getScheduler) {
  return sessionId => {
    if (rt.readOnly() !== undefined || !rt.isBotSession(sessionId)) return
    const scheduler = getScheduler()
    const owner = rt.groupOwners.get(sessionId)
    const room = owner && state.room(owner.roomId)
    const botId = rt.selfOf(sessionId)
    if (!scheduler || !taskflowRoomEnabled(room) || !botId || !state.member(room, botId) || !state.member(room, room.admin)) return
    const plans = scheduler.listPlans(room.id).filter(plan => plan.status === 'open')
    const obligation = (plan, card, action, text, blocked = false) => {
      const key = JSON.stringify([room.id, plan.plan_id, botId, card?.id, card?.attempts, action])
      const budget = scheduler.write(() => {
        const events = scheduler.events(plan.plan_id).filter(event => event.payload?.key === key)
        const used = events.filter(event => event.type === 'continuation_reserved').length
        const exhausted = blocked || used >= 2
        const report = exhausted && !events.some(event => event.type === 'continuation_exhausted')
        // Reserve before delivery. A failed delivery consumes its reservation;
        // restarting the host must not repeat a potentially billed execution.
        if (!exhausted) scheduler.event(plan.plan_id, card?.id, 'continuation_reserved', { key, member: botId, action })
        else if (report) scheduler.event(plan.plan_id, card?.id, 'continuation_exhausted', { key, member: botId, action })
        return { exhausted, report }
      })
      return { key, ...budget, action, roomId: room.id, planId: plan.plan_id, cardId: card?.id,
        text: `[Taskflow ${plan.plan_id}${card ? `/${card.id}` : ''}] 任务尚未完成。${text}` }
    }
    for (const saved of plans) {
      const plan = scheduler.planState(saved.plan_id)
      const hasResult = card => {
        try { scheduler.resultPayload(plan.plan_id, card.id); return true } catch { return false }
      }
      if (botId !== room.admin) {
        const card = plan.cards.find(card => card.member === botId && card.state === 'running' && !hasResult(card))
        if (card) return obligation(plan, card, 'submit',
          `继续当前任务，不要把已用过工具或回合结束当成完成。已有结果时调用 taskflow_submit，planId="${plan.plan_id}"、cardId="${card.id}"，attempt 使用产生该结果的派工消息中的值；遇到阻塞如实提交失败，不要重复已完成的外部操作。`)
        continue
      }
      if (plan.principal !== botId) continue
      const unknown = plan.cards.find(card => card.state === 'unknown')
      const recoveryClaimed = unknown && scheduler.events(plan.plan_id).some(event => event.type === 'recovery_wake_claimed'
        && event.payload?.key === JSON.stringify([room.id, plan.plan_id, unknown.id, unknown.attempts, botId, 'unknown']))
      if (unknown && !recoveryClaimed) return obligation(plan, unknown, 'unknown',
        '派工送达状态 unknown，依赖卡仍在等待。先核实已发生的执行及结果并报告此阻塞；不得把该卡视为完成，也不得未经核实自动重派。', true)
      const submitted = plan.cards.find(card => card.state === 'running' && hasResult(card))
      if (submitted) return obligation(plan, submitted, 'accept',
        '已有提交尚未验收。调用 taskflow_results 检查实际结果并完成所需验证，再决定 taskflow_accept 或返工；不要把收到回复当成验收。')
      if (plan.cards.length && plan.cards.every(card => card.state === 'verified')) {
        return obligation(plan, undefined, 'finish', '全部卡已验收，但计划仍未完成。核对总验收条件后调用 taskflow_finish；若条件未满足，明确说明阻塞。')
      }
      const active = new Set(plan.cards.filter(card => ['running', 'dispatching', 'unknown'].includes(card.state)).map(card => card.member))
      if (scheduler.inFlight(plan.plan_id) >= plan.concurrency) continue
      const ready = new Set(scheduler.readyCards(plan.plan_id))
      const pending = plan.cards.find(card => ready.has(card.id) && !active.has(card.member))
      if (pending) return obligation(plan, pending, 'dispatch',
        `仍有已满足依赖与审批条件的任务卡未派出。调用 taskflow_dispatch，planId="${plan.plan_id}"，继续派出就绪任务；不要重复创建计划或绕过审批。`)
    }
  }
}
