import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { contentDigest, publishInsight, publishSkill } from './publication.js'
import { SkillLifecycle, skillTags, tagsDigest } from './skill-lifecycle.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS insights (
  plan_id TEXT PRIMARY KEY, room TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL,
  acceptance TEXT NOT NULL DEFAULT '', at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS insights_room ON insights(room, at);
CREATE TABLE IF NOT EXISTS insight_sources (
  plan_id TEXT NOT NULL, room TEXT NOT NULL, card_id TEXT NOT NULL,
  member TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY(plan_id,card_id)
);
CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY, room TEXT NOT NULL, tier TEXT NOT NULL, title TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft',
  bot_review TEXT, owner_review TEXT, owner_text_hash TEXT, at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS candidates_room ON candidates(room, tier, status);
CREATE TABLE IF NOT EXISTS skill_shares (
  candidate_id TEXT PRIMARY KEY, text_hash TEXT NOT NULL, sources_hash TEXT NOT NULL DEFAULT '', reviewer TEXT NOT NULL, at REAL NOT NULL,
  FOREIGN KEY(candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS skill_loads (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, room TEXT NOT NULL, bot TEXT NOT NULL,
  name TEXT NOT NULL, digest TEXT NOT NULL, at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS candidate_sources (
  room TEXT NOT NULL, tier TEXT NOT NULL, source_id TEXT NOT NULL, candidate_id TEXT NOT NULL,
  PRIMARY KEY (room, tier, source_id), FOREIGN KEY(candidate_id) REFERENCES candidates(id)
);
CREATE TABLE IF NOT EXISTS candidate_method_evidence (
  candidate_id TEXT NOT NULL, source_id TEXT NOT NULL, step TEXT NOT NULL, validation TEXT NOT NULL,
  source_digest TEXT NOT NULL, PRIMARY KEY(candidate_id,source_id),
  FOREIGN KEY(candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS archives (
  plan_id TEXT PRIMARY KEY, room TEXT NOT NULL, summary TEXT NOT NULL, at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS archived_marks (
  keyword TEXT PRIMARY KEY, plan_id TEXT NOT NULL, room TEXT NOT NULL,
  kind TEXT NOT NULL, summary TEXT NOT NULL, cleaned_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS archived_marks_room ON archived_marks(room, keyword);
`

const tiers = { normal: null, excellent: 'normal', premium: 'excellent' }
const textHash = value => createHash('sha256').update(value, 'utf8').digest('hex')
const grams = value => {
  const chars = Array.from((String(value).toLowerCase().match(/[\p{L}\p{N}]/gu) ?? []).join(''))
  return new Set(Array.from({ length: Math.max(0, chars.length - 2) }, (_, i) => chars.slice(i, i + 3).join('')))
}
const score = (a, b) => {
  const left = grams(a)
  const right = grams(b)
  if (!left.size || !right.size) return 0
  const overlap = [...left].filter(part => right.has(part)).length
  return overlap / (left.size + right.size - overlap)
}
const similar = (a, b, threshold = 0.45) => score(a.title, b.title) >= threshold && score(a.text, b.text) >= threshold
const check = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 12000) throw new Error(`invalid_${label}`)
  return value.trim()
}

export class Knowledge {
  constructor(path, { readOnly = false, clock = () => Date.now() / 1000 } = {}) {
    this.clock = clock
    this.root = join(dirname(path), 'library')
    this.readOnly = readOnly
    this.db = new DatabaseSync(path, { readOnly })
    if (!readOnly) {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON')
      this.db.exec(SCHEMA)
      if (!this.db.prepare('PRAGMA table_info(candidates)').all().some(row => row.name === 'owner_text_hash')) {
        this.db.exec('ALTER TABLE candidates ADD COLUMN owner_text_hash TEXT')
      }
      if (!this.db.prepare('PRAGMA table_info(skill_shares)').all().some(row => row.name === 'sources_hash')) {
        this.db.exec("ALTER TABLE skill_shares ADD COLUMN sources_hash TEXT NOT NULL DEFAULT ''")
      }
      if (!this.db.prepare('PRAGMA table_info(candidates)').all().some(row => row.name === 'owner_tags_hash')) {
        this.db.exec('ALTER TABLE candidates ADD COLUMN owner_tags_hash TEXT')
      }
    }
    this.lifecycle = new SkillLifecycle(this)
  }

  close() { this.db.close() }

  write(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  stageSources(room, planId, notes) {
    room = check(room, 'room')
    planId = check(planId, 'plan_id')
    return this.write(() => {
      for (const note of notes) {
        const prior = this.db.prepare('SELECT room FROM insight_sources WHERE plan_id=? AND card_id=?')
          .get(planId, note.card_id)
        if (prior && prior.room !== room) throw new Error('source_room_conflict')
        this.db.prepare(`INSERT INTO insight_sources(plan_id,room,card_id,member,text) VALUES(?,?,?,?,?)
          ON CONFLICT(plan_id,card_id) DO UPDATE SET member=excluded.member,text=excluded.text`)
          .run(planId, room, check(note.card_id, 'card_id'), check(note.member, 'member'), check(note.text, 'note'))
      }
    })
  }

  addInsight({ room, planId, title, text, acceptance = '' }) {
    room = check(room, 'room')
    planId = check(planId, 'plan_id')
    title = check(title, 'title')
    text = check(text, 'text')
    return this.write(() => {
      const prior = this.db.prepare('SELECT room, title, text FROM insights WHERE plan_id=?').get(planId)
      if (prior) {
        if (prior.room !== room || prior.title !== title || prior.text !== text) throw new Error('insight_conflict')
        return prior
      }
      this.db.prepare('INSERT INTO insights(plan_id,room,title,text,acceptance,at) VALUES(?,?,?,?,?,?)')
        .run(planId, room, title, text, String(acceptance), this.clock())
      return { room, planId, title, text }
    })
  }

  methodInsights(room, offset = 0) {
    room = check(room, 'room')
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid_offset')
    const rows = this.db.prepare(`SELECT i.plan_id AS id,i.title,i.text,i.acceptance,
      EXISTS(SELECT 1 FROM candidate_sources s WHERE s.room=i.room AND s.tier='normal' AND s.source_id=i.plan_id) AS used
      FROM insights i WHERE i.room=? ORDER BY i.at,i.plan_id LIMIT 11 OFFSET ?`).all(room, offset)
    return { insights: rows.slice(0, 10), nextOffset: rows.length > 10 ? offset + 10 : null }
  }

  proposeMethod(room, title, sources, previewDigest) {
    room = check(room, 'room')
    title = check(title, 'title')
    if (!Array.isArray(sources) || sources.length !== 10 || new Set(sources.map(item => item?.id)).size !== 10) {
      throw new Error('distinct_sources_required')
    }
    return this.write(() => {
      const evidence = sources.map(item => {
        const id = check(item.id, 'source')
        const step = check(item.step, 'evidence')
        const validation = check(item.validation, 'evidence')
        if (step === validation || [...step.matchAll(/[\p{L}\p{N}]/gu)].length < 8 || [...validation.matchAll(/[\p{L}\p{N}]/gu)].length < 8) throw new Error('insufficient_evidence')
        const source = this.db.prepare('SELECT title,text,acceptance FROM insights WHERE room=? AND plan_id=?').get(room, id)
        if (!source || this.db.prepare("SELECT 1 FROM candidate_sources WHERE room=? AND tier='normal' AND source_id=?").get(room, id)) throw new Error('source_unavailable')
        if (!source.text.includes(step) || !source.text.includes(validation)) throw new Error('evidence_not_in_source')
        return { id, step, validation, digest: contentDigest(JSON.stringify({ id, ...source })), source }
      })
      const digest = contentDigest(JSON.stringify({ room, title, evidence }))
      if (previewDigest === undefined) return { status: 'preview', title, digest, evidence }
      if (previewDigest !== digest) throw new Error('preview_changed')
      const id = randomUUID()
      this.db.prepare("INSERT INTO candidates(id,room,tier,title,at) VALUES(?,?,'normal',?,?)").run(id, room, title, this.clock())
      for (const item of evidence) {
        this.db.prepare("INSERT INTO candidate_sources(room,tier,source_id,candidate_id) VALUES(?,'normal',?,?)").run(room, item.id, id)
        this.db.prepare('INSERT INTO candidate_method_evidence(candidate_id,source_id,step,validation,source_digest) VALUES(?,?,?,?,?)')
          .run(id, item.id, item.step, item.validation, item.digest)
      }
      return this.candidates(room).find(row => row.id === id)
    })
  }

  candidates(room) {
    return this.db.prepare('SELECT * FROM candidates WHERE room=? ORDER BY at,id').all(room).map(row => ({
      ...row, sources: this.db.prepare('SELECT source_id FROM candidate_sources WHERE candidate_id=? ORDER BY source_id')
        .all(row.id).map(source => source.source_id),
      ...this.lifecycle.catalog(row.id),
    }))
  }

  reviewEvidence(room, id) {
    const draft = this.db.prepare('SELECT room,tier FROM candidates WHERE id=?').get(id)
    if (!draft || draft.room !== room) throw new Error('skill_not_accessible')
    const hasMethodEvidence = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='candidate_method_evidence'").get())
    return this.db.prepare('SELECT source_id FROM candidate_sources WHERE candidate_id=? ORDER BY source_id').all(id)
      .map(({ source_id: sourceId }) => {
        const source = draft.tier === 'normal'
          ? this.db.prepare('SELECT title,text,acceptance FROM insights WHERE plan_id=? AND room=?').get(sourceId, room)
          : this.db.prepare("SELECT title,text,bot_review,owner_review,owner_text_hash FROM candidates WHERE id=? AND room=? AND status='approved'").get(sourceId, room)
        if (!source) throw new Error('skill_source_missing')
        const digest = contentDigest(JSON.stringify({ id: sourceId, ...source }))
        const method = hasMethodEvidence ? this.db.prepare('SELECT step,validation,source_digest FROM candidate_method_evidence WHERE candidate_id=? AND source_id=?').get(id, sourceId) : undefined
        if (method && method.source_digest !== digest) throw new Error('skill_source_changed')
        return { id: sourceId, title: source.title, text: method ? source.text : source.text.slice(0, 500),
          acceptance: source.acceptance?.slice(0, 300) ?? '',
          ...(method ? { method: { step: method.step, validation: method.validation } } : {}),
          ...(draft.tier !== 'normal' ? { review: { bot: source.bot_review?.slice(0, 160) ?? '未记录',
            owner: source.owner_review?.slice(0, 160) ?? '未记录', textDigest: source.owner_text_hash ?? '未记录' } } : {}),
          digest }
      })
  }

  sourcesDigest(room, id) { return contentDigest(JSON.stringify({ sources: this.reviewEvidence(room, id), tags: this.lifecycle.catalog(id).tags })) }

  searchSkills(room, tier, query = '', tags = []) {
    const term = String(query).trim().toLowerCase()
    const normalized = skillTags(tags)
    const filters = normalized.filter(tag => !normalized.some(child => child.startsWith(`${tag}-`)))
    if (!term && !filters.length) throw new Error('invalid_query')
    return this.availableSkills(room, tier).filter(row => filters.every(filter => row.tags.some(tag => tag === filter || tag.startsWith(`${filter}-`)))
      && (!term || row.title.toLowerCase().includes(term) || row.text.toLowerCase().includes(term) || row.tags.some(tag => tag.toLowerCase().includes(term))))
      .map(({ id, tier: level, title, shared, tags: labels, lifecycle, score }) => ({ id, tier: level, title, shared, tags: labels, lifecycle, score }))
  }

  openSkill(room, tier, id) {
    const row = this.availableSkills(room, tier).find(skill => skill.id === id)
    if (!row) throw new Error('skill_not_accessible')
    return row
  }

  availableSkills(room, tier) {
    if (!(tier in tiers)) throw new Error('invalid_tier')
    const allowed = Object.keys(tiers).slice(0, Object.keys(tiers).indexOf(tier) + 1)
    const hasShares = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='skill_shares'").get()
    const hasSourceHash = hasShares && this.db.prepare('PRAGMA table_info(skill_shares)').all().some(row => row.name === 'sources_hash')
    const rows = hasShares
      ? this.db.prepare(`SELECT c.*,s.text_hash AS shared_hash,${hasSourceHash ? 's.sources_hash' : "''"} AS shared_sources_hash FROM candidates c
          LEFT JOIN skill_shares s ON s.candidate_id=c.id
          WHERE c.status='approved' AND (c.room=? OR s.candidate_id IS NOT NULL) ORDER BY c.at,c.id`).all(room)
      : this.db.prepare("SELECT * FROM candidates WHERE room=? AND status='approved' ORDER BY at,id").all(room)
    const hasMethodEvidence = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='candidate_method_evidence'").get())
    const validMethod = row => {
      if (!hasMethodEvidence || !this.db.prepare('SELECT 1 FROM candidate_method_evidence WHERE candidate_id=? LIMIT 1').get(row.id)) return true
      try { this.reviewEvidence(row.room, row.id); return true }
      catch (error) { if (['skill_source_missing', 'skill_source_changed'].includes(error.message)) return false; throw error }
    }
    const shared = row => {
      if (row.shared_hash !== contentDigest(row.text) || !row.shared_sources_hash) return false
      try { return row.shared_sources_hash === this.sourcesDigest(row.room, row.id) }
      catch (error) { if (['skill_source_missing', 'skill_source_changed'].includes(error.message)) return false; throw error }
    }
    return rows.filter(row => validMethod(row) && this.lifecycle.catalog(row.id).lifecycle !== 'retired' && allowed.includes(row.tier) && row.bot_review && row.owner_review
      && (!row.owner_tags_hash || row.owner_tags_hash === tagsDigest(this.lifecycle.catalog(row.id).tags))
      && row.owner_text_hash === contentDigest(row.text) && (row.room === room || shared(row)))
      .map(row => ({ id: row.id, room: row.room, tier: row.tier, title: row.title, text: row.text,
        shared: shared(row), ...this.lifecycle.catalog(row.id) }))
  }

  insightPublication(room, planId) {
    const row = this.db.prepare('SELECT * FROM insights WHERE room=? AND plan_id=?').get(room, planId)
    if (!row) throw new Error('insight_not_accessible')
    const sources = this.db.prepare('SELECT card_id,member,text FROM insight_sources WHERE room=? AND plan_id=? ORDER BY card_id').all(room, planId)
    return publishInsight(this.root, { ...row, planId }, sources, { readOnly: this.readOnly })
  }

  skillPublication(room, tier, id, { shared = false } = {}) {
    const row = this.openSkill(room, tier, id)
    if (shared && !row.shared) throw new Error('skill_not_accessible')
    const sources = this.db.prepare('SELECT source_id FROM candidate_sources WHERE candidate_id=? ORDER BY source_id').all(id)
      .map(item => item.source_id)
    const publicCopy = shared || row.room !== room
    const hasMethodEvidence = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='candidate_method_evidence'").get()
      && this.db.prepare('SELECT 1 FROM candidate_method_evidence WHERE candidate_id=? LIMIT 1').get(row.id)
    const methodEvidence = hasMethodEvidence ? this.reviewEvidence(row.room, row.id).filter(item => item.method)
      .map(item => publicCopy ? { id: item.id, digest: item.digest } : { id: item.id, digest: item.digest, ...item.method }) : []
    return publishSkill(this.root, row, sources, publicCopy, { readOnly: this.readOnly, methodEvidence,
      ...(publicCopy ? { sourcesDigest: this.sourcesDigest(row.room, row.id) } : {}) })
  }

  syncPublications() {
    for (const row of this.db.prepare('SELECT room,plan_id FROM insights').all()) this.insightPublication(row.room, row.plan_id)
    for (const row of this.db.prepare("SELECT room,tier,id FROM candidates WHERE status='approved'").all()) {
      if (this.lifecycle.catalog(row.id).lifecycle === 'retired') continue
      try { this.skillPublication(row.room, row.tier, row.id) }
      catch (error) {
        if (error.message !== 'skill_not_accessible') throw error
        try { this.reviewEvidence(row.room, row.id) }
        catch (sourceError) {
          if (['skill_source_missing', 'skill_source_changed'].includes(sourceError.message)) continue
          throw sourceError
        }
        throw error
      }
      if (this.openSkill(row.room, row.tier, row.id).shared) {
        this.skillPublication(row.room, row.tier, row.id, { shared: true })
      }
    }
    this.lifecycle.cleanup()
  }

  publishShared(room, id, reviewer, digest, sourcesHash) {
    return this.write(() => {
      const row = this.db.prepare("SELECT * FROM candidates WHERE room=? AND id=? AND status='approved'").get(room, id)
      if (!row) throw new Error('skill_not_accessible')
      if (this.lifecycle.catalog(row.id).lifecycle === 'retired') throw new Error('skill_not_accessible')
      if (contentDigest(row.text) !== digest) throw new Error('skill_changed')
      if (!row.bot_review || !row.owner_review || row.owner_text_hash !== digest) throw new Error('reviews_required')
      if (sourcesHash !== this.sourcesDigest(room, id)) throw new Error('skill_sources_changed')
      this.db.prepare('INSERT OR REPLACE INTO skill_shares(candidate_id,text_hash,sources_hash,reviewer,at) VALUES(?,?,?,?,?)')
        .run(id, digest, sourcesHash, check(reviewer, 'reviewer'), this.clock())
      const sources = this.db.prepare('SELECT source_id FROM candidate_sources WHERE candidate_id=? ORDER BY source_id').all(id).map(item => item.source_id)
      const methodEvidence = this.reviewEvidence(room, id).filter(item => item.method)
        .map(item => ({ id: item.id, digest: item.digest }))
      return publishSkill(this.root, { ...row, ...this.lifecycle.catalog(row.id) }, sources, true, { readOnly: this.readOnly, sourcesDigest: sourcesHash, methodEvidence })
    })
  }

  unpublishShared(room, id) {
    const row = this.openSkill(room, 'premium', id)
    if (row.room !== room) throw new Error('skill_not_accessible')
    return this.write(() => {
      this.db.prepare('DELETE FROM skill_shares WHERE candidate_id=?').run(id)
      return { id, shared: false }
    })
  }

  recordSkillLoads(session, room, bot, skills) {
    if (this.readOnly) return
    this.write(() => {
      for (const skill of skills) this.db.prepare('INSERT INTO skill_loads(session,room,bot,name,digest,at) VALUES(?,?,?,?,?,?)')
        .run(session, room, bot, skill.name, skill.digest, this.clock())
    })
  }

  recordSkillUse(room, bot, session, id, eventKey) {
    this.lifecycle.recordUse(room, bot, session, id, eventKey)
  }

  purgePlan(planId) {
    return this.write(() => {
      const descendants = this.db.prepare('SELECT candidate_id FROM candidate_sources WHERE source_id=?')
      const seen = new Set()
      const erase = id => {
        if (seen.has(id)) return
        seen.add(id)
        for (const child of descendants.all(id)) erase(child.candidate_id)
        this.db.prepare('DELETE FROM candidate_sources WHERE candidate_id=?').run(id)
        this.db.prepare('DELETE FROM skill_cycles WHERE skill_id=?').run(id)
        this.db.prepare('DELETE FROM skill_uses WHERE skill_id=?').run(id)
        this.db.prepare('DELETE FROM skill_catalog WHERE skill_id=?').run(id)
        this.db.prepare('DELETE FROM candidates WHERE id=?').run(id)
      }
      for (const child of descendants.all(planId)) erase(child.candidate_id)
      this.db.prepare('DELETE FROM insight_sources WHERE plan_id=?').run(planId)
      this.db.prepare('DELETE FROM insights WHERE plan_id=?').run(planId)
    })
  }

  archive({ planId, room, insight, marks, summary }) {
    this.addInsight({ room, planId, title: insight.title, text: insight.text, acceptance: summary })
    return this.write(() => {
      this.db.prepare('INSERT OR IGNORE INTO archives(plan_id,room,summary,at) VALUES(?,?,?,?)')
        .run(planId, room, summary, this.clock())
      for (const mark of marks) {
        const original = this.db.prepare('SELECT plan_id,room,kind,summary FROM archived_marks WHERE keyword=?').get(mark.keyword)
        if (original && (original.plan_id !== planId || original.room !== room || original.kind !== mark.kind
          || original.summary !== mark.summary)) throw new Error('archive_keyword_conflict')
        this.db.prepare(`INSERT OR IGNORE INTO archived_marks(keyword,plan_id,room,kind,summary,cleaned_at)
          VALUES(?,?,?,?,?,?)`).run(mark.keyword, planId, room, mark.kind, mark.summary, this.clock())
      }
      if (this.db.prepare('SELECT room FROM archives WHERE plan_id=?').get(planId)?.room !== room
        || marks.some(mark => !this.db.prepare('SELECT 1 FROM archived_marks WHERE keyword=? AND plan_id=?')
          .get(mark.keyword, planId))) throw new Error('archive_incomplete')
      return { planId, marks: marks.length }
    })
  }

  archived(planId, marks) {
    return Boolean(this.db.prepare('SELECT 1 FROM archives WHERE plan_id=?').get(planId))
      && marks.every(mark => Boolean(this.db.prepare('SELECT 1 FROM archived_marks WHERE keyword=? AND plan_id=?')
        .get(mark.keyword, planId)))
  }

  searchArchivedMarks(room, query) {
    const term = check(query, 'query')
    return this.db.prepare(`SELECT keyword,kind,summary FROM archived_marks WHERE room=?
      AND (instr(keyword,?)>0 OR instr(summary,?)>0) ORDER BY cleaned_at DESC LIMIT 50`).all(room, term, term)
  }

  openArchivedMark(room, keyword) {
    const row = this.db.prepare('SELECT * FROM archived_marks WHERE keyword=? AND room=?').get(keyword, room)
    if (!row) throw new Error('mark_not_found')
    return { keyword, kind: row.kind, plan_id: row.plan_id, summary: row.summary,
      content: `原始明细已清理。归档摘要：${row.summary}`, archived: true }
  }

  promote(room, tier) {
    if (!(tier in tiers)) throw new Error('invalid_tier')
    if (tier === 'normal') return null
    const predecessor = tiers[tier]
    const rows = predecessor === null
      ? this.db.prepare(`SELECT plan_id AS id, title, text FROM insights i WHERE room=? AND NOT EXISTS
          (SELECT 1 FROM candidate_sources s WHERE s.room=i.room AND s.tier='normal' AND s.source_id=i.plan_id)
          ORDER BY i.at,i.plan_id`).all(room)
      : this.db.prepare(`SELECT id,title,text FROM candidates c WHERE room=? AND tier=? AND status='approved'
          AND NOT EXISTS (SELECT 1 FROM skill_catalog l WHERE l.skill_id=c.id AND l.lifecycle='retired') AND NOT EXISTS
          (SELECT 1 FROM candidate_sources s WHERE s.room=c.room AND s.tier=? AND s.source_id=c.id)
          ORDER BY c.at,c.id`).all(room, predecessor, tier)
    for (const seed of rows) {
      const group = rows.filter(row => similar(seed, row)).slice(0, 10)
      if (group.length < 10) continue
      if (this.db.prepare('SELECT title,text FROM candidates WHERE room=? AND tier=? AND status=?').all(room, tier, 'approved')
        .some(existing => similar(seed, existing, 0.92))) continue
      const id = randomUUID()
      this.db.prepare('INSERT INTO candidates(id,room,tier,title,at) VALUES(?,?,?,?,?)')
        .run(id, room, tier, seed.title, this.clock())
      for (const item of group) {
        this.db.prepare('INSERT INTO candidate_sources(room,tier,source_id,candidate_id) VALUES(?,?,?,?)')
          .run(room, tier, item.id, id)
      }
      return id
    }
    return null
  }

  review(id, { kind, reviewer, approved, text, tags }) {
    if (!['bot', 'owner'].includes(kind) || typeof approved !== 'boolean') throw new Error('invalid_review')
    reviewer = check(reviewer, 'reviewer')
    return this.write(() => {
      const candidate = this.db.prepare('SELECT * FROM candidates WHERE id=?').get(id)
      if (!candidate || candidate.status !== 'draft') throw new Error('draft_required')
      const column = kind === 'bot' ? 'bot_review' : 'owner_review'
      if (candidate[column]) throw new Error('review_already_recorded')
      if (kind === 'owner' && approved) {
        const approvedText = check(text, 'text')
        this.db.prepare("UPDATE candidates SET owner_review=?,owner_text_hash=?,owner_tags_hash=?,status='draft' WHERE id=?")
          .run(reviewer, textHash(approvedText), tagsDigest(tags), id)
      } else {
        this.db.prepare(`UPDATE candidates SET ${column}=?, status=? WHERE id=?`)
          .run(approved ? reviewer : `rejected:${reviewer}`, approved ? 'draft' : 'rejected', id)
      }
      return this.candidates(candidate.room).find(row => row.id === id)
    })
  }

  consolidate(id, text, tags) {
    text = check(text, 'text')
    tags = skillTags(tags)
    return this.write(() => {
      const candidate = this.db.prepare('SELECT * FROM candidates WHERE id=?').get(id)
      if (!candidate || candidate.status !== 'draft' || !candidate.bot_review || !candidate.owner_review) {
        throw new Error('reviews_required')
      }
      if (!candidate.owner_text_hash || candidate.owner_text_hash !== textHash(text)) {
        throw new Error('owner_text_mismatch')
      }
      if (candidate.owner_tags_hash && candidate.owner_tags_hash !== tagsDigest(tags)) throw new Error('owner_tags_mismatch')
      if (this.db.prepare('SELECT 1 FROM candidate_method_evidence WHERE candidate_id=? LIMIT 1').get(id)) {
        this.reviewEvidence(candidate.room, id)
      }
      if (this.db.prepare('SELECT title,text FROM candidates WHERE room=? AND tier=? AND status=?').all(candidate.room, candidate.tier, 'approved')
        .some(existing => similar({ title: candidate.title, text }, existing, 0.92))) throw new Error('duplicate_skill')
      this.db.prepare("UPDATE candidates SET text=?,status='approved' WHERE id=?").run(text, id)
      this.lifecycle.register(id, tags)
      if (candidate.tier === 'normal') this.promote(candidate.room, 'excellent')
      if (candidate.tier === 'excellent') this.promote(candidate.room, 'premium')
      return this.candidates(candidate.room).find(row => row.id === id)
    })
  }
}
