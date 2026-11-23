import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { indexRoster } from '../src/client/sources.js'

const requireApp = createRequire(new URL('../../app/package.json', import.meta.url))
const { SlotCore } = await import(pathToFileURL(requireApp.resolve('@deepseek-ai/dsh-client-ui-slots')).href)
const bundle = await build({ entryPoints: [join(process.env.STAGED_BOT_ROOT ?? fileURLToPath(new URL('..', import.meta.url)), 'src/client/task-inputs.js')],
  bundle: true, format: 'cjs', platform: 'node', write: false, external: ['react', '@deepseek-ai/dsh-client-ui-primitives'] })
const module = { exports: {} }
const h = (type, props, ...children) => ({ type, props, children })
runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'react'
  ? { createElement: h, Fragment: 'fragment', createContext: value => ({ value }), useContext: context => context.value,
    useState: initial => [initial, () => {}], useEffect() {}, useRef: value => ({ current: value }) }
  : { MarkdownText: 'MarkdownText' } })

function setup() {
  const core = new SlotCore()
  const nativeUser = () => null
  const sourceChildren = { 'conversation.chat.user.before': { kind: 'chain', scope: 'session' } }
  const offRoot = core.register({ name: 'root', children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } } }, () => null)
  const offUser = core.register({ name: 'conversation.chat.node', key: 'user', locale: 'native-chat', children: sourceChildren }, nativeUser)
  const originalInject = sessionId => ({ renderSlotChain: () => null, sessionMarker: sessionId, hooks: { native: 'native-hook', ui: 'native-ui', turnClock: 'native-clock' } })
  const offSteering = core.register({ name: 'conversation.chat.node', key: 'steering', locale: 'native-chat', inject: originalInject }, nativeUser)
  const nativeTrigger = () => null
  const offTrigger = core.register({ name: 'conversation.chat.node', key: 'turn-trigger', locale: 'native-chat' }, nativeTrigger)
  const slots = { inject: (_name, register) => register(), register: (...args) => core.register(...args), entries: name => core.entriesOfSlot(name) }
  const roster = { getSnapshot: () => ({ roomsById: { room: { id: 'room' } } }) }
  const PrincipalReply = () => null
  const off = module.exports.installTaskInputs(slots, { roster, face: () => ({ actions: 'bot-actions', hooks: { roster, ui: 'bot-ui', turnClock: 'bot-clock' } }), principalReply: PrincipalReply })
  const selected = key => core.entriesOfSlot('conversation.chat.node').find(entry => entry.options.key === key)
  return { core, selected, nativeUser, nativeTrigger, PrincipalReply, sourceChildren, roster, dispose: () => { off(); offTrigger(); offSteering(); offUser(); offRoot() } }
}

test('production task input registration preserves real SlotCore steering inject and native locale', () => {
  const env = setup()
  try {
    const entry = env.selected('steering')
    assert.equal(entry.locale, 'native-chat')
    const injected = entry.inject('room')
    assert.equal(typeof injected.renderSlotChain, 'function', 'Native steering fallback must keep its source-seat callback')
    assert.equal(injected.sessionMarker, 'room')
    assert.equal(injected.hooks.native, 'native-hook')
    assert.equal(injected.hooks.roster, env.roster)
    assert.equal(injected.hooks.ui, 'native-ui')
    assert.equal(injected.hooks.turnClock, 'native-clock')
    assert.equal(injected.hooks.principalUi, 'bot-ui')
    assert.equal(injected.hooks.principalTurnClock, 'bot-clock')
    assert.equal(injected.principalActions, 'bot-actions')
  } finally { env.dispose() }
})

