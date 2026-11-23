import { randomUUID } from 'node:crypto'
import { contentDigest, removeSkillPublications, skillName } from './publication.js'

export const SKILL_PERIOD = 5 * 24 * 3600
export const QUALITY_KEYS = ['scope', 'inputs', 'steps', 'validation', 'prevention', 'boundaries']
export function skillTags(value, { required = false } = {}) {
  if (value === undefined && !required) return []
  if (!Array.isArray(value) || value.length > 48 || (required && !value.length)) throw new Error('invalid_skill_tags')
  const result = new Set()
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim() || item.length > 100 || !/^[\p{L}\p{N} _+.#-]+$/u.test(item)) throw new Error('invalid_skill_tags')
    const parts = item.trim().split('-').map(part => part.trim())
    if (parts.some(part => !part) || parts.length > 4) throw new Error('invalid_skill_tags')
    parts.forEach((_part, index) => result.add(parts.slice(0, index + 1).join('-')))
  }
  if (result.size > 48) throw new Error('invalid_skill_tags')
  return [...result].sort()
}
export const tagsDigest = tags => contentDigest(JSON.stringify(skillTags(tags)))
export const skillVersion = (text, tags) => contentDigest(JSON.stringify({ text, tags: skillTags(tags) }))
const frequencyScore = count => count >= 7 ? 2 : count >= 4 ? 1.5 : count >= 2 ? 1 : count >= 1 ? 0.5 : 0
const schema = `
CREATE TABLE IF NOT EXISTS skill_catalog (
 skill_id TEXT PRIMARY KEY, tags TEXT NOT NULL DEFAULT '[]', lifecycle TEXT NOT NULL DEFAULT 'active',
 score REAL, low_streak INTEGER NOT NULL DEFAULT 0, next_due REAL NOT NULL, period REAL NOT NULL DEFAULT ${SKILL_PERIOD},
 cleanup_done INTEGER NOT NULL DEFAULT 0, cleanup_error TEXT,
 FOREIGN KEY(skill_id) REFERENCES candidates(id)
);
CREATE TABLE IF NOT EXISTS skill_uses (
 skill_id TEXT NOT NULL, room TEXT NOT NULL, bot TEXT NOT NULL, session TEXT NOT NULL,
 event_key TEXT NOT NULL, at REAL NOT NULL, PRIMARY KEY(skill_id,event_key)
);
CREATE INDEX IF NOT EXISTS skill_uses_window ON skill_uses(skill_id,at);
CREATE TABLE IF NOT EXISTS skill_cycles (
 id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, room TEXT NOT NULL, version TEXT NOT NULL,
 start_at REAL NOT NULL, end_at REAL NOT NULL, uses INTEGER NOT NULL, assemblies INTEGER NOT NULL,
 frequency REAL NOT NULL, status TEXT NOT NULL DEFAULT 'pending', ratings TEXT, quality REAL, total REAL,
 reviewer TEXT, rated_at REAL, notified_at REAL, outcome TEXT,
 FOREIGN KEY(skill_id) REFERENCES candidates(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS skill_pending_cycle ON skill_cycles(skill_id) WHERE status='pending';
`

export class SkillLifecycle {
  constructor(knowledge) {
    this.knowledge = knowledge
    this.db = knowledge.db
    if (!knowledge.readOnly) {
      knowledge.write(() => {
        this.db.exec(schema)
        if (!this.db.prepare('PRAGMA table_info(skill_catalog)').all().some(column => column.name === 'period')) {
          this.db.exec(`ALTER TABLE skill_catalog ADD COLUMN period REAL NOT NULL DEFAULT ${3 * 24 * 3600}`)
        }
        // Preserve the existing clock origin and extend legacy deadlines exactly once.
        this.db.prepare('UPDATE skill_catalog SET next_due=next_due+?-period,period=? WHERE period<>?')
          .run(SKILL_PERIOD, SKILL_PERIOD, SKILL_PERIOD)
        this.db.prepare(`UPDATE skill_cycles SET status='superseded',outcome=CASE
          WHEN skill_id IN (SELECT id FROM candidates WHERE tier='premium') THEN 'scoring_exempt' ELSE 'period_changed' END
          WHERE status='pending' AND (end_at-start_at<>? OR skill_id IN (SELECT id FROM candidates WHERE tier='premium'))`).run(SKILL_PERIOD)
        this.db.prepare(`UPDATE skill_catalog SET lifecycle='active',score=NULL,low_streak=0
          WHERE lifecycle<>'retired' AND skill_id IN (SELECT id FROM candidates WHERE tier='premium')`).run()
        this.db.prepare(`INSERT OR IGNORE INTO skill_catalog(skill_id,next_due,period)
          SELECT id,?,? FROM candidates WHERE status='approved'`).run(knowledge.clock() + SKILL_PERIOD, SKILL_PERIOD)
      })
    }
    this.available = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='skill_catalog'").get())
  }

