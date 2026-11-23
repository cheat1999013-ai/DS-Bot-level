// Group activity for task checks is durable task enablement plus unfinished work.
// The selected chat, sidebar visibility and the last model message are irrelevant.
export const taskflowRoomEnabled = room => !!room && room.taskflowEnabled !== false
  && !['paused', 'stopped'].includes(room.goal?.status)

export function installTaskflowMonitor(rt, { rooms, openPlans, remind,
  setTimer = setInterval, clearTimer = clearInterval, clock = Date.now }) {
  let checking = false
  let stopped = false
  const state = { intervalMs: 300000, checking: false, lastCheckedAt: null, rooms: {} }
  rt.taskflowMonitorState = () => structuredClone(state)
  rt.taskflowCheck = async () => {
    if (checking || stopped || rt.readOnly() !== undefined) return []
    checking = true
    state.checking = true
    const handled = []
    try {
      for (const room of rooms()) {
        const enabled = taskflowRoomEnabled(room)
        const row = state.rooms[room.id] = { enabled, active: false, checkedAt: null }
        if (!enabled) continue
        const plans = await openPlans(room.id)
        if (!taskflowRoomEnabled(room)) continue
        row.active = plans.some(plan => plan.status === 'open')
        if (!row.active) continue
        row.checkedAt = clock()
        for (const plan of plans) {
          if (stopped || rt.readOnly() !== undefined || !taskflowRoomEnabled(room)) break
          if (plan.status === 'open' && await remind(room, plan)) handled.push({ roomId: room.id, planId: plan.plan_id, reminder: true })
        }
      }
      state.lastCheckedAt = clock()
      return handled
    } finally { checking = false; state.checking = false }
  }
  rt.ctx.effect(() => {
    const timer = setTimer(() => {
      void rt.taskflowCheck().catch(error => rt.warn('ds-bot: task check: %s', String(error?.message ?? error)))
    }, state.intervalMs)
    return () => { stopped = true; clearTimer(timer) }
  }, 'ds-bot: active group task monitor')
}
