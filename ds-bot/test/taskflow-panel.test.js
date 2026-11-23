import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/details-drawer.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) })
const requireFake = name => {
  const platform = {
      react: { createElement: h, Fragment: 'fragment', createContext: value => ({ value }),
        useContext: context => context.value, useId: () => 'test',
        useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
        useEffect: () => {}, useLayoutEffect: () => {}, useRef: initial => ({ current: initial }),
        useMemo: make => make(), useCallback: fn => fn, useSyncExternalStore: (_, get) => get(),
      },
      'react-dom': { createPortal: node => node },
      '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: () => null },
  }
  if (!(name in platform)) throw new Error(`no platform module ${name}`)
  return platform[name]
}
const context = target => ({
  module: target, exports: target.exports, URL, URLSearchParams, setTimeout, clearTimeout,
  window: { addEventListener() {}, removeEventListener() {}, innerWidth: 1280 }, require: requireFake,
})
runInNewContext(bundle.outputFiles[0].text, context(module))
const nodes = (tree, match, found = []) => {
  if (Array.isArray(tree)) tree.forEach(child => nodes(child, match, found))
  else if (tree && typeof tree === 'object') {
    if (match(tree)) found.push(tree)
    for (const child of tree.children ?? []) nodes(child, match, found)
  }
  return found
}

const room = { id: 'room-a', name: 'Group A', members: [], admin: null }
const props = actions => ({
  sessionId: room.id, startTab: 'taskflow', hasStrip: false,
  roster: { byId: {}, roomsById: { [room.id]: room }, memory: false, exchangeTurns: {} },
  actions, useSessions: select => select({ byId: {}, projectionsBySession: {} }),
  useSessionStatus: select => select(new Map()), useActivity: select => select({}),
  useWork: select => select({}), useBrowserTabs: select => select({}), useBrowserPages: select => select({}),
})

test('the group taskflow tab renders the board for this group inside the details pane', () => {
  const selected = []
  const tree = module.exports.DetailsDrawer(props({ setPanelTab: tab => selected.push(tab) }))
  const tabs = nodes(tree, node => node.props?.role === 'tab')
  assert.equal(tabs.length, 2)
  assert.equal(tabs[1].props['aria-selected'], true)
  const [body] = nodes(tree, node => node.props?.className === 'bt-drawer-body')
  const [board] = nodes(body, node => node.type?.name === 'TaskflowPage')
  assert.equal(board.props.roomId, room.id)
  assert.equal(board.props.key, room.id)
  tabs[0].props.onClick()
  assert.deepEqual(selected, [null])
})

const headerBundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/header.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const header = { exports: {} }
runInNewContext(headerBundle.outputFiles[0].text, context(header))

test('the group header opens and closes the taskflow tab in the chat panel', () => {
  const calls = []
  const ui = { details: null, tab: null, visits: {} }
  const render = () => header.exports.HeaderPill({
    sessionId: room.id,
    useRoster: select => select({ byId: {}, roomsById: { [room.id]: room }, memory: false }),
    useSessions: select => select({ byId: {}, projectionsBySession: {} }),
    useSessionStatus: select => select(new Map()), useActivity: select => select({}),
    useWork: select => select({}), useTurnClock: select => select({}),
    useMemoryNews: select => select({}), useUi: select => select(ui),
    actions: { showDetails: (...args) => calls.push(['open', ...args]), closePanel: () => calls.push(['close']) },
  })
  const trigger = () => nodes(render(), node => node.props?.className === 'bt-taskflow-trigger')[0]
  assert.equal(trigger().props['aria-expanded'], false)
  trigger().props.onClick()
  assert.deepEqual(calls, [['open', room.id, 'taskflow']])
  Object.assign(ui, { details: room.id, tab: 'taskflow' })
  assert.equal(trigger().props['aria-expanded'], true)
  trigger().props.onClick()
  assert.deepEqual(calls, [['open', room.id, 'taskflow'], ['close']])
})

