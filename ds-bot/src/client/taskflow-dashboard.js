import { createElement as h, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { call } from './api.js'
import { dateLocale, t } from './i18n.js'
import { BotAvatar } from './mark.js'

const stateName = { submitted: 'Submitted', pending: 'Pending', dispatching: 'Dispatching', running: 'Running', verified: 'Accepted', failed: 'Failed', cancelled: 'Cancelled', unknown: 'Unknown', assigned: 'Assignment observed', replied: 'Reply observed' }
const eventName = { plan_created: 'Plan created', card_claimed: 'Started', receipt_bound: 'Dispatched', dispatch_started: 'Started and dispatched', result_observed: 'Submitted', result_accepted: 'Accepted', card_failed: 'Failed', card_retried: 'Retried', plan_finished: 'Plan completed', plan_cancelled: 'Plan cancelled' }
const eventTone = { card_claimed: 'start', receipt_bound: 'start', dispatch_started: 'start', result_accepted: 'success', plan_finished: 'success', card_failed: 'danger' }
const observed = item => item.type === 'result_observed'
  ? { failed: 'Failed', cancelled: 'Cancelled' }[item.payload?.status] ?? 'Submitted'
  : eventName[item.type] ?? item.type
const tone = item => item.type === 'result_observed' && item.payload?.status === 'failed'
  ? 'danger' : eventTone[item.type] ?? 'muted'

function lifecycleEvents(events) {
  const claims = new Map()
  const merged = new Map()
  const consumed = new Set()
  for (const item of [...events].sort((a, b) => a.seq - b.seq)) {
    if (!item.plan_id || !item.card_id) continue
    const key = JSON.stringify([item.room, item.plan_id, item.card_id, item.member])
    const claim = claims.get(key)
    claims.delete(key)
    if (item.type === 'card_claimed') claims.set(key, item)
    else if (item.type === 'receipt_bound' && claim) {
      consumed.add(claim)
      merged.set(item, { ...item, type: 'dispatch_started', started_at: claim.at,
        sourceEvents: [claim, item] })
    }
  }
  return events.filter(item => !consumed.has(item)).map(item => merged.get(item) ?? item)
}

function memberFor(data, roomId, botId) {
  const scoped = data?.membersByRoom?.[roomId]?.[botId]
  if (scoped) return scoped
  const member = data?.members?.[botId] ?? {}
  // A legacy flat DTO only establishes scoped values for its selected room.
  return roomId === data?.room?.id ? member : { ...member, level: null, tool: null, usedSkills: [] }
}

function executorIn(data, member, roomId, principal) {
  const room = roomId === data?.room?.id ? data.room : data?.rooms?.find(room => room.id === roomId)
  return Boolean(member && member !== principal && member !== room?.admin)
}

function taskEvents(data) {
  const groups = new Map()
  const entries = lifecycleEvents(data?.timeline ?? []).filter(item => item.plan_id && item.card_id
    && executorIn(data, item.member, item.room ?? data?.room?.id,
      item.principal ?? (item.plan_id === data?.plan?.plan_id ? data.plan.principal : undefined)))
  for (const item of entries) {
    const key = JSON.stringify([item.room ?? data?.room?.id, item.plan_id, item.card_id, item.member])
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }
  return [...groups.entries()].map(([key, history]) => {
    history.sort((a, b) => a.at - b.at || a.seq - b.seq)
    return { ...history.at(-1), history, key }
  }).sort((a, b) => b.at - a.at || b.seq - a.seq)
}
// Keep task identity inside a Bot row; equal names or card IDs are not identities.
export function executorRows(data) {
  const rows = new Map()
  const tasks = new Map()
  const add = (card, planId, roomId, event) => {
    const key = JSON.stringify([roomId, planId ?? null, card.id, card.member])
    if (tasks.has(key)) { if (event) tasks.get(key).event = event; return }
    const task = { key, card, planId, roomId, event }
    tasks.set(key, task)
    const botKey = JSON.stringify([roomId, card.member])
    if (!rows.has(botKey)) rows.set(botKey, { key: botKey, member: card.member, roomId, tasks: [] })
    rows.get(botKey).tasks.push(task)
  }
  const plan = data?.plan
  for (const card of plan?.cards ?? []) {
    const roomId = plan.room ?? data?.room?.id
    if (executorIn(data, card.member, roomId, plan.principal)) add(card, plan.plan_id, roomId)
  }
  for (const card of data?.observedTasks ?? []) {
    const roomId = card.room ?? data?.room?.id
    if (executorIn(data, card.member, roomId, card.principal ?? (roomId === data?.room?.id ? plan?.principal : undefined))) {
      add(card, undefined, roomId)
    }
  }
  const eventState = { card_claimed: 'running', receipt_bound: 'running', dispatch_started: 'running',
    card_failed: 'failed', card_retried: 'pending', result_accepted: 'verified' }
  for (const event of taskEvents(data)) {
    add({ id: event.card_id, member: event.member, member_name: event.member_name,
      goal: event.card_goal, room_name: event.room_name,
      state: event.type === 'result_observed' ? (event.payload?.status === 'failed' ? 'failed'
        : event.payload?.status === 'cancelled' ? 'cancelled' : 'submitted') : eventState[event.type] ?? 'unknown' },
    event.plan_id, event.room ?? data?.room?.id, event)
  }
  const active = task => ['running', 'dispatching', 'unknown', 'assigned', 'pending'].includes(task.card.state)
  const time = task => task.event?.at ?? task.card.started_at ?? task.card.source?.at ?? task.card.ended_at ?? 0
  for (const row of rows.values()) {
    row.tasks.sort((a, b) => Number(active(b)) - Number(active(a)) || time(b) - time(a))
    row.usedSkills = [...new Set(row.tasks.flatMap(task => task.card.usedSkills ?? []))]
  }
  return [...rows.values()]
}
const colors = ['var(--bt-accent)', 'var(--bt-green)', 'var(--bt-star)', 'var(--bt-accent)']
const trackStyle = lane => ({ '--lane': lane, '--task-color': colors[lane % colors.length] })
const avatar = (bot, id, size) => h(BotAvatar, { bot: bot?.id ? bot : { id }, size, badge: false, live: false })

function Flow({ children }) {
  const ref = useRef(null)
  const [paths, setPaths] = useState([])
  useLayoutEffect(() => {
    const root = ref.current
    let frame
    const draw = () => {
      const box = root.getBoundingClientRect()
      const points = [...root.querySelectorAll('[data-flow-node]')].map(node => {
        const rect = node.getBoundingClientRect()
        const content = node.parentElement.querySelector('.bt-taskflow-title')?.getBoundingClientRect()
        return { x: rect.left - box.left + rect.width / 2, y: rect.top - box.top + rect.height / 2,
          target: content ? content.left - box.left - 4 : null,
          key: node.dataset.flowKey, lane: Number(node.dataset.lane) || 0 }
      })
      const runs = new Map()
      for (const point of points) {
        if (!point.key) continue
        const run = runs.get(point.key)
        if (run) run.end = point
        else runs.set(point.key, { start: point, end: point })
      }
      const rails = [...runs.values()].filter(run => run.start !== run.end)
        .map(run => ({ d: `M${run.start.x} ${run.start.y}V${run.end.y}`, lane: run.start.lane, kind: 'rail' }))
      const arms = points.filter(point => point.key && point.target > point.x)
        .map(point => ({ d: `M${point.x} ${point.y}H${point.target}`, lane: point.lane, kind: 'arm' }))
      const next = [...rails, ...arms]
      setPaths(current => JSON.stringify(current) === JSON.stringify(next) ? current : next)
    }
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(draw) }
    const observer = new ResizeObserver(schedule)
    observer.observe(root)
    root.querySelectorAll('[data-flow-node]').forEach(node => observer.observe(node.parentElement))
    schedule()
    return () => { cancelAnimationFrame(frame); observer.disconnect() }
  }, [children])
  return h('div', { className: 'bt-taskflow-flow', ref },
    h('svg', { className: 'bt-taskflow-paths', 'aria-hidden': true },
      paths.map((path, index) => h('path', { key: index, d: path.d,
        stroke: colors[path.lane % colors.length],
        strokeDasharray: path.kind === 'rail' ? '2 3' : undefined,
        opacity: path.kind === 'rail' ? .58 : .72 }))),
    children)
}
function BotLevel({ member = {} }) {
  const level = member.level
  const tiers = { normal: 'Ordinary', excellent: 'Excellent', premium: 'Premium' }
  const tier = Object.hasOwn(tiers, level?.tier) ? tiers[level.tier] : null
  if (!tier || !Number.isFinite(level?.level)) {
    return h('span', { className: 'bt-taskflow-level', 'data-tier': 'unknown' }, t('Level unavailable'))
  }
  return h('span', { className: 'bt-taskflow-level', 'data-tier': level.tier,
    title: t('{count} credited plans in this group · normal +0.1, excellent/premium +0.01 per completed plan', { count: level.count }) },
  `Lv ${level.level.toFixed(2)} · ${t(tier)}`)
}

