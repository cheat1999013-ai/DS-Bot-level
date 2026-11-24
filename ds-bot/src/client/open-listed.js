// DSH's main view opens only a Session that its client list already holds; any other id
// throws `sessions.retain: unknown session`. A part the Host made a moment ago, or any part
// before the first list arrives, waits for the list; a newer navigation — through here or
// elsewhere — drops the wait.
export function listedOpener({ list, open, refresh, current }) {
  let drop = () => {}
  return (target) => {
    drop()
    drop = () => {}
    const listed = () => list.getSnapshot().byId?.[target] !== undefined
    if (listed()) { open(target); return }
    const from = current?.()
    const off = list.subscribe(() => {
      if (current?.() !== from) {
        off()
        drop = () => {}
        return
      }
      if (!listed()) return
      off()
      drop = () => {}
      open(target)
    })
    drop = off
    refresh?.()
  }
}

// The workspace drops its last history reference on navigation. Keep a small
// set of the Sessions it has already opened so revisits share the native history.
export function retainRecentGroupHistory({ roster, sessions, onError }) {
  const held = new Map()
  let scheduled = false
  let stopped = false
  const sync = () => {
    if (scheduled || stopped) return
    scheduled = true
    queueMicrotask(() => {
      if (stopped) return
      try {
        const currentParts = new Set((roster.getSnapshot().rooms ?? []).map(room => room.sessionId ?? room.id))
        for (const [id, reference] of held) {
          if (currentParts.has(id)) continue
          held.delete(id)
          reference.release()
        }
        const main = Object.values(sessions.list.getSnapshot().byId ?? {}).find(row => (row.retainedBy?.mainView ?? 0) > 0)?.id
        if (!currentParts.has(main)) return
        const previous = held.get(main)
        const reference = previous ?? sessions.retain(main, { source: 'dsBotGroupHistory' })
        held.delete(main)
        held.set(main, reference)
        if (!previous) void reference.ready.catch((error) => {
          if (held.get(main) !== reference) return
          held.delete(main)
          reference.release()
          onError(error)
        })
        if (held.size > 3) {
          const oldest = held.keys().next().value
          const retired = held.get(oldest)
          held.delete(oldest)
          retired.release()
        }
      } catch (error) {
        onError(error)
      } finally {
        scheduled = false
      }
    })
  }
  const offList = sessions.list.subscribe(sync)
  const offRoster = roster.subscribe(sync)
  sync()
  return () => {
    stopped = true
    offList()
    offRoster()
    for (const reference of held.values()) reference.release()
    held.clear()
  }
}
