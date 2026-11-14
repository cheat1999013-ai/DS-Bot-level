import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
const requireApp = createRequire(new URL('../../app/package.json', import.meta.url))
const { SlotCore } = await import(pathToFileURL(requireApp.resolve('@deepseek-ai/dsh-client-ui-slots')).href)
const base = process.env.GROUP_RELAY_SOURCE ?? fileURLToPath(new URL('../src/', import.meta.url))
const bundle = await build({ stdin: { contents: `export * as cells from '${base.replaceAll('\\', '/')}/client/cells.js'; export * as surface from '${base.replaceAll('\\', '/')}/client/surface.js'`, resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, format: 'cjs', platform: 'browser', write: false, external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'] })
function fixture() {
  const values = [], dependencies = [], effects = [], timers = new Set()
  let cursor = 0
  const h = (type, props, ...children) => ({ type, props: { ...props, children } })
  const react = { createElement: h, Fragment: 'fragment', createContext: value => ({ value }), useContext: context => context.value,
    useState(initial) { const at = cursor++; if (!(at in values)) values[at] = typeof initial === 'function' ? initial() : initial; return [values[at], value => { values[at] = typeof value === 'function' ? value(values[at]) : value }] },
    useEffect(fn, deps) { const at = cursor++; if (!dependencies[at] || !deps || deps.some((value, i) => value !== dependencies[at][i])) { dependencies[at] = deps; effects.push(fn) } },
    useMemo: fn => fn(), useCallback: fn => fn, useRef: current => ({ current }), useId: () => 'fixture-id', useSyncExternalStore: (_subscribe, get) => get() }
  react.useLayoutEffect = react.useEffect
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, document: { hidden: false }, TextEncoder,
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: fn => { const timer = { fn }; timers.add(timer); return timer }, clearTimeout: timer => timers.delete(timer),
    require: name => name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : { MarkdownText: ({ text }) => text } })
  const core = new SlotCore()
  const native = () => null
  const children = { 'tool.call.toolview': { kind: 'keyed', scope: 'session' } }
  const offRoot = core.register({ name: 'root', children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } } }, () => null)
  const offNative = core.register({ name: 'conversation.chat.node', key: 'tool-call', children }, native)
  const subscriptions = new Set()
  let current = { mode: 'bot', plain: false }
  const surface = { getSnapshot: () => current, subscribe: fn => { subscriptions.add(fn); return () => subscriptions.delete(fn) } }
  const principal = { id: 'chief', name: 'Principal', color: 'blue' }
  const room = { id: 'room', name: 'Room', admin: 'chief', members: ['chief'] }
  const roster = { byId: { chief: principal }, bots: [principal], roomsById: { room }, rooms: [room], exchangeTurns: { room: [1] }, revision: 1 }
  const actions = { roomProgress: async () => [] }
  const face = () => ({ actions, hooks: { roster: { getSnapshot: () => roster } } })
  const slots = { inject: (_name, register) => register(), register: (...args) => core.register(...args), entries: name => core.entriesOfSlot(name) }
  const off = module.exports.surface.installGroupToolView?.(slots, { surface, face, component: module.exports.cells.GroupRelayToolView })
  const original = core.entriesOfSlot('conversation.chat.node')[0]
  const expand = node => Array.isArray(node) ? node.map(expand) : !node || typeof node !== 'object' ? node : typeof node.type === 'function'
    ? expand(node.type(node.props)) : { ...node, props: { ...node.props, children: expand(node.props.children) } }
  const text = node => Array.isArray(node) ? node.map(text).join('') : !node || typeof node === 'boolean' ? '' : typeof node === 'object' ? text(node.props?.children) : String(node)
  function render(content = { from: 386, anchor: 'fixture-anchor' }, callId = 'relay-1') {
    cursor = 0
    const entry = core.entriesOfSlot('tool.call.toolview').find(entry => entry.options.key === 'group_relay')
    if (!entry) return { text: 'Generic group_relay tool card', entry }
    const injected = entry.inject('room')
    const node = expand(h(entry.component, { sessionId: 'room', callId, phase: 'result', block: { content: [{ type: 'text', text: JSON.stringify(content) }] }, actions: injected.actions,
      useRoster: pick => pick(injected.hooks.roster.getSnapshot()), useUi: pick => pick({ reactions: {} }) }))
    return { node, text: text(node), entry }
  }
  const cleanups = []
  const flush = async () => { while (effects.length) { const clean = effects.shift()(); if (typeof clean === 'function') cleanups.push(clean) } await new Promise(resolve => setImmediate(resolve)) }
  const next = async () => { const timer = [...timers][0]; assert.ok(timer, 'An open group range must keep a refresh scheduled'); timers.delete(timer); await timer.fn(); await new Promise(resolve => setImmediate(resolve)) }
  const parentProps = (content, callId) => ({
    sessionId: 'room', node: { key: callId, location: { turn: { turn: 343 } }, data: { root: {
      kind: 'tool-result', callId, name: 'group_relay', content: [{ type: 'text', text: JSON.stringify(content) }],
    } } }, actions, useRoster: pick => pick(roster), useUi: pick => pick({ reactions: {} }),
  })
  let offShadow
  const renderParent = (content = { from: 683, anchor: 'fixture-anchor' }, callId = 'relay-343') => {
    cursor = 0
    const parent = core.entriesOfSlot('conversation.chat.node').find(entry => entry.options.key === 'tool-call')
    if (parent.component === native) return render(content, callId)
    const node = expand(h(parent.component, parentProps(content, callId)))
    return { node, text: text(node), parent }
  }
  return { core, original, native, children, actions, roster, render, renderParent, flush, next, timers,
    shadowParent() { offShadow = core.register({ name: 'conversation.chat.node', key: 'tool-call', priority: -100, inject: face }, module.exports.cells.ToolCell) },
    renderIndependent({ sessionId = 'room', turn = 343, isError = false } = {}) {
      cursor = 0
      const node = expand(h(module.exports.cells.GroupReplyCell, { actions, sessionId,
        useRoster: pick => pick(roster), useUi: pick => pick({ reactions: {} }),
        node: { location: { turn: { turn } }, data: { callId: 'standalone-fixture', phase: 'result',
          block: { isError, content: [{ type: 'text', text: isError ? 'Reported relay failure.' : JSON.stringify({ from: 900, anchor: 'standalone-anchor' }) }] } } },
      }))
      return { node, text: text(node) }
    },
    mode(value) { current = value; for (const fn of subscriptions) fn() },
    dispose() { for (const fn of cleanups.reverse()) fn(); offShadow?.(); off?.(); offNative(); offRoot() } }
}
test('native group_relay tool view shows the ordinary principal reply with the native owner retained', async t => {
  const f = fixture(); t.after(() => f.dispose())
  const queries = []
  f.actions.groupRows = async (...args) => { queries.push(args); return { rows: [{ botId: 'chief', text: 'Principal ordinary reply.' }], open: false } }
  assert.ok(f.render().entry, 'The native group_relay slot must have a reply renderer instead of a generic tool card')
  await f.flush()
  assert.match(f.render().text, /Principal ordinary reply\./)
  assert.deepEqual(queries, [['room', 386, undefined, 'fixture-anchor']])
  assert.equal(f.original.component, f.native)
  assert.equal(f.original.children, f.children)
  assert.equal(f.core.entriesOfSlot('conversation.chat.node').length, 1)
})
test('an open quiet group range refreshes until the delayed principal reply arrives', async t => {
  const f = fixture(); t.after(() => f.dispose())
  let requests = 0
  f.actions.groupRows = async () => ++requests === 1 ? { rows: [], open: true, active: false } : { rows: [{ botId: 'chief', text: 'Delayed ordinary reply.' }], open: false }
  assert.ok(f.render().entry)
  await f.flush(); await f.next()
  assert.match(f.render().text, /Delayed ordinary reply\./)
  assert.equal(requests, 2)
})
test('a failed reply read stays visible and retries instead of silently leaving only task cards', async t => {
  const f = fixture(); t.after(() => f.dispose())
  let calls = 0
  f.actions.groupRows = async () => { if (++calls === 1) throw new Error('fixture read unavailable'); return { rows: [{ botId: 'chief', text: 'Recovered ordinary reply.' }], open: false } }
  assert.ok(f.render().entry); await f.flush()
  assert.match(f.render().text, /The group replies could not be shown/)
  await f.next(); assert.match(f.render().text, /Recovered ordinary reply\./)
})