function Capabilities({ member = {} }) {
  const [expanded, setExpanded] = useState(false)
  const assigned = new Set(member.skills ?? [])
  const used = new Set(member.usedSkills ?? [])
  const skills = [...new Set([...used, ...assigned])]
  const tool = member.tool ? { name: member.tool, kind: 'Current tool', type: 'tool' } : null
  const entries = [
    ...skills.filter(name => used.has(name)).map(name => ({ name, kind: 'Used skill', type: 'skill', invoked: true })),
    tool,
    ...skills.filter(name => !used.has(name)).map(name => ({ name, kind: 'Attached skill', type: 'skill' })),
  ].filter(Boolean)
  const visible = expanded ? entries : entries.slice(0, 5)
  const extra = entries.length - 5
  const chip = ({ name, kind, type, invoked }) => h('span', { key: `${type}:${name}`,
    className: 'bt-taskflow-chip', 'data-kind': type, 'data-used': invoked || undefined,
    title: `${t(kind)}: ${name}` }, name)
  return h('div', { className: 'bt-taskflow-capabilities' },
    member.model ? h('span', { className: 'bt-taskflow-chip', 'data-kind': 'model', title: `${t('Model')}: ${member.model}` }, member.model) : null,
    visible.map(chip),
    extra > 0 ? h('button', { type: 'button', className: 'bt-taskflow-more',
      'aria-expanded': expanded, 'aria-label': expanded ? t('Show less') : t('Show {count} more', { count: extra }),
      onClick: () => setExpanded(value => !value) }, expanded ? t('Show less') : `+${extra}`) : null)
}
const taskReference = (planId, cardId) => [planId, cardId].filter(Boolean).join('/')
const taskLabel = (planId, cardId) => cardId && planId ? `${cardId} · ${planId}` : cardId ?? planId ?? ''
const ago = (seconds, now) => {
  const minutes = Math.max(0, Math.floor((now / 1000 - seconds) / 60))
  if (!minutes) return t('Just now')
  if (minutes < 60) return t('{minutes}m ago', { minutes })
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? t('{hours}h ago', { hours }) : t('{days}d ago', { days: Math.floor(hours / 24) })
}

