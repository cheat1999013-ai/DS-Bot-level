// CPU-only native SDK projection harness. Shell notification/lifetime adapters do
// not replace the SDK event matching, location index, view builder or grouping.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
const app = createRequire(new URL('../../../app/package.json', import.meta.url))
const modules = new Map()
for (const name of ['react', 'react/jsx-runtime', 'react-dom', 'zod', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-slots']) modules.set(name, app(name))
modules.set('@deepseek-ai/dsh-client-store', {
  createSnapshotStore(initial) {
    let value = initial; const listeners = new Set()
    return { getSnapshot: () => value, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) },
      set(next) { value = typeof next === 'function' ? next(value) : next; for (const fn of listeners) fn() } }
  },
  defineStore: definition => definition,
  notifySubscribers(listeners, ...ownerAndArgs) { for (const listener of [...listeners]) listener(...ownerAndArgs.slice(1)) },
})
modules.set('@deepseek-ai/dsh-client-ui-primitives', new Proxy({}, { get: () => () => null }))
modules.set('@tanstack/react-virtual', {})
async function load(name) {
  const filename = process.env.SDK_CLIENT_ROOT
    ? path.join(process.env.SDK_CLIENT_ROOT, name.replace('@deepseek-ai/', ''), 'lib/client.js')
    : path.join(path.dirname(app.resolve(`${name}/package.json`)), 'lib/client.js')
  let descriptor
  runInNewContext(await fs.readFile(filename, 'utf8'), {
    window: { __ModuleLoader__: { load: value => { descriptor = value } } }, console,
    setTimeout, clearTimeout, queueMicrotask, TextEncoder, TextDecoder, AbortController, URL, Map, Set, WeakMap, WeakSet,
  })
  return descriptor.factory(Object.assign(name => {
    if (!modules.has(name)) throw Error(`Unmapped SDK dependency: ${name}`)
    return modules.get(name)
  }, { asset: value => value }))
}
const native = await load('@deepseek-ai/dsh-client-ui-conversation')
const chat = await load('@deepseek-ai/dsh-client-ui-chat')
export function nativeProjection(register) {
  const lifecycle = { effect: fn => fn() }
  const events = new native.ConversationEventRegistry(lifecycle)
  const views = new native.ConversationViewRegistry(lifecycle)
  const definitions = []
  const groups = { register: value => { definitions.push(value); return () => {} }, entries: () => definitions,
    forTarget: target => definitions.find(value => value.target === target) }
  const stop = new Error('Definitions captured')
  const ctx = { ...lifecycle, uiConversation: { events, views, groups }, uiSession: { provide() { throw stop } } }
  try { chat.apply(ctx) } catch (error) { if (error !== stop) throw error }
  const dispose = register?.(ctx)
  const assembler = new native.ConversationNodeAssembler(events, views, groups)
  return { ctx, assembler,
    replay(records, hasMore = false) {
      assembler.replaceWindow(records.map(event => ({ type: 'event', event })), hasMore)
      assembler.activateTarget('chat'); assembler.flush()
      return { snapshot: assembler.snapshot('chat'), grouped: assembler.grouped('chat') }
    },
    dispose: () => dispose?.(),
  }
}
export function relayEvents({ turn = 343, seq = 1, name = 'group_relay', callId = `fixture-call-${turn}`, from = 683 } = {}) {
  const event = (type, data, extra = {}) => ({ type, seq: seq++, time: 1794517470006 + seq, data, ...extra })
  return [
    event('turn/start', { turn }),
    event('step/start', { turn, step: 0 }),
    event('tool/call', { turn, step: 0, callId, name, arguments: '{}' }),
    event('tool/result', { turn, step: 0, message: { role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId,
      content: [{ type: 'text', text: JSON.stringify({ from, anchor: `fixture-anchor-${turn}` }) }], isError: false } }, { surfaceOp: 'append' }),
    event('step/end', { turn, step: 0, reason: { kind: 'complete' } }),
    event('turn/end', { turn, reason: { kind: 'complete' } }),
  ]
}
