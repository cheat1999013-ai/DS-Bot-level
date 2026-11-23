// Preserve the exact runtime baseline and prior ordinary-reply repair; stage this board delta only.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const baseline = JSON.parse(await fs.readFile(path.join(root, '.tmp-verify/principal-view-candidate-principal2-manifest.json'), 'utf8'))
const source = path.join(root, '.tmp-verify/principal-native-candidate-3')
const target = path.join(root, '.tmp-verify/executor-flow-candidate-1')
const hash = data => createHash('sha256').update(data).digest('hex')
try { await fs.access(target); throw new Error('Candidate exists; refusing overwrite') } catch (error) { if (error.code !== 'ENOENT') throw error }
for (const [name, expected] of Object.entries(baseline.candidate)) {
  if (hash(await fs.readFile(path.join(source, name))) !== expected) throw new Error(`Earlier candidate changed: ${name}`)
}
await fs.cp(source, target, { recursive: true, errorOnExist: true, force: false })
const replace = (text, before, after) => {
  if (text.split(before).length !== 2) throw new Error(`Unexpected source seam: ${before}`)
  return text.replace(before, after)
}
let dashboard = (await fs.readFile(path.join(root, 'src/client/taskflow-dashboard.js'), 'utf8')).replaceAll('\r\n', '\n')
dashboard = replace(dashboard, 'export function TaskflowPage({ roomId, actions })', 'export function TaskflowPage({ roomId })')
dashboard = replace(dashboard, "    onSchedule: actions?.openSettings && scope !== 'all' && (!roomId || roomId === scope)\n      ? () => actions.openSettings('schedules', `group:${scope}`) : undefined,\n", '')
dashboard = replace(dashboard, 'onConfirm, onSchedule }) {', 'onConfirm }) {')
dashboard = replace(dashboard, "      onSchedule ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onSchedule }, t('New group task')) : null,\n", '')
await fs.writeFile(path.join(target, 'src/client/taskflow-dashboard.js'), dashboard)
let translations = (await fs.readFile(path.join(target, 'src/client/i18n.js'), 'utf8')).replaceAll('\r\n', '\n')
translations = replace(translations, "  'Event timeline': '事件时间线',", "  'Event timeline': '事件时间线',\n  'Task history': '任务历史',")
await fs.writeFile(path.join(target, 'src/client/i18n.js'), translations)
let host = (await fs.readFile(path.join(target, 'src/host/taskflow.js'), 'utf8')).replaceAll('\r\n', '\n')
for (const [before, after, count] of [
  ['{ id: item.id, name: item.name, planId:', '{ id: item.id, name: item.name, admin: state.member(item, item.admin)?.id ?? null, planId:', 2],
  ['{ id: room.id, name: room.name, adminName:', '{ id: room.id, name: room.name, admin: state.member(room, room.admin)?.id ?? null, adminName:', 2],
]) {
  if (host.split(before).length !== count + 1) throw new Error('Runtime host DTO seam differs')
  host = host.replaceAll(before, after)
}
await fs.writeFile(path.join(target, 'src/host/taskflow.js'), host)
const manifest = JSON.parse(await fs.readFile(path.join(target, 'package.json'), 'utf8'))
manifest.version = '0.3.26-taskflow.1'
await fs.writeFile(path.join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
const { bundleClient } = await import(pathToFileURL(path.join(target, 'scripts/build-client.mjs')).href)
await fs.writeFile(path.join(target, 'client.js'), await bundleClient())
const candidate = Object.fromEntries(await Promise.all(Object.keys(baseline.candidate).map(async name => [name, hash(await fs.readFile(path.join(target, name)))])))
const changed = Object.keys(baseline.baseline).filter(name => candidate[name] !== baseline.baseline[name]).sort()
const allowed = ['client.js', 'package.json', 'src/client/cells.js', 'src/client/index.js', 'src/client/surface.js', 'src/client/taskflow-dashboard.js', 'src/client/i18n.js', 'src/host/taskflow.js'].sort()
if (JSON.stringify(changed) !== JSON.stringify(allowed)) throw new Error('Unexpected runtime changes')
const receipt = { version: manifest.version, baselineVersion: baseline.baselineVersion, baseline: baseline.baseline, candidate, changed, added: baseline.added, scope: 'Prior principal reply repair retained. Board role filtering, task lifecycle grouping and four read-only administrator-ID DTO fields only. All other Host files, office, schedules, dependencies and user data preserved.' }
await fs.writeFile(path.join(root, '.tmp-verify/executor-flow-candidate-manifest.json'), JSON.stringify(receipt, null, 2))
console.log(JSON.stringify({ version: manifest.version, files: Object.keys(candidate).length, changed, added: baseline.added }))
