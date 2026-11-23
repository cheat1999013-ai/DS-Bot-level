import assert from 'node:assert/strict'
import test from 'node:test'
import { Knowledge } from '../src/host/taskflow/knowledge.js'
import { createHash } from 'node:crypto'
import { buildToolDefinitions } from '../src/host/taskflow/tools.js'
import { fixture } from './taskflow-fixture.mjs'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../.tmp-test/', import.meta.url))
mkdirSync(root, { recursive: true })
test('similar insights remain unclaimed until a method preview is confirmed', () => {
  const dir = mkdtempSync(join(root, 'method-legacy-'))
  const library = new Knowledge(join(dir, 'knowledge.sqlite'))
  try {
    for (let i = 0; i < 10; i++) library.addInsight({ room:'group-a', planId:`p${i}`,
      title:'排查登录请求方法', text:`检查登录页面请求及错误日志，记录完整复核步骤 ${i}` })
    assert.deepEqual(library.candidates('group-a'), [])
    assert.equal(library.promote('group-a', 'normal'), null)
    assert.deepEqual(library.candidates('group-a'), [])
  } finally { library.close(); rmSync(dir, { recursive:true, force:true }) }
})

test('principal can propose a method from ten distinct evidenced insights in the same room', () => {
  const dir = mkdtempSync(join(root, 'method-proposal-'))
  const library = new Knowledge(join(dir, 'knowledge.sqlite'))
  try {
    const sources = []
    for (let i = 0; i < 10; i++) {
      const planId = `plan-${i}`
      const step = `先建立基线后逐项修订案例${i}`
      const validation = `核对diff与块外一致案例${i}`
      const noise = createHash('sha256').update(String(i)).digest('hex')
      library.addInsight({ room:'group-a', planId, title:`不同主题${noise}`, text:`${noise}${step}。${validation}。${noise}` })
      sources.push({ id:planId, step, validation })
    }
    assert.equal(library.candidates('group-a').length, 0)
    assert.throws(() => library.proposeMethod('group-b', '定点修订并复核', sources), /source/)
    assert.throws(() => library.proposeMethod('group-a', '定点修订并复核', [...sources.slice(0,9), sources[0]]), /distinct/)
    assert.throws(() => library.proposeMethod('group-a', '定点修订并复核', sources.map((s,i)=>i ? s : {...s,step:'不存在的证据'})), /evidence/)
    assert.throws(() => library.proposeMethod('group-a', '定点修订并复核', sources.map((s,i)=>i ? s : {...s,step:'a'})), /evidence/)
    assert.throws(() => library.proposeMethod('group-a', '定点修订并复核', sources.map((s,i)=>i ? s : {...s,validation:s.step})), /evidence/)
    assert.equal(library.candidates('group-a').length, 0)
    const preview = library.proposeMethod('group-a', '定点修订并复核', sources)
    assert.equal(preview.status, 'preview')
    assert.equal(library.candidates('group-a').length, 0)
    const prior = library.db.prepare('SELECT text FROM insights WHERE plan_id=?').get(sources[0].id).text
    library.db.prepare('UPDATE insights SET text=? WHERE plan_id=?').run(prior+'变更', sources[0].id)
    assert.throws(() => library.proposeMethod('group-a', '定点修订并复核', sources, preview.digest), /preview_changed/)
    library.db.prepare('UPDATE insights SET text=? WHERE plan_id=?').run(prior, sources[0].id)
    const draft = library.proposeMethod('group-a', '定点修订并复核', sources, preview.digest)
    assert.equal(draft.tier, 'normal')
    assert.equal(draft.status, 'draft')
    assert.deepEqual(new Set(draft.sources), new Set(sources.map(s=>s.id)))
    assert.throws(() => library.proposeMethod('group-a', '重复使用', sources), /source/)
    assert.throws(() => library.consolidate(draft.id, '未审核正文'), /reviews_required/)
    assert.equal(library.reviewEvidence('group-a', draft.id)[0].method.step, sources[0].step)
    library.review(draft.id, {kind:'bot', reviewer:'leader', approved:true})
    library.review(draft.id, {kind:'owner', reviewer:'owner', approved:true, text:'经过审核的复核方法'})
    const originalText = library.db.prepare('SELECT text FROM insights WHERE plan_id=?').get(sources[0].id).text
    library.db.prepare('UPDATE insights SET text=? WHERE plan_id=?').run('审批后变更', sources[0].id)
    assert.throws(() => library.consolidate(draft.id, '经过审核的复核方法'), /skill_source_changed/)
    library.db.prepare('UPDATE insights SET text=? WHERE plan_id=?').run(originalText, sources[0].id)
    library.consolidate(draft.id, '经过审核的复核方法')
    const provenance = library.skillPublication('group-a','normal',draft.id).metadata
    assert.equal(provenance.methodEvidence.length, 10)
    assert.equal(provenance.methodEvidence[0].step, sources[0].step)
    assert.equal(provenance.methodEvidence[0].digest.length, 64)
    const shared = library.publishShared('group-a', draft.id, 'owner', createHash('sha256').update('经过审核的复核方法').digest('hex'), library.sourcesDigest('group-a', draft.id))
    assert.equal(shared.metadata.methodEvidence, undefined)
    assert.equal(shared.metadata.room, undefined)
    assert.equal(shared.metadata.sources, undefined)
    const remoteMetadata = library.skillPublication('group-b','normal',draft.id).metadata
    assert.equal(remoteMetadata.methodEvidence, undefined)
    assert.equal(remoteMetadata.room, undefined)
    assert.equal(remoteMetadata.sources, undefined)
    library.db.prepare('UPDATE insights SET text=? WHERE plan_id=?').run('变更', sources[0].id)
    assert.throws(() => library.reviewEvidence('group-a', draft.id), /skill_source_changed/)
    assert.deepEqual(library.searchSkills('group-a','normal','复核'), [])
    assert.throws(() => library.openSkill('group-a','normal',draft.id), /skill_not_accessible/)
    assert.doesNotThrow(() => library.syncPublications())
  } finally { library.close(); rmSync(dir, { recursive:true, force:true }) }
})

