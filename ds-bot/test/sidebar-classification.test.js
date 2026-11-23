import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const bundle = await build({
  stdin: { contents: "export { TeamSidebar } from './src/client/sidebar.js'; export { sidebarSection, botFunction } from './src/client/sidebar-sections.js'", resolveDir: root },
  bundle: true, format: 'cjs', platform: 'browser', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const nodes = (tree, predicate, out = []) => {
  if (Array.isArray(tree)) tree.forEach(child => nodes(child, predicate, out))
  else if (tree && typeof tree === 'object') {
    if (predicate(tree)) out.push(tree)
    nodes(tree.props?.children, predicate, out)
  }
  return out
}
const text = tree => Array.isArray(tree) ? tree.map(text).join('')
  : tree && typeof tree === 'object' ? text(tree.props?.children) : tree == null ? '' : String(tree)

const main = { id: 'main', name: 'Chief', sessionId: 'main-session', createdAt: 1 }
const writer = { id: 'writer', name: 'Writer', sessionId: 'writer-session', role: 'Writes verified drafts',
  capabilities: ['skill-one', 'mcp-files'], createdAt: 10 }
const reviewer = { id: 'reviewer', name: 'Reviewer', sessionId: 'reviewer-session', capabilities: [], createdAt: 5, pinned: true }
const room = { id: 'room', name: 'Project', members: ['main', 'writer'], createdAt: 100 }
const agent = { id: 'agent', name: 'Agent', sessions: [], createdAt: 200 }
const roster = { bots: [main, writer, reviewer], rooms: [room], agents: [agent], mainBotId: 'main', mainBotIds: ['main'],
  byId: { main, writer, reviewer }, roomsById: { room }, exchangeTurns: {}, questions: {}, ready: true }

function boot(saved = { value: null }, { storageError = false, rail = false, data = roster, activeIds = [] } = {}) {
  const module = { exports: {} }
  const listeners = new Map()
  const reads = []; const writes = []; const calls = []
  const storage = {
    getItem(key) { reads.push(key); if (storageError) throw new Error('storage unavailable'); return saved.value },
    setItem(key, value) { if (storageError) throw new Error('storage unavailable'); writes.push(key); saved.value = value },
  }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: 'fragment',
    createContext: value => ({ value }), useContext: context => context.value,
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: current => ({ current }), useMemo: make => make(), useCallback: fn => fn,
    useEffect() {}, useLayoutEffect() {}, useId: () => 'example',
    useSyncExternalStore(subscribe, getSnapshot) { subscribe(() => {}); return getSnapshot() },
  }
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, require: name => name === 'react' ? react : {},
    localStorage: storage,
    window: { innerWidth: 1280, localStorage: storage,
      addEventListener(name, listener) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener) },
      removeEventListener(name, listener) { listeners.get(name)?.delete(listener) } },
    setTimeout: () => 0, clearTimeout() {},
  })
  const props = {
    wide: true, actions: { openSession: id => calls.push(['open', id]), landOn() {} },
    useRoster: pick => pick(data), useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}),
    useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}),
    useSessionStatus: pick => pick(new Map()), useSessionRetainInfo: (id, pick) => pick({ retainedBy: { mainView: activeIds.includes(id) ? 1 : 0 } }),
    useActivity: pick => pick({}), useWork: pick => pick({ rooms: {}, approvals: [] }),
    useSidebarPref: () => rail ? 'rail' : 'open',
  }
  return { render: () => module.exports.TeamSidebar(props), helpers: module.exports, reads, writes, calls, saved,
    storageEvent(value) { saved.value = value; for (const listener of listeners.get('storage') ?? []) listener({ key: reads[0], newValue: value, storageArea: storage }) } }
}
const rowNodes = tree => nodes(tree, node => ['BotRow', 'RoomRow', 'AgentRow'].includes(node.type?.name))
const toggle = (tree, section) => nodes(tree, node => node.props?.['data-dsb-toggle-section'] === section)[0]

test('native sidebar restores Bot, Bot groups and Unclassified sections without changing the Main Bot', () => {
  const page = boot(); const tree = page.render()
  assert.deepEqual(nodes(tree, node => node.props?.['data-dsb-sidebar-section']).map(node => node.props['data-dsb-sidebar-section']), ['bot', 'room', 'other'])
  assert.deepEqual(rowNodes(tree).map(node => node.props.bot?.id ?? node.props.room?.id ?? node.props.agent?.id), ['main', 'reviewer', 'writer', 'room', 'agent'])
  assert.equal(rowNodes(tree).filter(node => node.props.bot?.id === 'main').length, 1)
})

test('the real Bot row displays its recorded role and capabilities and still opens the same chat', () => {
  const page = boot(); const row = rowNodes(page.render()).find(node => node.props.bot?.id === 'writer')
  const rendered = row.type(row.props)
  const description = nodes(rendered, node => node.props?.['data-dsb-bot-function'] === 'writer')[0]
  assert.ok(description)
  assert.equal(text(description), 'Writes verified drafts · skill-one, mcp-files')
  nodes(rendered, node => node.props?.['data-bot-id'] === 'writer')[0].props.onClick()
  assert.deepEqual(page.calls, [['open', 'writer']])
})

test('the avatar rail keeps the Main Bot visible without an ineffective hide control', () => {
  const page = boot({ value: null }, { rail: true })
  const rows = rowNodes(page.render())
  const mainRow = rows.find(node => node.props.bot?.id === 'main')
  const writerRow = rows.find(node => node.props.bot?.id === 'writer')
  assert.ok(mainRow)
  assert.equal(nodes(mainRow.type(mainRow.props), node => node.props?.['data-dsb-hide-entry']).length, 0)
  assert.equal(nodes(writerRow.type(writerRow.props), node => node.props?.['data-dsb-hide-entry'] === 'writer').length, 1)
})

