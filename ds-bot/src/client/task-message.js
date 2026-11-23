import { createElement as h, useEffect, useState } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { confirmedLegacyTask, legacyTaskCandidate, taskMessageOf, taskIdentityOf } from '../shared/taskflow-message.js'
import { t } from './i18n.js'
import { clockLabel, messageClock } from './text.js'
import { call } from './api.js'

export const markdownLabels = () => ({ code: { copyLabel: t('Copy'), copiedLabel: t('Copied'), toolbarLabels: { codeLabel: t('Code'), wrapLabel: t('Wrap lines'), unwrapLabel: t('Unwrap lines') } }, footnotes: t('Footnotes') })
const phases = { assigned: 'Task assigned', submitted: 'Result submitted', failed: 'Task failed', reflection: 'Reflection submitted' }
const referenceOf = task => [task.planId, task.cardId].filter(Boolean).join('/')
export function TaskError() {
  return h('article', { className: 'bt-task-message bt-task-error', role: 'alert' },
    h('strong', null, '任务数据无法读取'), h('p', null, '任务类型或身份信息无效。已阻止退回普通 Bot 消息，请刷新或修复任务数据。'))
}
export function NativeTaskCell({ node }) {
  const data = node.data ?? {}
  return data.error || !data.task ? h(TaskError) : h(TaskMessage, data)
}
function heading(task, time) {
  const reference = [task.planId, task.cardId].filter(Boolean).join('/')
  const reminder = task.event === 'recovery' && task.recovery?.kind === 'reminder'
  const phase = reminder ? 'Task reminder' : Object.hasOwn(phases, task.event) ? phases[task.event] : 'Bot task'
  const recipient = task.to?.name ?? task.to?.id
  const sender = task.from?.name ?? task.from?.id
  return [
    h('div', { className: 'bt-task-message-head' }, h('strong', null, t(phase)),
      reference ? h('span', { className: 'bt-task-message-ref', title: reference }, task.cardId ? `${task.cardId} · ${task.planId}` : task.planId) : null,
      Number.isFinite(time) ? h('time', { title: clockLabel(time) }, messageClock(time)) : null),
    reminder && recipient ? h('div', { className: 'bt-task-message-route' }, t('To principal: {name}', { name: recipient }))
      : sender && recipient ? h('div', { className: 'bt-task-message-route' }, `${sender} → ${recipient}`) : null,
  ]
}

export function TaskSourceHeader({ matched }) {
  if (!taskIdentityOf(matched)) return null
  return h('div', { className: 'bt-task-source', 'data-task-reference': referenceOf(matched) }, ...heading(matched))
}

export function TaskMessage({ task, text = '', time }) {
  // Malformed historical rows must not abdicate the shared conversation renderer.
  if (!taskIdentityOf(task)) return h(TaskError)
  const reference = referenceOf(task)
  const recipient = task.to?.name ?? task.to?.id
  const prefix = recipient && reference ? `@${recipient} [Taskflow ${reference}]` : null
  const body = prefix && text.startsWith(prefix) ? text.slice(prefix.length).trimStart() : text
  return h('article', { className: 'bt-task-message', 'data-task-reference': reference }, ...heading(task, time),
    h('div', { className: 'bt-task-message-body' }, h(MarkdownText, { text: body, labels: markdownLabels(), variant: 'compact' })))
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
export function TaskInputCell({ node, sessionId, useRoster, loadTaskflow = readTaskflow, Fallback, PrincipalReply, ...props }) {
  const data = node.data ?? {}
  const roster = useRoster?.(state => state)
  const conversation = roster?.roomsById?.[sessionId]
  const room = conversation?.id ?? sessionId
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
  if (data.source?.kind === 'taskflow') {
    if ((props.actions?.nativeTaskNodes || props.principalActions?.nativeTaskNodes) && data.source.role === 'post') return null
    if (!task) return h(TaskError)
    return data.source.role === 'room' ? null : h(TaskMessage, { task, text: (data.content ?? []).map(block => block.text ?? '').join('\n'), time: data.time })
  }
  if (identity) return h(TaskMessage, { task: identity, text: (data.content ?? []).map(block => block.text ?? '').join('\n').replace(/^\[Group post from [^\r\n]*\]\r?\n/, ''), time: data.time })
  const source = data.source
  if (source?.kind === 'bot' && source.form === 'relay' && source.role === 'post'
    && source.roomId === room && typeof source.senderSessionId === 'string' && source.senderSessionId
    && typeof source.senderName === 'string' && source.senderName
    && Array.isArray(data.content)) {
    const sender = roster?.byId?.[source.senderSessionId]
    const principal = sender && typeof conversation?.admin === 'string'
      && sender.id === conversation.admin && conversation.members?.includes(sender.id)
    if (!principal) return null
    if (!data.content.every(block => block?.type === 'text')) {
      return Fallback ? h(Fallback, { ...props, node, sessionId, useRoster }) : null
    }
    const text = data.content.map(block => block.text ?? '').join('\n')
      .replace(/^\[Group post from [^\r\n]*\]\r?\n/, '')
    if (!text.trim()) return null
    if (PrincipalReply) {
      return h(PrincipalReply, { ...props, node, sessionId, useRoster,
        actions: props.principalActions ?? props.actions,
        useUi: props.usePrincipalUi ?? props.useUi,
        useTurnClock: props.usePrincipalTurnClock ?? props.useTurnClock })
    }
    return Fallback ? h(Fallback, { ...props, node, sessionId, useRoster }) : null
  }
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
