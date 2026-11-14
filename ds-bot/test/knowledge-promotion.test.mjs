import assert from 'node:assert/strict'
import test from 'node:test'
import { Knowledge } from '../src/host/taskflow/knowledge.js'
import { contentDigest } from '../src/host/taskflow/publication.js'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../.tmp-test/', import.meta.url))
mkdirSync(root, { recursive: true })

test('independent reviewed sources advance through normal, excellent and premium without reuse', () => {
  const dir = mkdtempSync(join(root, 'promotion-'))
  const library = new Knowledge(join(dir, 'knowledge.sqlite'))
  const title = '登录页面请求与错误日志排查并保留原始响应证据的复核办法'
  const common = '检查登录页面请求及错误日志，保留原始响应和发生顺序；先确认失败原因再选择处理步骤，复核处理结果并保留可追溯证据。回归案例方法编号：'
  const approve = (draft, text) => {
    assert.ok(draft)
    assert.equal(new Set(draft.sources).size, 10)
    library.review(draft.id, { kind: 'bot', reviewer: 'leader', approved: true })
    library.review(draft.id, { kind: 'owner', reviewer: 'human-owner', approved: true, text })
    return library.consolidate(draft.id, text)
  }
  try {
    for (let batch = 0; batch < 10; batch++) {
      for (let method = 0; method < 10; method++) {
        const key = `${batch}:${method}`
        const suffix = contentDigest(key)
        for (let source = 0; source < 10; source++) library.addInsight({ room: 'group-a', planId: `${key}:${source}`,
          title: title + suffix.slice(0, 10), text: common + suffix.slice(0, 20) + ` 来源 ${source}` })
        const draft = library.candidates('group-a').find(row => row.tier === 'normal' && row.status === 'draft')
        approve(draft, common + suffix.slice(0, 20))
      }
      const excellent = library.candidates('group-a').find(row => row.tier === 'excellent' && row.status === 'draft')
      approve(excellent, common + contentDigest(`excellent:${batch}`).slice(0, 20))
    }
    const premium = library.candidates('group-a').find(row => row.tier === 'premium' && row.status === 'draft')
    const approved = approve(premium, common + '精品归纳：将已核实方法按具体失败原因分类应用。')
    const counts = Object.fromEntries(['normal', 'excellent', 'premium'].map(tier => [tier,
      library.candidates('group-a').filter(row => row.tier === tier && row.status === 'approved').length]))
    assert.deepEqual(counts, { normal: 10 ** 2, excellent: 10, premium: 1 })
    assert.throws(() => library.openSkill('group-a', 'excellent', approved.id), /skill_not_accessible/)
    assert.equal(library.openSkill('group-a', 'premium', approved.id).id, approved.id)
    assert.equal(library.skillPublication('group-a', 'premium', approved.id).metadata.sources.length, 10)
  } finally { library.close(); rmSync(dir, { recursive: true, force: true }) }
})
