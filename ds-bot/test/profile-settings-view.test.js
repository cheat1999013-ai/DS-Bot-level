import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const bundle = await build({ stdin: { contents: "export { ProfilesPage } from './src/client/profile-settings.js'; export { BotCapabilitiesCard } from './src/client/capability-settings.js'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, format: 'cjs', platform: 'browser', write: false, external: ['react'] })
const slots = []
let cursor = 0
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState(initial) {
    const index = cursor++
    if (!(index in slots)) slots[index] = initial
    return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
  },
  useEffect() {},
}
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: () => react })
const { ProfilesPage, BotCapabilitiesCard } = module.exports
const textOf = node => node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node)
  : Array.isArray(node) ? node.map(textOf).join('') : textOf(node.props?.children)
const walk = (node, match) => Array.isArray(node) ? node.flatMap(child => walk(child, match))
  : node && typeof node === 'object' ? [...(match(node) ? [node] : []), ...walk(node.props?.children, match)] : []
const view = () => ({
  dshProfiles: [{ name: 'work', active: true, bundles: ['global-plugin'], skills: [] }],
  plugins: [{ name: 'global-plugin', active: true, profiles: ['work'] }],
  capabilities: [{ name: 'writing', kind: 'skill' }, { name: 'private-server', kind: 'mcp' }],
  profiles: [{ name: 'writer', description: '', capabilities: ['writing', 'private-server'], plugins: ['global-plugin'],
    missing: [], missingPlugins: [], inactivePlugins: [] }], bots: [],
  skills: { available: true, complete: true, items: [] },
  skillRoots: { global: 'D:/isolated-fixture/skills', profile: null },
})
const mount = data => {
  slots.length = 0
  slots.push(data)
  const saved = []
  const actions = { saveProfile: async (profile, original) => { saved.push({ profile, original }); return data } }
  const render = () => { cursor = 0; return ProfilesPage({ actions }) }
  return { render, saved }
}

test('Bot profiles show skill installation roots and omit global plugin and MCP selectors', () => {
  const env = mount(view())
  let tree = env.render()
  assert.ok(textOf(tree).includes('D:/isolated-fixture/skills'))
  assert.ok(textOf(tree).includes('<name>/SKILL.md'))
  assert.ok(!textOf(tree).includes('global-plugin'))
  assert.ok(!textOf(tree).includes('private-server'))
  walk(tree, node => node.type === 'button' && textOf(node) === 'Edit')[0].props.onClick()
  tree = env.render()
  assert.ok(textOf(tree).includes('writing'))
  assert.ok(!textOf(tree).includes('global-plugin'))
  assert.ok(!textOf(tree).includes('private-server'))
})

test('editing visible skills preserves hidden MCP assignments and leaves plugin references to the host', async () => {
  const data = view()
  const env = mount(data)
  let tree = env.render()
  walk(tree, node => node.type === 'button' && textOf(node) === 'Edit')[0].props.onClick()
  tree = env.render()
  walk(tree, node => node.type === 'form')[0].props.onSubmit({ preventDefault() {} })
  await Promise.resolve()
  assert.equal(env.saved.length, 1)
  assert.deepEqual(Array.from(env.saved[0].profile.capabilities), ['writing', 'private-server'])
  assert.equal(Object.hasOwn(env.saved[0].profile, 'plugins'), false)
  assert.equal(env.saved[0].original, 'writer')
  assert.deepEqual(data.profiles[0].plugins, ['global-plugin'])
})

test('Bot settings omit MCP switches while keeping the saved assignment intact', () => {
  const bot = { id: 'writer', capabilities: ['private-server', 'writing'] }
  const calls = []
  const tree = BotCapabilitiesCard({ bot, roster: { capabilities: view().capabilities },
    actions: { setBotCapability: (...args) => calls.push(args) }, run: value => value,
    Card: 'card', SwitchRow: 'switch-row' })
  const switches = walk(tree, node => node.type === 'switch-row')
  assert.deepEqual(switches.map(node => node.props.label), ['writing'])
  switches[0].props.onChange(false)
  assert.deepEqual(calls, [['writer', 'writing', false]])
  assert.deepEqual(bot.capabilities, ['private-server', 'writing'])
})