export function TaskflowCard({ card, member = {}, lane = 0, planId, tasks, children, flowKey }) {
  const reference = taskReference(planId, card.id)
  return h('article', { className: 'bt-taskflow-item', 'data-state': card.state, style: trackStyle(lane), tabIndex: 0 },
    h('span', { className: 'bt-taskflow-step-node', 'data-flow-node': true,
      'data-flow-key': flowKey ?? card.member, 'data-lane': lane, 'aria-hidden': true },
    avatar(member, card.member, 24)),
    h('div', { className: 'bt-taskflow-title' },
      h('strong', null, member.name ?? card.member_name ?? card.member),
      h(BotLevel, { member }),
      h('span', { className: 'bt-taskflow-task-ref', title: reference }, taskLabel(planId, card.id)),
      h('span', { className: 'bt-taskflow-count', 'data-tone': card.state }, t(stateName[card.state] ?? card.state))),
    h('div', { className: 'bt-taskflow-summary', title: card.goal }, card.goal),
    card.source?.kind === 'group_message' ? h('small', null,
      `${t('Group assignment')} · ${card.room_name} · #${card.source.seq} · ${card.source.at
        ? new Date(card.source.at * 1000).toLocaleString(dateLocale()) : t('Time not recorded')}`) : null,
    h(Capabilities, { member: { ...member, usedSkills: card.usedSkills } }),
    tasks ? h('details', { className: 'bt-taskflow-bot-tasks' },
      h('summary', null, t('Tasks and history ({count})', { count: tasks.length })), children) :
    card.dependencies?.length || card.result || card.comments?.length || card.evidence || card.test
      ? h('div', { className: 'bt-taskflow-detail', title: card.goal },
      card.dependencies?.length ? h('small', null, `${t('After')}: ${card.dependencies.join(', ')}`) : null,
      card.result ? h('pre', null, card.result) : null,
      card.comments?.map((comment, index) => h('small', { key: index }, `${comment.author}: ${comment.text}`)),
      card.evidence ? h('small', null, `${t('Evidence')}: ${card.evidence}`) : null,
      card.test ? h('small', null, `${t('Test')}: ${card.test.run?.state ?? 'required'}`) : null) : null)
}

