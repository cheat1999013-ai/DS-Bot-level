import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const installed = process.env.DS_BOT_INSTALLED
if (!installed) throw new Error('Set DS_BOT_INSTALLED to the installed ds-bot folder')
const prior = JSON.parse(await fs.readFile(path.join(root, '.tmp-verify/task-only-manifest-1.json'), 'utf8'))
const out = path.join(root, '.tmp-verify/followthrough-candidate-1')
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
const swap = async (name, transform) => bodies.set(name, Buffer.from(transform(bodies.get(name).toString('utf8').replaceAll('\r\n', '\n'), await source(name))))
await swap('src/host/groups.js', (base, current) => replace(base,
  section(base, 'const unseenLines =', '\n// A notice keeps'),
  section(current, 'const unseenLines =', '\n// A notice keeps')))
await swap('src/host/turns.js', (base, current) => replace(base,
  section(base, '        if (taskPending?.exhausted', '        const replyText ='),
  section(current, '        if (taskPending?.exhausted', '        const replyText =')))
await swap('src/host/taskflow/continuation.js', (base, current) => replace(base,
  section(base, '      return { key, ...budget', '        text:'),
  section(current, '      return { key, ...budget', '        text:')))
await swap('src/host/taskflow.js', (base, current) => {
  base = replace(base, '  rt.taskflowTransferPrincipal =', section(current, '  rt.taskflowEscalate =', '  rt.taskflowDispatchScheduled =') + '  rt.taskflowTransferPrincipal =')
  const before = "          for (const card of plan.cards.filter(card => card.state === 'unknown'))"
  return replace(base, before, section(current, "          for (const card of plan.cards.filter(card => card.state === 'running'", before) + before)
})
await swap('src/host/taskflow/recovery.js', (base, current) => {
  base = replace(base, '  const valid =', section(current, '  const exhausted =', '  const valid =') + '  const valid =')
  base = replace(base, "      : kind === 'pending'", "      : kind === 'exhausted' ? exhausted(scheduler, plan, card)\n      : kind === 'pending'")
  base = replace(base, "kind === 'unknown' ? 'recovery_attention' : 'dispatch_attention'", "kind === 'pending' ? 'dispatch_attention' : 'recovery_attention'")
  return replace(base, section(base, '      const text =', '      const scope ='), section(current, '      const text =', '      const scope ='))
})
const pkg = JSON.parse(bodies.get('package.json'))
pkg.version = '0.3.40-task-followthrough.1'
bodies.set('package.json', Buffer.from(JSON.stringify(pkg, null, 2) + '\n'))
const candidate = Object.fromEntries([...bodies].map(([name, body]) => [name, hash(body)]))
const changed = Object.keys(candidate).filter(name => candidate[name] !== prior.candidate[name]).sort()
const expected = ['package.json', 'src/host/groups.js', 'src/host/taskflow.js', 'src/host/taskflow/continuation.js', 'src/host/taskflow/recovery.js', 'src/host/turns.js']
if (JSON.stringify(changed) !== JSON.stringify(expected)) throw Error(JSON.stringify(changed))
for (const [name, body] of bodies) {
  await fs.mkdir(path.dirname(path.join(out, name)), { recursive: true })
  await fs.writeFile(path.join(out, name), body)
}
const bind = async names => Object.fromEntries(await Promise.all(names.map(async name => [name, hash(await fs.readFile(path.join(root, name)))])))
const reviewInputs = await bind(['test/group-work.test.js', 'test/taskflow-continuation.test.mjs', 'test/taskflow-exhaustion.test.mjs', 'test/harness-resolve.mjs', 'scripts/stage-task-followthrough.mjs', '.tmp-verify/followthrough-runtime-loader.mjs'])
const sourcePatchInputs = await bind(expected.filter(name => name !== 'package.json'))
await fs.writeFile(path.join(root, '.tmp-verify/followthrough-manifest-1.json'), JSON.stringify({ version: pkg.version, baseline: prior.candidate, candidate, changed, reviewInputs, sourcePatchInputs,
  scope: 'Installed .39 baseline plus ledger-backed exhaustion escalation and explicit self-recovery prompt visibility. No unrelated client, Host or data changes.' }, null, 2))
console.log(JSON.stringify({ version: pkg.version, files: bodies.size, changed }))
