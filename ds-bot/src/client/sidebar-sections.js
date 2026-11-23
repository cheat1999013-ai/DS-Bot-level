import { useSyncExternalStore } from 'react'

const STORAGE_KEY = "dsb-sidebar-fold-v1"
export const SIDEBAR_SECTIONS = ['bot', 'room', 'other']
export const sidebarSection = kind => kind === 'bot' ? 'bot' : kind === 'room' ? 'room' : 'other'

const normalize = value => ({
  collapsed: Object.fromEntries(SIDEBAR_SECTIONS.map(section => [section, value?.collapsed?.[section] === true])),
  hidden: Array.isArray(value?.hidden) ? [...new Set(value.hidden.filter(id => typeof id === 'string' && id.length > 0))] : [],
})
const storage = () => typeof localStorage === 'undefined' ? window.localStorage : localStorage
const read = () => {
  try { return normalize(JSON.parse(storage().getItem(STORAGE_KEY))) }
  catch { return normalize(null) }
}
let snapshot = read()
const listeners = new Set()
const publish = next => {
  snapshot = normalize(next)
  for (const listener of listeners) listener()
}
const set = next => {
  const clean = normalize(next)
  try { storage().setItem(STORAGE_KEY, JSON.stringify(clean)) } catch { /* Local-only controls remain usable without storage. */ }
  publish(clean)
}
const onStorage = event => {
  if (event.key === STORAGE_KEY || event.key === null) publish(read())
}
const subscribe = listener => {
  if (listeners.size === 0 && typeof window !== 'undefined') window.addEventListener?.('storage', onStorage)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener?.('storage', onStorage)
  }
}
const getSnapshot = () => snapshot
export const useSidebarFold = () => useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
export const sidebarFold = {
  toggle(section) {
    if (!SIDEBAR_SECTIONS.includes(section)) return
    set({ ...snapshot, collapsed: { ...snapshot.collapsed, [section]: !snapshot.collapsed[section] } })
  },
  hide(id) { if (!snapshot.hidden.includes(id)) set({ ...snapshot, hidden: [...snapshot.hidden, id] }) },
  restore(ids) {
    const restored = new Set(ids)
    set({ ...snapshot, hidden: snapshot.hidden.filter(id => !restored.has(id)) })
  },
  reset() { set({ collapsed: {}, hidden: [] }) },
}

export function botFunction(bot, fallback) {
  const capabilities = (bot.capabilities ?? []).filter(name => typeof name === 'string' && name.length > 0)
  const summary = capabilities.slice(0, 6).join(', ') + (capabilities.length > 6 ? ` +${capabilities.length - 6}` : '')
  return [bot.role?.trim() || fallback, summary].filter(Boolean).join(' · ')
}
