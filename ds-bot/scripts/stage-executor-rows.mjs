import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { bundleClient } from './build-client.mjs'
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const installed = process.env.DS_BOT_INSTALLED
if (!installed) throw new Error('Set DS_BOT_INSTALLED to the installed ds-bot folder')
const previous = JSON.parse(await fs.readFile(path.join(root, '.tmp-verify/native-manifest-1.json'), 'utf8'))
const out = path.join(root, '.tmp-verify/executor-rows-candidate-1')
const hash = value => createHash('sha256').update(value).digest('hex')
const files = new Map()
for (const [name, expected] of Object.entries(previous.candidate)) {
  const body = await fs.readFile(path.join(installed, name))
  if (hash(body) !== expected) throw Error(`Installed baseline changed: ${name}`)
  files.set(name, body)
}
const replace = (text, before, after) => {
  if (text.split(before).length !== 2) throw Error(`Ambiguous seam: ${before}`)
  return text.replace(before, after)
}
const source = async name => (await fs.readFile(path.join(root, name), 'utf8')).replaceAll('\r\n', '\n')
// Restore the existing per-room/per-Bot projection and its own styles. Leave the
// unrelated workspace-only schedule entry out of this published regression fix.
let dashboard = await source('src/client/taskflow-dashboard.js')
dashboard = replace(dashboard, 'export function TaskflowPage({ roomId, actions })', 'export function TaskflowPage({ roomId })')
dashboard = replace(dashboard, "    onSchedule: actions?.openSettings && scope !== 'all' && (!roomId || roomId === scope)\n      ? () => actions.openSettings('schedules', `group:${scope}`) : undefined,\n", '')
dashboard = replace(dashboard, 'onRefresh = () => {}, onConfirm, onSchedule })', 'onRefresh = () => {}, onConfirm })')
dashboard = replace(dashboard, "      onSchedule ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onSchedule }, t('New group task')) : null,\n", '')
files.set('src/client/taskflow-dashboard.js', Buffer.from(dashboard))
let locale = files.get('src/client/i18n.js').toString('utf8').replaceAll('\r\n', '\n')
locale = replace(locale, "  'Task history': '任务历史',", "  'Tasks and history ({count})': '任务与历史（{count}）',\n  'Task history': '任务历史',")
files.set('src/client/i18n.js', Buffer.from(locale))
// A Bot reused by two groups needs each group's level/tool snapshot. A flat
// members map cannot establish foreign-room metadata for the restored renderer.
let host = files.get('src/host/taskflow.js').toString('utf8').replaceAll('\r\n', '\n')
host = replace(host, '        members: scopeAll ? Object.assign({}, ...rooms.map(membersOf)) : membersOf(room), plan: null, plans: [], timeline: [],', '        membersByRoom: Object.fromEntries((scopeAll ? rooms : [room]).filter(Boolean).map(item => [item.id, membersOf(item)])),\n        members: scopeAll ? Object.assign({}, ...rooms.map(membersOf)) : membersOf(room), plan: null, plans: [], timeline: [],')
host = replace(host, '      members: scopeAll ? Object.assign({}, ...rooms.filter(item => item.id !== room?.id).map(membersOf), membersOf(room)) : membersOf(room),', '      membersByRoom: Object.fromEntries((scopeAll ? rooms : [room]).filter(Boolean).map(item => [item.id, membersOf(item)])),\n      members: scopeAll ? Object.assign({}, ...rooms.filter(item => item.id !== room?.id).map(membersOf), membersOf(room)) : membersOf(room),')
files.set('src/host/taskflow.js', Buffer.from(host))
const pkg = JSON.parse(files.get('package.json'))
pkg.version = '0.3.43-executor-rows.1'
files.set('package.json', Buffer.from(JSON.stringify(pkg, null, 2) + '\n'))
for (const [name, body] of files) {
  await fs.mkdir(path.dirname(path.join(out, name)), { recursive: true })
  await fs.writeFile(path.join(out, name), body)
}
files.set('client.js', Buffer.from(await bundleClient(out)))
await fs.writeFile(path.join(out, 'client.js'), files.get('client.js'))
const candidate = Object.fromEntries([...files].map(([name, body]) => [name, hash(body)]))
const changed = Object.keys(candidate).filter(name => candidate[name] !== previous.candidate[name]).sort()
const bound = async names => Object.fromEntries(await Promise.all(names.map(async name => [name, hash(await fs.readFile(path.join(root, name)))])))
const reviewInputs = await bound(['scripts/stage-executor-rows.mjs', 'scripts/build-client.mjs', 'test/taskflow-panel.test.js', 'test/plugin.test.mjs', 'test/harness-resolve.mjs', '.tmp-verify/executor-rows-runtime-loader.mjs'])
const sourcePatchInputs = await bound(['src/client/taskflow-dashboard.js', 'src/client/i18n.js', 'src/host/taskflow.js'])
await fs.writeFile(path.join(root, '.tmp-verify/executor-rows-manifest-1.json'), JSON.stringify({ version: pkg.version, baseline: previous.candidate, candidate, changed, reviewInputs, sourcePatchInputs,
  scope: 'Installed .42 plus existing per-room/stable-Bot executor grouping, all child task/history preservation, scoped member DTO and one translation; exact candidate bundle rebuilt. All native task channel and independent monitor files preserved.' }, null, 2))
console.log(JSON.stringify({ version: pkg.version, files: files.size, changed }))