function Overview({ plan, members, roomName }) {
  const cards = plan.cards ?? []
  const accepted = cards.filter(card => card.state === 'verified').length
  const principal = members?.[plan.principal] ?? {}
  const insight = [plan.insight?.title, plan.insight?.text].filter(Boolean).join('\n')
  return h('section', { className: 'bt-taskflow-overview', 'aria-label': t('Plan overview') },
    h('div', { className: 'bt-taskflow-overview-head' },
      avatar(principal, plan.principal, 28),
      h('div', { className: 'bt-taskflow-owner' },
        h('div', { className: 'bt-taskflow-title' },
          h('strong', null, plan.principal_name ?? principal.name ?? plan.principal),
          h(BotLevel, { member: principal }),
          h('span', { className: 'bt-taskflow-role' }, t('Group leader')),
          h('span', { className: 'bt-taskflow-room' }, roomName)),
        h(Capabilities, { member: principal })),
      h('span', { className: 'bt-taskflow-count', 'data-tone': plan.status },
        t({ open: 'In progress', completed: 'Plan completed', cancelled: 'Plan cancelled', cancelling: 'Cancelling' }[plan.status] ?? plan.status))),
    h('p', { className: 'bt-taskflow-goal', title: plan.goal }, plan.goal),
    h('div', { className: 'bt-taskflow-progress' },
      h('span', { className: 'bt-taskflow-id', title: plan.plan_id }, plan.plan_id),
      h('span', null, t('{accepted} of {total} accepted', { accepted, total: cards.length }))),
    h('progress', { max: cards.length || 1, value: accepted, 'aria-label': t('Accepted tasks') }),
    h('div', { className: 'bt-taskflow-overview-note', 'aria-label': t('Plan insight'), title: insight || undefined },
      h('strong', null, t('Plan insight')), '\n', insight || t('No insights yet.')))
}

function Event({ item, now }) {
  const history = (item.history ?? [item]).flatMap(event => event.sourceEvents ?? [event])
  return h('div', { className: 'bt-taskflow-event-history' },
    h('ol', null, history.map(event => h('li', { key: event.seq },
      h('span', { 'data-tone': tone(event) }, t(observed(event))), ' · ',
      h('time', { dateTime: new Date(event.at * 1000).toISOString() }, ago(event.at, now)),
      event.payload?.reason ? h('span', { className: 'bt-taskflow-event-reason' }, ` · ${event.payload.reason}`) : null))))
}

function TaskRecord({ task, children }) {
  const { card, planId } = task
  return h('section', { className: 'bt-taskflow-task-record', 'data-task-key': task.key },
    h('div', { className: 'bt-taskflow-title' },
      h('span', { className: 'bt-taskflow-task-ref', title: taskReference(planId, card.id) }, taskLabel(planId, card.id)),
      h('span', { className: 'bt-taskflow-count', 'data-tone': card.state }, t(stateName[card.state] ?? card.state))),
    h('p', null, card.goal),
    card.source?.kind === 'group_message' ? h('small', null,
      `${t('Group assignment')} · ${card.room_name ?? task.roomId} · #${card.source.seq} · ${card.source.at
        ? new Date(card.source.at * 1000).toLocaleString(dateLocale()) : t('Time not recorded')}`) : null,
    card.dependencies?.length ? h('small', null, `${t('After')}: ${card.dependencies.join(', ')}`) : null,
    card.result ? h('pre', null, card.result) : null,
    card.comments?.map((comment, index) => h('small', { key: index }, `${comment.author}: ${comment.text}`)),
    card.evidence ? h('small', null, `${t('Evidence')}: ${card.evidence}`) : null,
    card.test ? h('small', null, `${t('Test')}: ${card.test.run?.state ?? 'required'}`) : null,
    card.usedSkills?.length ? h('small', null, `${t('Used skill')}: ${card.usedSkills.join(', ')}`) : null,
    children)
}

function Confirmation({ item, onConfirm }) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const decide = async decision => {
    setBusy(true)
    setError('')
    try { await onConfirm(item.card_id, decision, note, item.stage, item.terminal) }
    catch (failure) { setError(failure?.message ?? String(failure)) }
    finally { setBusy(false) }
  }
  return h('div', { className: 'bt-taskflow-confirm', 'data-card-id': item.card_id },
    h('p', null, `${item.member_name}: ${item.question ?? ''}`),
    item.stage === 'after_result' ? h('div', { className: 'bt-taskflow-reviewed-result' },
      h('strong', null, t('Submitted result'), ` · ${item.terminal}`), h('pre', null, item.result)) : null,
    item.decision === 'reject' ? h('small', null, `${t('Rejected')}${item.note ? ` · ${item.note}` : ''}`) :
      h('div', null,
        h('input', { value: note, maxLength: 500, placeholder: t('Optional note'),
          'aria-label': t('Optional note'), onChange: event => setNote(event.target.value) }),
        h('button', { type: 'button', disabled: busy, onClick: () => void decide('approve') }, t('Approve and continue')),
        h('button', { type: 'button', disabled: busy, onClick: () => void decide('reject') }, t('Reject'))),
    error ? h('small', { role: 'alert' }, error) : null)
}

