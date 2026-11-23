import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Knowledge } from '../src/host/taskflow/knowledge.js'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { contentDigest, readPublishedSkill, skillName } from '../src/host/taskflow/publication.js'

function methodDraft(library, room, ids) {
  const sources = ids.map(id => ({ id, step: '检查登录页面请求及错误日志', validation: '记录复核步骤并保留原始证据' }))
  const preview = library.proposeMethod(room, '登录页面排查', sources)
  return library.proposeMethod(room, '登录页面排查', sources, preview.digest)
}
function approvedSkill(library, room = 'group-a') {
  for (let i = 0; i < 10; i++) library.addInsight({ room, planId: `${room}-p${i}`, title: '登录页面排查', text: `检查登录页面请求及错误日志，记录复核步骤并保留原始证据 ${i}` })
  const draft = methodDraft(library, room, Array.from({length:10}, (_, i) => `${room}-p${i}`))
  // This fixture exercises pre-existing approved skills without method snapshots.
  library.db.prepare('DELETE FROM candidate_method_evidence WHERE candidate_id=?').run(draft.id)
  const text = '检查登录请求及错误日志，复核凭证有效性后再决定是否重试。'
  library.review(draft.id, { kind: 'bot', reviewer: 'leader', approved: true })
  library.review(draft.id, { kind: 'owner', reviewer: 'human-owner', approved: true, text })
  return library.consolidate(draft.id, text)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '.tmp-test')
mkdirSync(root, { recursive: true })