test('fold and restore use native callbacks, persist across reload and do not mutate the roster', () => {
  const saved = { value: null }; const page = boot(saved); const before = JSON.stringify(roster)
  assert.ok(toggle(page.render(), 'room'))
  toggle(page.render(), 'room').props.onClick()
  assert.equal(rowNodes(page.render()).some(node => node.props.room), false)
  const reopened = boot(saved)
  assert.equal(toggle(reopened.render(), 'room').props['aria-expanded'], false)
  toggle(reopened.render(), 'room').props.onClick()
  const row = rowNodes(reopened.render()).find(node => node.props.bot?.id === 'writer')
  const rendered = row.type(row.props)
  nodes(rendered, node => node.props?.['data-dsb-hide-entry'] === 'writer')[0].props.onClick()
  assert.equal(rowNodes(reopened.render()).some(node => node.props.bot?.id === 'writer'), false)
  nodes(reopened.render(), node => node.props?.['data-dsb-restore-section'] === 'bot')[0].props.onClick()
  assert.equal(rowNodes(reopened.render()).some(node => node.props.bot?.id === 'writer'), true)
  assert.equal(JSON.stringify(roster), before)
  assert.equal(new Set([...page.reads, ...page.writes, ...reopened.reads, ...reopened.writes]).size, 1)
})

test('legacy collapsed/hidden state loads and storage events refresh another window', () => {
  const saved = { value: JSON.stringify({ collapsed: { room: true }, hidden: ['writer'] }) }
  const page = boot(saved)
  assert.ok(toggle(page.render(), 'room'))
  assert.equal(toggle(page.render(), 'room').props['aria-expanded'], false)
  assert.equal(rowNodes(page.render()).some(node => node.props.bot?.id === 'writer'), false)
  page.storageEvent(JSON.stringify({ collapsed: {}, hidden: [] }))
  assert.equal(toggle(page.render(), 'room').props['aria-expanded'], true)
  assert.equal(rowNodes(page.render()).some(node => node.props.bot?.id === 'writer'), true)
})

test('damaged or unavailable browser storage keeps the native sidebar usable', () => {
  for (const options of [{ value: '{broken' }, { value: null }]) {
    const page = boot(options, { storageError: options.value === null })
    assert.ok(toggle(page.render(), 'room'))
    toggle(page.render(), 'room').props.onClick()
    assert.equal(rowNodes(page.render()).some(node => node.props.room), false)
    nodes(page.render(), node => node.props?.['data-dsb-restore-all'])[0].props.onClick()
    assert.equal(rowNodes(page.render()).some(node => node.props.room), true)
  }
})

test('capability summaries retain six recorded names plus the exact remainder and classify unknown kinds', () => {
  const { botFunction, sidebarSection } = boot().helpers
  assert.equal(botFunction({ role: 'Design', capabilities: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }, 'Bot'), 'Design · a, b, c, d, e, f +2')
  assert.equal(botFunction({}, 'Bot'), 'Bot')
  assert.equal(sidebarSection('future-kind'), 'other')
  assert.equal(sidebarSection(undefined), 'other')
})

test('native hidden Bot and group rows still honor mainView retention without leaving orphan controls', () => {
  const hiddenWriter = { ...writer, hidden: true }
  const hiddenRoom = { ...room, hidden: true }
  const data = { ...roster, bots: [main, hiddenWriter, reviewer], rooms: [hiddenRoom],
    byId: { ...roster.byId, writer: hiddenWriter }, roomsById: { room: hiddenRoom } }
  for (const retained of [false, true]) {
    const page = boot({ value: null }, { data, activeIds: retained ? ['writer-session', 'room'] : [] })
    const rows = rowNodes(page.render())
    for (const row of rows.filter(node => node.props.bot?.id === 'writer' || node.props.room?.id === 'room')) {
      const rendered = row.type(row.props)
      if (retained) assert.ok(nodes(rendered, node => node.props?.['aria-current'] === 'page').length)
      else assert.equal(rendered, null)
    }
  }
})

test('temporary local folding is reversible on a read-only team and does not close the displayed chat', () => {
  const data = { ...roster, readOnly: 'Team is open elsewhere' }
  const before = JSON.stringify(data)
  const page = boot({ value: null }, { data, activeIds: ['writer-session'] })
  const row = rowNodes(page.render()).find(node => node.props.bot?.id === 'writer')
  const rendered = row.type(row.props)
  assert.ok(nodes(rendered, node => node.props?.['aria-current'] === 'page').length)
  nodes(rendered, node => node.props?.['data-dsb-hide-entry'] === 'writer')[0].props.onClick()
  assert.equal(rowNodes(page.render()).some(node => node.props.bot?.id === 'writer'), false)
  assert.deepEqual(page.calls, [])
  assert.equal(JSON.stringify(data), before)
  nodes(page.render(), node => node.props?.['data-dsb-restore-all'])[0].props.onClick()
  assert.equal(rowNodes(page.render()).some(node => node.props.bot?.id === 'writer'), true)
})

test('legacy preferences cannot hide the primary Main Bot from either sidebar layout', () => {
  for (const rail of [false, true]) {
    const page = boot({ value: JSON.stringify({ collapsed: { bot: true }, hidden: ['main'] }) }, { rail })
    const row = rowNodes(page.render()).find(node => node.props.bot?.id === 'main')
    assert.ok(row)
    assert.equal(nodes(row.type(row.props), node => node.props?.['data-bot-id'] === 'main').length, 1)
  }
})