  catalog(id) {
    const row = this.available && this.db.prepare('SELECT * FROM skill_catalog WHERE skill_id=?').get(id)
    const scoringExempt = this.db.prepare('SELECT tier FROM candidates WHERE id=?').get(id)?.tier === 'premium'
    return row ? { tags: JSON.parse(row.tags), lifecycle: scoringExempt && row.lifecycle === 'forgetting' ? 'active' : row.lifecycle,
      score: scoringExempt ? null : row.score, lowStreak: scoringExempt ? 0 : row.low_streak,
      nextDue: scoringExempt ? null : row.next_due, scoringExempt }
      : { tags: [], lifecycle: 'active', score: null, lowStreak: 0, nextDue: null, scoringExempt }
  }

  register(id, tags) {
    this.db.prepare('INSERT INTO skill_catalog(skill_id,tags,next_due,period) VALUES(?,?,?,?)')
      .run(id, JSON.stringify(skillTags(tags)), this.knowledge.clock() + SKILL_PERIOD, SKILL_PERIOD)
  }

  recordUse(room, bot, session, id, eventKey) {
    if (this.knowledge.readOnly) return
    this.db.prepare('INSERT OR IGNORE INTO skill_uses(skill_id,room,bot,session,event_key,at) VALUES(?,?,?,?,?,?)')
      .run(id, room, bot, session, eventKey, this.knowledge.clock())
  }

  pending(room) {
    if (!this.available) return []
    return this.db.prepare(`SELECT r.*,c.title,c.text FROM skill_cycles r JOIN candidates c ON c.id=r.skill_id
      WHERE r.status='pending' AND c.tier<>'premium' AND (? IS NULL OR r.room=?) AND r.end_at-r.start_at=?
      ORDER BY r.end_at,r.id`).all(room ?? null, room ?? null, SKILL_PERIOD).map(row => ({ ...row, tags: this.catalog(row.skill_id).tags }))
  }