test('ten independent insights require preview confirmation to create a draft', () => {
  const dir = mkdtempSync(join(root, 'knowledge-'))
  const library = new Knowledge(join(dir, 'knowledge.sqlite'))
  try {
    for (let i = 0; i < 9; i++) {
      library.addInsight({ room: 'group-a', planId: `p${i}`, title: '登录页面排查', text: `检查登录页面请求及错误日志，记录复核步骤并保留原始证据 ${i}` })
    }
    assert.deepEqual(library.candidates('group-a'), [])
    library.addInsight({ room: 'group-b', planId: 'other', title: '登录页面排查', text: '检查登录页面请求及错误日志，记录复核步骤' })
    assert.deepEqual(library.candidates('group-a'), [])
    library.addInsight({ room: 'group-a', planId: 'p9', title: '登录页面排查', text: '检查登录页面请求及错误日志，记录复核步骤并保留原始证据 9' })
    assert.deepEqual(library.candidates('group-a'), [])
    methodDraft(library, 'group-a', Array.from({length:10}, (_, i) => `p${i}`))
    const drafts = library.candidates('group-a')
    assert.equal(drafts.length, 1)
    assert.equal(drafts[0].tier, 'normal')
    assert.equal(drafts[0].status, 'draft')
    assert.equal(new Set(drafts[0].sources).size, 10)
    library.addInsight({ room: 'group-a', planId: 'p9', title: '登录页面排查', text: '检查登录页面请求及错误日志，记录复核步骤并保留原始证据 9' })
    assert.equal(library.candidates('group-a').length, 1)
    assert.equal(library.candidates('group-b').length, 0)
  } finally {
    library.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('approved skills and insights are exported with honest provenance and survive reopen', () => {
  const dir = mkdtempSync(join(root, 'knowledge-export-'))
  let library = new Knowledge(join(dir, 'knowledge.sqlite'))
  try {
    const skill = approvedSkill(library)
    const file = library.skillPublication('group-a', 'normal', skill.id)
    assert.equal(existsSync(file.path), true)
    assert.match(readPublishedSkill(file), /检查登录请求/)
    assert.equal(file.metadata.sources.length, 10)
    const insight = library.insightPublication('group-a', 'group-a-p0')
    assert.match(readFileSync(insight.path, 'utf8'), /检查登录页面/)
    assert.equal(insight.provenance, 'missing')
    library.close()
    library = new Knowledge(join(dir, 'knowledge.sqlite'))
    assert.equal(library.skillPublication('group-a', 'normal', skill.id).digest, file.digest)
    assert.throws(() => library.skillPublication('group-b', 'premium', skill.id), /skill_not_accessible/)
  } finally { library.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('explicit publication shares only the approved body and revocation denies later access', () => {
  const dir = mkdtempSync(join(root, 'knowledge-shared-'))
  const library = new Knowledge(join(dir, 'knowledge.sqlite'))
  try {
    const skill = approvedSkill(library)
    assert.deepEqual(library.searchSkills('group-b', 'normal', '登录'), [])
    assert.throws(() => library.publishShared('group-a', skill.id, 'human-owner', 'wrong-digest'), /skill_changed/)
    library.publishShared('group-a', skill.id, 'human-owner', contentDigest(skill.text), library.sourcesDigest('group-a', skill.id))
    assert.equal(library.searchSkills('group-b', 'normal', '登录').length, 1)
    assert.match(library.openSkill('group-b', 'normal', skill.id).text, /复核凭证/)
    assert.match(library.skillPublication('group-b', 'normal', skill.id).path, /shared/)
    assert.throws(() => library.unpublishShared('group-b', skill.id), /skill_not_accessible/)
    library.unpublishShared('group-a', skill.id)
    assert.deepEqual(library.searchSkills('group-b', 'premium', '登录'), [])
    assert.throws(() => library.openSkill('group-b', 'premium', skill.id), /skill_not_accessible/)
    assert.equal(library.openSkill('group-a', 'normal', skill.id).id, skill.id)
  } finally { library.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('shared evidence remains bound after publication and old unbound grants require new approval', () => {
  const dir = mkdtempSync(join(root, 'knowledge-share-evidence-'))
  const path = join(dir, 'knowledge.sqlite')
  let library = new Knowledge(path)
  try {
    const skill = approvedSkill(library)
    const approvedSources = library.sourcesDigest('group-a', skill.id)
    const publication = library.publishShared('group-a', skill.id, 'human-owner', contentDigest(skill.text), approvedSources)
    assert.equal(JSON.parse(readFileSync(join(publication.directory, 'provenance.json'), 'utf8')).sourcesDigest, approvedSources)
    library.db.prepare('UPDATE insights SET acceptance=? WHERE plan_id=?').run('验收证据已变化', 'group-a-p0')
    assert.deepEqual(library.searchSkills('group-b', 'normal', '登录'), [])
    assert.throws(() => library.openSkill('group-b', 'normal', skill.id), /skill_not_accessible/)
    assert.equal(library.openSkill('group-a', 'normal', skill.id).shared, false)
    library.db.exec('ALTER TABLE skill_shares DROP COLUMN sources_hash')
    const reader = new Knowledge(path, { readOnly: true })
    try {
      assert.deepEqual(reader.searchSkills('group-b', 'normal', '登录'), [])
      assert.equal(reader.openSkill('group-a', 'normal', skill.id).id, skill.id)
      assert.equal(reader.db.prepare('PRAGMA table_info(skill_shares)').all().some(row => row.name === 'sources_hash'), false)
    } finally { reader.close() }
    library.close()
    library = new Knowledge(path)
    assert.deepEqual(library.searchSkills('group-b', 'normal', '登录'), [])
    library.publishShared('group-a', skill.id, 'human-owner', contentDigest(skill.text), library.sourcesDigest('group-a', skill.id))
    assert.equal(library.searchSkills('group-b', 'normal', '登录').length, 1)
  } finally { library.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('startup publication repair restores both group and shared skill files', () => {
  const dir = mkdtempSync(join(root, 'knowledge-repair-'))
  const library = new Knowledge(join(dir, 'knowledge.sqlite'))
  try {
    const skill = approvedSkill(library)
    const shared = library.publishShared('group-a', skill.id, 'human-owner', contentDigest(skill.text), library.sourcesDigest('group-a', skill.id))
    const oldRoot = library.root
    library.root = join(dir, 'restored-files')
    library.syncPublications()
    assert.equal(existsSync(shared.path.replace(oldRoot, library.root)), true)
    assert.equal(library.searchSkills('group-b', 'normal', '登录').length, 1)
  } finally { library.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('first publication preserves an unowned manual skill without creating a marker', () => {
  const dir = mkdtempSync(join(root, 'knowledge-unowned-'))
  const library = new Knowledge(join(dir, 'knowledge.sqlite'))
  try {
    const skill = approvedSkill(library)
    const directory = join(library.root, 'groups', contentDigest('group-a').slice(0, 24), 'skills', skillName(skill.id))
    mkdirSync(directory, { recursive: true })
    const file = join(directory, 'SKILL.md')
    const manual = '首次发布前已存在的人工技能正文。'
    writeFileSync(file, manual)
    assert.equal(existsSync(join(directory, '.publication.json')), false)
    assert.throws(() => library.skillPublication('group-a', 'normal', skill.id), /publication_conflict/)
    assert.throws(() => library.syncPublications(), /publication_conflict/)
    assert.equal(readFileSync(file, 'utf8'), manual)
    assert.equal(existsSync(join(directory, '.publication.json')), false)
    assert.equal(existsSync(join(directory, 'provenance.json')), false)
  } finally { library.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('exports preserve an existing manually edited skill instead of replacing it', () => {
  const dir = mkdtempSync(join(root, 'knowledge-conflict-'))
  const library = new Knowledge(join(dir, 'knowledge.sqlite'))
  try {
    const skill = approvedSkill(library)
    const publication = library.skillPublication('group-a', 'normal', skill.id)
    const manual = '用户保留的人工技能正文，不允许自动覆盖。'
    writeFileSync(publication.path, manual)
    assert.throws(() => library.skillPublication('group-a', 'normal', skill.id), /publication_conflict/)
    assert.equal(readFileSync(publication.path, 'utf8'), manual)
    assert.throws(() => library.syncPublications(), /publication_conflict/)
    assert.equal(readFileSync(publication.path, 'utf8'), manual)
  } finally { library.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('skill search and exact open enforce room and Bot level', () => {
  const dir = mkdtempSync(join(root, 'knowledge-'))
  const library = new Knowledge(join(dir, 'knowledge.sqlite'))
  try {
    for (let i = 0; i < 10; i++) library.addInsight({ room: 'group-a', planId: `p${i}`, title: '登录页面排查', text: `检查登录页面请求及错误日志，记录复核步骤并保留原始证据 ${i}` })
    const draft = methodDraft(library, 'group-a', Array.from({length:10}, (_, i) => `p${i}`))
    assert.deepEqual(library.searchSkills('group-a', 'normal', '登录'), [])
    library.review(draft.id, { kind: 'bot', reviewer: 'leader-a', approved: true })
    library.review(draft.id, { kind: 'owner', reviewer: 'user', approved: true, text: '检查登录页面请求与失败日志，归纳重试规则' })
    library.consolidate(draft.id, '检查登录页面请求与失败日志，归纳重试规则')
    assert.equal(library.searchSkills('group-a', 'normal', '登录').length, 1)
    assert.equal(library.openSkill('group-a', 'normal', draft.id).text.includes('归纳重试'), true)
    assert.deepEqual(library.searchSkills('group-b', 'premium', '登录'), [])
    assert.throws(() => library.openSkill('group-b', 'premium', draft.id), /skill_not_accessible/)
    // Synthetic tier change below models a legacy skill without method evidence.
    library.db.prepare('DELETE FROM candidate_method_evidence WHERE candidate_id=?').run(draft.id)
    library.db.prepare("UPDATE candidates SET tier='premium' WHERE id=?").run(draft.id)
    assert.deepEqual(library.searchSkills('group-a', 'excellent', '登录'), [])
    assert.throws(() => library.openSkill('group-a', 'excellent', draft.id), /skill_not_accessible/)
    assert.equal(library.searchSkills('group-a', 'premium', '登录').length, 1)
  } finally {
    library.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('draft requires both independent reviews and a later consolidation before approval', () => {
  const dir = mkdtempSync(join(root, 'knowledge-'))
  const library = new Knowledge(join(dir, 'knowledge.sqlite'))
  try {
    for (let i = 0; i < 10; i++) {
      library.addInsight({ room: 'group-a', planId: `p${i}`, title: '登录页面排查', text: `检查登录页面请求及错误日志，记录复核步骤并保留原始证据 ${i}` })
    }
    const draft = methodDraft(library, 'group-a', Array.from({length:10}, (_, i) => `p${i}`))
    assert.throws(() => library.consolidate(draft.id, '归纳后的登录页步骤'), /reviews_required/)
    library.review(draft.id, { kind: 'bot', reviewer: 'leader-a', approved: true })
    assert.throws(() => library.consolidate(draft.id, '归纳后的登录页步骤'), /reviews_required/)
    library.review(draft.id, { kind: 'owner', reviewer: 'user', approved: true, text: '归纳后的登录页步骤' })
    assert.throws(() => library.consolidate(draft.id, '未经人审的其他步骤'), /owner_text_mismatch/)
    const approved = library.consolidate(draft.id, '归纳后的登录页步骤')
    assert.equal(approved.status, 'approved')
    assert.equal(approved.text, '归纳后的登录页步骤')
    assert.equal(library.candidates('group-b').length, 0)
  } finally {
    library.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
