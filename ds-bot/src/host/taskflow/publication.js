import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync, lstatSync, realpathSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const contentDigest = text => createHash('sha256').update(text, 'utf8').digest('hex')
export const skillName = id => `taskflow-${contentDigest(id).slice(0, 24)}`
const groupKey = room => contentDigest(room).slice(0, 24)
const write = (file, text, readOnly) => {
  try { if (readFileSync(file, 'utf8') === text) return } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (readOnly) throw new Error('read_only_publication_unavailable')
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, text, 'utf8')
  renameSync(temporary, file)
}

const managedWrite = (directory, files, readOnly) => {
  const marker = join(directory, '.publication.json')
  let owner
  try { owner = JSON.parse(readFileSync(marker, 'utf8')) } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('publication_conflict', { cause: error })
  }
  if (owner && owner.generator !== 'ds-bot-taskflow') throw new Error('publication_conflict')
  for (const [name, text] of Object.entries(files)) {
    let current
    try { current = readFileSync(join(directory, name), 'utf8') } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (current !== undefined && current !== text && owner?.files?.[name] !== contentDigest(current)) {
      throw new Error('publication_conflict')
    }
  }
  for (const [name, text] of Object.entries(files)) write(join(directory, name), text, readOnly)
  write(marker, JSON.stringify({ generator: 'ds-bot-taskflow', files: Object.fromEntries(
    Object.entries(files).map(([name, text]) => [name, contentDigest(text)])) }, null, 2) + '\n', readOnly)
}

export function publishInsight(root, insight, sources, { readOnly = false } = {}) {
  const directory = join(root, 'groups', groupKey(insight.room), 'insights', contentDigest(insight.planId).slice(0, 24))
  const body = `# ${insight.title}\n\n${insight.text}\n`
  managedWrite(directory, { 'INSIGHT.md': body,
    'sources.json': JSON.stringify({ planId: insight.planId, room: insight.room,
      provenance: sources.length ? 'preserved' : 'missing', sources }, null, 2) + '\n' }, readOnly)
  return { path: join(directory, 'INSIGHT.md'), digest: contentDigest(body), provenance: sources.length ? 'preserved' : 'missing' }
}

export function publishSkill(root, row, sources, shared = false, { readOnly = false, sourcesDigest, methodEvidence } = {}) {
  const name = skillName(row.id)
  const directory = shared ? join(root, 'shared', 'skills', name) : join(root, 'groups', groupKey(row.room), 'skills', name)
  const content = `# ${row.title}\n\n${row.text}\n`
  const metadata = { id: row.id, tier: row.tier, shared, contentDigest: contentDigest(row.text),
    ...(!shared ? { room: row.room, sources } : {}),
    tags: row.tags ?? [], lifecycle: row.lifecycle ?? 'active', score: row.score ?? null, scoringExempt: row.scoringExempt ?? false,
    ...(sourcesDigest ? { sourcesDigest } : {}), ...(!shared && methodEvidence?.length ? { methodEvidence } : {}) }
  const front = `---\nname: ${name}\ndescription: ${JSON.stringify(row.title)}\ntags: ${JSON.stringify(row.tags ?? [])}\nlifecycle: ${row.lifecycle ?? 'active'}\nscore: ${row.score ?? 'null'}\nscoring_exempt: ${row.scoringExempt ?? false}\n---\n`
  const path = join(directory, 'SKILL.md')
  managedWrite(directory, { 'SKILL.md': front + content,
    'provenance.json': JSON.stringify(metadata, null, 2) + '\n' }, readOnly)
  return { name, path, content, digest: contentDigest(front + content), directory, metadata }
}

export function readPublishedSkill(publication) {
  const raw = readFileSync(publication.path, 'utf8')
  if (contentDigest(raw) !== publication.digest) throw new Error('skill_file_changed')
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
}

// Only retire files with this generator's intact ownership marker. Never recurse.
export function removeSkillPublications(root, row) {
  const name = skillName(row.id)
  const directories = [join(root, 'groups', groupKey(row.room), 'skills', name), join(root, 'shared', 'skills', name)]
  const batches = []
  for (const directory of directories) {
    let current = directory
    const segments = []
    while (true) {
      segments.push(current)
      if (resolve(current) === resolve(root)) break
      const parent = dirname(current)
      if (parent === current) throw new Error('publication_conflict')
      current = parent
    }
    let missing = false
    for (const segment of segments.reverse()) {
      const info = lstatSync(segment, { throwIfNoEntry: false })
      if (!info) { missing = true; break }
      const actual = realpathSync.native(segment)
      const equal = process.platform === 'win32' ? actual.toLowerCase() === resolve(segment).toLowerCase() : actual === resolve(segment)
      if (!info.isDirectory() || info.isSymbolicLink() || !equal) throw new Error('publication_conflict')
    }
    if (missing) continue
    const marker = join(directory, '.publication.json')
    const markerInfo = lstatSync(marker, { throwIfNoEntry: false })
    if (!markerInfo?.isFile() || markerInfo.isSymbolicLink()) throw new Error('publication_conflict')
    let owner
    try { owner = JSON.parse(readFileSync(marker, 'utf8')) } catch { throw new Error('publication_conflict') }
    const owned = ['SKILL.md', 'provenance.json']
    if (owner.generator !== 'ds-bot-taskflow' || !owner.files || Object.keys(owner.files).length !== 2
      || readdirSync(directory).some(file => ![...owned, '.publication.json'].includes(file))) throw new Error('publication_conflict')
    const files = []
    for (const file of owned) {
      const path = join(directory, file)
      const info = lstatSync(path, { throwIfNoEntry: false })
      if (!info) continue
      if (!info.isFile() || info.isSymbolicLink() || owner.files[file] !== contentDigest(readFileSync(path, 'utf8'))) throw new Error('publication_conflict')
      files.push(path)
    }
    batches.push({ directory, marker, files })
  }
  for (const batch of batches) {
    for (const file of batch.files) unlinkSync(file)
    unlinkSync(batch.marker)
    rmdirSync(batch.directory)
  }
}
