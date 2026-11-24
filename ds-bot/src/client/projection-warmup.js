const CONCURRENCY = 2

export function projectionWarmup({ refresh, onError }) {
  const seen = new Set()
  const pending = new Set()
  let priority
  let active = 0
  let stopped = false

  const drain = () => {
    while (!stopped && active < CONCURRENCY && pending.size > 0) {
      const id = pending.has(priority) ? priority : pending.values().next().value
      pending.delete(id)
      active += 1
      void Promise.resolve().then(() => refresh(id)).catch(onError).finally(() => {
        active -= 1
        drain()
      })
    }
  }

  return {
    add(ids) {
      if (stopped) return
      for (const id of ids) {
        if (seen.has(id)) continue
        seen.add(id)
        pending.add(id)
      }
      drain()
    },
    prioritize(id) { priority = id },
    stop() { stopped = true; pending.clear(); seen.clear() },
  }
}