test('changing a reply cursor cannot show the previous principal message', async t => {
  const f = fixture(); t.after(() => f.dispose())
  f.actions.groupRows = async () => ({ rows: [{ botId: 'chief', text: 'Previous cursor reply.' }], open: false })
  assert.ok(f.render().entry); await f.flush(); assert.match(f.render().text, /Previous cursor reply/)
  assert.doesNotMatch(f.render({ from: 500, anchor: 'second-fixture-anchor' }, 'relay-2').text, /Previous cursor reply/)
})

test('group reply registration withdraws on an ordinary Agent session and returns in Bot chat', t => {
  const f = fixture(); t.after(() => f.dispose())
  assert.ok(f.render().entry)
  f.mode({ mode: 'bot', plain: true }); assert.equal(f.render().entry, undefined)
  f.mode({ mode: 'bot', plain: false }); assert.ok(f.render().entry)
  f.mode({ mode: 'agent', plain: false }); assert.equal(f.render().entry, undefined)
})
test('the production ToolCell parent reads and displays an ordinary principal reply from a persisted cursor', async t => {
  const f = fixture(); t.after(() => f.dispose())
  const queries = []
  f.actions.groupRows = async (...args) => { queries.push(args); return { rows: [{ botId: 'chief', text: 'Principal reply for the reported user turn.' }], open: false } }
  f.shadowParent()
  assert.notEqual(f.core.entriesOfSlot('conversation.chat.node')[0].component, f.native)
  f.renderParent()
  await f.flush()
  assert.match(f.renderParent().text, /Principal reply for the reported user turn\./)
  assert.deepEqual(queries, [['room', 683, undefined, 'fixture-anchor']])
})

