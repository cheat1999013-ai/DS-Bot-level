import { createElement as h, useEffect, useState } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { confirmedLegacyTask, legacyTaskCandidate, taskMessageOf } from '../shared/taskflow-message.js'
import { t } from './i18n.js'
import { clockLabel, messageClock } from './text.js'
import { call } from './api.js'

const phases = { assigned: 'Task assigned', submitted: 'Result submitted', failed: 'Task failed', reflection: 'Reflection submitted' }
const referenceOf = task => [task.planId, task.cardId].filter(Boolean).join('/')
function heading(task, time) {
  const reference = [task.planId, task.cardId].filter(Boolean).join('/')
  const phase = Object.hasOwn(phases, task.event) ? phases[task.event] : 'Bot task'
  const recipient = task.to?.name ?? task.to?.id
  const sender = task.from?.name ?? task.from?.id
  return [
    h('div', { className: 'bt-task-message-head' }, h('strong', null, t(phase)),
      reference ? h('span', { className: 'bt-task-message-ref', title: reference }, task.cardId ? `${task.cardId} · ${task.planId}` : task.planId) : null,
      Number.isFinite(time) ? h('time', { title: clockLabel(time) }, messageClock(time)) : null),
    sender && recipient ? h('div', { className: 'bt-task-message-route' }, `${sender} → ${recipient}`) : null,
  ]
}

export function TaskSourceHeader({ matched }) {
  return h('div', { className: 'bt-task-source', 'data-task-reference': referenceOf(matched) }, ...heading(matched))
}

export function TaskMessage({ task, text = '', time }) {
  const reference = referenceOf(task)
  const recipient = task.to?.name ?? task.to?.id
  const prefix = recipient && reference ? `@${recipient} [Taskflow ${reference}]` : null
  const body = prefix && text.startsWith(prefix) ? text.slice(prefix.length).trimStart() : text
  return h('article', { className: 'bt-task-message', 'data-task-reference': reference }, ...heading(task, time),
    h('div', { className: 'bt-task-message-body' }, h(MarkdownText, { text: body, variant: 'compact' })))
}

const readTaskflow = room => call('taskflow-state', { room })
const boards = new WeakMap()
const legacyBoard = (load, room) => {
  let rooms = boards.get(load)
  if (!rooms) boards.set(load, rooms = new Map())
  if (!rooms.has(room)) rooms.set(room, Promise.resolve().then(() => load(room))
    .catch(() => null).finally(() => rooms.delete(room)))
  return rooms.get(room)
}

// Older external taskflow posts used the human RPC route. Validate against the ledger,
// and leave every unconfirmed input to the original DSH renderer.
export function TaskInputCell({ node, sessionId, useRoster, loadTaskflow = readTaskflow, Fallback, ...props }) {
  const data = node.data ?? {}
  const room = useRoster?.(state => state.roomsById[sessionId]?.id) ?? sessionId
  const task = taskMessageOf(data)
  const candidate = legacyTaskCandidate(data)
  const identityKey = JSON.stringify([room, data.seq, data.time, data.source?.rpcId, candidate])
  const [legacy, setLegacy] = useState(null)
  useEffect(() => {
    let active = true
    setLegacy(null)
    if (candidate) void legacyBoard(loadTaskflow, room).then(board => {
      if (active) setLegacy({ key: identityKey, task: confirmedLegacyTask(data, board) })
    })
    return () => { active = false }
  }, [room, loadTaskflow, identityKey])
  const identity = task ?? (legacy?.key === identityKey ? legacy.task : null)
  if (identity) return h(TaskMessage, { task: identity, text: (data.content ?? []).map(block => block.text ?? '').join('\n').replace(/^\[Group post from [^\r\n]*\]\r?\n/, ''), time: data.time })
  return Fallback ? h(Fallback, { ...props, node, sessionId, useRoster }) : null
}

export const TASK_MESSAGE_CSS = `
.bt-task-message,div:has(> .bt-task-source){box-sizing:border-box;max-width:100%;min-width:0;margin:12px 0;padding:12px 14px;border:1px solid var(--bt-line-2);border-radius:12px;background:var(--bt-card);color:var(--bt-ink);text-align:left}
div:has(> .bt-task-source){align-items:stretch}
div:has(> .bt-task-source)> .bt-task-source+*{max-width:100%;align-self:stretch}
.bt-task-message-head{display:flex;flex-wrap:wrap;align-items:center;gap:9px;min-width:0;margin-bottom:9px;font-size:12px;color:var(--bt-ink-2)}
.bt-task-message-route{margin-bottom:8px;font-size:12px;color:var(--bt-ink-2);overflow-wrap:anywhere}
.bt-task-message-head strong{color:var(--bt-accent);flex:none}.bt-task-message-head time{margin-left:auto;white-space:nowrap;flex:none}
.bt-task-message-ref{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:11px ui-monospace,monospace}
.bt-task-message-body{padding:10px;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-bubble);overflow-wrap:anywhere;font-size:13px;line-height:1.65}
`