export function TaskflowPage({ roomId, actions }) {
  const [scope, setScope] = useState(roomId ?? 'all')
  const [data, setData] = useState(null)
  const [rooms, setRooms] = useState([])
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let alive = true
    let generation = 0
    const load = async () => {
      const request = ++generation
      try {
        const next = await call('taskflow-state', scope === 'all' ? { all: true } : { room: scope })
        if (!alive || request !== generation) return
        setData(next)
        setRooms(next.rooms ?? [])
        setError('')
      } catch (failure) { if (alive && request === generation) setError(failure?.message ?? String(failure)) }
    }
    setData(null)
    void load()
    const timer = setInterval(load, 2000)
    return () => { alive = false; clearInterval(timer) }
  }, [scope, roomId, revision])
  return h(DashboardView, { data, rooms, scope, error, onScopeChange: setScope,
    onSchedule: actions?.openSettings && scope !== 'all' && (!roomId || roomId === scope)
      ? () => actions.openSettings('schedules', `group:${scope}`) : undefined,
    onConfirm: roomId && data?.room?.id !== roomId ? undefined : async (cardId, decision, note, stage, terminal) => {
      if (!data?.room?.id || !data.plan?.plan_id) throw new Error('Select a plan to decide')
      await call('taskflow-confirm-card', { room: data.room.id, planId: data.plan.plan_id, cardId, decision, note, stage, terminal })
      setRevision(value => value + 1)
    },
    onRefresh: () => setRevision(value => value + 1) })
}

export function DashboardView({ data, rooms = data?.rooms ?? [], scope = 'all', error = '', onScopeChange = () => {}, onRefresh = () => {}, onConfirm, onSchedule }) {
  const plan = data?.plan
  const rows = executorRows(data)
  const lanes = new Map(rows.map((row, index) => [row.key, index]))
  return h('div', { className: 'bt-taskflow bt-taskflow-dashboard', style: { '--last-lane': Math.max(0, lanes.size - 1) } },
    h('header', { className: 'bt-taskflow-toolbar' },
      h('h2', null, t('Bot taskflow')),
      h('select', { 'aria-label': t('Filter groups'), value: scope, onChange: event => onScopeChange(event.target.value) },
        h('option', { value: 'all' }, t('All groups')),
        rooms.map(room => h('option', { key: room.id, value: room.id }, room.name))),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onRefresh }, t('Refresh')),
      onSchedule ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onSchedule }, t('New group task')) : null,
      h('div', { className: 'bt-taskflow-legend', 'aria-label': t('Status legend') },
        ['Running', 'Accepted', 'Failed', 'Pending'].map(label => h('span', { key: label, 'data-state': label.toLowerCase() }, t(label))))),
    error ? h('p', { className: 'bt-error', role: 'alert' }, error) : null,
    !data ? h('p', null, t('Loading…')) : null,
    data && !plan && !rows.length ? h('p', { className: 'bt-taskflow-empty' }, t('No taskflow plans yet.')) : null,
    data ? h(Flow, null,
      plan ? h('div', { className: 'bt-taskflow-board' },
        h(Overview, { plan, members: data.members, roomName: data.room?.name }),
        plan.pending_confirmations?.length ? h('section', { className: 'bt-taskflow-pending' },
          h('h3', null, t('Waiting for confirmation')),
          plan.pending_confirmations.map(item => ['before_dispatch', 'after_result'].includes(item.stage) && onConfirm
            ? h(Confirmation, { key: item.card_id, item, onConfirm })
            : h('p', { key: item.card_id ?? item.cardId }, `${item.member_name}: ${item.question ?? item.reason ?? ''}`))) : null) : null,
      h('section', { className: 'bt-taskflow-history', 'aria-label': t('Event timeline') },
        h('div', { className: 'bt-taskflow-history-head' },
          h('strong', null, t('Now'), ' ', new Date(data.generatedAt).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' })),
          h('span', { className: 'bt-taskflow-live' }, t('Live · refreshes every 2 seconds'))),
        rows.length ? h('section', { className: 'bt-taskflow-summaries', 'aria-label': t('Task summaries') },
          rows.map(row => {
            const current = row.tasks[0]
            return h(TaskflowCard, { key: row.key, card: { ...current.card, usedSkills: row.usedSkills },
              planId: current.planId, tasks: row.tasks, flowKey: row.key, lane: lanes.get(row.key), member: memberFor(data, row.roomId, row.member) },
            row.tasks.map(task => h(TaskRecord, { key: task.key, task },
              task.event ? h(Event, { item: task.event, now: data.generatedAt }) : null)))
          })) : h('p', { className: 'bt-taskflow-empty' }, t('No events yet.')))) : null)

}

