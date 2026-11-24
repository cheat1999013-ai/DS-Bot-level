// The theme owns the sprite and pointer capture. Track the same gesture without
// replacing its click or lift handlers.
export function installMascotPosition(doc = document) {
  const positions = new Map()
  let press
  const down = event => {
    if (press || event.button !== 0 || !doc.body.hasAttribute('data-bt-room')) return
    const hit = event.target.closest?.('.dsh-claude-crab-hit')
    const mascot = hit?.closest('.dsh-claude-crab')
    if (!mascot) return
    const box = hit.getBoundingClientRect()
    const stand = mascot.parentElement.getBoundingClientRect()
    const offset = positions.get(mascot) ?? { x: 0, y: 0, original: mascot.style.translate }
    press = { mascot, offset, id: event.pointerId, x: event.clientX, y: event.clientY,
      minX: Math.min(0, Math.max(0, stand.left) - box.left),
      maxX: Math.max(0, Math.min(doc.documentElement.clientWidth, stand.right) - box.right),
      minY: Math.min(0, -box.top) }
  }
  const move = event => {
    if (press?.id !== event.pointerId) return
    const dx = event.clientX - press.x
    const dy = event.clientY - press.y
    if (!press.moved && Math.hypot(dx, dy) < 6) return
    press.moved = true
    const { mascot, offset } = press
    const x = offset.x + Math.max(press.minX, Math.min(press.maxX, dx))
    // The default stand is above the composer. Downward drags can return to it.
    const y = Math.min(0, offset.y + Math.max(press.minY, dy))
    mascot.style.translate = `${x}px ${y}px`
    positions.set(mascot, { x, y, original: offset.original })
  }
  const end = event => { if (press?.id === event.pointerId) press = undefined }
  const listeners = { pointerdown: down, pointermove: move, pointerup: end, pointercancel: end, lostpointercapture: end }
  for (const [type, listener] of Object.entries(listeners)) doc.addEventListener(type, listener, true)
  return () => {
    for (const [type, listener] of Object.entries(listeners)) doc.removeEventListener(type, listener, true)
    for (const [mascot, position] of positions) mascot.style.translate = position.original
    positions.clear()
    press = undefined
  }
}