test('method tools restrict current group to the principal and retain review requirements', async () => {
  const env = fixture()
  try {
    const defs = buildToolDefinitions(x => x, env.service)
    const call = async (name, args, agent) => JSON.parse(await defs.find(tool => tool.name === name).execute(args, {agent}))
    const sources = []
    for (let i=0; i<10; i++) {
      const id = `method-${i}`
      const noise = createHash('sha256').update(id).digest('hex')
      const step = `保留基线并逐项修改${i}`
      const validation = `核对修改块与块外一致${i}`
      env.knowledge.addInsight({room:'room-1', planId:id, title:noise, text:`${noise}${step}。${validation}${noise}`})
      sources.push({id,step,validation})
    }
    assert.equal((await call('taskflow_skill_insights', {}, env.memberA)).error, 'leader_only')
    assert.equal((await call('taskflow_skill_propose_method', {title:'复核',sources}, env.memberA)).error, 'leader_only')
    const list = await call('taskflow_skill_insights', {}, env.admin)
    assert.equal(list.insights.length,10)
    const preview = await call('taskflow_skill_propose_method', {title:'定点修订复核',sources}, env.admin)
    assert.equal(preview.preview.status, 'preview')
    const result = await call('taskflow_skill_propose_method', {title:'定点修订复核',sources,previewDigest:preview.preview.digest}, env.admin)
    assert.equal(result.success, true)
    assert.equal(result.draft.status, 'draft')
    assert.equal(env.knowledge.reviewEvidence('room-1',result.draft.id).length,10)
    assert.equal((await call('taskflow_skill_consolidate', {id:result.draft.id,text:'技能正文',tags:['写作']}, env.admin)).error, 'bot_review_required')
  } finally { env.cleanup() }
})