  due(room) {
    if (this.knowledge.readOnly || !this.available) return this.pending(room)
    this.knowledge.write(() => {
      const now = this.knowledge.clock()
      const rows = this.db.prepare(`SELECT c.*,s.tags,s.next_due FROM candidates c JOIN skill_catalog s ON s.skill_id=c.id
        WHERE c.status='approved' AND c.tier<>'premium' AND s.lifecycle <> 'retired' AND s.next_due<=? AND (? IS NULL OR c.room=?)
        AND NOT EXISTS (SELECT 1 FROM skill_cycles r WHERE r.skill_id=c.id AND r.status='pending')`).all(now, room ?? null, room ?? null)
      for (const row of rows) {
        const tags = JSON.parse(row.tags)
        // An overdue host opens only one real window, never a stack of fictional missed ratings.
        const end = now
        const start = end - SKILL_PERIOD
        const uses = this.db.prepare('SELECT COUNT(*) AS n FROM skill_uses WHERE skill_id=? AND at>=? AND at<?').get(row.id, start, end).n
        const assemblies = this.db.prepare('SELECT COUNT(*) AS n FROM skill_loads WHERE name=? AND at>=? AND at<?')
          .get(skillName(row.id), start, end).n
        this.db.prepare(`INSERT INTO skill_cycles(id,skill_id,room,version,start_at,end_at,uses,assemblies,frequency)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(randomUUID(), row.id, row.room, skillVersion(row.text, tags), start, end, uses, assemblies, frequencyScore(uses))
      }
    })
    if (room !== undefined) return this.pending(room)
    return this.db.prepare("SELECT DISTINCT room FROM skill_cycles WHERE status='pending'").all().flatMap(row => this.pending(row.room))
  }

  rate(room, cycleId, reviewer, ratings) {
    if (!ratings || typeof ratings !== 'object' || Object.keys(ratings).length !== QUALITY_KEYS.length || !QUALITY_KEYS.every(key => {
      const item = ratings[key]
      return item && [0, 0.5].includes(item.score) && typeof item.evidence === 'string' && item.evidence.trim() && item.evidence.length <= 1000
    })) throw new Error('invalid_quality_ratings')
    const normalized = JSON.stringify(Object.fromEntries(QUALITY_KEYS.map(key => [key, { score: ratings[key].score, evidence: ratings[key].evidence.trim() }])))
    return this.knowledge.write(() => {
      const cycle = this.db.prepare('SELECT * FROM skill_cycles WHERE id=? AND room=?').get(cycleId, room)
      if (!cycle) throw new Error('rating_not_accessible')
      const skill = this.db.prepare("SELECT * FROM candidates WHERE id=? AND room=? AND status='approved'").get(cycle.skill_id, room)
      if (skill?.tier === 'premium') throw new Error('skill_scoring_exempt')
      if (cycle.status === 'rated') {
        if (cycle.ratings !== normalized) throw new Error('rating_conflict')
        return { total: cycle.total, quality: cycle.quality, frequency: cycle.frequency, state: cycle.outcome }
      }
      if (cycle.status !== 'pending') throw new Error('rating_not_pending')
      const catalog = this.catalog(cycle.skill_id)
      if (!skill || catalog.lifecycle === 'retired' || skillVersion(skill.text, catalog.tags) !== cycle.version
        || skill.owner_text_hash !== contentDigest(skill.text)
        || (skill.owner_tags_hash && skill.owner_tags_hash !== tagsDigest(catalog.tags))) throw new Error('skill_changed_during_rating')
      const quality = QUALITY_KEYS.reduce((sum, key) => sum + ratings[key].score, 0)
      const total = quality + cycle.frequency
      const streak = total < 3 ? catalog.lowStreak + 1 : 0
      const state = streak >= 2 ? 'retired' : streak === 1 ? 'forgetting' : 'active'
      const now = this.knowledge.clock()
      this.db.prepare(`UPDATE skill_cycles SET status='rated',ratings=?,quality=?,total=?,reviewer=?,rated_at=?,outcome=? WHERE id=?`)
        .run(normalized, quality, total, reviewer, now, state, cycleId)
      this.db.prepare('UPDATE skill_catalog SET lifecycle=?,score=?,low_streak=?,next_due=? WHERE skill_id=?')
        .run(state, total, streak, now + SKILL_PERIOD, skill.id)
      if (state === 'retired') this.db.prepare('DELETE FROM skill_shares WHERE candidate_id=?').run(skill.id)
      return { id: skill.id, cycleId, total, quality, frequency: cycle.frequency, state, lowStreak: streak, nextDue: now + SKILL_PERIOD }
    })
  }

  history(room, id) {
    if (!this.available) return []
    return this.db.prepare("SELECT * FROM skill_cycles WHERE skill_id=? AND room=? AND status='rated' ORDER BY rated_at,id").all(id, room)
  }

  markNotified(id) {
    this.db.prepare("UPDATE skill_cycles SET notified_at=? WHERE id=? AND status='pending'").run(this.knowledge.clock(), id)
  }

  cleanup() {
    if (this.knowledge.readOnly || !this.available) return []
    const results = []
    for (const row of this.db.prepare(`SELECT c.id,c.room FROM candidates c JOIN skill_catalog s ON s.skill_id=c.id
      WHERE c.tier<>'premium' AND s.lifecycle='retired' AND s.cleanup_done=0`).all()) {
      try {
        removeSkillPublications(this.knowledge.root, row)
        this.db.prepare('UPDATE skill_catalog SET cleanup_done=1,cleanup_error=NULL WHERE skill_id=?').run(row.id)
        results.push({ id: row.id, removed: true })
      } catch (error) {
        const message = String(error?.message ?? error)
        this.db.prepare('UPDATE skill_catalog SET cleanup_error=? WHERE skill_id=?').run(message, row.id)
        results.push({ id: row.id, error: message })
      }
    }
    return results
  }
}