test('production task inputs keep the native user owner and decorate its authorized source chain', () => {
  const env = setup()
  try {
    const user = env.selected('user')
    assert.equal(user.component, env.nativeUser)
    assert.equal(user.children, env.sourceChildren)
    const [source] = env.core.entriesOfSlot('conversation.chat.user.before')
    const task = { planId: 'plan', cardId: 'write', event: 'submitted',
      from: { id: 'writer', name: 'Writer' }, to: { id: 'chief', name: 'Chief' } }
    for (const owner of [{ kind: 'user', source: { kind: 'user' } },
      { kind: 'user', source: { kind: 'user', taskflowEvent: task } },
      { kind: 'user', source: { kind: 'bot', role: 'post' } }]) {
      assert.equal(source.select(owner), null)
      assert.equal(env.selected('user'), user)
    }
    const matched = source.select({ kind: 'user', source: { kind: 'bot', role: 'post', taskflowEvent: task } })
    assert.equal(matched, task)
    const header = source.component({ matched })
    assert.equal(header.props.className, 'bt-task-source')
    assert.match(JSON.stringify(header), /Result submitted/)
    assert.match(JSON.stringify(header), /Writer → Chief/)
    const entry = env.selected('steering')
    const input = entry.component({ sessionId: 'room', node: { data: { source: { kind: 'bot', role: 'post', taskflowEvent: task },
      content: [{ type: 'text', text: 'Task result' }] } } })
    assert.equal(input.props.Fallback, env.nativeUser)
    const card = input.type(input.props)
    assert.equal(card.type.name, 'TaskMessage')
    assert.equal(card.props.task.cardId, 'write')
  } finally { env.dispose() }
})

test('the current group admin ordinary reply uses Bot chat while formal tasks keep their cards', () => {
  const env = setup()
  try {
    const entry = env.selected('turn-trigger')
    const chief = { id: 'chief', sessionId: 'chief-current', parts: ['chief-old'], name: 'lq-operation' }
    const writer = { id: 'writer', name: 'lq-operation' }
    const room = { id: 'room', sessionId: 'group-part', ownParts: ['group-old'], admin: 'chief', members: ['chief', 'writer'] }
    let state = indexRoster({ bots: [chief, writer], rooms: [room], mainBotIds: ['chief'] })
    const useRoster = select => select(state)
    const source = { kind: 'bot', form: 'relay', role: 'post', roomId: 'room', senderSessionId: 'chief', senderName: 'lq-operation' }
    const data = { source, seq: 6008, time: 1794625487018, content: [{ type: 'text', text: '[Group post from lq-operation]\n已登记发布记录，保留发布时间和链接。' }] }
    const usePrincipalUi = () => null
    const usePrincipalTurnClock = () => null
    const render = (value = data, sessionId = 'group-part') => { const input = entry.component({ node: { kind: 'turn-trigger', data: value }, sessionId, useRoster,
      actions: 'native-actions', principalActions: 'bot-actions', usePrincipalUi, usePrincipalTurnClock }); return input.type(input.props) }
    const ordinary = render()
    assert.equal(ordinary.type, env.PrincipalReply, 'A verified current admin must use the existing Bot chat renderer')
    assert.equal(ordinary.props.node.data, data, 'Reuse the complete original message, including its source and seq')
    assert.equal(ordinary.props.sessionId, 'group-part')
    assert.equal(ordinary.props.actions, 'bot-actions')
    assert.equal(ordinary.props.useUi, usePrincipalUi)
    assert.equal(ordinary.props.useTurnClock, usePrincipalTurnClock)
    assert.equal(render(data, 'group-old').type, env.PrincipalReply, 'Older group parts resolve the same room')
    assert.equal(render({ ...data, source: { ...source, senderSessionId: 'chief-old' } }).type, env.PrincipalReply, 'Sender parts resolve through stable roster identity')
    assert.equal(render({ ...data, source: { ...source, senderSessionId: 'writer' } }), null, 'An executor with the same display name cannot post ordinary group text')
    const formal = { ...data, source: { ...source, taskflowEvent: { planId: 'plan', cardId: 'fix', event: 'submitted' } } }
    assert.equal(render(formal).type.name, 'TaskMessage')
    assert.equal(render({ ...data, content: [{ type: 'text', text: '[Group post from lq-operation]\n' }] }), null, 'Empty ordinary admin replies stay suppressed')
    assert.equal(render({ ...data, source: { ...source, roomId: 'foreign' } }).type, env.nativeTrigger)
    state = indexRoster({ bots: [chief, writer], rooms: [{ ...room, admin: 'writer' }], mainBotIds: ['chief'] })
    assert.equal(render(), null, 'A global Main Bot is not the current room admin')
    state = indexRoster({ bots: [chief, writer], rooms: [{ ...room, members: ['writer'] }] })
    assert.equal(render(), null, 'An admin pointer outside membership is stale')
    state = indexRoster({ bots: [writer], rooms: [room] })
    assert.equal(render(), null, 'A missing admin Bot cannot be inferred from its display name')
    state = indexRoster({ bots: [writer], rooms: [{ ...room, admin: undefined }] })
    assert.equal(render(), null, 'Missing sender and admin metadata do not create an admin reply')
  } finally { env.dispose() }
})

