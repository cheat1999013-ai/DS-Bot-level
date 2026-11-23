import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { bundleClient } from './build-client.mjs'
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const installed = process.env.DS_BOT_INSTALLED
if (!installed) throw new Error('Set DS_BOT_INSTALLED to the installed ds-bot folder')
const previous = JSON.parse(await fs.readFile(path.join(root, '.tmp-verify/timeline-reference-manifest-1.json'), 'utf8'))
const out = path.join(root, '.tmp-verify/taskflow-readable-candidate')
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
dashboard = replace(dashboard, 'export function TaskflowPage({ roomId, actions })', 'export function TaskflowPage({ roomId })')
dashboard = replace(dashboard, "    onSchedule: actions?.openSettings && scope !== 'all' && (!roomId || roomId === scope)\n      ? () => actions.openSettings('schedules', `group:${scope}`) : undefined,\n", '')
dashboard = replace(dashboard, 'onRefresh = () => {}, onConfirm, onSchedule, onLoadOlder })', 'onRefresh = () => {}, onConfirm, onLoadOlder })')
dashboard = replace(dashboard, "      onSchedule ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onSchedule }, t('New group task')) : null,\n", '')
files.set('src/client/taskflow-dashboard.js', Buffer.from(dashboard))
let i18n = files.get('src/client/i18n.js').toString('utf8')
i18n = replace(i18n, "  'Group assignment': '群内派工',", "  'Group assignment': '群内派工',\n  'Observed group messages': '群消息观察记录',")
files.set('src/client/i18n.js', Buffer.from(i18n))
const pkg = JSON.parse(files.get('package.json'))
pkg.version = '0.3.46-readable-tasks.1'
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
const reviewInputs = await bound(['scripts/stage-taskflow-readable.mjs', 'scripts/build-client.mjs', 'test/taskflow-panel.test.js', 'test/harness-resolve.mjs'])
const sourcePatchInputs = await bound(['src/client/taskflow-dashboard.js'])
await fs.writeFile(path.join(root, '.tmp-verify/taskflow-readable-manifest.json'), JSON.stringify({ version: pkg.version, baseline: previous.candidate, candidate, changed, reviewInputs, sourcePatchInputs }, null, 2))
console.log(JSON.stringify({ version: pkg.version, files: files.size, changed }))
