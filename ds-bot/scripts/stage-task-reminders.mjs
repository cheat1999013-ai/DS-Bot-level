import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const installed = process.env.DS_BOT_INSTALLED
if (!installed) throw new Error('Set DS_BOT_INSTALLED to the installed ds-bot folder')
const prior = JSON.parse(await fs.readFile(path.join(root, '.tmp-verify/followthrough-manifest-1.json'), 'utf8'))
const out = path.join(root, '.tmp-verify/reminders-candidate-1')
const hash = body => createHash('sha256').update(body).digest('hex')
const bodies = new Map()
for (const [name, expected] of Object.entries(prior.candidate)) {
  const body = await fs.readFile(path.join(installed, name))
  if (hash(body) !== expected) throw Error(`Installed drift: ${name}`)
  bodies.set(name, body)
}
const source = async name => (await fs.readFile(path.join(root, name), 'utf8')).replaceAll('\r\n', '\n')
const replace = (body, before, after) => {
  if (body.split(before).length !== 2) throw Error(`Ambiguous seam: ${before.slice(0, 80)}`)
  return body.replace(before, after)
}
const section = (body, start, end) => {
  if (body.split(start).length !== 2 || body.split(end).length !== 2) throw Error(`Section changed: ${start}`)
  return body.slice(body.indexOf(start), body.indexOf(end, body.indexOf(start)))
}
const recovery = 'src/host/taskflow/recovery.js'
if (prior.sourcePatchInputs[recovery] !== prior.candidate[recovery]) throw Error('Recovery donor baseline differs from shipped baseline')
bodies.set(recovery, Buffer.from(await source(recovery)))
const name = 'src/host/taskflow.js', donor = await source(name)
let host = bodies.get(name).toString('utf8').replaceAll('\r\n', '\n')
const guard = "          if (taskflow && !room.members.includes(taskflow.member))"
host = replace(host, guard, section(donor, "          if (taskflowEvent?.recovery?.kind === 'reminder'", guard) + guard)
const tail = "        }\n      }\n      for (const cycle of knowledge.lifecycle.due())"
host = replace(host, tail, section(donor, '          const reminderCard =', tail) + tail)
bodies.set(name, Buffer.from(host))
const pkg = JSON.parse(bodies.get('package.json'))
pkg.version = '0.3.41-task-reminders.1'
bodies.set('package.json', Buffer.from(JSON.stringify(pkg, null, 2) + '\n'))
const candidate = Object.fromEntries([...bodies].map(([file, body]) => [file, hash(body)]))
const changed = Object.keys(candidate).filter(file => candidate[file] !== prior.candidate[file]).sort()
if (JSON.stringify(changed) !== JSON.stringify(['package.json', 'src/host/taskflow.js', recovery])) throw Error(JSON.stringify(changed))
for (const [file, body] of bodies) {
  await fs.mkdir(path.dirname(path.join(out, file)), { recursive: true })
  await fs.writeFile(path.join(out, file), body)
}
const bind = async names => Object.fromEntries(await Promise.all(names.map(async file => [file, hash(await fs.readFile(path.join(root, file)))])))
const reviewInputs = await bind(['test/group-work.test.js', 'test/taskflow-reminders.test.mjs', 'test/taskflow-exhaustion.test.mjs', 'test/taskflow-continuation.test.mjs', 'test/harness-resolve.mjs', 'scripts/stage-task-reminders.mjs', '.tmp-verify/reminders-runtime-loader.mjs'])
const sourcePatchInputs = await bind([name, recovery])
await fs.writeFile(path.join(root, '.tmp-verify/reminders-manifest-1.json'), JSON.stringify({ version: pkg.version, baseline: prior.candidate, candidate, changed, reviewInputs, sourcePatchInputs,
  scope: 'Installed .40 baseline plus five-minute periodic unfinished-plan reminders to the current principal. Preserve task-only executor submissions, runtime fork, approvals, dependencies and completed/cancelled silence.' }, null, 2))
console.log(JSON.stringify({ version: pkg.version, files: bodies.size, changed }))
