import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const bundle = await build({ stdin: { contents: "export { TaskForm } from './src/client/schedules.js'; export { TaskflowPage } from './src/client/taskflow-dashboard.js'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, format: 'cjs', platform: 'browser', write: false, external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'] })
const slots = []
let cursor = 0
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  createContext: value => ({ value }), useContext: context => context.value,
  useState(initial) {
    const index = cursor++
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
    return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
  },
  useEffect() {}, useLayoutEffect() {}, useMemo: factory => factory(), useCallback: value => value,
  useRef: value => ({ current: value }), useSyncExternalStore: (_subscribe, get) => get(),
}
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports,
  require: name => name === 'react' ? react : {}, window: { addEventListener() {}, removeEventListener() {} }, document: {} })
const { TaskForm, TaskflowPage } = module.exports
const walk = (node, match) => Array.isArray(node) ? node.flatMap(child => walk(child, match))
  : node && typeof node === 'object' ? [...(match(node) ? [node] : []), ...walk(node.props?.children, match)] : []
const bots = [{ id: 'chief', name: 'Chief' }, { id: 'writer', name: 'Writer' }, { id: 'reviewer', name: 'Reviewer' }]
const roster = { bots, byId: Object.fromEntries(bots.map(bot => [bot.id, bot])), rooms: [
  { id: 'one', name: 'One', admin: 'chief', members: ['chief', 'writer'] },
  { id: 'two', name: 'Two', admin: 'chief', members: ['chief', 'reviewer'] },
] }
function form(group = true, start = 'one') {
  slots.length = 0
  const requests = []
  const actions = { groupScheduleCreate: async value => { requests.push({ type: 'card', value }); return {} },
    scheduleCreate: async value => { requests.push({ type: 'reminder', value }); return {} } }
  const render = () => { cursor = 0; return TaskForm({ roster, actions, start, group, onDone() {}, onCancel() {} }) }
  const fill = () => {
    const tree = render()
    walk(tree, node => node.type === 'input' && node.props.maxLength === 120)[0].props.onChange({ target: { value: 'Daily evidence check' } })
    walk(tree, node => node.type === 'textarea')[0].props.onChange({ target: { value: 'Verify the sources' } })
  }
  return { requests, render, fill }
}

test('the group schedule form submits the selected executor to the card endpoint, not a chat reminder', async () => {
  const env = form()
  env.fill()
  env.render().props.onSubmit({ preventDefault() {} })
  await Promise.resolve()
  assert.equal(env.requests.length, 1)
  assert.equal(env.requests[0].type, 'card')
  assert.equal(env.requests[0].value.target, 'one')
  assert.equal(env.requests[0].value.memberId, 'writer')
  assert.equal(env.requests[0].value.when.kind, 'daily')
  assert.equal(env.requests[0].value.prompt, 'Verify the sources')
})

test('switching groups resolves that group executor instead of retaining a foreign member', async () => {
  const env = form()
  env.fill()
  const tree = env.render()
  walk(tree, node => node.type === 'select' && node.props['aria-label'] === 'Group chats')[0].props.onChange({ target: { value: 'two' } })
  env.render().props.onSubmit({ preventDefault() {} })
  await Promise.resolve()
  assert.equal(env.requests[0].value.target, 'two')
  assert.equal(env.requests[0].value.memberId, 'reviewer')
})

test('single Bot reminders keep their endpoint and never inherit a group target from navigation', async () => {
  const env = form(false, 'one')
  env.fill()
  env.render().props.onSubmit({ preventDefault() {} })
  await Promise.resolve()
  assert.equal(env.requests[0].type, 'reminder')
  assert.equal(env.requests[0].value.target, 'chief')
  assert.equal(Object.hasOwn(env.requests[0].value, 'memberId'), false)
})

test('the real task panel callback opens a group-seeded schedule form and is absent on a foreign preview', () => {
  slots.length = 0
  const calls = []
  cursor = 0
  const props = { roomId: 'one', actions: { openSettings: (...args) => calls.push(args) } }
  TaskflowPage(props).props.onSchedule()
  assert.deepEqual(calls, [['schedules', 'group:one']])
  slots[0] = 'two'
  cursor = 0
  assert.equal(TaskflowPage(props).props.onSchedule, undefined)
})
