// Stage a client-only repair on the exact installed source baseline. Never writes the runtime.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const [runtimeArg, targetArg] = process.argv.slice(2)
if (!runtimeArg || !targetArg) throw new Error('Usage: node scripts/stage-principal-view.mjs <installed-package> <new-candidate-directory>')
const runtime = path.resolve(runtimeArg), target = path.resolve(targetArg)
if (target === runtime || target.startsWith(runtime + path.sep) || !target.startsWith(project + path.sep)) throw new Error('Candidate must be a separate directory inside this project')
try { await fs.access(target); throw new Error('Candidate already exists; refusing replacement') } catch (e) { if (e.code !== 'ENOENT') throw e }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
async function tree(root, prefix = '') {
  const files = []
  for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name)
    if (entry.isDirectory()) files.push(...await tree(root, relative))
    else if (entry.isFile()) files.push(relative)
    else throw new Error(`Unexpected non-file in package source: ${relative}`)
  }
  return files.sort()
}
const manifest = JSON.parse(await fs.readFile(path.join(runtime, 'package.json'), 'utf8'))
if (manifest.name !== 'ds-bot') throw new Error('Not a DS Bot package')
const published = new Set(['package.json', 'src/'])
for (const item of manifest.files ?? []) published.add(item)
const originals = new Map()
for (const item of published) {
  const relative = item.replace(/\/$/, '')
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..') || relative.split(/[\\/]/).includes('node_modules')) throw new Error('Unsafe package file list')
  const original = path.join(runtime, relative)
  const stat = await fs.stat(original)
  for (const file of stat.isDirectory() ? (await tree(original)).map(file => path.posix.join(relative, file)) : [relative]) {
    if (!originals.has(file)) originals.set(file, digest(await fs.readFile(path.join(runtime, file))))
  }
}
await fs.mkdir(target, { recursive: true })
for (const file of originals.keys()) {
  await fs.mkdir(path.dirname(path.join(target, file)), { recursive: true })
  await fs.copyFile(path.join(runtime, file), path.join(target, file))
}
const readSource = async relative => (await fs.readFile(path.join(project, 'src', relative), 'utf8')).replaceAll('\r\n', '\n')
const readStage = async relative => (await fs.readFile(path.join(target, 'src', relative), 'utf8')).replaceAll('\r\n', '\n')
function functionBody(text, name) {
  const start = text.indexOf(name)
  const end = text.indexOf('\n}\n', start)
  if (start < 0 || end < start) throw new Error(`Source function not found: ${name}`)
  return text.slice(start, end + 2)
}
const sourceCells = await readSource('client/cells.js')
let cells = await readStage('client/cells.js')
if (!cells.includes('relayRange') || !cells.includes('const settledRows = new Map()')) throw new Error('Runtime does not have the expected ledger group client')
const oldReplies = functionBody(cells, 'function GroupReplies(')
cells = cells.replace(oldReplies, functionBody(sourceCells, 'export function GroupRelayToolView(') + '\n\n' + functionBody(sourceCells, 'function GroupReplies('))
await fs.writeFile(path.join(target, 'src/client/cells.js'), cells)
let surface = await readStage('client/surface.js')
surface = surface.replace('export function readMode(', functionBody(await readSource('client/surface.js'), 'export function installGroupToolView(') + '\n\nexport function readMode(')
await fs.writeFile(path.join(target, 'src/client/surface.js'), surface)
let index = await readStage('client/index.js')
for (const [before, after] of [
  ["ToolCell } from './cells.js'", "ToolCell, GroupRelayToolView } from './cells.js'"],
  ['freePriority, groupsFor, readMode', 'freePriority, groupsFor, installGroupToolView, readMode'],
  ['  const BOT_PRIORITY = -100', "  const BOT_PRIORITY = -100\n  ctx.effect(() => installGroupToolView(ctx.slots, { surface, face, component: GroupRelayToolView, priority: BOT_PRIORITY }), 'ds-bot: native group reply view')"],
]) {
  if (index.split(before).length !== 2) throw new Error(`Runtime registration seam differs: ${before}`)
  index = index.replace(before, after)
}
await fs.writeFile(path.join(target, 'src/client/index.js'), index)
const version = '0.3.26-principal.1'
manifest.version = version
manifest.files = [...new Set([...manifest.files, 'src/client/', 'scripts/build-client.mjs'])]
await fs.writeFile(path.join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
await fs.mkdir(path.join(target, 'scripts'), { recursive: true })
await fs.copyFile(path.join(project, 'scripts/build-client.mjs'), path.join(target, 'scripts/build-client.mjs'))
const { bundleClient } = await import(pathToFileURL(path.join(target, 'scripts/build-client.mjs')).href)
await fs.writeFile(path.join(target, 'client.js'), await bundleClient())
const allowed = new Set(['package.json', 'client.js', 'src/client/cells.js', 'src/client/surface.js', 'src/client/index.js'])
const changed = []
for (const [file, expected] of originals) {
  if (digest(await fs.readFile(path.join(runtime, file))) !== expected) throw new Error(`Runtime package changed during staging: ${file}`)
  if (digest(await fs.readFile(path.join(target, file))) !== expected) {
    changed.push(file)
    if (!allowed.has(file)) throw new Error(`Unexpected package change: ${file}`)
  }
}
if (changed.length !== allowed.size) throw new Error('The candidate repair did not change every expected artifact')
const candidateFiles = await tree(target)
const evidence = { scope: 'Client-only candidate copied from the installed public package; no user data or runtime write', version, baselineVersion: JSON.parse(await fs.readFile(path.join(runtime, 'package.json'), 'utf8')).version,
  baselineCount: originals.size, changed: changed.sort(), added: candidateFiles.filter(file => !originals.has(file)),
  baseline: Object.fromEntries(originals), candidate: Object.fromEntries(await Promise.all(candidateFiles.map(async file => [file, digest(await fs.readFile(path.join(target, file)))]))) }
await fs.writeFile(path.join(target, '..', 'principal-view-candidate-manifest.json'), JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify({ version, baselineCount: originals.size, changed: evidence.changed, added: evidence.added, hostUnchanged: changed.every(file => !file.startsWith('src/host/')) }))
