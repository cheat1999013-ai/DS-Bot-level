import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { bundleClient } from './build-client.mjs'
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const installed = process.env.DS_BOT_INSTALLED
if (!installed) throw new Error('Set DS_BOT_INSTALLED to the installed ds-bot folder')
const previous = JSON.parse(await fs.readFile(path.join(root, '.tmp-verify/executor-rails-manifest-1.json'), 'utf8'))
const out = path.join(root, '.tmp-verify/timeline-reference-candidate-1')
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
let dashboard = (await fs.readFile(path.join(root, 'src/client/taskflow-dashboard.js'), 'utf8')).replaceAll('\r\n', '\n')
// Preserve the exact grouped panel; do not publish the separate workspace-only schedule entry.
dashboard = replace(dashboard, 'export function TaskflowPage({ roomId, actions })', 'export function TaskflowPage({ roomId })')
dashboard = replace(dashboard, "    onSchedule: actions?.openSettings && scope !== 'all' && (!roomId || roomId === scope)\n      ? () => actions.openSettings('schedules', `group:${scope}`) : undefined,\n", '')
dashboard = replace(dashboard, 'onRefresh = () => {}, onConfirm, onSchedule, onLoadOlder })', 'onRefresh = () => {}, onConfirm, onLoadOlder })')
dashboard = replace(dashboard, "      onSchedule ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onSchedule }, t('New group task')) : null,\n", '')
files.set('src/client/taskflow-dashboard.js', Buffer.from(dashboard))
// Transplant only the reviewed view and scheduler projection from the donor.
for (const [name, start, end] of [
  ['src/host/taskflow.js', '  rt.taskflowView = async ', '  rt.taskflowRecordProgress = '],
  ['src/host/taskflow/scheduler.js', '  timeline(rooms, limit = 120) {', '  // ---- room pointer'],
]) {
  const donor = (await fs.readFile(path.join(root, name), 'utf8')).replaceAll('\r\n', '\n')
  const base = files.get(name).toString('utf8').replaceAll('\r\n', '\n')
  const section = text => {
    const first = text.indexOf(start), last = text.indexOf(end, first)
    if (first < 0 || last < 0 || text.indexOf(start, first + 1) !== -1) throw Error(`Ambiguous projection seam: ${name}`)
    return text.slice(first, last)
  }
  let replacement = section(donor)
  if (name === 'src/host/taskflow/scheduler.js') {
    const extra = donor.indexOf('  timelinePlanIds(rooms) {')
    const startOfTimeline = donor.indexOf(start)
    if (extra < 0 || extra >= startOfTimeline) throw Error('Missing timeline plan ID seam')
    replacement = donor.slice(extra, startOfTimeline) + replacement
  }
  files.set(name, Buffer.from(replace(base, section(base), replacement)))
}
const pkg = JSON.parse(files.get('package.json'))
pkg.version = '0.3.45-visible-timeline.1'
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
const reviewInputs = await bound(['scripts/stage-timeline-reference.mjs', 'scripts/build-client.mjs', 'test/taskflow-panel.test.js', 'test/taskflow-group-activity.test.js', 'test/scheduler.test.mjs', 'test/harness-resolve.mjs', '.tmp-verify/timeline-reference-runtime-loader.mjs', '.tmp-verify/build-timeline-reference-preview.mjs', '.tmp-verify/timeline-reference-preview-entry.mjs', '.tmp-verify/timeline-reference-preview-electron.cjs', '.tmp-verify/timeline-geometry-preview-electron.cjs'])
const sourcePatchInputs = await bound(['src/client/taskflow-dashboard.js', 'src/host/taskflow.js', 'src/host/taskflow/scheduler.js'])
await fs.writeFile(path.join(root, '.tmp-verify/timeline-reference-manifest-1.json'), JSON.stringify({ version: pkg.version, baseline: previous.candidate, candidate, changed, reviewInputs, sourcePatchInputs,
  scope: 'Installed .44 plus visible task timeline, scoped multi-plan projections and cursor pagination. Native transport and monitor remain unchanged.' }, null, 2))
console.log(JSON.stringify({ version: pkg.version, files: files.size, changed }))