const pageBundle = await build({
  entryPoints: [process.env.TASKFLOW_DASHBOARD_SOURCE ?? fileURLToPath(new URL('../src/client/taskflow-dashboard.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false, external: ['react'],
})
const page = { exports: {} }
runInNewContext(pageBundle.outputFiles[0].text, context(page))

test('executor area shows one Bot without task cards or task contents', () => {
  const data = { generatedAt: 100000, room: { id: 'create', admin: 'chief' }, members: { image: { name: 'lq-image' } },
    plan: { room: 'create', plan_id: 'cover-plan', principal: 'chief', cards: [
      { id: 'xhs-cover-glm55', member: 'image', goal: '制作封面一', state: 'verified' },
      { id: 'xhs-cover-dots', member: 'image', goal: '制作封面二', state: 'running' },
      { id: 'xhs-cover-livanhong', member: 'image', goal: '制作封面三', state: 'pending' },
    ] }, timeline: [{ room: 'create', plan_id: 'cover-plan', card_id: 'xhs-cover-dots', member: 'image', type: 'receipt_bound', seq: 1, at: 90 }] }
  const view = page.exports.DashboardView({ data })
  const [area] = nodes(view, node => node.props?.className === 'bt-taskflow-summaries')
  assert.equal(area.children.length, 1, 'one executor row for three tasks')
  const row = area.children[0].type(area.children[0].props)
  assert.doesNotMatch(JSON.stringify(row), /xhs-cover|制作封面/)
  assert.equal(nodes(view, node => node.type?.name === 'Event').length, 1, 'timeline remains available')
})

test('formal work remains visible while observed historical messages stay in source data', () => {
  const group = { id: 'create', name: 'lq-create', admin: 'lead' }
  const data = { generatedAt: 100000, room: group, rooms: [group], members: {
    review: { id: 'review', name: 'lq-review', model: 'provider/model', skills: [] },
  }, plan: { room: group.id, plan_id: 'cyber', principal: 'lead', status: 'completed', cards: [
    { id: 'verify-cyber-p2', member: 'review', goal: '定点复核', state: 'verified', usedSkills: ['verify'] },
  ] }, observedTasks: [{ id: 'group-create-896-review', member: 'review', room: 'create',
    goal: '写 review-cyber/verify-cyber 心得，四段式真实内容。', state: 'replied', usedSkills: ['reflect'],
    source: { kind: 'group_message', seq: 896, at: null } }], timeline: [
    { room: 'create', plan_id: 'cyber', card_id: 'verify-cyber-p2', member: 'review', type: 'result_accepted', seq: 1, at: 90 },
  ] }
  const before = JSON.stringify(data)
  const view = page.exports.DashboardView({ data })
  const cards = nodes(view, node => node.type?.name === 'ExecutorRow')
  assert.equal(cards.length, 1, 'only formal work appears in task summaries')

  assert.equal(nodes(view, node => node.props?.className === 'bt-taskflow-observation').length, 0)
  const tree = cards[0].type({ ...cards[0].props, children: cards[0].children })
  assert.equal(nodes(tree, node => node.type?.name === 'BotAvatar').length, 1)
  assert.equal(nodes(tree, node => node.type?.name === 'Capabilities').length, 1)
  assert.deepEqual(Array.from(cards[0].props.usedSkills), ['verify'])
  assert.equal(nodes(tree, node => node.type === 'details' && node.props.className === 'bt-taskflow-bot-tasks').length, 0)
  assert.equal(nodes(view, node => node.type?.name === 'Event').length, 1)
  assert.doesNotMatch(JSON.stringify(view), /写 review-cyber\/verify-cyber 心得/)
  assert.equal(JSON.stringify(data), before)
})



test('a task summary and its lifecycle event share the same Bot rail', () => {
  const data = { generatedAt: 3000, room, members: {}, plan: { plan_id: 'p', principal: 'lead',
    cards: [{ id: 'draft', member: 'writer', state: 'verified' }] },
  timeline: [{ plan_id: 'p', card_id: 'draft', member: 'writer', seq: 1, at: 1, type: 'result_accepted' }] }
  const view = page.exports.DashboardView({ data })
  const [card] = nodes(view, node => node.type?.name === 'ExecutorRow')
  const [event] = nodes(view, node => node.type?.name === 'Event')
  const [avatar] = nodes(card.type(card.props), node => node.props?.['data-flow-node'])
  const [dot] = nodes(event.type(event.props), node => node.props?.['data-flow-node'])
  assert.equal(dot.props['data-flow-key'], avatar.props['data-flow-key'])
  assert.equal(dot.props['data-lane'], avatar.props['data-lane'])
  assert.equal(nodes(event.type(event.props), node => node.type?.name === 'BotAvatar').length, 0)
})

test('task summaries and timeline keep distinct Bot and room identities', () => {
  const rooms = [{ id: 'a', admin: 'chief' }, { id: 'b', admin: 'other' }]
  const data = { room: rooms[0], rooms, members: { x: { name: 'Same' }, y: { name: 'Same' } },
    plan: { room: 'a', plan_id: 'p', principal: 'chief', cards: [
      { id: 'done', member: 'x', state: 'verified', goal: 'Finished', usedSkills: ['check'] },
      { id: 'active', member: 'x', state: 'running', goal: 'Still running', usedSkills: ['write'] },
      { id: 'different', member: 'y', state: 'pending', goal: 'Different Bot' },
    ] }, observedTasks: [{ id: 'group-b-2-x', room: 'b', member: 'x', state: 'replied',
      goal: 'Other group', source: { kind: 'group_message', seq: 2 } }], timeline: [
      { room: 'a', plan_id: 'p', card_id: 'done', member: 'x', type: 'result_accepted', seq: 1, at: 100 },
      { room: 'a', plan_id: 'old', card_id: 'done', member: 'x', type: 'card_failed', seq: 2, at: 101, payload: { reason: 'keep failure' } },
    ] }
  const before = JSON.stringify(data)
  data.generatedAt = 102000
  const view = page.exports.DashboardView({ data })
  const rows = nodes(view, node => node.type?.name === 'ExecutorRow')
  assert.equal(rows.length, 2)
  assert.notEqual(rows[0].props.flowKey, rows[1].props.flowKey, 'same display names are distinct Bots')
  assert.deepEqual(Array.from(rows[0].props.usedSkills), ['check', 'write'])
  assert.ok(nodes(rows[0].type(rows[0].props), node => node.type === 'strong' && node.children.includes('Same')).length)
  assert.doesNotMatch(JSON.stringify(rows[0].type(rows[0].props)), /Still running|Finished|active/)
  const events = nodes(view, node => node.type?.name === 'Event')
  assert.equal(events.length, 1)
  assert.equal(events[0].props.item.plan_id, 'p')
  assert.equal(data.timeline[1].payload.reason, 'keep failure')
  assert.doesNotMatch(JSON.stringify(view), /Other group/)
  delete data.generatedAt
  assert.equal(JSON.stringify(data), before)
})

test('all groups show each current plan and hide older plans and history control', () => {
  const rooms = [{ id: 'a', admin: 'leader', planId: 'plan-0' }, { id: 'b', admin: 'leader', planId: 'plan-1' }]
  const plans = rooms.map((room, index) => ({ room: room.id, plan_id: `plan-${index}`, principal: 'leader', cards: [{ id: 'task', member: 'worker', state: 'verified' }] }))
  plans.push({ room: 'a', plan_id: 'old', principal: 'leader', cards: [{ id: 'past', member: 'worker', state: 'verified' }] })
  let clicked = 0
  const view = page.exports.DashboardView({ scope: 'all', data: { generatedAt: 3000, rooms, room: rooms[0], plan: plans[0], fullPlans: plans, timeline: [], timelineNext: { at: 1, seq: 1 } }, onLoadOlder: () => clicked++ })
  const cards = nodes(view, node => node.type?.name === 'ExecutorRow')
  assert.equal(cards.length, 2)
  assert.notEqual(cards[0].props.flowKey, cards[1].props.flowKey)
  const [button] = nodes(view, node => node.type === 'button' && node.children.includes('Load earlier'))
  assert.equal(button, undefined)
  assert.equal(clicked, 0)
})

test('all groups overview uses a current plan and does not confirm a different plan', () => {
  const rooms = [{ id: 'a', name: 'A', admin: 'leader', planId: 'current-a' }, { id: 'b', name: 'B', admin: 'boss', planId: 'current-b' }]
  const old = { room: 'a', plan_id: 'old', principal: 'leader', cards: [] }
  const current = { room: 'b', plan_id: 'current-b', principal: 'boss', cards: [], pending_confirmations: [{ card_id: 'verify', stage: 'after_result', member_name: 'Worker' }] }
  const data = { generatedAt: 1000, rooms, room: rooms[0], plan: old, fullPlans: [old, current], membersByRoom: { b: { boss: { name: 'Boss B' } } }, timeline: [] }
  const view = page.exports.DashboardView({ scope: 'all', data, onConfirm: () => { throw Error('wrong plan') } })
  const [overview] = nodes(view, node => node.type?.name === 'Overview')
  assert.equal(overview.props.plan.plan_id, 'current-b')
  assert.equal(overview.props.roomName, 'B')
  assert.equal(overview.props.members.boss.name, 'Boss B')
  assert.equal(nodes(view, node => node.type?.name === 'Confirmation').length, 0)
})

test('all-group Bot rows read levels and active tools from their own room snapshot', () => {
  const rooms = [{ id: 'a', admin: 'chief', planId: 'a' }, { id: 'b', admin: 'other', planId: 'b' }]
  const a = { id: 'worker', name: 'Worker', model: 'm', level: { level: 1.6, tier: 'normal' }, tool: null }
  const b = { ...a, level: { level: 17, tier: 'excellent' }, tool: 'read_file' }
  const data = { generatedAt: 100000, room: rooms[0], rooms, members: { worker: a },
    membersByRoom: { a: { worker: a }, b: { worker: b } }, fullPlans: rooms.map(r => ({ room: r.id, plan_id: r.id, principal: r.admin,
      cards: [{ id: 'work', member: 'worker', state: 'running', goal: r.id }] })), timeline: [] }
  const cards = nodes(page.exports.DashboardView({ data, scope: 'all' }), node => node.type?.name === 'ExecutorRow')
  assert.equal(cards.length, 2)
  assert.equal(cards[0].props.member.level.level, 1.6)
  assert.equal(cards[1].props.member.level.level, 17)
  assert.equal(cards[0].props.member.tool, null)
  assert.equal(cards[1].props.member.tool, 'read_file')
  delete data.membersByRoom
  const old = nodes(page.exports.DashboardView({ data, scope: 'all' }), node => node.type?.name === 'ExecutorRow')
  assert.equal(old[1].props.member.level, null, 'legacy flat snapshots cannot assert a foreign room level')
  assert.equal(old[1].props.member.tool, null)
})

test('a group taskflow first requests its own room even when another room has a newer plan', () => {
  const requests = []
  const effects = []
  const isolated = { exports: {} }
  runInNewContext(pageBundle.outputFiles[0].text, {
    ...context(isolated),
    require: name => name === 'react'
      ? { ...requireFake(name), useEffect: effect => effects.push(effect) }
      : requireFake(name),
    fetch: async (_route, options) => {
      requests.push(JSON.parse(options.body))
      return { ok: true, json: async () => ({ ok: true, value: { rooms: [], room, plan: null, timeline: [] } }) }
    },
    setInterval: () => 1, clearInterval: () => {},
  })
  const board = isolated.exports.TaskflowPage({ roomId: room.id })
  assert.equal(board.props.scope, room.id)
  for (const effect of effects) effect()
  assert.deepEqual(requests, [{ endpoint: 'taskflow-state', payload: { room: room.id, currentOnly: true } }])
})

test('a group taskflow cannot confirm a plan viewed from another room', () => {
  const isolated = { exports: {} }
  const other = { room: { id: 'room-b' }, plan: { plan_id: 'plan-b' }, rooms: [] }
  let hook = 0
  runInNewContext(pageBundle.outputFiles[0].text, {
    ...context(isolated),
    require: name => name === 'react'
      ? { ...requireFake(name), useState: initial => [hook++ === 1 ? other : initial, () => {}] }
      : requireFake(name),
  })
  const board = isolated.exports.TaskflowPage({ roomId: room.id })
  assert.equal(board.props.onConfirm, undefined)
})

test('the current group keeps its confirmation controls', () => {
  const isolated = { exports: {} }
  const current = { room: { id: room.id }, plan: { plan_id: 'plan-a' }, rooms: [] }
  let hook = 0
  runInNewContext(pageBundle.outputFiles[0].text, {
    ...context(isolated),
    require: name => name === 'react'
      ? { ...requireFake(name), useState: initial => [hook++ === 1 ? current : initial, () => {}] }
      : requireFake(name),
  })
  const board = isolated.exports.TaskflowPage({ roomId: room.id })
  assert.equal(typeof board.props.onConfirm, 'function')
})

test('the embedded taskflow board gives the owner working approve and reject controls', async () => {
  const calls = []
  const data = { generatedAt: Date.now(), room: { id: 'room-1', name: 'Ops' }, members: {}, timeline: [],
    plan: { plan_id: 'plan-1', principal: 'bot-admin', goal: 'publish', status: 'open', cards: [],
      pending_confirmations: [{ card_id: 'publish', member_name: 'Writer', question: 'Publish now?', stage: 'before_dispatch' }] } }
  const board = page.exports.DashboardView({ data, onConfirm: async (...args) => calls.push(args) })
  const [component] = nodes(board, node => node.type?.name === 'Confirmation')
  assert.equal(component.props.item.card_id, 'publish')
  const card = component.type(component.props)
  const buttons = nodes(card, node => node.type === 'button')
  assert.equal(buttons.length, 2)
  await buttons[0].props.onClick()
  await buttons[1].props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(calls, [['publish', 'approve', '', 'before_dispatch', undefined], ['publish', 'reject', '', 'before_dispatch', undefined]])
})

test('the board shows a legacy submitted result and offers a terminal-bound decision', async () => {
  const calls = []
  const data = { generatedAt: Date.now(), room: { id: 'room-1', name: 'Ops' }, members: {}, timeline: [],
    plan: { plan_id: 'plan-1', principal: 'bot-admin', goal: 'publish', status: 'open', cards: [],
      pending_confirmations: [{ card_id: 'publish', member_name: 'Writer', question: 'Publish now?',
        stage: 'after_result', terminal: 'terminal-1', result: 'ready for publication' }] } }
  const board = page.exports.DashboardView({ data, onConfirm: async (...args) => calls.push(args) })
  const [component] = nodes(board, node => node.type?.name === 'Confirmation')
  assert.equal(component.props.item.terminal, 'terminal-1')
  const card = component.type(component.props)
  assert.ok(nodes(card, node => node.children?.includes('ready for publication')).length > 0)
  const buttons = nodes(card, node => node.type === 'button')
  await buttons[0].props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(calls, [['publish', 'approve', '', 'after_result', 'terminal-1']])
})

test('task text has no avatar while its Bot track uses the configured avatar', () => {
  const card = { id: 'long-task-identifier-2026', member: 'bot-a', member_name: 'Writer',
    goal: 'A very long task instruction', state: 'running' }
  const member = { id: 'bot-a', name: 'Writer', avatar: { shape: 'fox' }, color: 'violet',
    model: 'provider/model', skills: ['draft'], tool: 'write_file' }
  const item = page.exports.TaskflowCard({ card, member })
  assert.equal(item.type, 'article')
  const [track] = nodes(item, node => node.props?.className === 'bt-taskflow-step-node')
  const [trackAvatar] = nodes(track, node => node.type?.name === 'BotAvatar')
  assert.equal(trackAvatar.props.bot, member)
  assert.equal(trackAvatar.props.size, 24)
  assert.equal(nodes(item, node => node.type?.name === 'BotAvatar').length, 1)
  assert.equal(nodes(item, node => node.props?.className === 'bt-taskflow-title' && node.type === 'div')[0].children.some(child => child?.type?.name === 'BotAvatar'), false)
  assert.equal(nodes(item, node => node.type === 'strong')[0].children[0], member.name)
  assert.equal(item.props.tabIndex, 0)
  assert.equal(nodes(item, node => node.props?.className === 'bt-taskflow-task-ref')[0].props.title, card.id)
  const [capabilities] = nodes(item, node => node.type?.name === 'Capabilities')
  const labels = nodes(capabilities.type(capabilities.props), node => node.props?.className === 'bt-taskflow-chip')
  assert.deepEqual(labels.map(node => node.children[0]), ['provider/model', 'write_file', 'draft'])
  assert.equal(nodes(item, node => node.props?.className === 'bt-taskflow-summary')[0].props.title, card.goal)
  assert.equal(nodes(item, node => node.props?.className === 'bt-taskflow-detail').length, 0)
  assert.match(page.exports.DASHBOARD_CSS, /\.bt-taskflow-capabilities\{[^}]*flex-wrap:wrap/)
  assert.match(page.exports.DASHBOARD_CSS, /\.bt-taskflow-item:hover \.bt-taskflow-detail/)
  assert.match(page.exports.DASHBOARD_CSS, /\.bt-taskflow-item:focus-within \.bt-taskflow-detail/)
  assert.equal(nodes(item, node => String(node.children?.[0]).startsWith('session-')).length, 0)
})

test('Bot level badges show zero and tiered group levels without consuming capability slots', () => {
  for (const level of [{ count: 0, level: 0, tier: 'normal' }, { count: 160, level: 16, tier: 'excellent' },
    { count: 161, level: 16.01, tier: 'excellent' }, { count: 1260, level: 27, tier: 'premium' },
    { count: 1261, level: 27.01, tier: 'premium' }, { count: 2660, level: 41, tier: 'premium' }]) {
    const item = page.exports.TaskflowCard({ card: { id: 'task', member: 'bot-a', state: 'running', goal: 'Check' },
      member: { id: 'bot-a', name: 'Writer', level, model: 'provider/model', skills: ['draft'] } })
    const [component] = nodes(item, node => node.type?.name === 'BotLevel')
    assert.ok(component, 'the member title must render its group level')
    const badge = component.type(component.props)
    assert.equal(badge.props['data-tier'], level.tier)
    assert.ok(badge.children.join('').includes(`Lv ${level.level.toFixed(2)}`))
    assert.ok(badge.props.title.includes(String(level.count)))
    assert.ok(badge.props.title.includes('completed'))
    assert.ok(badge.props.title.includes('0.01'))
    if (level.tier !== 'premium') assert.ok(badge.props.title.includes('Next tier at'), 'progress to the next tier is explained')
    else assert.ok(badge.props.title.includes('Highest tier'), 'highest tier is explained')
    const [capabilities] = nodes(item, node => node.type?.name === 'Capabilities')
    assert.equal(nodes(capabilities.type(capabilities.props), node => node.props?.className === 'bt-taskflow-chip').length, 2)
  }
  const missing = page.exports.TaskflowCard({ card: { id: 'task', member: 'bot-a', state: 'pending' }, member: { name: 'Writer' } })
  const [component] = nodes(missing, node => node.type?.name === 'BotLevel')
  assert.equal(component.type(component.props).props['data-tier'], 'unknown')
  assert.equal(component.type(component.props).children.join('').includes('Lv 0.0'), false)
})

test('task identifiers remain distinct and used skills lead the five visible tool and skill chips', () => {
  const data = { generatedAt: Date.now(), room, members: {
    reviewer: { id: 'reviewer', name: 'Reviewer', model: 'provider/model', tool: 'skill',
      skills: ['one', 'two', 'three', 'four', 'five', 'six', 'seven'] },
  }, plan: { plan_id: 'plan-x', principal: 'lead', status: 'completed', goal: 'Publish',
    cards: [{ id: 'review', member: 'reviewer', goal: 'Check the sources', state: 'verified', usedSkills: ['seven'] }] },
  timeline: [{ plan_id: 'plan-x', card_id: 'review', member: 'reviewer', seq: 1,
    type: 'result_accepted', at: Date.now() / 1000 }] }
  const view = page.exports.DashboardView({ data })
  const [card] = nodes(view, node => node.type?.name === 'ExecutorRow')
  const rendered = card.type(card.props)
  assert.equal(nodes(rendered, node => node.props?.className === 'bt-taskflow-task-ref').length, 0)
  const [capabilities] = nodes(rendered, node => node.type?.name === 'Capabilities')
  const body = capabilities.type(capabilities.props)
  const chips = nodes(body, node => node.props?.className === 'bt-taskflow-chip')
  assert.deepEqual(chips.map(chip => chip.children[0]), ['provider/model', 'seven', 'skill', 'one', 'two', 'three'])
  assert.equal(chips[0].props['data-kind'], 'model')
  assert.equal(chips[1].props['data-used'], true)
  const [more] = nodes(body, node => node.props?.className === 'bt-taskflow-more')
  assert.equal(more.children[0], '+3')
  assert.equal(more.props['aria-expanded'], false)
  const [event] = nodes(view, node => node.type?.name === 'Event')
  const [eventTag] = nodes(event.type(event.props), node => node.props?.className === 'bt-taskflow-task-ref')
  assert.equal(nodes(event.type(event.props), node => node.type?.name === 'BotAvatar').length, 0)
  assert.equal(eventTag.props.title, 'plan-x/review')
  assert.equal(eventTag.children[0], 'review · plan-x')
})

test('a skill that was not assigned is visible as used for a task and the principal overview', () => {
  const member = { name: 'Writer', model: 'provider/model', skills: [], usedSkills: ['group-only'] }
  const card = page.exports.TaskflowCard({ card: { id: 'write', member: 'writer', state: 'running', usedSkills: ['actually-called'] }, member })
  const [caps] = nodes(card, node => node.type?.name === 'Capabilities')
  const chips = nodes(caps.type(caps.props), node => node.props?.['data-kind'] === 'skill')
  assert.deepEqual(chips.map(node => [node.children[0], node.props['data-used']]), [['actually-called', true]])
  const data = { generatedAt: Date.now(), room, members: { lead: { ...member, name: 'Principal', usedSkills: ['principal-unassigned'] } },
    plan: { plan_id: 'p', principal: 'lead', status: 'open', goal: 'Work', cards: [] }, timeline: [] }
  const [overview] = nodes(page.exports.DashboardView({ data }), node => node.type?.name === 'Overview')
  const [principalCaps] = nodes(overview.type(overview.props), node => node.type?.name === 'Capabilities')
  assert.deepEqual(nodes(principalCaps.type(principalCaps.props), node => node.props?.['data-kind'] === 'skill')
    .map(node => node.children[0]), ['principal-unassigned'])
})

test('Bot identities keep avatars in overview, track and timeline, but not task text', () => {
  const member = { id: 'bot-a', name: 'Writer', avatar: { shape: 'fox' }, color: 'violet' }
  const data = { generatedAt: Date.now(), room: { id: room.id, name: room.name },
    members: { 'bot-a': member, lead: { id: 'lead', name: 'Leader' } },
    plan: { plan_id: 'plan-a', principal: 'lead', status: 'open', goal: 'Publish',
      cards: [{ id: 'write', member: 'bot-a', goal: 'Draft', state: 'verified' }] },
    timeline: [{ plan_id: 'plan-a', seq: 1, type: 'result_accepted', member: 'bot-a',
      card_id: 'write', at: Date.now() / 1000, room_name: room.name }] }
  const board = page.exports.DashboardView({ data })
  const [overview] = nodes(board, node => node.type?.name === 'Overview')
  const topAvatars = nodes(overview.type(overview.props), node => node.type?.name === 'BotAvatar')
  assert.equal(topAvatars.length, 1)
  assert.equal(topAvatars[0].props.bot, data.members.lead)
  const [task] = nodes(board, node => node.type?.name === 'ExecutorRow')
  const [track] = nodes(task.type(task.props), node => node.props?.className === 'bt-taskflow-step-node')
  const [trackAvatar] = nodes(track, node => node.type?.name === 'BotAvatar')
  assert.equal(trackAvatar.props.bot, member)
  assert.equal(nodes(task.type(task.props), node => node.type?.name === 'BotAvatar').length, 1)
  const [event] = nodes(board, node => node.type?.name === 'Event')
  const record = event.type(event.props)
  assert.equal(nodes(record, node => node.type?.name === 'BotAvatar').length, 0)
  assert.equal(nodes(record, node => node.props?.className === 'bt-taskflow-node').length, 1)
  assert.equal(nodes(record, node => node.type === 'time').length, 1)
})

test('stored plan insight does not add an unrelated card between task summaries and events', () => {
  const insight = { title: 'Dropbox×Tigris plan insight', text: 'Preserve this stored result' }
  const data = { generatedAt: Date.now(), room, members: {},
    plan: { plan_id: 'plan-a', principal: 'lead', status: 'completed', goal: 'Publish',
      cards: [{ id: 'review', member: 'reviewer', goal: 'Check', state: 'verified' }], insight },
    timeline: [{ plan_id: 'plan-a', seq: 1, type: 'result_accepted', member: 'reviewer', at: Date.now() / 1000 }] }
  const view = page.exports.DashboardView({ data })
  const sections = nodes(view, node => ['bt-taskflow-summaries', 'bt-taskflow-history'].includes(node.props?.className))
  assert.deepEqual(sections.map(node => node.props.className), ['bt-taskflow-summaries', 'bt-taskflow-history'])
  assert.equal(nodes(view, node => node.props?.className === 'bt-taskflow-insight' || node.type?.name === 'Insight').length, 0)
  assert.equal(data.plan.insight, insight)
})

test('the overview preview shows the saved plan insight instead of the dispatch goal', () => {
  const plan = { plan_id: 'plan-a', principal: 'lead', status: 'completed', goal: 'Publish',
    cards: [{ id: 'write', member: 'writer', goal: 'Fetch source and write the article', state: 'verified' }],
    insight: { title: 'Source verification', text: 'Check the SEC filing before quoting the transaction amount.' } }
  const board = page.exports.DashboardView({ data: { plan, room, members: {}, timeline: [] } })
  const [overview] = nodes(board, node => node.type?.name === 'Overview')
  const tree = overview.type(overview.props)
  const [note] = nodes(tree, node => node.props?.className === 'bt-taskflow-overview-note')
  assert.ok(note)
  assert.equal(note.props['aria-label'], 'Plan insight')
  assert.match(JSON.stringify(note), /Source verification/)
  assert.match(JSON.stringify(note), /Check the SEC filing/)
  assert.doesNotMatch(JSON.stringify(note), /Fetch source and write the article/)
  const [task] = nodes(board, node => node.type?.name === 'ExecutorRow')
  assert.doesNotMatch(JSON.stringify(task.type(task.props)), /Fetch source and write the article/)
})

test('an overview without a saved insight stays empty rather than substituting its task goal', () => {
  const plan = { plan_id: 'plan-a', principal: 'lead', status: 'open', goal: 'Publish',
    cards: [{ id: 'write', member: 'writer', goal: 'Fetch source and write the article', state: 'running' }] }
  const board = page.exports.DashboardView({ data: { plan, room, members: {}, timeline: [] } })
  const [overview] = nodes(board, node => node.type?.name === 'Overview')
  const [note] = nodes(overview.type(overview.props), node => node.props?.className === 'bt-taskflow-overview-note')
  assert.ok(note)
  assert.match(JSON.stringify(note), /No insights yet\./)
  assert.doesNotMatch(JSON.stringify(note), /Fetch source and write the article/)
})

test('task summaries and events keep separate Bot tracks and a shared text column', () => {
  const now = Date.now()
  const data = { generatedAt: now, room, members: {},
    plan: { plan_id: 'plan-a', principal: 'lead', status: 'completed', goal: 'Publish',
      cards: [{ id: 'write', member: 'writer', goal: 'Draft', state: 'verified' },
        { id: 'review', member: 'reviewer', goal: 'Check', state: 'verified' }] },
    timeline: [
      { plan_id: 'plan-a', card_id: 'review', seq: 3, type: 'result_accepted', member: 'reviewer', at: now / 1000 },
      { plan_id: 'plan-a', card_id: 'write', seq: 2, type: 'result_accepted', member: 'writer', at: now / 1000 },
      { plan_id: 'plan-a', seq: 1, type: 'plan_finished', principal: 'lead', at: now / 1000 },
    ] }
  const view = page.exports.DashboardView({ data })
  assert.equal(view.props.style['--last-lane'], 1)
  const cards = nodes(view, node => node.type?.name === 'ExecutorRow')
  const events = nodes(view, node => node.type?.name === 'Event')
  assert.deepEqual(cards.map(node => node.props.lane), [0, 1])
  assert.deepEqual(events.map(node => node.props.item.member), ['reviewer', 'writer'])
  assert.deepEqual(cards.map(node => node.type(node.props).children[0].props['data-flow-key']), ['["room-a","writer"]', '["room-a","reviewer"]'])
  assert.ok(events.every(node => nodes(node.type(node.props), item => item.props?.['data-flow-node']).length === 1))
  assert.match(page.exports.DASHBOARD_CSS, /left:calc\(5px \+ var\(--lane\) \* 16px\)/)
  assert.match(page.exports.DASHBOARD_CSS, /padding:8px 2px 8px calc\(38px \+ var\(--last-lane\) \* 16px\)/)
})

test('draft dispatch shows its distinct lifecycle events on the visible timeline', () => {
  const goal = '写一篇约 800–1200 字的中文 AI 科技媒体文章'
  const planId = '6c856a7c-53cb-4da5-bfef-81ad32b3e966'
  const timeline = [
    { plan_id: planId, card_id: 'draft-dots', seq: 3, type: 'receipt_bound', at: 102, member: 'writer', card_goal: goal },
    { plan_id: planId, card_id: 'draft-dots', seq: 2, type: 'card_claimed', at: 101, member: 'writer', card_goal: goal },
  ]
  const data = { generatedAt: 103000, room, members: {}, timeline,
    plan: { plan_id: planId, principal: 'lead', status: 'open', cards: [{ id: 'draft-dots', member: 'writer', goal, state: 'running' }] } }
  const view = page.exports.DashboardView({ data })
  assert.equal(nodes(view, node => node.type?.name === 'ExecutorRow').length, 1)
  const events = nodes(view, node => node.type?.name === 'Event')
  assert.equal(events.length, 2, 'Claim and receipt are separate visible lifecycle records')
  const rendered = events[0].type(events[0].props)
  assert.equal(nodes(rendered, node => node.props?.className === 'bt-taskflow-event-goal').length, 1)
  assert.equal(data.timeline.length, 2, 'Presentation must not delete persisted lifecycle evidence')
})

test('current plan retains retries while older plans are hidden', () => {
  const entries = [
    { plan_id: 'a', card_id: 'write', seq: 1, type: 'card_claimed', at: 1 },
    { plan_id: 'a', card_id: 'write', seq: 2, type: 'receipt_bound', at: 2 },
    { plan_id: 'a', card_id: 'write', seq: 3, type: 'card_failed', at: 3, payload: { reason: 'failed once' } },
    { plan_id: 'a', card_id: 'write', seq: 4, type: 'card_retried', at: 4 },
    { plan_id: 'a', card_id: 'write', seq: 5, type: 'card_claimed', at: 5 },
    { plan_id: 'a', card_id: 'write', seq: 6, type: 'receipt_bound', at: 6 },
    { plan_id: 'b', card_id: 'write', seq: 7, type: 'card_claimed', at: 7 },
    { plan_id: 'b', card_id: 'write', seq: 8, type: 'receipt_bound', at: 8 },
  ].reverse()
  const view = page.exports.DashboardView({ data: { generatedAt: 9000, room, members: {}, plan: { plan_id: 'a', cards: [] }, timeline: entries.map(item => ({ ...item, member: 'worker' })) } })
  const events = nodes(view, node => node.type?.name === 'Event').map(node => node.props.item)
  assert.equal(events.length, 6)
  assert.equal(events.filter(item => item.type === 'card_claimed').length, 2)
  assert.equal(events.filter(item => item.type === 'card_failed').length, 1)
  assert.equal(events.filter(item => item.type === 'card_retried').length, 1)
})

test('an unacknowledged claim remains visible and cannot merge across a failed attempt', () => {
  const timeline = [
    { plan_id: 'a', card_id: 'write', seq: 3, type: 'receipt_bound', at: 3 },
    { plan_id: 'a', card_id: 'write', seq: 2, type: 'card_failed', at: 2 },
    { plan_id: 'a', card_id: 'write', seq: 1, type: 'card_claimed', at: 1 },
  ]
  const view = page.exports.DashboardView({ data: { generatedAt: 4000, room, members: {}, plan: { plan_id: 'a', cards: [] }, timeline: timeline.map(item => ({ ...item, member: 'worker' })) } })
  const events = nodes(view, node => node.type?.name === 'Event')
  assert.equal(events.length, 3)
  assert.deepEqual(events.map(item => item.props.item.type), ['receipt_bound', 'card_failed', 'card_claimed'])
})

test('historical group observation does not masquerade as a current formal plan', () => {
  const card = { id: 'group-room-a-5-writer', room_name: 'Group A', member: 'writer', goal: '请核查公开来源。',
    state: 'replied', source: { kind: 'group_message', seq: 5, at: null } }
  const view = page.exports.DashboardView({ data: { generatedAt: 4000, room, members: {}, observedTasks: [card], timeline: [] } })
  assert.equal(nodes(view, node => node.props?.className === 'bt-taskflow-observation').length, 0)
  assert.doesNotMatch(JSON.stringify(view), /请核查公开来源/)
  assert.match(JSON.stringify(view), /No taskflow plans yet/)
  assert.equal(card.goal, '请核查公开来源。')
})

test('a pending older-page request retains every polling snapshot', async () => {
  const effects = [], responses = [], states = []
  let poll
  const isolated = { exports: {} }
  runInNewContext(pageBundle.outputFiles[0].text, {
    ...context(isolated),
    require: name => name === 'react' ? { ...requireFake(name),
      useEffect: effect => effects.push(effect),
      useState: initial => {
        let value = initial
        return [initial, next => { value = typeof next === 'function' ? next(value) : next; if (value?.timeline) states.push(value) }]
      },
    } : requireFake(name),
    fetch: (_route, options) => new Promise(resolve => responses.push({ resolve, body: JSON.parse(options.body) })),
    setInterval: callback => { poll = callback; return 1 }, clearInterval() {},
  })
  const board = isolated.exports.TaskflowPage({ roomId: room.id })
  const dispose = effects[0]()
  const sequence = (high, low) => Array.from({ length: high - low + 1 }, (_, i) => ({ seq: high - i }))
  const result = (timeline, timelineNext) => ({ ok: true, json: async () => ({ ok: true, value: { timeline, timelineNext, rooms: [] } }) })
  responses[0].resolve(result(sequence(200, 81), { at: 1, seq: 81 }))
  await new Promise(resolve => setImmediate(resolve))
  const pending = board.props.onLoadOlder()
  assert.equal(responses[1].body.payload.timelineBefore.seq, 81)
  poll()
  responses[2].resolve(result(sequence(250, 131), { at: 1, seq: 131 }))
  await new Promise(resolve => setImmediate(resolve))
  responses[1].resolve(result(sequence(80, 1), null))
  await pending
  const ids = states.at(-1).timeline.map(item => item.seq)
  assert.equal(ids.length, 250)
  assert.equal(new Set(ids).size, 250)
  assert.ok(ids.includes(81) && ids.includes(130))
  dispose()
})

test('overlapping polls bridge missing pages while older history is loading', async () => {
  const effects = [], responses = [], states = []
  let poll
  const isolated = { exports: {} }
  runInNewContext(pageBundle.outputFiles[0].text, {
    ...context(isolated),
    require: name => name === 'react' ? { ...requireFake(name), useEffect: effect => effects.push(effect),
      useState: initial => { let value = initial; return [initial, next => { value = typeof next === 'function' ? next(value) : next; if (value?.timeline) states.push(value) }] },
    } : requireFake(name),
    fetch: (_route, options) => new Promise(resolve => responses.push({ resolve, body: JSON.parse(options.body) })),
    setInterval: callback => { poll = callback; return 1 }, clearInterval() {},
  })
  const board = isolated.exports.TaskflowPage({ roomId: room.id })
  const dispose = effects[0]()
  const seq = (high, low) => Array.from({ length: high - low + 1 }, (_, i) => ({ seq: high - i, at: 1 }))
  const result = (timeline, timelineNext) => ({ ok: true, json: async () => ({ ok: true, value: { timeline, timelineNext, rooms: [] } }) })
  const tick = () => new Promise(resolve => setImmediate(resolve))
  responses[0].resolve(result(seq(200, 81), { at: 1, seq: 81 })); await tick()
  const pending = board.props.onLoadOlder()
  poll(); poll()
  responses[2].resolve(result(seq(350, 231), { at: 1, seq: 231 })); await tick()
  responses[3].resolve(result(seq(500, 381), { at: 1, seq: 381 })); await tick()
  const activeCount = responses.length
  poll(); poll(); poll()
  assert.equal(responses.length, activeCount, 'ticks must not cancel or multiply an active bridge')
  for (const [high, low] of [[380, 261], [260, 141]]) {
    const request = responses.find(item => item.body.payload.timelineBefore?.seq === high + 1)
    assert.ok(request, `missing bridge request for ${high}`)
    request.resolve(result(seq(high, low), { at: 1, seq: low })); await tick()
  }
  responses[1].resolve(result(seq(80, 1), null)); await pending; await tick()
  const ids = states.at(-1).timeline.map(item => item.seq)
  assert.equal(ids.length, 500)
  assert.equal(new Set(ids).size, 500)
  dispose()
})

test('polling removes cached history for plans deleted by retention', async () => {
  const effects = [], responses = [], states = []
  let poll
  const isolated = { exports: {} }
  runInNewContext(pageBundle.outputFiles[0].text, { ...context(isolated),
    require: name => name === 'react' ? { ...requireFake(name), useEffect: effect => effects.push(effect),
      useState: initial => { let value = initial; return [initial, next => { value = typeof next === 'function' ? next(value) : next; if (value?.timeline) states.push(value) }] },
    } : requireFake(name),
    fetch: () => new Promise(resolve => responses.push(resolve)), setInterval: callback => { poll = callback; return 1 }, clearInterval() {},
  })
  const board = isolated.exports.TaskflowPage({ roomId: room.id })
  const dispose = effects[0]()
  const result = (timeline, timelineNext, timelinePlanIds) => ({ ok: true, json: async () => ({ ok: true, value: { timeline, timelineNext, timelinePlanIds, rooms: [] } }) })
  const tick = () => new Promise(resolve => setImmediate(resolve))
  responses[0](result([{ seq: 2, plan_id: 'removed' }], { at: 1, seq: 2 }, ['removed', 'kept'])); await tick()
  const pending = board.props.onLoadOlder()
  responses[1](result([{ seq: 1, plan_id: 'kept' }], null, ['removed', 'kept'])); await pending
  poll()
  responses[2](result([{ seq: 1, plan_id: 'kept' }], null, ['kept'])); await tick()
  assert.deepEqual(Array.from(states.at(-1).timeline, item => item.plan_id), ['kept'])
  dispose()
})

test('slow polls coalesce ticks and still publish their response', async () => {
  const effects = [], responses = [], states = []
  let poll
  const isolated = { exports: {} }
  runInNewContext(pageBundle.outputFiles[0].text, { ...context(isolated),
    require: name => name === 'react' ? { ...requireFake(name), useEffect: effect => effects.push(effect),
      useState: initial => [initial, value => { if (value?.plan) states.push(value) }],
    } : requireFake(name), fetch: () => new Promise(resolve => responses.push(resolve)),
    setInterval: callback => { poll = callback; return 1 }, clearInterval() {},
  })
  isolated.exports.TaskflowPage({ roomId: room.id })
  const dispose = effects[0]()
  poll(); poll(); poll()
  assert.equal(responses.length, 1)
  responses[0]({ ok: true, json: async () => ({ ok: true, value: { plan: { plan_id: 'first' }, timeline: [], rooms: [] } }) })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(states.at(-1).plan.plan_id, 'first')
  assert.equal(responses.length, 2)
  dispose()
})

test('late older page cannot resurrect a plan removed by retention', async () => {
  const effects = [], responses = [], states = []
  let poll
  const isolated = { exports: {} }
  runInNewContext(pageBundle.outputFiles[0].text, { ...context(isolated),
    require: name => name === 'react' ? { ...requireFake(name), useEffect: effect => effects.push(effect),
      useState: initial => { let value = initial; return [initial, next => { value = typeof next === 'function' ? next(value) : next; if (value?.timeline) states.push(value) }] },
    } : requireFake(name), fetch: () => new Promise(resolve => responses.push(resolve)),
    setInterval: callback => { poll = callback; return 1 }, clearInterval() {},
  })
  const board = isolated.exports.TaskflowPage({ roomId: room.id }), dispose = effects[0]()
  const result = (timeline, timelineNext, timelinePlanIds) => ({ ok: true, json: async () => ({ ok: true, value: { timeline, timelineNext, timelinePlanIds, rooms: [] } }) })
  const tick = () => new Promise(resolve => setImmediate(resolve))
  responses[0](result([{ seq: 2, plan_id: 'kept' }], { at: 1, seq: 2 }, ['removed', 'kept'])); await tick()
  const pending = board.props.onLoadOlder()
  poll(); responses[2](result([{ seq: 2, plan_id: 'kept' }], { at: 1, seq: 2 }, ['kept'])); await tick()
  responses[1](result([{ seq: 1, plan_id: 'removed' }], null, ['removed', 'kept'])); await pending
  assert.deepEqual(Array.from(states.at(-1).timeline, item => item.plan_id), ['kept'])
  dispose()
})

test('a delayed older poll cannot replace a newer taskflow response', async () => {
  const effects = []
  const responses = []
  const snapshots = []
  let poll
  const isolated = { exports: {} }
  runInNewContext(pageBundle.outputFiles[0].text, {
    ...context(isolated),
    require: name => name === 'react' ? { ...requireFake(name),
      useEffect: effect => effects.push(effect),
      useState: initial => [initial, value => { if (value?.plan) snapshots.push(value) }],
    } : requireFake(name),
    fetch: () => new Promise(resolve => responses.push(resolve)),
    setInterval: callback => { poll = callback; return 1 }, clearInterval() {},
  })
  isolated.exports.TaskflowPage({ roomId: room.id })
  const dispose = effects[0]()
  poll()
  const result = planId => ({ ok: true, json: async () => ({ ok: true, value: { room, plan: { plan_id: planId } } }) })
  responses[0](result('old'))
  await new Promise(resolve => setImmediate(resolve))
  responses[1](result('new'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(snapshots.at(-1).plan.plan_id, 'new')
  dispose()
})

test('score-claude-oss-3 occupies one task-flow row and the principal stays only in the overview', () => {
  const planId = 'screenshot-plan'
  const cardId = 'score-claude-oss-3'
  const worker = { id: 'score', name: 'lq-score' }
  const lead = { id: 'lead', name: 'lq-operation' }
  const group = { id: 'lq-create', name: 'lq-create', admin: 'lead' }
  const data = { generatedAt: 100000, room: group, rooms: [group], members: { score: worker, lead },
    plan: { plan_id: planId, principal: 'lead', status: 'completed', goal: 'Check report', cards: [
      { id: cardId, member: 'score', goal: 'Score the report', state: 'verified' },
      { id: 'admin-card', member: 'lead', goal: 'Coordinate', state: 'verified' },
    ] }, timeline: [
      { seq: 6, type: 'plan_finished', principal: 'lead', room: group.id, plan_id: planId, at: 96 },
      ...['result_accepted', 'result_observed', 'receipt_bound', 'card_claimed'].map((type, i) => ({
        seq: 5 - i, type, room: group.id, plan_id: planId, card_id: cardId, member: 'score', principal: 'lead', at: 95 - i,
      })),
      { seq: 1, type: 'result_accepted', room: group.id, plan_id: planId, card_id: 'admin-card', member: 'lead', principal: 'lead', at: 91 },
    ] }
  const before = JSON.stringify(data)
  const view = page.exports.DashboardView({ data })
  assert.equal(nodes(view, node => node.type?.name === 'Overview').length, 1)
  assert.deepEqual(nodes(view, node => node.type?.name === 'ExecutorRow').map(node => node.props.memberId), ['score'])
  const events = nodes(view, node => node.type?.name === 'Event')
  assert.equal(events.length, 4, 'each lifecycle event has a visible timeline row')
  assert.equal(events[0].props.item.member, 'score')
  assert.equal(events[0].props.item.type, 'result_accepted')
  assert.deepEqual(events.map(event => event.props.item.type), ['result_accepted', 'result_observed', 'receipt_bound', 'card_claimed'])
  assert.doesNotMatch(JSON.stringify(events[0].type(events[0].props)), /lq-operation/)
  assert.equal(JSON.stringify(data), before, 'display grouping must preserve original evidence')
  assert.equal(view.props.style['--last-lane'], 0, 'the principal must not allocate an executor rail')
})

test('task-flow grouping preserves retry evidence and separates identical card IDs across rooms and plans', () => {
  const entries = [
    { room: 'a', plan_id: 'p', card_id: 'same', member: 'worker', seq: 1, at: 1, type: 'card_claimed' },
    { room: 'a', plan_id: 'p', card_id: 'same', member: 'worker', seq: 2, at: 2, type: 'card_failed', payload: { reason: 'first attempt failed' } },
    { room: 'a', plan_id: 'p', card_id: 'same', member: 'worker', seq: 3, at: 3, type: 'card_retried' },
    { room: 'a', plan_id: 'p', card_id: 'same', member: 'worker', seq: 4, at: 4, type: 'card_claimed' },
    { room: 'a', plan_id: 'p', card_id: 'same', member: 'worker', seq: 5, at: 5, type: 'receipt_bound' },
    { room: 'b', plan_id: 'p', card_id: 'same', member: 'worker', seq: 6, at: 6, type: 'result_accepted' },
    { room: 'a', plan_id: 'other', card_id: 'same', member: 'worker', seq: 7, at: 7, type: 'result_accepted' },
  ].reverse()
  const rooms = [{ id: 'a', admin: 'lead', planId: 'p' }, { id: 'b', admin: 'other-lead', planId: 'p' }]
  const fullPlans = rooms.map(item => ({ room: item.id, plan_id: 'p', cards: [] }))
  const view = page.exports.DashboardView({ data: { generatedAt: 9000, rooms, fullPlans, timeline: entries } })
  const events = nodes(view, node => node.type?.name === 'Event')
  assert.equal(events.length, 6)
  const retried = events.find(node => node.props.item.type === 'card_failed')
  assert.match(JSON.stringify(retried.type(retried.props)), /first attempt failed/)
})

test('current administrators are excluded per room without hiding their executor work in another room', () => {
  const rooms = [{ id: 'a', admin: 'chief', planId: 'p' }, { id: 'b', admin: 'other', planId: 'q' }]
  const timeline = [
    { room: 'a', plan_id: 'p', card_id: 'old-lead', principal: 'previous', member: 'previous', seq: 1, at: 1, type: 'result_accepted' },
    { room: 'a', plan_id: 'p', card_id: 'admin', principal: 'previous', member: 'chief', seq: 2, at: 2, type: 'result_accepted' },
    { room: 'b', plan_id: 'q', card_id: 'executor', principal: 'other', member: 'chief', seq: 3, at: 3, type: 'result_accepted' },
  ]
  const fullPlans = rooms.map(item => ({ room: item.id, plan_id: item.planId, cards: [] }))
  const view = page.exports.DashboardView({ data: { generatedAt: 4000, rooms, fullPlans, timeline } })
  const events = nodes(view, node => node.type?.name === 'Event')
  assert.equal(events.length, 1)
  assert.equal(events[0].props.item.room, 'b')
  assert.equal(events[0].props.item.member, 'chief')
})
