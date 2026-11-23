// Stage only the approved reward delta over the verified installed release.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const installed = process.env.DS_BOT_INSTALLED
if (!installed) throw new Error('Set DS_BOT_INSTALLED to the installed ds-bot folder')
const previous = JSON.parse(await fs.readFile(path.join(root, '.tmp-verify/executor-flow-candidate-manifest.json'), 'utf8'))
const target = path.join(root, '.tmp-verify/levels-candidate-1')
const hash = value => createHash('sha256').update(value).digest('hex')
await fs.mkdir(target) // Refuse to overwrite an existing candidate.
for (const [name, expected] of Object.entries(previous.candidate)) {
  const body = await fs.readFile(path.join(installed, name))
  if (hash(body) !== expected) throw Error(`Installed baseline drift: ${name}`)
  await fs.mkdir(path.dirname(path.join(target, name)), { recursive: true })
  await fs.writeFile(path.join(target, name), body)
}
const read = (base, name) => fs.readFile(path.join(base, name), 'utf8').then(text => text.replaceAll('\r\n', '\n'))
const replace = (text, before, after) => {
  if (text.split(before).length !== 2) throw Error(`Unexpected source seam: ${before.slice(0, 90)}`)
  return text.replace(before, after)
}
const section = (text, first, next) => {
  const start = text.indexOf(first), end = text.indexOf(next, start + first.length)
  if (start < 0 || end < 0) throw Error(`Missing section: ${first}`)
  return text.slice(start, end)
}
let scheduler = await read(target, 'src/host/taskflow/scheduler.js')
const source = await read(root, 'src/host/taskflow/scheduler.js')
scheduler = replace(scheduler, '  room TEXT NOT NULL, plan_id TEXT NOT NULL, bot_id TEXT NOT NULL, at REAL NOT NULL,\n', '  room TEXT NOT NULL, plan_id TEXT NOT NULL, bot_id TEXT NOT NULL, at REAL NOT NULL,\n  points INTEGER NOT NULL DEFAULT 10,\n')
scheduler = replace(scheduler, '    this.db.exec(SCHEMA)\n', '    this.db.exec(SCHEMA)\n' + section(source, '    // Historical rewards keep', '    this.preflightAvailable = true'))
scheduler = replace(scheduler, "      this.db.prepare('INSERT OR IGNORE INTO bot_rewards(room,plan_id,bot_id,at) VALUES(?,?,?,?)')\n        .run(plan.room, planId, card.member, this.clock())\n", '')
for (const [first, next] of [['  botLevel(room, botId)', '  // ---- v2:'], ['  finishPlan(planId,', '  requestCancel(planId,']]) {
  scheduler = replace(scheduler, section(scheduler, first, next), section(source, first, next))
}
await fs.writeFile(path.join(target, 'src/host/taskflow/scheduler.js'), scheduler)
let tools = await read(target, 'src/host/taskflow/tools.js')
const sourceTools = await read(root, 'src/host/taskflow/tools.js')
const toolDescription = text => text.split('\n').find(line => line.includes("description: '查看当前群自身的"))
tools = replace(tools, toolDescription(tools), toolDescription(sourceTools))
await fs.writeFile(path.join(target, 'src/host/taskflow/tools.js'), tools)
const guideName = 'src/host/skills/taskflow/SKILL.md'
let guide = await read(target, guideName)
const guideSource = await read(root, guideName)
const oldPrefix = guide.split('\n').find(line => line.startsWith('成功验收的任务')).split('十条')[0]
const newPrefix = guideSource.split('\n').find(line => line.startsWith('整个计划成功完成')).split('十条')[0]
await fs.writeFile(path.join(target, guideName), replace(guide, oldPrefix, newPrefix))
const dashboardName = 'src/client/taskflow-dashboard.js'
let dashboard = await read(target, dashboardName)
const sourceDashboard = await read(root, dashboardName)
await fs.writeFile(path.join(target, dashboardName), replace(dashboard, section(dashboard, 'function BotLevel(', 'function Capabilities('), section(sourceDashboard, 'function BotLevel(', 'function Capabilities(')))
let translations = await read(target, 'src/client/i18n.js')
const sourceTranslations = await read(root, 'src/client/i18n.js')
const oldTranslation = translations.split('\n').find(line => line.includes("'{count} accepted plans in this group"))
const newTranslation = sourceTranslations.split('\n').find(line => line.includes("'{count} credited plans in this group"))
await fs.writeFile(path.join(target, 'src/client/i18n.js'), replace(translations, oldTranslation, newTranslation))
const pkg = JSON.parse(await fs.readFile(path.join(target, 'package.json'), 'utf8'))
pkg.version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version
await fs.writeFile(path.join(target, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
const { bundleClient } = await import(pathToFileURL(path.join(target, 'scripts/build-client.mjs')).href)
await fs.writeFile(path.join(target, 'client.js'), await bundleClient())
const candidate = Object.fromEntries(await Promise.all(Object.keys(previous.candidate).map(async name => [name, hash(await fs.readFile(path.join(target, name)))])))
const changed = Object.keys(candidate).filter(name => candidate[name] !== previous.candidate[name]).sort()
const allowed = ['package.json', 'client.js', 'src/client/i18n.js', dashboardName, guideName, 'src/host/taskflow/scheduler.js', 'src/host/taskflow/tools.js'].sort()
if (JSON.stringify(changed) !== JSON.stringify(allowed)) throw Error('Unexpected candidate scope')
const manifest = { version: pkg.version, baselineVersion: '0.3.26-taskflow.1', baseline: previous.candidate, candidate, changed,
  scope: 'Reward delta only. Previous reply/board fixes and remaining runtime files retained; real group reply visibility remains unresolved. No profile or live database write.' }
await fs.writeFile(path.join(root, '.tmp-verify/levels-candidate-manifest.json'), JSON.stringify(manifest, null, 2))
console.log(JSON.stringify({ version: pkg.version, files: Object.keys(candidate).length, changed }))