test('header-only Bot relay from the reported 10:47 round does not create an empty card', () => {
  const env = setup()
  try {
    const entry = env.selected('turn-trigger')
    const source = { kind: 'bot', form: 'relay', role: 'post', roomId: 'room', senderSessionId: 'chief', senderName: 'lq-operation' }
    const useRoster = select => select(env.roster.getSnapshot())
    const render = value => { const input = entry.component({ node: { kind: 'turn-trigger', data: value }, sessionId: 'room', useRoster }); return input.type(input.props) }
    const data = { source, seq: 5972, time: 1794624420969, content: [{ type: 'text', text: '[Group post from lq-operation]\n' }] }
    for (const content of [data.content, [{ type: 'text', text: '[Group post from lq-operation]\r\n  \t\n' }], [{ type: 'text', text: '  \n\t' }], []]) {
      assert.equal(render({ ...data, content }), null, 'No visible body means no ordinary Bot report card')
    }
    const text = '  保留真实正文及 Markdown 缩进。\n'
    assert.equal(render({ ...data, content: [{ type: 'text', text: '[Group post from lq-operation]\n' + text }] }), null, 'Nonempty unassigned reports must not become tasks or group updates')
    assert.equal(render({ ...data, source: { ...source, taskflowEvent: { planId: 'plan', cardId: 'fix', event: 'submitted' } } }).type.name, 'TaskMessage', 'Formal task identity remains visible even without report text')
    assert.equal(render({ ...data, source: { kind: 'plugin' } }).type, env.nativeTrigger)
    assert.equal(render({ ...data, content: [...data.content, { type: 'file', attachment: { name: 'proof.txt' } }] }), null, 'An executor cannot bypass formal submission through an ordinary attachment post')
  } finally { env.dispose() }
})

test('native turn-trigger suppresses executor ordinary reports and preserves real tasks and unrelated renderers', () => {
  const env = setup()
  try {
    const entry = env.selected('turn-trigger')
    assert.notEqual(entry.component, env.nativeTrigger, 'DS Bot must own the new trigger cell too')
    assert.equal(entry.locale, 'native-chat')
    const source = { kind: 'bot', form: 'relay', role: 'post', roomId: 'room', senderSessionId: 'chief', senderName: 'lq-operation' }
    const data = { source, seq: 5726, time: 1794618572911, content: [{ type: 'text', text: '[Group post from lq-operation]\n03_数据清理完成；原文件与存档均可查。' }] }
    const useRoster = select => select(env.roster.getSnapshot())
    const render = value => { const input = entry.component({ node: { kind: 'turn-trigger', data: value }, sessionId: 'room', useRoster }); return input.type(input.props) }
    assert.equal(render(data), null)
    const formal = render({ ...data, source: { ...source, taskflowEvent: { planId: 'plan', cardId: 'fix', event: 'submitted' } } })
    assert.equal(formal.type.name, 'TaskMessage')
    for (const changed of [{ kind: 'user' }, { kind: 'plugin' }, { ...source, roomId: 'foreign' }, { ...source, role: 'context' }]) {
      assert.equal(render({ ...data, source: changed }).type, env.nativeTrigger)
    }
    assert.equal(render({ ...data, content: [...data.content, { type: 'image', attachment: { name: 'proof.png' } }] }), null, 'ordinary executor image posts do not bypass task-only delivery')
  } finally { env.dispose() }
})
