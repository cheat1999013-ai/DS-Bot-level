// Stage the reply projection delta over the exact installed levels release.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const installed = process.env.DS_BOT_INSTALLED
if (!installed) throw new Error('Set DS_BOT_INSTALLED to the installed ds-bot folder')
const previous = JSON.parse(await fs.readFile(path.join(root, '.tmp-verify/levels-candidate-manifest.json'), 'utf8'))
const target = path.join(root, '.tmp-verify/replies-candidate-2')
const hash = value => createHash('sha256').update(value).digest('hex')
const bodies = new Map()
for (const [name, expected] of Object.entries(previous.candidate)) {
  const body = await fs.readFile(path.join(installed, name))
  if (hash(body) !== expected) throw Error(`Installed baseline drift: ${name}`)
  bodies.set(name, body)
}
const normalized = name => bodies.get(name).toString('utf8').replaceAll('\r\n', '\n')
const source = name => fs.readFile(path.join(root, name), 'utf8').then(text => text.replaceAll('\r\n', '\n'))
const replace = (text, before, after) => {
  if (text.split(before).length !== 2) throw Error(`Unexpected integration seam: ${before.slice(0, 100)}`)
  return text.replace(before, after)
}
let index = normalized('src/client/index.js')
index = replace(index, "import { AssistantCell, TriggerCell, TurnProcessCell, Nothing, CellEmpty, TurnTailCell, ToolCell, GroupRelayToolView } from './cells.js'",
  "import { AssistantCell, TriggerCell, TurnProcessCell, Nothing, CellEmpty, TurnTailCell, ToolCell, GroupRelayToolView, GroupReplyCell } from './cells.js'\nimport { GROUP_REPLY_KIND, installGroupReplyProjection, supportsGroupReplyProjection } from './group-reply-projection.js'")
index = replace(index, '  const face = () =>', '  actions.groupReplyNodes = supportsGroupReplyProjection(ctx)\n  const face = () =>')
index = replace(index, '  const installConversation = () => [\n',
  "  const installConversation = () => [\n    () => installGroupReplyProjection(ctx),\n    () => actions.groupReplyNodes ? shadow('conversation.chat.node', { key: GROUP_REPLY_KIND, priority: BOT_PRIORITY, locale: 'chat', inject: face }, GroupReplyCell) : () => {},\n")
bodies.set('src/client/index.js', Buffer.from(index))
let cells = normalized('src/client/cells.js')
const sourceCells = await source('src/client/cells.js')
const first = sourceCells.indexOf('export function GroupReplyCell('), last = sourceCells.indexOf('export function GroupRelayToolView(', first)
if (first < 0 || last < 0) throw Error('Missing independent renderer')
const header = 'export function GroupRelayToolView({ sessionId, callId, phase, block, useRoster, useUi, useWork, actions }) {\n  const roster = useRoster(value => value)\n'
cells = replace(cells, header, sourceCells.slice(first, last) +
  'export function GroupRelayToolView({ sessionId, callId, phase, block, useRoster, useUi, useWork, actions, standalone = false }) {\n  const roster = useRoster(value => value)\n  if (!standalone && actions.groupReplyNodes === true && roster.roomsById[sessionId] !== undefined) return h(CellEmpty)\n')
cells = replace(cells, '  const drawn = calls.filter(call => DRAWN.has(toolName(call)) || isComputerCall(toolName(call)))',
  "  const drawn = calls.filter(call => (DRAWN.has(toolName(call)) || isComputerCall(toolName(call)))\n    && !(actions.groupReplyNodes === true && roster.roomsById[sessionId] !== undefined && toolName(call) === 'group_relay'))")
bodies.set('src/client/cells.js', Buffer.from(cells))
bodies.set('src/client/group-reply-projection.js', Buffer.from(await source('src/client/group-reply-projection.js')))
const pkg = JSON.parse(normalized('package.json'))
pkg.version = JSON.parse(await source('package.json')).version
bodies.set('package.json', Buffer.from(JSON.stringify(pkg, null, 2) + '\n'))
await fs.mkdir(target)
for (const [name, body] of bodies) {
  await fs.mkdir(path.dirname(path.join(target, name)), { recursive: true })
  await fs.writeFile(path.join(target, name), body)
}
const { bundleClient } = await import(pathToFileURL(path.join(target, 'scripts/build-client.mjs')).href)
await fs.writeFile(path.join(target, 'client.js'), await bundleClient())
const candidate = Object.fromEntries(await Promise.all([...bodies.keys()].map(async name => [name, hash(await fs.readFile(path.join(target, name)))])))
const changed = Object.keys(candidate).filter(name => candidate[name] !== previous.candidate[name]).sort()
const allowed = ['package.json', 'client.js', 'src/client/index.js', 'src/client/cells.js', 'src/client/group-reply-projection.js'].sort()
if (JSON.stringify(changed) !== JSON.stringify(allowed)) throw Error('Unexpected release delta')
const manifest = { version: pkg.version, baselineVersion: '0.3.27-levels.1', baseline: previous.candidate, candidate, changed,
  scope: 'Independent group-reply node through public SDK, exact installed baseline retained. No host, profile, database, executor visibility policy or real message write.' }
await fs.writeFile(path.join(root, '.tmp-verify/replies-candidate-manifest.json'), JSON.stringify(manifest, null, 2))
console.log(JSON.stringify({ version: pkg.version, files: Object.keys(candidate).length, changed }))
