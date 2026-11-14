// Retain the exact installed package and the independently staged reply repair.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const installed = 'D:/software/deepseekharness desktop/resources/app/dsh/node_modules/ds-bot'
const previous = JSON.parse(await fs.readFile(path.join(root, '.tmp-verify/replies-candidate-manifest.json'), 'utf8'))
const target = path.join(root, '.tmp-verify/group-controls-candidate-5')
const hash = body => createHash('sha256').update(body).digest('hex')
const baseline = JSON.parse(await fs.readFile(path.join(root, '.tmp-verify/group-controls-installed-baseline.json'), 'utf8'))
const bodies = new Map()
for (const [name, expected] of Object.entries(baseline.files)) {
  const body = await fs.readFile(path.join(installed, name))
  if (hash(body) !== expected) throw Error(`Installed baseline drift: ${name}`)
  bodies.set(name, body)
}
for (const name of ['src/client/index.js', 'src/client/cells.js', 'src/client/group-reply-projection.js']) {
  const body = await fs.readFile(path.join(root, '.tmp-verify/replies-candidate-2', name))
  if (hash(body) !== previous.candidate[name]) throw Error(`Previous candidate drift: ${name}`)
  bodies.set(name, body)
}
const normalized = body => body.toString('utf8').replaceAll('\r\n', '\n')
const source = async name => normalized(await fs.readFile(path.join(root, name)))
const replace = (text, before, after) => {
  if (text.split(before).length !== 2) throw Error(`Unexpected integration seam: ${before.slice(0, 100)}`)
  return text.replace(before, after)
}
const section = (text, from, to) => {
  if (text.split(from).length !== 2 || text.split(to).length !== 2) throw Error(`Ambiguous section ${from}`)
  return text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)))
}
const transplant = async (name, from, to) => {
  const base = normalized(bodies.get(name)), current = await source(name)
  bodies.set(name, Buffer.from(replace(base, section(base, from, to), section(current, from, to))))
}
let index = normalized(bodies.get('src/client/index.js'))
index = replace(index, "import { MEMBER_CSS, MemberDock } from './member-status.js'", "import { MEMBER_CSS, MemberDock, GroupApprovalDock } from './member-status.js'")
index = replace(index, "    () => shadow('conversation.input.dock', { id: 'bot-members', order: -120, inject: face }, MemberDock),",
  "    () => shadow('conversation.input.dock', { id: 'bot-approvals', order: -130, inject: face }, GroupApprovalDock),\n    () => shadow('conversation.input.dock', { id: 'bot-members', order: -120, inject: face }, MemberDock),")
bodies.set('src/client/index.js', Buffer.from(index))
bodies.set('src/client/member-status.js', Buffer.from(await source('src/client/member-status.js')))
await transplant('src/client/details-drawer.js', 'function MemberRow(', "// A group's overview:")
let details = normalized(bodies.get('src/client/details-drawer.js'))
details = replace(details, 'import { MemberApprovals, MemberState,', 'import { MemberState,')
bodies.set('src/client/details-drawer.js', Buffer.from(details))
await transplant('src/client/taskflow-dashboard.js', 'function Capabilities(', 'const taskReference =')
let board = normalized(bodies.get('src/client/taskflow-dashboard.js'))
board = replace(board, "        principal.model ? h('small', { title: principal.model }, principal.model) : null),", "        h(Capabilities, { member: principal })),")
board = replace(board, '    const timer = setInterval(load, 5000)', '    const timer = setInterval(load, 2000)')
board = replace(board, "t('Live · refreshes every 5 seconds')", "t('Live · refreshes every 2 seconds')")
bodies.set('src/client/taskflow-dashboard.js', Buffer.from(board))
let copy = normalized(bodies.get('src/client/i18n.js'))
copy = replace(copy, "  'Allow once': '允许一次',", "  'Allow once': '允许一次',\n  'Approve once': '通过',\n  'Operation details': '展开完整参数',\n  'Live · refreshes every 2 seconds': '实时 · 每 2 秒刷新',")
bodies.set('src/client/i18n.js', Buffer.from(copy))
await transplant('src/host/taskflow.js', '  const skillUses =', '  rt.taskflowView =')
let host = normalized(bodies.get('src/host/taskflow.js'))
host = replace(host, 'flatMap(item => groupAssignments(item, rt.state.bots))', 'flatMap(item => observedFor(item))')
host = replace(host, 'flatMap(item => groupAssignments(item, rt.state.bots,', 'flatMap(item => observedFor(item,')
bodies.set('src/host/taskflow.js', Buffer.from(host))
let approvals = normalized(bodies.get('src/host/approvals.js'))
approvals = replace(approvals, "reason: String(request.reason ?? '').slice(0, 500),", "reason: String(request.reason ?? ''),")
bodies.set('src/host/approvals.js', Buffer.from(approvals))
await transplant('src/host/turns.js', '  const callDetail =', '  // Where a Session speaks,')
let turns = normalized(bodies.get('src/host/turns.js'))
turns = replace(turns, "      case 'tool/ptc-dispatch':\n        endCall(id, entry, event.data?.subCallId)",
  "      case 'tool/ptc-dispatch':\n        if (!entry.calls?.has(event.data?.subCallId)) {\n          noteSkill(id, String(event.data?.name ?? ''), event.data?.arguments, event.time ?? Date.now())\n        }\n        endCall(id, entry, event.data?.subCallId)")
bodies.set('src/host/turns.js', Buffer.from(turns))
const knowledgeRuntime = normalized(bodies.get('src/host/taskflow/knowledge-runtime.js'))
bodies.set('src/host/taskflow/knowledge-runtime.js', Buffer.from(replace(knowledgeRuntime,
  '    for (const skill of material.loaded) rt.noteTaskflowSkill?.(current.room.id, current.botId, skill.name)\n', '')))
const pkg = JSON.parse(normalized(bodies.get('package.json')))
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
const changed = Object.keys(candidate).filter(name => candidate[name] !== baseline.files[name]).sort()
const allowed = ['package.json', 'client.js', 'src/client/index.js', 'src/client/cells.js', 'src/client/group-reply-projection.js',
  'src/client/member-status.js', 'src/client/details-drawer.js', 'src/client/taskflow-dashboard.js', 'src/client/i18n.js', 'src/host/taskflow.js',
  'src/host/approvals.js', 'src/host/turns.js', 'src/host/taskflow/knowledge-runtime.js'].sort()
if (JSON.stringify(changed) !== JSON.stringify(allowed)) throw Error(`Unexpected release delta: ${JSON.stringify(changed)}`)
const manifest = { version: pkg.version, baselineVersion: baseline.version, baseline: baseline.files, candidate, changed,
  scope: 'Public group chat approval dock and observed skill projections; preserve all installed capabilities and previous reply-node repair. No profile, database or real message writes.' }
await fs.writeFile(path.join(root, '.tmp-verify/group-controls-candidate-manifest.json'), JSON.stringify(manifest, null, 2))
console.log(JSON.stringify({ version: pkg.version, files: Object.keys(candidate).length, changed }))