export const DASHBOARD_CSS = `
.bt-taskflow-trigger{position:absolute;right:12px;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:.5px solid var(--bt-glass-rim);border-radius:999px;background:var(--bt-glass-bg);color:var(--bt-ink);cursor:pointer;pointer-events:auto}
.bt-taskflow-trigger:hover,.bt-taskflow-trigger[aria-expanded=true]{background:var(--bt-hover)}
.bt-taskflow-trigger svg{width:16px;height:16px}
.bt-taskflow{display:grid;gap:16px;color:var(--bt-ink);font-size:13px;line-height:18px;min-width:0}
.bt-taskflow-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.bt-taskflow-board{display:grid;gap:12px;min-width:0}
.bt-taskflow-title{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0}
.bt-taskflow-level{display:inline-block;flex:none;border:1px solid var(--bt-line);border-radius:4px;padding:0 5px;color:var(--bt-ink-2);font-size:11px;line-height:18px;white-space:nowrap}
.bt-taskflow-level[data-tier=excellent]{color:var(--bt-accent)}
.bt-taskflow-level[data-tier=premium]{color:var(--bt-star)}
.bt-taskflow-capabilities{display:flex;flex-wrap:wrap;align-items:center;gap:5px;min-width:0;padding:4px 0}
.bt-taskflow-chip{display:inline-block;flex:none;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid var(--bt-line);border-radius:4px;padding:1px 6px;color:var(--bt-ink-2);font-size:11px}
.bt-taskflow-chip[data-kind=model]{color:var(--bt-ink)}
.bt-taskflow-chip[data-kind=tool]{border-color:var(--bt-star);color:var(--bt-star)}
.bt-taskflow-chip[data-used=true]{border-color:var(--bt-accent);color:var(--bt-accent)}
.bt-taskflow-more{border:1px solid var(--bt-line);border-radius:4px;background:var(--bt-main);color:var(--bt-ink-2);padding:1px 6px;font:11px/16px var(--bt-font);cursor:pointer}
.bt-taskflow-more:hover,.bt-taskflow-more:focus-visible{color:var(--bt-ink);border-color:var(--bt-accent)}
.bt-taskflow-task-ref{display:inline-block;flex:0 1 auto;max-width:min(52%,220px);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid var(--task-color,var(--bt-accent));border-radius:4px;padding:1px 6px;color:var(--task-color,var(--bt-accent));background:color-mix(in srgb,var(--task-color,var(--bt-accent)) 12%,transparent);font-size:11px;line-height:16px}
.bt-taskflow-event-head .bt-taskflow-task-ref{margin-left:auto}
.bt-taskflow-event-head .bt-taskflow-event-owner{margin-left:0}
.bt-taskflow-count{margin-left:auto;color:var(--bt-accent);font-size:12px}
.bt-taskflow-detail{display:none;overflow-wrap:anywhere}
.bt-taskflow-item:hover .bt-taskflow-detail,.bt-taskflow-item:focus-within .bt-taskflow-detail{display:block}
.bt-taskflow-item pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/18px var(--bt-font);background:var(--bt-main);padding:8px;border-radius:6px}
.bt-taskflow-item small{display:block;margin-top:6px;color:var(--bt-ink-2)}
.bt-taskflow-dashboard{container-type:inline-size;gap:16px}
.bt-taskflow-dashboard .bt-taskflow-toolbar{align-items:center}
.bt-taskflow-dashboard .bt-taskflow-toolbar h2{font-size:15px;line-height:20px;font-weight:600;margin:0 8px 0 0;white-space:nowrap}
.bt-taskflow-toolbar select{min-width:100px;max-width:180px;height:28px;border:1px solid var(--bt-line-2);border-radius:8px;background:var(--bt-card);color:var(--bt-ink);font:12px var(--bt-font);padding:0 8px}
.bt-taskflow-toolbar button{min-height:28px}
.bt-taskflow-legend{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-left:auto;color:var(--bt-ink-2);font-size:11px}
.bt-taskflow-legend span{display:inline-flex;gap:5px;align-items:center;white-space:nowrap}
.bt-taskflow-legend span::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--bt-line-2)}
.bt-taskflow-legend [data-state=running]::before{background:var(--bt-star)}
.bt-taskflow-legend [data-state=accepted]::before{background:var(--bt-green)}
.bt-taskflow-legend [data-state=failed]::before{background:var(--bt-danger)}
.bt-taskflow-legend [data-state=pending]::before{background:var(--bt-accent)}
.bt-taskflow-overview,.bt-taskflow-pending{border:1px solid var(--bt-line-2);border-radius:12px;background:var(--bt-card);padding:12px;min-width:0}
.bt-taskflow-confirm>div{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.bt-taskflow-confirm>.bt-taskflow-reviewed-result{display:grid;min-width:0}
.bt-taskflow-reviewed-result pre{margin:0;max-height:180px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.bt-taskflow-confirm input{min-width:120px;flex:1;border:1px solid var(--bt-line-2);border-radius:6px;background:var(--bt-main);color:var(--bt-ink);padding:6px}
.bt-taskflow-confirm button{border:1px solid var(--bt-line-2);border-radius:6px;background:var(--bt-main);color:var(--bt-ink);padding:6px 9px;cursor:pointer}
.bt-taskflow-overview-head{display:flex;align-items:center;gap:10px;min-width:0}
.bt-taskflow-owner{display:grid;min-width:0;gap:2px;flex:1}
.bt-taskflow-owner small,.bt-taskflow-room{font-size:11px;color:var(--bt-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-taskflow-owner strong,.bt-taskflow-dispatch strong{font-weight:600}
.bt-taskflow-role{border:1px solid var(--bt-line);border-radius:4px;padding:0 5px;font-size:11px;color:var(--bt-ink-2)}
.bt-taskflow-overview-head>.bt-taskflow-count{margin-left:0;flex:none}
.bt-taskflow-goal{font-size:13px;line-height:18px;margin:12px 0 8px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow-wrap:anywhere}
.bt-taskflow-progress{display:flex;align-items:center;gap:8px;color:var(--bt-ink-2);font-size:11px;min-width:0}
.bt-taskflow-progress .bt-taskflow-id{flex:0 1 auto}
.bt-taskflow-overview progress{width:100%;height:5px;margin:8px 0 0;accent-color:var(--bt-green)}
.bt-taskflow-dashboard .bt-taskflow-id{display:inline-block;max-width:180px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid var(--bt-line-2);border-radius:4px;padding:1px 6px;color:var(--bt-ink-2);font-size:11px;line-height:16px;vertical-align:middle;flex:none}
.bt-taskflow-dashboard .bt-taskflow-count{font-size:11px;white-space:nowrap}
.bt-taskflow-count[data-tone=verified],.bt-taskflow-count[data-tone=completed],.bt-taskflow-event[data-tone=success] .bt-taskflow-event-status{color:var(--bt-green)}
.bt-taskflow-count[data-tone=failed],.bt-taskflow-event[data-tone=danger] .bt-taskflow-event-status{color:var(--bt-danger)}
.bt-taskflow-count[data-tone=cancelled]{color:var(--bt-ink-2)}
.bt-taskflow-dispatch{display:flex;align-items:center;gap:0;margin-top:8px;min-width:0}
.bt-taskflow-dispatch-mark{position:relative;display:grid;place-items:center;flex:none;width:28px;height:28px;border:1px solid var(--bt-star);border-radius:50%;corner-shape:round;color:var(--bt-star);font-size:13px}
.bt-taskflow-dispatch-mark::after{content:'';position:absolute;left:calc(100% + 2px);top:50%;width:40px;border-top:1px solid var(--bt-star)}
.bt-taskflow-dispatch-content{min-width:0;flex:1;margin-left:44px;border:1px solid var(--bt-line);border-radius:8px;padding:8px;background:var(--bt-main)}
.bt-taskflow-dashboard .bt-taskflow-capabilities{flex-wrap:wrap}
.bt-taskflow-dashboard .bt-taskflow-chip{border-radius:4px;line-height:16px}
.bt-taskflow-overview-note{background:var(--bt-main);border:1px solid var(--bt-line);border-radius:8px;padding:8px;margin-top:5px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:16px}
.bt-taskflow-flow{position:relative;display:grid;gap:16px;min-width:0}
.bt-taskflow-paths{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;z-index:1}
.bt-taskflow-paths path{fill:none;stroke-width:1.3;stroke-linecap:round;stroke-linejoin:round}
.bt-taskflow-summaries{position:relative;border:1px solid var(--bt-line-2);border-radius:10px;background:var(--bt-card);overflow:hidden}
.bt-taskflow-dashboard .bt-taskflow-item{position:relative;z-index:2;padding:8px 2px 8px calc(38px + var(--last-lane) * 16px);border-top:0;border-bottom:1px solid var(--bt-line);min-width:0;outline:none}
.bt-taskflow-dashboard .bt-taskflow-item:last-child{border-bottom:0}
.bt-taskflow-step-node{position:absolute;left:calc(5px + var(--lane) * 16px);top:6px;display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:var(--bt-card)}
.bt-taskflow-dashboard .bt-taskflow-item:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px;border-radius:6px}
.bt-taskflow-dashboard .bt-taskflow-item .bt-taskflow-id{max-width:min(180px,45%)}
.bt-taskflow-summary{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--bt-ink-2);font-size:12px;min-width:0}
.bt-taskflow-item:hover .bt-taskflow-summary,.bt-taskflow-item:focus-within .bt-taskflow-summary{white-space:pre-wrap;overflow-wrap:anywhere}
.bt-taskflow-dashboard .bt-taskflow-detail{padding:8px;margin-top:5px;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-card)}

.bt-taskflow-history{border-top:1px solid var(--bt-line-2);padding-top:10px;min-width:0}
.bt-taskflow-history-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:12px}
.bt-taskflow-history-head strong{font-weight:600}
.bt-taskflow-live{color:var(--bt-ink-2);font-size:11px}
.bt-taskflow-live::before{content:'';display:inline-block;width:6px;height:6px;margin:0 6px 1px 0;border-radius:50%;corner-shape:round;background:var(--bt-green)}
.bt-taskflow-events{position:relative;margin:12px 0 0;min-width:0}
.bt-taskflow-event{position:relative;z-index:2;margin:0 0 12px 0;padding:0 0 0 calc(39px + var(--last-lane) * 16px);min-width:0;outline:none}
.bt-taskflow-node{position:absolute;left:calc(13px + var(--lane) * 16px);top:7px;width:8px;height:8px;border:1px solid var(--bt-accent);border-radius:50%;corner-shape:round;background:var(--bt-main)}
.bt-taskflow-event[data-tone=success] .bt-taskflow-node{border-color:var(--bt-green);background:var(--bt-green)}
.bt-taskflow-event[data-tone=danger] .bt-taskflow-node{border-color:var(--bt-danger);background:var(--bt-danger)}
.bt-taskflow-event[data-tone=start] .bt-taskflow-node{border-color:var(--bt-star)}
.bt-taskflow-event:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px;border-radius:6px}
.bt-taskflow-event-body{display:grid;gap:2px;min-width:0}
.bt-taskflow-event-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.bt-taskflow-event-head strong{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-taskflow-event-status{font-size:11px;color:var(--bt-ink-2);white-space:nowrap}
.bt-taskflow-event-owner{display:inline-flex;align-items:center;gap:5px;margin-left:auto;min-width:0}
.bt-taskflow-event-owner>.bt-mark{flex:none}
.bt-taskflow-event-head time{color:var(--bt-ink-3);font-size:11px;white-space:nowrap}

.bt-taskflow-event-room{color:var(--bt-ink-3);font-size:11px}
.bt-taskflow-event-reason{color:var(--bt-danger);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-taskflow-bot-tasks{margin-top:6px;color:var(--bt-ink-2)}
.bt-taskflow-bot-tasks>summary{cursor:pointer;font-size:12px;padding:3px 0}
.bt-taskflow-task-record{border-top:1px solid var(--bt-line);padding:8px 0;min-width:0}
.bt-taskflow-task-record p,.bt-taskflow-task-record pre{margin:6px 0;white-space:pre-wrap;overflow-wrap:anywhere}
.bt-taskflow-task-record .bt-taskflow-task-ref{max-width:70%}
.bt-taskflow-history>.bt-taskflow-summaries{margin-top:10px}
.bt-taskflow-event-history{font-size:11px;color:var(--bt-ink-2);min-width:0}
.bt-taskflow-event-history summary{cursor:pointer}
.bt-taskflow-event-history ol{margin:4px 0;padding-left:16px}
.bt-taskflow-event-history li{overflow-wrap:anywhere}
.bt-taskflow-empty{padding:12px;color:var(--bt-ink-2);font-size:12px}
@container (max-width:480px){.bt-taskflow-event-owner{margin-left:0;width:100%}.bt-taskflow-overview-head>.bt-taskflow-count{margin-left:auto}.bt-taskflow-dashboard .bt-taskflow-id{max-width:110px}}
`