test('independent group replies suppress both old tool paths and still load the body once', async t => {
  const f = fixture(); t.after(() => f.dispose())
  f.actions.groupReplyNodes = true; f.shadowParent()
  const queries = []
  f.actions.groupRows = async (...args) => { queries.push(args); return { rows: [{ botId: 'chief', text: 'One independent ordinary principal reply.' }], open: false } }
  assert.equal(f.renderParent().text, '')
  assert.equal(f.render().text, '')
  f.renderIndependent(); await f.flush()
  assert.match(f.renderIndependent().text, /One independent ordinary principal reply\./)
  assert.deepEqual(queries, [['room', 900, undefined, 'standalone-anchor']])
})

test('an independent group reply cannot appear in a private session or a hidden exchange turn', async t => {
  const f = fixture(); t.after(() => f.dispose())
  let reads = 0; f.actions.groupRows = async () => { reads++; return { rows: [], open: false } }
  assert.equal(f.renderIndependent({ sessionId: 'chief' }).text, '')
  assert.equal(f.renderIndependent({ turn: 1 }).text, '')
  await f.flush(); assert.equal(reads, 0)
})

test('an independent failed relay shows its recorded error without attempting a cursor read', async t => {
  const f = fixture(); t.after(() => f.dispose())
  let reads = 0; f.actions.groupRows = async () => { reads++; return { rows: [], open: false } }
  assert.match(f.renderIndependent({ isError: true }).text, /Reported relay failure/)
  await f.flush(); assert.equal(reads, 0)
})

test('legacy inline principal replies remain visible in the native tool view', t => {
  const f = fixture(); t.after(() => f.dispose())
  const view = f.render({ replies: [{ botId: 'chief', text: 'Legacy ordinary reply.' }] })
  assert.match(view.text, /Legacy ordinary reply\./)
})
