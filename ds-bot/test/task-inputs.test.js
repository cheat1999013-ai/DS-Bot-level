import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'

const requireApp = createRequire(new URL('../../app/package.json', import.meta.url))
const { SlotCore } = await import(pathToFileURL(requireApp.resolve('@deepseek-ai/dsh-client-ui-slots')).href)
const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/client/task-inputs.js', import.meta.url))],
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
  const originalInject = sessionId => ({ renderSlotChain: () => null, sessionMarker: sessionId, hooks: { native: 'native-hook' } })
  const offSteering = core.register({ name: 'conversation.chat.node', key: 'steering', locale: 'native-chat', inject: originalInject }, nativeUser)
  const slots = { inject: (_name, register) => register(), register: (...args) => core.register(...args), entries: name => core.entriesOfSlot(name) }
  const roster = { getSnapshot: () => ({ roomsById: { room: { id: 'room' } } }) }
  const off = module.exports.installTaskInputs(slots, { roster, face: () => ({ hooks: { roster } }) })
  const selected = key => core.entriesOfSlot('conversation.chat.node').find(entry => entry.options.key === key)
  return { core, selected, nativeUser, sourceChildren, roster, dispose: () => { off(); offSteering(); offUser(); offRoot() } }
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
