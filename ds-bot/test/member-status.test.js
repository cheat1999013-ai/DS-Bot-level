import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { install as installApprovals } from '../src/host/approvals.js'

const bundle = await build({
  entryPoints: [process.env.MEMBER_STATUS_SOURCE ?? fileURLToPath(new URL('../src/client/member-status.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports,
  require: (name) => {
    const platform = {
      react: { createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx }, useContext: ctx => ctx.value, useMemo: make => make(), useCallback: fn => fn, useId: () => 'dv-id', useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }), useState: initial => [initial, () => {}], useEffect: () => {}, useRef: initial => ({ current: initial }), useLayoutEffect: () => {}, Fragment: 'fragment' },
      'react-dom': {},
      '@deepseek-ai/dsh-client-ui-primitives': {},
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { busyMembers, summaryText, MemberDock, MemberState, StopMemberWork, StopRoomWork, memberWork, GroupApprovalDock } = module.exports
// Values from the bundle's realm compare by content only.
const plain = value => JSON.parse(JSON.stringify(value))
// The dock's capsule in an element tree.
const capsuleOf = (node) => {
  if (node === null || typeof node !== 'object') return null
  if (node.props.className === 'bt-mw-pill') return node
  for (const child of node.children) {
    const found = capsuleOf(child)
    if (found) return found
  }
  return null
}

test('the members line names who waits for an approval first, then who is at work', () => {
  const names = { a: 'Anvil', b: 'Flint', c: 'Prism', d: 'Quill', e: 'King', f: 'Comet' }
  const roster = { byId: Object.fromEntries(Object.entries(names).map(([id, name]) => [id, { id, name }])) }
  const room = { id: 'r1', members: ['e', 'd', 'a', 'b', 'c', 'f'] }
  const work = {
    bots: { d: { since: 1, tool: 'edit' }, a: { since: 1, tool: 'pwsh' }, f: { since: 1 } },
    rooms: { r1: [{ botId: 'd', since: 1, tool: 'edit' }, { botId: 'f', since: 1 }] },
    approvals: [{ botId: 'a', roomId: 'r1' }, { botId: 'b', roomId: 'r1' }, { botId: 'c', roomId: 'r1' }],
  }
  const busy = busyMembers(room, work, roster)
  assert.deepEqual(plain(busy.map(entry => [entry.bot.name, entry.state])), [['Anvil', 'ask'], ['Flint', 'ask'], ['Prism', 'ask'], ['Quill', 'work'], ['Comet', 'work']])
  assert.deepEqual(plain(summaryText(busy)), { waiting: 'Anvil, Flint and 1 more are waiting for your approval', doing: 'Quill · Writing changes… +1' })
  assert.deepEqual(plain(summaryText(busy.slice(1, 3))), { waiting: 'Flint and Prism are waiting for your approval', doing: '' })
  assert.deepEqual(plain(summaryText(busy.slice(4))), { waiting: '', doing: 'Comet · Thinking about it…' })
  assert.equal(busyMembers(room, { bots: {}, approvals: [] }, roster).length, 0)
})

const names = { a: 'Anvil', b: 'Flint', c: 'Prism', d: 'Quill' }
const team = {
  byId: Object.fromEntries(Object.entries(names).map(([id, name]) => [id, { id, name }])),
  roomsById: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b', 'c', 'd'] }, r2: { id: 'r2', name: 'Docs', members: ['a', 'b'] } },
}

test('another group or private approval never marks the current group as waiting', () => {
  const work = { bots: {}, rooms: {}, approvals: [
    { id: 'other', botId: 'a', roomId: 'r2', answerable: true },
    { id: 'private', botId: 'b', answerable: true },
  ] }
  assert.deepEqual(plain(busyMembers(team.roomsById.r1, work, team)), [])
  assert.equal(MemberDock({ sessionId: 'r1', useRoster: pick => pick(team), useWork: pick => pick(work), actions: {} }), null)
})

const approvalNodes = (tree, found = []) => {
  if (!tree || typeof tree !== 'object') return found
  if (typeof tree.type === 'function') return approvalNodes(tree.type({ ...tree.props, children: tree.children }), found)
  found.push(tree)
  for (const child of tree.children ?? []) approvalNodes(child, found)
  return found
}
const groupApproval = (actions, work, sessionId = 'r1') => GroupApprovalDock({ sessionId,
  useRoster: pick => pick(team), useWork: pick => pick(work), actions })

for (const choice of ['reject', 'allow']) test(`chat approval ${choice} settles the real pending request once`, async () => {
  let request
  const rt = { ctx: { on: (_event, listener) => { request = listener } },
    groupOwners: new Map([['group-session', { roomId: 'r1', botId: 'a' }]]), chatOwners: new Map() }
  installApprovals(rt)
  const signal = new AbortController()
  let executions = 0
  const outcome = request({ agent: { session: { id: 'group-session' } }, toolName: 'write_file', reason: 'Review this example', signal: signal.signal }, () => assert.fail('group approvals must not be left in a hidden session'))
    .then(decision => { if (decision === 'allowed-once') executions++; return decision })
  const pending = rt.approvalsView()
  const errors = []
  const tree = groupApproval({ answerApproval: (id, answer) => rt.answerApproval(id, answer), reportError: error => errors.push(error.code) }, { approvals: pending })
  const buttons = approvalNodes(tree).filter(node => node.type === 'button')
  assert.equal(buttons.length, 2)
  buttons[choice === 'reject' ? 0 : 1].props.onClick()
  assert.equal(await outcome, choice === 'allow' ? 'allowed-once' : 'rejected')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(executions, choice === 'allow' ? 1 : 0)
  assert.deepEqual(rt.approvalsView(), [])
  buttons[1].props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(errors, ['bot/stale'])
  assert.equal(executions, choice === 'allow' ? 1 : 0, 'an old card must never approve a second execution')
})

test('pending group approval appears directly in chat and its buttons answer only that request', async () => {
  assert.equal(typeof GroupApprovalDock, 'function')
  const answers = []
  const approvals = [
    { id: 'here', botId: 'a', roomId: 'r1', tool: 'write_file', answerable: true, detail: { code: 'example.txt', parameters: JSON.stringify({ paths: ['first.md', 'second.md'] }) } },
    { id: 'elsewhere', botId: 'a', roomId: 'r2', tool: 'unrelated', answerable: true },
    { id: 'private', botId: 'a', tool: 'private', answerable: true },
  ]
  for (const choice of ['reject', 'allow']) {
    const tree = groupApproval({ answerApproval: (...args) => answers.push(args) }, { approvals })
    const nodes = approvalNodes(tree)
    assert.equal(nodes.filter(node => node.props.className === 'bt-mw-card').length, 1)
    assert.equal(nodes.filter(node => node.props['data-approval-id'] === 'here').length, 1)
    assert.ok(nodes.some(node => node.children?.includes('Command approval required')))
    assert.equal(nodes.filter(node => node.type === 'details' && node.props.className === 'bt-mw-parameters').length, 1)
    assert.ok(nodes.some(node => node.type === 'pre' && node.children[0].includes('second.md')))
    const buttons = nodes.filter(node => node.type === 'button')
    assert.equal(buttons.length, 2, 'neither settings nor private-chat navigation is required')
    buttons[choice === 'reject' ? 0 : 1].props.onClick()
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.deepEqual(answers, [['here', 'reject'], ['here', 'allow']])
  assert.equal(groupApproval({}, { approvals }, 'a'), null)
  assert.equal(groupApproval({}, { approvals: [] }), null)
})

test('rapid approval clicks submit only once and failures keep the request actionable', async () => {
  assert.equal(typeof GroupApprovalDock, 'function')
  const errors = [], calls = []
  let reject
  const request = new Promise((_resolve, fail) => { reject = fail })
  const tree = groupApproval({ answerApproval: (...args) => { calls.push(args); return request },
    reportError: error => errors.push(error.message) }, { approvals: [{ id: 'pending', roomId: 'r1', botId: 'b', tool: 'run', answerable: true }] })
  const buttons = approvalNodes(tree).filter(node => node.type === 'button')
  buttons[1].props.onClick(); buttons[0].props.onClick()
  await Promise.resolve()
  assert.equal(calls.length, 1)
  reject(new Error('approval connection lost'))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(errors, ['approval connection lost'])
  buttons[0].props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [['pending', 'allow'], ['pending', 'reject']])
})

// #156: a member waiting for an approval keeps its work here, so Stop stays.
test('a member waiting for approval in this group can still be stopped', async () => {
  const stopped = []
  const room = team.roomsById.r1
  const entry = busyMembers(room, { rooms: { r1: [{ botId: 'a', since: 1 }] }, approvals: [{ botId: 'a', roomId: 'r1', at: 1 }] }, team)[0]
  assert.equal(entry.state, 'ask')
  const node = StopMemberWork({ entry, bot: team.byId.a, room, actions: { stopMemberWork: (...args) => stopped.push(args) } })
  assert.ok(node, 'waiting for approval must not hide Stop')
  node.props.onClick()
  await Promise.resolve()
  assert.deepEqual(stopped, [['r1', 'a']])
})

test('an approval for work elsewhere never offers to stop work in this group', () => {
  const room = team.roomsById.r1
  const entry = busyMembers(room, { rooms: { r2: [{ botId: 'a', since: 1 }] }, approvals: [{ botId: 'a', roomId: 'r2', at: 1 }] }, team)[0]
  assert.equal(StopMemberWork({ entry, bot: team.byId.a, room, actions: {} }), null)
  // Work here stays stoppable while it runs.
  const working = busyMembers(room, { rooms: { r1: [{ botId: 'a', since: 1 }] }, approvals: [] }, team)[0]
  assert.ok(StopMemberWork({ entry: working, bot: team.byId.a, room, actions: {} }))
})

test('a failed stop is reported and never answers the approval', async () => {
  const reported = []
  const room = team.roomsById.r1
  const entry = busyMembers(room, { rooms: { r1: [{ botId: 'a', since: 1 }] }, approvals: [{ botId: 'a', roomId: 'r1', at: 1 }] }, team)[0]
  const node = StopMemberWork({ entry, bot: team.byId.a, room, actions: {
    stopMemberWork: () => Promise.reject(new Error('connection lost')),
    reportError: (error, action) => reported.push([error.message, action]),
  } })
  assert.ok(node)
  node.props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(reported, [['connection lost', 'stop']])
})
// #592: DSH's own stop reaches only the round; a member the round moved on from kept working.
test('the stop button of a group\'s details stops all work there, and shows only while work is here', async () => {
  const stopped = []
  const room = team.roomsById.r1
  const actions = { stopRoomWork: id => stopped.push(id) }
  const shown = work => StopRoomWork({ room, entries: memberWork(room, work), actions })
  const button = shown({ bots: {}, rooms: { r1: [{ botId: 'a', since: 1, tool: 'pwsh' }] }, approvals: [] })
  assert.equal(button.props['aria-label'], 'Stop all work in this group')
  button.props.onClick()
  await Promise.resolve()
  assert.deepEqual(stopped, ['r1'])
  // Members busy only in their own chats or in another group have nothing here to stop.
  assert.equal(shown({ bots: { a: { since: 1, tool: 'pwsh' }, b: { since: 1, roomId: 'r2' } }, rooms: { r2: [{ botId: 'b', since: 1 }] }, approvals: [] }), null)
  assert.equal(shown({ bots: {}, rooms: { r2: [{ botId: 'a', since: 1 }] }, approvals: [{ botId: 'a', roomId: 'r2', at: 1 }] }), null)
  // A turn waiting for an approval here still holds its work.
  assert.ok(shown({ bots: {}, rooms: { r1: [{ botId: 'a', since: 1 }] }, approvals: [{ botId: 'a', roomId: 'r1', at: 1 }] }))
})

test('a failed stop of a group\'s work is reported', async () => {
  const reported = []
  const room = team.roomsById.r1
  const button = StopRoomWork({ room, entries: memberWork(room, { bots: {}, rooms: { r1: [{ botId: 'a', since: 1 }] }, approvals: [] }), actions: {
    stopRoomWork: () => Promise.reject(new Error('connection lost')),
    reportError: (error, action) => reported.push([error.message, action]),
  } })
  button.props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(reported, [['connection lost', 'stop']])
})
// The capsule's label and what a click on it asks for.
const dock = (sessionId, work) => {
  const calls = []
  const actions = { showDetails: id => calls.push(['details', id]), openSession: id => calls.push(['session', id]) }
  const capsule = capsuleOf(MemberDock({ sessionId, useRoster: pick => pick(team), useWork: pick => pick(work), actions }))
  if (!capsule) return null
  capsule.props.onClick()
  return { label: capsule.props['aria-label'], calls }
}

test('one capsule names who waits and keeps approval requests in the group chat', () => {
  const work = {
    // Anvil runs in its own chat too; its work here wins. Coral's work in r2 shows
    // there and on its own chat, not here (#473).
    bots: { a: { since: 1, tool: 'pwsh' }, b: { since: 1, roomId: 'r2', tool: 'edit' } },
    rooms: { r1: [{ botId: 'a', since: 1, tool: 'write' }, { botId: 'd', since: 1, speaking: true }], r2: [{ botId: 'b', since: 1, tool: 'edit' }] },
    approvals: [{ botId: 'c', roomId: 'r1' }],
  }
  assert.deepEqual(plain(dock('r1', work)), { label: 'Prism is waiting for your approval · Anvil · Writing changes… +1', calls: [['session', 'r1']] })
})

test('group work shows a progress bar above its capsule until the last local Bot stops', () => {
  const render = (entries, approvals = []) => MemberDock({
    sessionId: 'r1', useRoster: pick => pick(team),
    useWork: pick => pick({ rooms: { r1: entries, r2: [{ botId: 'b' }] }, approvals }), actions: {},
  })
  const first = { botId: 'a', since: 1, speaking: true, tool: 'write' }
  const second = { botId: 'd', since: 2, speaking: true, tool: 'read' }
  for (const [entries, name] of [[[first, second], 'Anvil'], [[second], 'Quill']]) {
    const dock = render(entries)
    assert.equal(dock.children[0].props.role, 'progressbar')
    assert.equal(dock.children[0].props['aria-valuenow'], undefined)
    assert.match(capsuleOf(dock.children[1]).props['aria-label'], new RegExp(name))
  }
  assert.equal(render([]), null)
  const approvalOnly = render([], [{ botId: 'a', roomId: 'r1' }])
  assert.ok(capsuleOf(approvalOnly))
  assert.ok(approvalOnly.children.every(child => child?.props.role !== 'progressbar'))
})

test('a Bot\'s own chat shows the groups it is at work in, unless its own chat runs', () => {
  const away = { bots: { a: { since: 1, roomId: 'r1', tool: 'pwsh' } }, rooms: { r1: [{ botId: 'a', since: 1, tool: 'pwsh' }], r2: [{ botId: 'a', since: 1 }] }, approvals: [] }
  assert.deepEqual(plain(dock('a', away)), { label: 'in Ops · Running shell commands… +1', calls: [['session', 'r1']] })
  assert.equal(dock('a', { ...away, bots: { a: { since: 1 } } }), null)
  assert.equal(dock('b', away), null)
})

test('the capsule says what a member does in its call\'s own words, and that it moves to a fresh conversation', () => {
  const label = doing => dock('r1', { bots: {}, rooms: { r1: [{ botId: 'a', since: 1, ...doing }] }, approvals: [] }).label
  assert.equal(label({ tool: 'pwsh', note: 'Download Ghidra 12.1.4 and check its hash.' }), 'Anvil · Download Ghidra 12.1.4 and check its hash…')
  assert.equal(label({ tool: 'read', target: 'dump.py' }), 'Anvil · Opening a file · dump.py…')
  assert.equal(label({ switching: true }), 'Anvil · Moving to a fresh conversation…')
  assert.equal(label({ switching: true, folder: true }), 'Anvil · Switching working folder…')
  assert.equal(label({ tool: 'pwsh', said: '解压 Ghidra，顺便写脚本。', note: 'Expand-Archive' }), 'Anvil · 解压 Ghidra，顺便写脚本…')
})

test('a member\'s line runs a clock from its turn\'s start or its approval\'s', () => {
  // The clock renders as `{since}` here; it ticks on its own.
  const flat = node => (node === null || node === '' ? '' : typeof node === 'string' ? node
    : node.props.at !== undefined ? `{${node.props.at}}` : node.children.map(flat).join(''))
  const stateText = entry => flat(MemberState({ entry, bot: { id: 'a', name: 'Anvil' }, room: { id: 'r1' }, roster: team }))
  assert.equal(stateText({ state: 'work', doing: { roomId: 'r1', tool: 'pwsh', since: 1_000 } }), 'Running shell commands…{1000}')
  assert.equal(stateText({ state: 'ask', approvals: [{ at: 2_000 }] }), 'Waiting for your approval{2000}')
  assert.equal(flat(MemberState({ entry: { state: 'idle' }, bot: { id: 'a', name: 'Anvil', role: 'Writer' }, room: { id: 'r1' }, roster: team })), 'Writer')
})
