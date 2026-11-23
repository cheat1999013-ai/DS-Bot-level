import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const out = path.join(root, '.tmp-verify/readiness-candidate-1')
const installed = process.env.DS_BOT_INSTALLED
if (!installed) throw new Error('Set DS_BOT_INSTALLED to the installed ds-bot folder')
const prior = JSON.parse(await fs.readFile(path.join(root, '.tmp-verify/group-controls-candidate-manifest.json'), 'utf8'))
const hash = body => createHash('sha256').update(body).digest('hex')
const bodies = new Map()
for (const [name, expected] of Object.entries(prior.candidate)) {
  const body = await fs.readFile(path.join(installed, name))
  if (hash(body) !== expected) throw Error(`Installed baseline changed: ${name}`)
  bodies.set(name, body)
}
bodies.set('src/host/skill-index.js', await fs.readFile(path.join(root, 'src/host/skill-index.js')))
const pkg = JSON.parse(bodies.get('package.json'))
pkg.version = '0.3.29-group-controls.2'
bodies.set('package.json', Buffer.from(JSON.stringify(pkg, null, 2) + '\n'))
await fs.mkdir(out, { recursive: true })
for (const [name, body] of bodies) {
  await fs.mkdir(path.dirname(path.join(out, name)), { recursive: true })
  await fs.writeFile(path.join(out, name), body)
}
const candidate = Object.fromEntries([...bodies].map(([name, body]) => [name, hash(body)]))
const manifest = {version:pkg.version,baseline:prior.candidate,candidate,changed:Object.keys(candidate).filter(name=>candidate[name]!==prior.candidate[name])}
await fs.writeFile(path.join(root, '.tmp-verify/readiness-candidate-manifest.json'), JSON.stringify(manifest, null, 2))
console.log(JSON.stringify({version:pkg.version,files:bodies.size,changed:manifest.changed}))
