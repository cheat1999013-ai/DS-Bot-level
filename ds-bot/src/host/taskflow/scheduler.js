/**
 * Durable SQLite dependency-DAG scheduler for native DS Bot taskflow.
 * Ported from the local MIT-licensed dsh-bot-taskflow scheduler (see NOTICE).
 *
 * Card lifecycle:
 *   pending -> dispatching -> running -> verified
 *                  |             |
 *                  |             +-> failed / cancelled
 *                  +-> pending   (release_unsent: transport never accepted)
 *   dispatching -> unknown       (crash recovery; never auto-pending)
 *   failed/unknown -> pending    (explicit retry, attempt budget applies)
 *
 * Invariants:
 *   - 1..32 cards, keys exactly {id, member, goal, dependencies}.
 *   - Ordered DAG: every dependency must be declared earlier (no cycles).
 *   - Concurrency 1..6; dispatching + running + unknown count in flight.
 *   - A card dispatches only when every dependency is `verified`.
 *   - Results bind member + receipt + terminal id; acceptance requires
 *     sha256 evidence over the canonical result payload.
 *   - Finish requires every card verified, an unchanged snapshot (CAS), and
 *     sha256 evidence over the canonical snapshot.
 */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, statSync } from 'node:fs'

const require = createRequire(import.meta.url)

export const MIN_CARDS = 1
export const MAX_CARDS = 32
export const MIN_CONCURRENCY = 1
export const MAX_CONCURRENCY = 6
export const MIN_RETRY_LIMIT = 0
export const MAX_RETRY_LIMIT = 5
export const CARD_KEYS = ['id', 'member', 'goal', 'dependencies']
export const IN_FLIGHT = ['dispatching', 'running', 'unknown']
export const RESULT_STATES = ['settled', 'failed', 'cancelled']
export const TEXT_LIMIT = 48000
export const AUTO_NOTE = '(auto placeholder: 执行者尚未写心得，可在汇总前替换)'

export class SchedulerError extends Error {
  constructor(code, message = '') {
    super(message ? `${code}: ${message}` : code)
    this.name = 'SchedulerError'
    this.code = code
  }
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

export function digest(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

function identifier(value, field) {
  if (typeof value !== 'string' || value === '' || value !== value.trim()
    || value.includes('\u0000') || value.length > 256) {
    throw new SchedulerError('invalid_identifier', `${field} must be a non-empty trimmed string <= 256 chars`)
  }
  return value
}

function text(value, field, limit = TEXT_LIMIT) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SchedulerError('invalid_text', `${field} must be non-empty text`)
  }
  if (Buffer.byteLength(value, 'utf8') > limit) {
    throw new SchedulerError('invalid_text', `${field} exceeds ${limit} UTF-8 bytes`)
  }
  return value
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plans (
  plan_id TEXT PRIMARY KEY,
  room TEXT NOT NULL,
  principal TEXT NOT NULL,
  concurrency INTEGER NOT NULL,
  retry_limit INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at REAL NOT NULL,
  ended_at REAL,
  cancel_reason TEXT
);
-- Keep occurrence tombstones even after completed plan details are archived.
CREATE TABLE IF NOT EXISTS scheduled_occurrences (
  schedule_id TEXT NOT NULL, occurrence_at TEXT NOT NULL,
  plan_id TEXT NOT NULL UNIQUE, room TEXT NOT NULL,
  PRIMARY KEY(schedule_id, occurrence_at)
);
CREATE TABLE IF NOT EXISTS scheduled_attempts (
  plan_id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, occurrence_at TEXT NOT NULL,
  state TEXT NOT NULL, reason TEXT, at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS cards (
  plan_id TEXT NOT NULL REFERENCES plans(plan_id),
  card_id TEXT NOT NULL,
  member TEXT NOT NULL,
  goal TEXT NOT NULL,
  position INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  receipt TEXT,
  terminal_event_id TEXT,
  dispatched_at REAL,
  started_at REAL,
  ended_at REAL,
  fail_reason TEXT,
  PRIMARY KEY (plan_id, card_id)
);
CREATE TABLE IF NOT EXISTS card_deps (
  plan_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  PRIMARY KEY (plan_id, card_id, depends_on),
  FOREIGN KEY (plan_id, card_id) REFERENCES cards(plan_id, card_id),
  FOREIGN KEY (plan_id, depends_on) REFERENCES cards(plan_id, card_id)
);
CREATE TABLE IF NOT EXISTS card_progress (
  plan_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  at REAL NOT NULL,
  PRIMARY KEY (plan_id, card_id),
  FOREIGN KEY (plan_id, card_id) REFERENCES cards(plan_id, card_id)
);
CREATE TABLE IF NOT EXISTS results (
  plan_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  status TEXT NOT NULL,
  terminal_event_id TEXT NOT NULL,
  member TEXT NOT NULL,
  receipt TEXT NOT NULL,
  text TEXT NOT NULL,
  observed_at REAL NOT NULL,
  PRIMARY KEY (plan_id, card_id),
  FOREIGN KEY (plan_id, card_id) REFERENCES cards(plan_id, card_id)
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id TEXT NOT NULL,
  card_id TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS events_plan ON events(plan_id, seq);
CREATE TABLE IF NOT EXISTS node_marks (
  keyword TEXT PRIMARY KEY,
  event_seq INTEGER NOT NULL UNIQUE,
  plan_id TEXT NOT NULL,
  room TEXT NOT NULL,
  card_id TEXT,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS node_marks_room ON node_marks(room, event_seq);
CREATE TABLE IF NOT EXISTS bot_rewards (
  room TEXT NOT NULL, plan_id TEXT NOT NULL, bot_id TEXT NOT NULL, at REAL NOT NULL,
  points INTEGER NOT NULL DEFAULT 10,
  PRIMARY KEY(room, plan_id, bot_id)
);
CREATE INDEX IF NOT EXISTS bot_rewards_member ON bot_rewards(room, bot_id);
CREATE TABLE IF NOT EXISTS retention_clock (
  plan_id TEXT PRIMARY KEY, accepted_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS test_requirements (
  plan_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  PRIMARY KEY (plan_id, card_id),
  FOREIGN KEY (plan_id, card_id) REFERENCES cards(plan_id, card_id)
);
CREATE TABLE IF NOT EXISTS test_specs (
  plan_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  command TEXT NOT NULL,
  workdir TEXT NOT NULL,
  PRIMARY KEY (plan_id, card_id),
  FOREIGN KEY (plan_id, card_id) REFERENCES cards(plan_id, card_id)
);
CREATE TABLE IF NOT EXISTS test_runs (
  plan_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  terminal TEXT NOT NULL,
  state TEXT NOT NULL,
  receipt TEXT,
  finished_at REAL,
  PRIMARY KEY (plan_id, card_id),
  FOREIGN KEY (plan_id, card_id) REFERENCES cards(plan_id, card_id)
);
CREATE TABLE IF NOT EXISTS confirmations (
  plan_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  terminal TEXT NOT NULL,
  decision TEXT NOT NULL,
  note TEXT,
  decided_by TEXT NOT NULL,
  at REAL NOT NULL,
  PRIMARY KEY (plan_id, card_id, terminal)
);
CREATE TABLE IF NOT EXISTS card_notes (
  plan_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  member TEXT NOT NULL,
  text TEXT NOT NULL,
  auto INTEGER NOT NULL DEFAULT 0,
  at REAL NOT NULL,
  PRIMARY KEY (plan_id, card_id),
  FOREIGN KEY (plan_id, card_id) REFERENCES cards(plan_id, card_id)
);
CREATE TABLE IF NOT EXISTS plan_insights (
  plan_id TEXT NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  at REAL NOT NULL,
  PRIMARY KEY (plan_id)
);
-- Plugin additions (not present in the Python core).
CREATE TABLE IF NOT EXISTS card_gates (
  plan_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  question TEXT NOT NULL,
  PRIMARY KEY (plan_id, card_id),
  FOREIGN KEY (plan_id, card_id) REFERENCES cards(plan_id, card_id)
);
CREATE TABLE IF NOT EXISTS preflight_decisions (
  plan_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  note TEXT,
  decided_by TEXT NOT NULL,
  at REAL NOT NULL,
  PRIMARY KEY (plan_id, card_id),
  FOREIGN KEY (plan_id, card_id) REFERENCES cards(plan_id, card_id)
);
CREATE TABLE IF NOT EXISTS card_comments (
  plan_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  at REAL NOT NULL,
  FOREIGN KEY (plan_id, card_id) REFERENCES cards(plan_id, card_id)
);
CREATE TABLE IF NOT EXISTS room_plans (
  room TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS plan_workdirs (
  plan_id TEXT PRIMARY KEY,
  workdir TEXT NOT NULL
);
`

export class Scheduler {
  constructor(path, { clock = () => Date.now() / 1000, recoverOnOpen = true, readOnly = false } = {}) {
    this.clock = clock
    this.path = path
    let DatabaseSync
    try {
      ({ DatabaseSync } = require('node:sqlite'))
    } catch (error) {
      if (error?.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw error
      throw new SchedulerError('sqlite_unavailable', 'Taskflow requires a Node runtime with node:sqlite support')
    }
    this.db = new DatabaseSync(path, { readOnly })
    if (readOnly) {
      this.preflightAvailable = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='preflight_decisions'").get())
      this.progressAvailable = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='card_progress'").get())
      return
    }
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec('PRAGMA foreign_keys=ON')
    this.db.exec(SCHEMA)
    // Historical rewards keep their earned +0.1; new rewards use integer hundredths.
    if (!this.db.prepare('PRAGMA table_info(bot_rewards)').all().some(row => row.name === 'points')) {
      this.db.exec('ALTER TABLE bot_rewards ADD COLUMN points INTEGER NOT NULL DEFAULT 10')
    }
    this.preflightAvailable = true
    this.progressAvailable = true
    const columns = this.db.prepare('PRAGMA table_info(plans)').all().map(row => row.name)
    if (!columns.includes('confirm_required')) {
      this.db.exec('ALTER TABLE plans ADD COLUMN confirm_required INTEGER NOT NULL DEFAULT 0')
    }
    if (!columns.includes('goal')) this.db.exec('ALTER TABLE plans ADD COLUMN goal TEXT')
    if (!columns.includes('group_goal_id')) this.db.exec('ALTER TABLE plans ADD COLUMN group_goal_id TEXT')
    if (!columns.includes('reflection_released')) this.db.exec('ALTER TABLE plans ADD COLUMN reflection_released INTEGER NOT NULL DEFAULT 0')
    this.backfillMemory()
    if (recoverOnOpen) this.recoverDispatches()
  }

  close() {
    this.db.close()
  }

  // ---- transaction helpers -------------------------------------------------

  write(fn, { admission = false } = {}) {
    try { this.db.exec('BEGIN IMMEDIATE') } catch (error) {
      if (admission && [5, 6].includes((error?.errcode ?? -1) & 0xff)) {
        throw new SchedulerError('taskflow_admission_busy', 'The task ledger is busy before plan admission; retry later')
      }
      throw error
    }
    try {
      const value = fn()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* already rolled back */ }
      throw error
    }
  }

  event(planId, cardId, type, payload) {
    const result = this.db.prepare('INSERT INTO events(plan_id, card_id, type, payload, at) VALUES(?,?,?,?,?)')
      .run(planId, cardId ?? null, type, canonicalJson(payload), this.clock())
    this.markEvent(planId, cardId, type, payload, Number(result.lastInsertRowid))
  }

  markEvent(planId, cardId, type, payload, seq) {
    const kinds = { receipt_bound: 'dispatch', result_observed: 'result', result_accepted: 'accept',
      note_saved: 'note', insight_consolidated: 'insight' }
    const kind = kinds[type]
    if (!kind) return
    const room = this.db.prepare('SELECT room FROM plans WHERE plan_id=?').get(planId)?.room
    const goal = cardId ? this.db.prepare('SELECT goal FROM cards WHERE plan_id=? AND card_id=?').get(planId, cardId)?.goal : null
    const summary = String(payload.title ?? goal ?? planId).slice(0, 300)
    const slug = summary.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 12) || '记录'
    const keyword = `${{ dispatch: '派发', result: '结果', accept: '验收', note: '心得', insight: '心得' }[kind]}·${slug}·${seq.toString(16).padStart(6, '0')}`
    this.db.prepare('INSERT INTO node_marks(keyword,event_seq,plan_id,room,card_id,kind,summary) VALUES(?,?,?,?,?,?,?)')
      .run(keyword, seq, planId, room, cardId ?? null, kind, summary)
  }

  backfillMemory() {
    return this.write(() => {
      const rows = this.db.prepare(`SELECT e.* FROM events e JOIN plans p ON p.plan_id=e.plan_id
        WHERE e.type IN ('receipt_bound','result_observed','result_accepted','note_saved','insight_consolidated')
        AND NOT EXISTS (SELECT 1 FROM node_marks n WHERE n.event_seq=e.seq) ORDER BY e.seq`).all()
      for (const row of rows) this.markEvent(row.plan_id, row.card_id, row.type, JSON.parse(row.payload), row.seq)
      return rows.length
    })
  }

  noteSources(planId) {
    return this.db.prepare(`SELECT e.card_id,c.member,e.payload FROM events e
      JOIN cards c ON c.plan_id=e.plan_id AND c.card_id=e.card_id
      WHERE e.plan_id=? AND e.type='note_saved' AND e.seq=(SELECT MAX(s.seq) FROM events s
        WHERE s.plan_id=e.plan_id AND s.card_id=e.card_id AND s.type='note_saved') ORDER BY e.card_id`).all(planId)
      .map(row => ({ card_id: row.card_id, member: row.member, text: JSON.parse(row.payload).text }))
      .filter(row => typeof row.text === 'string' && row.text.trim())
  }

  searchMarks(room, query, limit = 50) {
    identifier(room, 'room')
    const term = String(query ?? '').trim()
    if (!term) return []
    return this.db.prepare(`SELECT keyword, kind, summary, plan_id, card_id FROM node_marks
      WHERE room=? AND (instr(keyword, ?) > 0 OR instr(summary, ?) > 0)
      ORDER BY event_seq DESC LIMIT ?`).all(room, term, term, Math.max(1, Math.min(100, limit)))
  }

  openMark(room, keyword) {
    identifier(room, 'room')
    identifier(keyword, 'keyword')
    const mark = this.db.prepare('SELECT * FROM node_marks WHERE keyword=?').get(keyword)
    if (!mark) throw new SchedulerError('mark_not_found', keyword)
    if (mark.room !== room) throw new SchedulerError('other_room', 'This keyword belongs to another group')
    const node = this.db.prepare('SELECT type, payload, at FROM events WHERE seq=? AND plan_id=?').get(mark.event_seq, mark.plan_id)
    if (!node) throw new SchedulerError('node_not_found', keyword)
    const payload = JSON.parse(node.payload)
    return { keyword, kind: mark.kind, plan_id: mark.plan_id, card_id: mark.card_id,
      content: `${mark.summary}\n${payload.text ?? JSON.stringify(payload)}`, at: node.at, archived: false }
  }

  plan(planId, requireOpen = false) {
    const row = this.db.prepare('SELECT * FROM plans WHERE plan_id=?').get(planId)
    if (row === undefined) throw new SchedulerError('plan_not_found', planId)
    if (requireOpen && row.status !== 'open') throw new SchedulerError('plan_not_open', `${planId} is ${row.status}`)
    return row
  }

  card(planId, cardId) {
    const row = this.db.prepare('SELECT * FROM cards WHERE plan_id=? AND card_id=?').get(planId, cardId)
    if (row === undefined) throw new SchedulerError('card_not_found', `${planId}/${cardId}`)
    return row
  }

  requirePrincipal(plan, principal) {
    if (principal !== plan.principal) {
      throw new SchedulerError('principal_required', 'only the plan principal may run this operation')
    }
  }

  transferPrincipal(room, from, to) {
    identifier(room, 'room')
    identifier(from, 'old principal')
    if (to !== null) identifier(to, 'new principal')
    return this.write(() => {
      const plans = this.db.prepare("SELECT plan_id FROM plans WHERE room=? AND principal=? AND status IN ('open','cancelling')")
        .all(room, from)
      if (to === null && plans.length) throw new SchedulerError('leader_required', 'Assign a new leader before removing the admin from a group with open taskflow plans')
      for (const { plan_id: id } of plans) {
        this.db.prepare('UPDATE plans SET principal=? WHERE plan_id=?').run(to, id)
        this.event(id, null, 'principal_transferred', { from, to })
      }
      return plans.length
    })
  }

  recoverDispatches() {
    return this.write(() => {
      const rows = this.db.prepare(`SELECT c.plan_id, c.card_id, c.state FROM cards c
        JOIN plans p ON p.plan_id=c.plan_id WHERE p.status='open'
        AND (c.state='dispatching' OR (c.state='running' AND NOT EXISTS (
          SELECT 1 FROM results r WHERE r.plan_id=c.plan_id AND r.card_id=c.card_id)))`).all()
      for (const row of rows) {
        this.db.prepare("UPDATE cards SET state='unknown' WHERE plan_id=? AND card_id=?")
          .run(row.plan_id, row.card_id)
        this.event(row.plan_id, row.card_id, 'dispatch_recovered', { from: row.state, state: 'unknown' })
      }
      return rows.length
    })
  }

  // ---- plan creation -------------------------------------------------------

  scheduledOccurrence(scheduleId, occurrenceAt) {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduled_occurrences'").get()) return null
    return this.db.prepare('SELECT * FROM scheduled_occurrences WHERE schedule_id=? AND occurrence_at=?').get(scheduleId, occurrenceAt) ?? null
  }

  scheduledRetryable(planId) {
    return this.db.prepare("SELECT 1 FROM scheduled_attempts WHERE plan_id=? AND state='confirmed_unsent'").get(planId) !== undefined
  }

  scheduledOrigin(planId) {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduled_occurrences'").get()) return null
    return this.db.prepare('SELECT * FROM scheduled_occurrences WHERE plan_id=?').get(planId) ?? null
  }

  createPlan({ planId, room, principal, goal = null, groupGoalId = null, cards, concurrency = 3, retryLimit = 1,
    testRequiredCards = [], testChecks = {}, confirmRequired = false, gates = {}, workdir = null, scheduled = null }) {
    planId = identifier(planId, 'plan_id')
    room = identifier(room, 'room')
    principal = identifier(principal, 'principal')
    if (goal !== null) goal = text(goal, 'goal', 12000)
    if (!Array.isArray(cards) || cards.length < MIN_CARDS || cards.length > MAX_CARDS) {
      throw new SchedulerError('invalid_cards', `cards must be a list of ${MIN_CARDS}..${MAX_CARDS} entries`)
    }
    if (!Number.isInteger(concurrency) || concurrency < MIN_CONCURRENCY || concurrency > MAX_CONCURRENCY) {
      throw new SchedulerError('invalid_concurrency', `concurrency must be ${MIN_CONCURRENCY}..${MAX_CONCURRENCY}`)
    }
    if (!Number.isInteger(retryLimit) || retryLimit < MIN_RETRY_LIMIT || retryLimit > MAX_RETRY_LIMIT) {
      throw new SchedulerError('invalid_retry_limit', `retry_limit must be ${MIN_RETRY_LIMIT}..${MAX_RETRY_LIMIT}`)
    }
    const seen = new Set()
    const normalized = []
    cards.forEach((card, position) => {
      if (card === null || typeof card !== 'object' || Array.isArray(card)
        || Object.keys(card).length !== CARD_KEYS.length || !CARD_KEYS.every(key => Object.hasOwn(card, key))) {
        throw new SchedulerError('invalid_card_keys', `card #${position} keys must be exactly ${CARD_KEYS.join(', ')}`)
      }
      const cardId = identifier(card.id, 'card.id')
      if (seen.has(cardId)) throw new SchedulerError('duplicate_card', cardId)
      const member = identifier(card.member, 'card.member')
      const goal = text(card.goal, 'card.goal')
      if (!Array.isArray(card.dependencies)) {
        throw new SchedulerError('invalid_dependencies', `${cardId}: dependencies must be a list`)
      }
      for (const dep of card.dependencies) {
        if (!seen.has(dep)) {
          throw new SchedulerError('forward_dependency',
            `${cardId}: dependency ${JSON.stringify(dep)} must be declared earlier in the card list (ordered DAG)`)
        }
      }
      if (new Set(card.dependencies).size !== card.dependencies.length) {
        throw new SchedulerError('invalid_dependencies', `${cardId}: duplicate dependency`)
      }
      seen.add(cardId)
      normalized.push({ id: cardId, member, goal, dependencies: [...card.dependencies], position })
    })
    const required = testRequiredCards ?? []
    if (!Array.isArray(required) || required.some(item => typeof item !== 'string' || !seen.has(item))
      || new Set(required).size !== required.length) {
      throw new SchedulerError('invalid_test_requirements', 'test_required_cards must be unique existing card ids')
    }
    const checks = testChecks ?? {}
    if (checks === null || typeof checks !== 'object' || Array.isArray(checks)
      || Object.keys(checks).length !== required.length
      || Object.keys(checks).some(child => !required.includes(child))) {
      throw new SchedulerError('invalid_test_specification', 'test_checks must specify exactly every test_required_card')
    }
    const specRows = []
    for (const child of Object.keys(checks).sort()) {
      const check = checks[child]
      if (check === null || typeof check !== 'object' || Array.isArray(check)
        || Object.keys(check).length !== 2 || !Object.hasOwn(check, 'command') || !Object.hasOwn(check, 'workdir')
        || typeof check.command !== 'string' || check.command.trim() === ''
        || typeof check.workdir !== 'string' || !isAbsolute(check.workdir)) {
        throw new SchedulerError('invalid_test_specification', `${child}: spec needs command + absolute workdir`)
      }
      if (!existsSync(check.workdir) || !statSync(check.workdir).isDirectory()) {
        throw new SchedulerError('workspace_required', `${child}: workdir is not an existing directory`)
      }
      specRows.push({ child, command: check.command.trim(), workdir: check.workdir })
    }
    if (typeof confirmRequired !== 'boolean') {
      throw new SchedulerError('invalid_confirm_required', 'confirm_required must be a bool')
    }
    const gateRows = []
    for (const [cardId, question] of Object.entries(gates ?? {})) {
      if (!seen.has(cardId)) throw new SchedulerError('invalid_confirm', `${cardId}: unknown card`)
      if (typeof question !== 'string' || question.trim() === '' || question.length > 500) {
        throw new SchedulerError('invalid_confirm', `${cardId}: confirm question must be 1..500 chars`)
      }
      gateRows.push({ cardId, question: question.trim() })
    }
    return this.write(() => {
      if (this.db.prepare('SELECT 1 AS n FROM plans WHERE plan_id=?').get(planId)) {
        throw new SchedulerError('plan_exists', planId)
      }
      const openPlan = this.db.prepare("SELECT plan_id FROM plans WHERE room=? AND status IN ('open','cancelling') LIMIT 1").get(room)
      if (openPlan) throw new SchedulerError('plan_already_open', `This group already has an unfinished plan ${openPlan.plan_id}; finish or cancel it first`)
      const now = this.clock()
      this.db.prepare(`INSERT INTO plans(plan_id, room, principal, goal, concurrency, retry_limit, status, created_at, confirm_required, group_goal_id)
        VALUES(?,?,?,?,?,?,'open',?,?,?)`)
        .run(planId, room, principal, goal, concurrency, retryLimit, now, confirmRequired ? 1 : 0, groupGoalId)
      if (scheduled) {
        const scheduleId = identifier(scheduled.scheduleId, 'schedule_id')
        const occurrenceAt = identifier(scheduled.occurrenceAt, 'occurrence_at')
        if (scheduled.retryOf) {
          const changed = this.db.prepare(`UPDATE scheduled_occurrences SET plan_id=?
            WHERE schedule_id=? AND occurrence_at=? AND plan_id=? AND room=?
              AND EXISTS (SELECT 1 FROM scheduled_attempts WHERE plan_id=? AND state='confirmed_unsent')`)
            .run(planId, scheduleId, occurrenceAt, scheduled.retryOf, room, scheduled.retryOf)
          if (changed.changes !== 1) throw new SchedulerError('occurrence_not_retryable', 'The scheduled occurrence is not eligible for another attempt')
        } else {
          this.db.prepare('INSERT INTO scheduled_occurrences(schedule_id, occurrence_at, plan_id, room) VALUES(?,?,?,?)')
            .run(scheduleId, occurrenceAt, planId, room)
        }
        this.db.prepare("INSERT INTO scheduled_attempts(plan_id,schedule_id,occurrence_at,state,at) VALUES(?,?,?,'admitted',?)")
          .run(planId, scheduleId, occurrenceAt, now)
      }
      for (const card of normalized) {
        this.db.prepare(`INSERT INTO cards(plan_id, card_id, member, goal, position, state)
          VALUES(?,?,?,?,?,'pending')`)
          .run(planId, card.id, card.member, card.goal, card.position)
        for (const dep of card.dependencies) {
          this.db.prepare('INSERT INTO card_deps(plan_id, card_id, depends_on) VALUES(?,?,?)')
            .run(planId, card.id, dep)
        }
      }
      for (const child of [...required].sort()) {
        this.db.prepare('INSERT INTO test_requirements(plan_id, card_id) VALUES(?,?)').run(planId, child)
      }
      for (const spec of specRows) {
        this.db.prepare('INSERT INTO test_specs(plan_id, card_id, command, workdir) VALUES(?,?,?,?)')
          .run(planId, spec.child, spec.command, spec.workdir)
      }
      for (const gate of gateRows) {
        this.db.prepare('INSERT INTO card_gates(plan_id, card_id, question) VALUES(?,?,?)')
          .run(planId, gate.cardId, gate.question)
      }
      if (typeof workdir === 'string' && workdir !== '') {
        this.db.prepare('INSERT OR REPLACE INTO plan_workdirs(plan_id, workdir) VALUES(?,?)').run(planId, workdir)
      }
      this.db.prepare('INSERT OR REPLACE INTO room_plans(room, plan_id, updated_at) VALUES(?,?,?)')
        .run(room, planId, now)
      this.event(planId, null, 'plan_created', {
        room, principal, goal, concurrency, retry_limit: retryLimit,
        cards: normalized.map(card => card.id),
        test_required_cards: [...required].sort(),
        confirm_required: confirmRequired,
      })
      return this.planState(planId)
    }, { admission: true })
  }

  // ---- dispatch ------------------------------------------------------------

  dependencies(planId, cardId) {
    return this.db.prepare('SELECT depends_on FROM card_deps WHERE plan_id=? AND card_id=? ORDER BY depends_on')
      .all(planId, cardId).map(row => row.depends_on)
  }

  inFlight(planId) {
    return this.db.prepare("SELECT COUNT(*) AS n FROM cards WHERE plan_id=? AND state IN ('dispatching','running','unknown')")
      .get(planId).n
  }

  readyCards(planId) {
    const plan = this.plan(planId, true)
    const ready = []
    for (const card of this.db.prepare("SELECT * FROM cards WHERE plan_id=? AND state='pending' ORDER BY position").all(planId)) {
      if (this.preflightAvailable && (plan.confirm_required || this.cardGate(planId, card.card_id))) {
        const decision = this.db.prepare('SELECT decision FROM preflight_decisions WHERE plan_id=? AND card_id=?')
          .get(planId, card.card_id)
        if (decision?.decision !== 'approve') continue
      }
      const deps = this.dependencies(planId, card.card_id)
      if (deps.length === 0) { ready.push(card.card_id); continue }
      const marks = deps.map(() => '?').join(',')
      const row = this.db.prepare(`SELECT COUNT(*) AS n FROM cards WHERE plan_id=? AND card_id IN (${marks}) AND state='verified'`)
        .get(planId, ...deps)
      if (row.n === deps.length) ready.push(card.card_id)
    }
    return ready
  }

  claimNext(planId, { principal }) {
    return this.write(() => {
      const plan = this.plan(planId, true)
      this.requirePrincipal(plan, principal)
      const free = plan.concurrency - this.inFlight(planId)
      const claimed = []
      if (free > 0) {
        const reserved = new Set(this.db.prepare("SELECT member FROM cards WHERE plan_id=? AND state IN ('dispatching','running','unknown')")
          .all(planId).map(card => card.member))
        for (const cardId of this.readyCards(planId)) {
          const member = this.card(planId, cardId).member
          if (reserved.has(member)) continue
          this.db.prepare(`UPDATE cards SET state='dispatching', attempts=attempts+1, dispatched_at=?
            WHERE plan_id=? AND card_id=? AND state='pending'`).run(this.clock(), planId, cardId)
          this.event(planId, cardId, 'card_claimed', { attempts: this.card(planId, cardId).attempts })
          claimed.push(this.cardView(planId, cardId))
          reserved.add(member)
          if (claimed.length === free) break
        }
      }
      return claimed
    })
  }

  bindReceipt(planId, cardId, { receipt }) {
    receipt = identifier(receipt, 'receipt')
    return this.write(() => {
      this.plan(planId, true)
      const card = this.card(planId, cardId)
      if (card.state === 'running' && card.receipt === receipt) return this.cardView(planId, cardId)
      if (card.receipt !== null && card.receipt !== undefined && card.receipt !== receipt) {
        throw new SchedulerError('receipt_conflict', `${cardId} already bound to ${card.receipt}`)
      }
      if (card.state !== 'dispatching') {
        throw new SchedulerError('invalid_state', `${cardId} is ${card.state}, expected dispatching`)
      }
      this.db.prepare("UPDATE cards SET state='running', receipt=?, started_at=? WHERE plan_id=? AND card_id=?")
        .run(receipt, this.clock(), planId, cardId)
      this.event(planId, cardId, 'receipt_bound', { receipt })
      return this.cardView(planId, cardId)
    })
  }

  releaseUnsent(planId, cardId) {
    return this.write(() => {
      this.plan(planId, true)
      const card = this.card(planId, cardId)
      if (card.state !== 'dispatching' || card.receipt !== null) {
        throw new SchedulerError('invalid_state', 'release_unsent requires dispatching without a receipt')
      }
      this.db.prepare("UPDATE cards SET state='pending', attempts=attempts-1, dispatched_at=NULL WHERE plan_id=? AND card_id=?")
        .run(planId, cardId)
      this.event(planId, cardId, 'dispatch_released', {})
      return this.cardView(planId, cardId)
    })
  }

  reclaimScheduledUnsent(planId, cardId, reason) {
    return this.write(() => {
      const plan = this.plan(planId, true)
      const card = this.card(planId, cardId)
      const origin = this.scheduledOrigin(planId)
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM cards WHERE plan_id=?').get(planId).n
      const attempt = this.db.prepare("SELECT 1 FROM scheduled_attempts WHERE plan_id=? AND state='admitted'").get(planId)
      if (!origin || !attempt || count !== 1 || card.state !== 'dispatching' || card.receipt !== null) {
        throw new SchedulerError('invalid_state', 'Scheduled delivery cannot be safely reclaimed')
      }
      const why = String(reason).slice(0, 500)
      const now = this.clock()
      this.db.prepare("UPDATE cards SET state='cancelled', ended_at=? WHERE plan_id=? AND card_id=?").run(now, planId, cardId)
      this.db.prepare("UPDATE plans SET status='cancelled', ended_at=?, cancel_reason=? WHERE plan_id=?").run(now, why, planId)
      this.db.prepare("UPDATE scheduled_attempts SET state='confirmed_unsent', reason=?, at=? WHERE plan_id=?").run(why, now, planId)
      this.event(planId, cardId, 'scheduled_delivery_reclaimed', { reason: why, schedule_id: origin.schedule_id, occurrence_at: origin.occurrence_at })
      return { plan_id: plan.plan_id, state: 'confirmed_unsent' }
    })
  }

  markDispatchUnknown(planId, cardId, { reason }) {
    const why = text(reason, 'reason', 4000)
    return this.write(() => {
      this.plan(planId, true)
      const card = this.card(planId, cardId)
      if (card.state !== 'dispatching') throw new SchedulerError('invalid_state', `${cardId} is ${card.state}`)
      this.db.prepare("UPDATE cards SET state='unknown',fail_reason=? WHERE plan_id=? AND card_id=?")
        .run(why.slice(0, 500), planId, cardId)
      this.event(planId, cardId, 'dispatch_unknown', { reason: why.slice(0, 500) })
      return this.cardView(planId, cardId)
    })
  }

  // ---- results & acceptance -------------------------------------------------

  resultPayload(planId, cardId) {
    const row = this.db.prepare('SELECT status, terminal_event_id, member, text FROM results WHERE plan_id=? AND card_id=?')
      .get(planId, cardId)
    if (row === undefined) throw new SchedulerError('result_missing', `${planId}/${cardId}`)
    return { status: row.status, terminal_event_id: row.terminal_event_id, member: row.member, text: row.text }
  }

  observeResult(planId, cardId, { status, terminalEventId, member, receipt, text: body }) {
    if (!RESULT_STATES.includes(status)) {
      throw new SchedulerError('invalid_result_status', `status must be one of ${RESULT_STATES.join(', ')}`)
    }
    terminalEventId = identifier(terminalEventId, 'terminal_event_id')
    member = identifier(member, 'member')
    receipt = identifier(receipt, 'receipt')
    const bodyText = status === 'settled' ? text(body, 'text') : (body ?? '')
    if (typeof bodyText !== 'string') throw new SchedulerError('invalid_text', 'text must be a string')
    return this.write(() => {
      this.plan(planId, true)
      const card = this.card(planId, cardId)
      // Restart recovery can mark a previously acknowledged attempt unknown.
      const recovered = card.state === 'unknown' && card.receipt !== null && card.terminal_event_id === null
      if (card.state !== 'running' && !recovered) {
        throw new SchedulerError('invalid_state', `${cardId} is ${card.state}, expected running or acknowledged unknown`)
      }
      if (member !== card.member) throw new SchedulerError('result_member_mismatch', `${cardId} belongs to ${card.member}`)
      if (receipt !== card.receipt) throw new SchedulerError('result_receipt_mismatch', `${cardId} receipt is ${card.receipt}`)
      const existing = this.db.prepare('SELECT * FROM results WHERE plan_id=? AND card_id=?').get(planId, cardId)
      if (existing !== undefined) {
        if (existing.terminal_event_id === terminalEventId) return this.resultPayload(planId, cardId)
        if (existing.status !== 'failed') {
          throw new SchedulerError('result_conflict', 'a new terminal event may only replace a failed outcome')
        }
      }
      const now = this.clock()
      this.db.prepare(`INSERT INTO results(plan_id, card_id, status, terminal_event_id, member, receipt, text, observed_at)
        VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(plan_id, card_id) DO UPDATE SET status=excluded.status,
          terminal_event_id=excluded.terminal_event_id, member=excluded.member,
          receipt=excluded.receipt, text=excluded.text, observed_at=excluded.observed_at`)
        .run(planId, cardId, status, terminalEventId, member, receipt, bodyText, now)
      const nextState = { settled: 'running', failed: 'failed', cancelled: 'cancelled' }[status]
      this.db.prepare('UPDATE cards SET state=?, terminal_event_id=?, ended_at=?, fail_reason=? WHERE plan_id=? AND card_id=?')
        .run(nextState, terminalEventId, nextState === 'running' ? null : now,
          nextState === 'failed' ? bodyText.slice(0, 500) : null, planId, cardId)
      this.event(planId, cardId, 'result_observed', { status, terminal_event_id: terminalEventId, text: bodyText })
      return this.resultPayload(planId, cardId)
    })
  }

  acceptResult(planId, cardId, { principal, evidence }) {
    return this.write(() => {
      const plan = this.plan(planId, true)
      this.requirePrincipal(plan, principal)
      const card = this.card(planId, cardId)
      if (card.state !== 'running') {
        throw new SchedulerError('invalid_state', `${cardId} is ${card.state}, expected running`)
      }
      const payload = this.resultPayload(planId, cardId)
      if (payload.status !== 'settled') throw new SchedulerError('result_not_settled', `${cardId} outcome is ${payload.status}`)
      this.requireNoPendingTests(planId, cardId)
      this.requireConfirmed(plan, planId, cardId, payload)
      const expected = digest(payload)
      if (evidence !== `principal-result:${expected}` && evidence !== `human-result:${expected}`) {
        throw new SchedulerError('evidence_mismatch', 'evidence must bind sha256 of the observed result')
      }
      this.db.prepare("UPDATE cards SET state='verified', ended_at=? WHERE plan_id=? AND card_id=?")
        .run(this.clock(), planId, cardId)
      if (this.db.prepare("SELECT COUNT(*) AS n FROM cards WHERE plan_id=? AND state <> 'verified'").get(planId).n === 0) {
        this.db.prepare('INSERT OR IGNORE INTO retention_clock(plan_id,accepted_at) VALUES(?,?)').run(planId, this.clock())
      }
      this.event(planId, cardId, 'result_accepted', { evidence })
      return this.cardView(planId, cardId)
    })
  }

  orphanPlans(rooms) {
    const active = new Set(rooms)
    return this.db.prepare('SELECT plan_id,room,status FROM plans ORDER BY created_at,plan_id').all()
      .filter(plan => !active.has(plan.room))
  }

  cancelOrphan(planId) {
    return this.write(() => {
      this.plan(planId)
      this.db.prepare("UPDATE plans SET status='cancelled', ended_at=? WHERE plan_id=?").run(this.clock(), planId)
      this.db.prepare("UPDATE cards SET state='cancelled', ended_at=? WHERE plan_id=? AND state<>'verified'")
        .run(this.clock(), planId)
    })
  }

  consolidatedPlans() {
    return this.db.prepare(`SELECT p.plan_id, p.room, i.title, i.text FROM plans p
      JOIN plan_insights i ON i.plan_id=p.plan_id
      WHERE p.status IN ('open','completed') ORDER BY p.created_at,p.plan_id`).all().map(row => ({
      planId: row.plan_id, room: row.room, title: row.title, text: row.text,
      acceptance: this.db.prepare("SELECT goal FROM cards WHERE plan_id=? AND state='verified' ORDER BY position")
        .all(row.plan_id).map(card => card.goal).join('；'),
    }))
  }

  cancellingPlans() {
    return this.db.prepare("SELECT plan_id,room,principal,cancel_reason FROM plans WHERE status='cancelling' ORDER BY created_at,plan_id").all()
  }

  cancelledPlans() {
    return this.db.prepare(`SELECT p.plan_id,p.room FROM plans p WHERE p.status='cancelled'
      AND NOT EXISTS (SELECT 1 FROM scheduled_attempts a WHERE a.plan_id=p.plan_id AND a.state='confirmed_unsent')
      ORDER BY p.ended_at,p.plan_id`).all()
  }

  retentionCandidates(now = this.clock()) {
    this.write(() => {
      this.db.prepare(`INSERT OR IGNORE INTO retention_clock(plan_id,accepted_at)
        SELECT p.plan_id,? FROM plans p JOIN plan_insights i ON i.plan_id=p.plan_id
        WHERE p.status='completed'`).run(now)
    })
    return this.db.prepare(`SELECT p.plan_id, p.room FROM plans p
      JOIN retention_clock r ON r.plan_id=p.plan_id
      JOIN plan_insights i ON i.plan_id=p.plan_id
      WHERE p.status='completed' AND r.accepted_at<=? ORDER BY r.accepted_at,p.plan_id`)
      .all(now - 72 * 3600)
  }

  archiveSnapshot(planId) {
    const plan = this.plan(planId)
    if (plan.status !== 'completed') throw new SchedulerError('not_completed', planId)
    const insight = this.planInsight(planId)
    if (!insight) throw new SchedulerError('insight_missing', planId)
    const marks = this.db.prepare('SELECT keyword,kind,summary FROM node_marks WHERE plan_id=? ORDER BY event_seq').all(planId)
    const accepted = this.db.prepare("SELECT goal FROM cards WHERE plan_id=? AND state='verified' ORDER BY position")
      .all(planId).map(row => row.goal)
    return { planId, room: plan.room, insight, marks, summary: accepted.join('；') || insight.title }
  }

  deleteCards(planId) {
    return this.write(() => {
      const plan = this.plan(planId)
      if (!['completed', 'cancelled'].includes(plan.status)) throw new SchedulerError('plan_not_terminal', planId)
      for (const table of ['card_deps', 'results', 'test_requirements', 'test_specs', 'test_runs',
        'card_gates', 'card_notes', 'confirmations', 'preflight_decisions', 'card_comments', 'card_progress', 'cards']) {
        this.db.prepare(`DELETE FROM ${table} WHERE plan_id=?`).run(planId)
      }
    })
  }

  deletePlanDetails(planId) {
    return this.write(() => {
      const plan = this.plan(planId)
      if (!['completed', 'cancelled'].includes(plan.status)) throw new SchedulerError('plan_not_terminal', planId)
      if (this.db.prepare('SELECT 1 FROM cards WHERE plan_id=?').get(planId)) throw new SchedulerError('cards_not_removed', planId)
      this.db.prepare('DELETE FROM room_plans WHERE plan_id=?').run(planId)
      if (plan.status === 'cancelled') this.db.prepare('DELETE FROM bot_rewards WHERE plan_id=?').run(planId)
      for (const table of ['node_marks', 'events', 'plan_insights', 'plan_workdirs', 'retention_clock', 'plans']) {
        this.db.prepare(`DELETE FROM ${table} WHERE plan_id=?`).run(planId)
      }
    })
  }

  isAssignedWorker(room, botId) {
    return Boolean(this.db.prepare(`SELECT 1 FROM cards c JOIN plans p ON p.plan_id=c.plan_id
      WHERE p.room=? AND c.member=? AND p.status IN ('open','cancelling')
      AND c.state IN ('dispatching','running','unknown') LIMIT 1`).get(room, botId))
  }

  botLevel(room, botId) {
    const hasPoints = this.db.prepare('PRAGMA table_info(bot_rewards)').all().some(row => row.name === 'points')
    const { count, points } = this.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(${hasPoints ? 'points' : '10'}),0) AS points
      FROM bot_rewards WHERE room=? AND bot_id=?`).get(room, botId)
    return { count, level: points / 100, tier: points >= 2700 ? 'premium' : points >= 1600 ? 'excellent' : 'normal' }
  }

  // ---- v2: independent test admission -------------------------------------

  childTestSpec(planId, cardId) {
    const plan = this.plan(planId)
    this.card(planId, cardId)
    const row = this.db.prepare('SELECT command, workdir FROM test_specs WHERE plan_id=? AND card_id=?').get(planId, cardId)
    if (row === undefined) throw new SchedulerError('operator_test_command_required', `${cardId} is test-required but has no test command`)
    return { command: row.command, workdir: row.workdir, confirm_required: Boolean(plan.confirm_required) }
  }

  testStatus(planId, cardId) {
    this.plan(planId)
    const current = this.card(planId, cardId)
    const required = this.db.prepare('SELECT 1 AS n FROM test_requirements WHERE plan_id=? AND card_id=?').get(planId, cardId) !== undefined
    const spec = this.db.prepare('SELECT command, workdir FROM test_specs WHERE plan_id=? AND card_id=?').get(planId, cardId)
    const run = this.db.prepare('SELECT terminal, state, receipt, finished_at FROM test_runs WHERE plan_id=? AND card_id=?').get(planId, cardId)
    return {
      required,
      spec: spec ? { command: spec.command, workdir: spec.workdir } : null,
      run: run ? { terminal: run.terminal, state: run.state, receipt: run.receipt, finished_at: run.finished_at } : null,
      passed_current: Boolean(run && run.state === 'passed' && current.terminal_event_id !== null
        && run.terminal === current.terminal_event_id),
    }
  }

  admitTests(planId, cardId, { terminal }) {
    terminal = identifier(terminal, 'terminal')
    return this.write(() => {
      this.plan(planId, true)
      const card = this.card(planId, cardId)
      if (!this.db.prepare('SELECT 1 AS n FROM test_requirements WHERE plan_id=? AND card_id=?').get(planId, cardId)) {
        throw new SchedulerError('test_not_required', `${cardId} has no tests requirement`)
      }
      if (card.state !== 'running' || card.terminal_event_id !== terminal) {
        throw new SchedulerError('result_not_ready_for_tests', `${cardId} must be running with result terminal ${terminal}`)
      }
      const payload = this.resultPayload(planId, cardId)
      if (payload.terminal_event_id !== terminal || payload.status !== 'settled') {
        throw new SchedulerError('result_not_ready_for_tests', `${cardId} result on ${terminal} is not settled`)
      }
      if (this.db.prepare('SELECT 1 AS n FROM test_runs WHERE plan_id=? AND card_id=?').get(planId, cardId)) {
        throw new SchedulerError('test_run_already_admitted', `${cardId} admission already recorded`)
      }
      this.db.prepare("INSERT INTO test_runs(plan_id, card_id, terminal, state, receipt) VALUES(?,?,?,'unknown',NULL)")
        .run(planId, cardId, terminal)
      this.event(planId, cardId, 'tests_admitted', { terminal })
      return this.testStatus(planId, cardId)
    })
  }

  finishTests(planId, cardId, { terminal, result }) {
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      throw new SchedulerError('invalid_args', 'result must be a JSON object')
    }
    terminal = identifier(terminal, 'terminal')
    const passed = Number.isInteger(result.exit_code) && result.exit_code === 0 && !result.error
    const state = passed ? 'passed' : 'failed'
    return this.write(() => {
      this.plan(planId, true)
      const changed = this.db.prepare(`UPDATE test_runs SET state=?, receipt=?, finished_at=?
        WHERE plan_id=? AND card_id=? AND terminal=? AND state='unknown' AND receipt IS NULL`)
        .run(state, canonicalJson(result), this.clock(), planId, cardId, terminal)
      if (changed.changes !== 1) {
        throw new SchedulerError('invalid_test_run', `${cardId}: no open admission for terminal ${terminal}`)
      }
      this.event(planId, cardId, 'tests_finished', { terminal, state })
      return this.testStatus(planId, cardId)
    })
  }

  requireNoPendingTests(planId, cardId) {
    const pending = this.db.prepare(`SELECT 1 AS n FROM test_requirements q
      WHERE q.plan_id=? AND q.card_id=? AND NOT EXISTS (
        SELECT 1 FROM test_runs t JOIN results r
          ON t.plan_id=r.plan_id AND t.card_id=r.card_id AND t.terminal=r.terminal_event_id
        WHERE t.plan_id=q.plan_id AND t.card_id=q.card_id AND t.state='passed')`).get(planId, cardId)
    if (pending) {
      throw new SchedulerError('trusted_test_verification_required',
        `${cardId}: trusted tests must pass on the current result terminal`)
    }
  }

  // ---- v2: per-card owner confirmation ------------------------------------

  pendingPreflight(planId) {
    const plan = this.plan(planId)
    if (!this.preflightAvailable || plan.status !== 'open') return []
    const rows = this.db.prepare("SELECT card_id,member FROM cards WHERE plan_id=? AND state='pending' ORDER BY position").all(planId)
    return rows.flatMap(card => {
      const question = this.cardGate(planId, card.card_id)
      if (!plan.confirm_required && question === null) return []
      const deps = this.dependencies(planId, card.card_id)
      if (deps.some(id => this.card(planId, id).state !== 'verified')) return []
      const decision = this.db.prepare('SELECT decision,note FROM preflight_decisions WHERE plan_id=? AND card_id=?')
        .get(planId, card.card_id)
      return decision?.decision === 'approve' ? [] : [{ card_id: card.card_id, member: card.member,
        question, decision: decision?.decision ?? null, note: decision?.note ?? null, stage: 'before_dispatch' }]
    })
  }

  cardComments(planId, cardId) {
    if (!this.preflightAvailable) return []
    return this.db.prepare('SELECT author,text,at FROM card_comments WHERE plan_id=? AND card_id=? ORDER BY at')
      .all(planId, cardId).map(row => ({ ...row }))
  }

  decidePreflight(planId, cardId, { decision, note: memo = '', decidedBy }) {
    if (!['approve', 'reject'].includes(decision)) throw new SchedulerError('invalid_decision', decision)
    if (decidedBy !== 'user') throw new SchedulerError('owner_required', 'Only the user can decide before dispatch')
    if (typeof memo !== 'string' || memo.length > 500) throw new SchedulerError('invalid_text', 'note must be <= 500 chars')
    return this.write(() => {
      const plan = this.plan(planId, true)
      const card = this.card(planId, cardId)
      if (card.state !== 'pending') throw new SchedulerError('card_not_waiting', `${cardId} is ${card.state}`)
      if (!plan.confirm_required && this.cardGate(planId, cardId) === null) throw new SchedulerError('confirm_not_required', cardId)
      if (this.dependencies(planId, cardId).some(id => this.card(planId, id).state !== 'verified')) {
        throw new SchedulerError('dependencies_pending', cardId)
      }
      if (this.db.prepare('SELECT 1 FROM preflight_decisions WHERE plan_id=? AND card_id=?').get(planId, cardId)) {
        throw new SchedulerError('already_decided', cardId)
      }
      this.db.prepare('INSERT INTO preflight_decisions(plan_id,card_id,decision,note,decided_by,at) VALUES(?,?,?,?,?,?)')
        .run(planId, cardId, decision, memo.trim() || null, decidedBy, this.clock())
      if (memo.trim()) this.db.prepare('INSERT INTO card_comments(plan_id,card_id,author,text,at) VALUES(?,?,?,?,?)')
        .run(planId, cardId, decidedBy, memo.trim(), this.clock())
      this.event(planId, cardId, 'preflight_decided', { decision, note: memo.trim() || null })
      return { card_id: cardId, decision, note: memo.trim() || null }
    })
  }

  decideConfirmation(planId, cardId, { principal, decision, note: memo = '', expectedTerminal = null }) {
    if (decision !== 'approve' && decision !== 'reject') {
      throw new SchedulerError('invalid_decision', "decision must be 'approve' or 'reject'")
    }
    if (typeof memo !== 'string' || memo.length > 500) {
      throw new SchedulerError('invalid_text', 'note must be a string <= 500 chars')
    }
    return this.write(() => {
      const plan = this.plan(planId, true)
      this.requirePrincipal(plan, principal)
      if (!plan.confirm_required && this.cardGate(planId, cardId) === null) {
        throw new SchedulerError('confirm_not_required', `${planId} was created without a confirm gate`)
      }
      const card = this.card(planId, cardId)
      if (card.state !== 'running') throw new SchedulerError('card_not_waiting', `${cardId} is ${card.state}, expected running`)
      const payload = this.resultPayload(planId, cardId)
      if (payload.status !== 'settled') {
        throw new SchedulerError('result_not_ready_for_confirmation', `${cardId} outcome is ${payload.status}`)
      }
      const terminal = payload.terminal_event_id
      if (expectedTerminal !== null && terminal !== expectedTerminal) {
        throw new SchedulerError('result_changed_during_confirmation', `${cardId}: the submitted result changed while awaiting approval`)
      }
      if (this.db.prepare('SELECT 1 AS n FROM confirmations WHERE plan_id=? AND card_id=? AND terminal=?')
        .get(planId, cardId, terminal)) {
        throw new SchedulerError('already_decided', `${cardId} already decided for ${terminal}`)
      }
      this.db.prepare(`INSERT INTO confirmations(plan_id, card_id, terminal, decision, note, decided_by, at)
        VALUES(?,?,?,?,?,?,?)`)
        .run(planId, cardId, terminal, decision, memo.trim() || null, principal, this.clock())
      this.event(planId, cardId, 'confirmation_decided', { terminal, decision })
      return { card_id: cardId, terminal, decision, note: memo.trim() || null, decided_by: principal }
    })
  }

  pendingConfirmations(planId) {
    const plan = this.plan(planId)
    if (!plan.confirm_required && !this.db.prepare('SELECT 1 FROM card_gates WHERE plan_id=? LIMIT 1').get(planId)) return []
    const rows = this.db.prepare(`SELECT c.card_id, c.member, r.terminal_event_id
      FROM cards c JOIN results r ON c.plan_id=r.plan_id AND c.card_id=r.card_id
      WHERE c.plan_id=? AND c.state='running' AND r.status='settled' ORDER BY c.position`).all(planId)
    const out = []
    for (const row of rows) {
      const decided = this.db.prepare('SELECT decision FROM confirmations WHERE plan_id=? AND card_id=? AND terminal=?')
        .get(planId, row.card_id, row.terminal_event_id)
      if (this.db.prepare("SELECT 1 FROM preflight_decisions WHERE plan_id=? AND card_id=? AND decision='approve'")
        .get(planId, row.card_id)) continue
      if (decided === undefined) {
        const gate = this.db.prepare('SELECT question FROM card_gates WHERE plan_id=? AND card_id=?').get(planId, row.card_id)
        if (!plan.confirm_required && !gate) continue
        out.push({ card_id: row.card_id, member: row.member, terminal: row.terminal_event_id, question: gate?.question ?? null })
      }
    }
    return out
  }

  cardGate(planId, cardId) {
    return this.db.prepare('SELECT question FROM card_gates WHERE plan_id=? AND card_id=?').get(planId, cardId)?.question ?? null
  }

  requireConfirmed(plan, planId, cardId, payload) {
    const gate = this.cardGate(planId, cardId)
    if (!plan.confirm_required && gate === null) return
    const preflight = this.db.prepare('SELECT decision FROM preflight_decisions WHERE plan_id=? AND card_id=?')
      .get(planId, cardId)
    if (preflight?.decision === 'approve') return
    if (preflight?.decision === 'reject') throw new SchedulerError('confirm_rejected', `${cardId}: user rejected before dispatch`)
    const terminal = payload.terminal_event_id
    const row = this.db.prepare('SELECT decision, note FROM confirmations WHERE plan_id=? AND card_id=? AND terminal=?')
      .get(planId, cardId, terminal)
    if (row === undefined) {
      throw new SchedulerError('confirm_pending', `${cardId}: waiting for the owner's confirmation on ${terminal}`)
    }
    if (row.decision === 'reject') {
      throw new SchedulerError('confirm_rejected', `${cardId}: owner rejected ${terminal}${row.note ? ` (${row.note})` : ''}`)
    }
  }

  // ---- execution insights --------------------------------------------------

  note(planId, cardId, { member, text: body, auto = false, isDuplicate }) {
    member = identifier(member, 'member')
    const noteText = text(body, 'text', 8000)
    return this.write(() => {
      this.plan(planId)
      const card = this.card(planId, cardId)
      if (card.member !== member) throw new SchedulerError('not_card_executor', `${cardId} belongs to ${card.member}`)
      if (!['running', 'verified', 'failed', 'cancelled'].includes(card.state)) {
        throw new SchedulerError('invalid_state', `${cardId} is ${card.state}, no outcome yet`)
      }
      if (this.db.prepare('SELECT 1 AS n FROM plan_insights WHERE plan_id=?').get(planId)) {
        throw new SchedulerError('insight_already_consolidated', planId)
      }
      const existing = this.db.prepare('SELECT auto FROM card_notes WHERE plan_id=? AND card_id=?').get(planId, cardId)
      if (existing !== undefined && !existing.auto && !auto) {
        throw new SchedulerError('note_conflict', `${cardId} already has a real note`)
      }
      if (!auto && isDuplicate) {
        const peers = this.db.prepare(`SELECT card_id, text FROM card_notes
          WHERE plan_id=? AND card_id<>? AND auto=0 ORDER BY at, card_id`).all(planId, cardId)
        const duplicate = peers.find(peer => isDuplicate(peer.text))
        if (duplicate) throw new SchedulerError('note_duplicate',
          `心得与卡 ${duplicate.card_id} 已保存的心得高度相似。请根据自己这张卡的实际判断、证据和核验方法重写，再提交原卡。`)
      }
      this.db.prepare(`INSERT INTO card_notes(plan_id, card_id, member, text, auto, at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(plan_id, card_id) DO UPDATE SET text=excluded.text, auto=excluded.auto, at=excluded.at`)
        .run(planId, cardId, card.member, noteText, auto ? 1 : 0, this.clock())
      this.event(planId, cardId, auto ? 'note_auto_standed' : 'note_saved', { text: noteText })
      return { card_id: cardId, member: card.member, auto: Boolean(auto), text: noteText }
    })
  }

  ensureAutoNotes(planId) {
    this.plan(planId)
    if (this.db.prepare('SELECT 1 AS n FROM plan_insights WHERE plan_id=?').get(planId)) return []
    const rows = this.db.prepare(`SELECT card_id, member FROM cards WHERE plan_id=?
      AND state IN ('verified','failed','cancelled')
      AND card_id NOT IN (SELECT card_id FROM card_notes WHERE plan_id=?) ORDER BY position`).all(planId, planId)
    const standed = []
    for (const row of rows) {
      this.note(planId, row.card_id, { member: row.member, text: AUTO_NOTE, auto: true })
      standed.push(row.card_id)
    }
    return standed
  }

  pendingNotes(planId) {
    this.plan(planId)
    if (this.db.prepare('SELECT 1 AS n FROM plan_insights WHERE plan_id=?').get(planId)) return []
    return this.db.prepare(`SELECT card_id FROM cards WHERE plan_id=?
      AND state IN ('verified','failed','cancelled')
      AND card_id NOT IN (SELECT card_id FROM card_notes WHERE plan_id=?) ORDER BY position`)
      .all(planId, planId).map(row => row.card_id)
  }

  listNotes(planId) {
    return this.db.prepare('SELECT card_id, member, text, auto, at FROM card_notes WHERE plan_id=? ORDER BY card_id')
      .all(planId).map(row => ({ card_id: row.card_id, member: row.member, text: row.text, auto: Boolean(row.auto), at: row.at }))
  }

  consolidate(planId, { principal, title, text: body }) {
    title = identifier(title, 'title')
    if (title.length > 64) throw new SchedulerError('invalid_text', 'title must be <= 64 chars')
    const bodyText = text(body, 'text', 12000)
    return this.write(() => {
      const plan = this.plan(planId)
      this.requirePrincipal(plan, principal)
      const unfinished = this.db.prepare(`SELECT COUNT(*) AS n FROM cards WHERE plan_id=?
        AND state <> 'verified'`).get(planId).n
      if (unfinished > 0) throw new SchedulerError('not_all_verified', `${planId}: ${unfinished} cards not accepted`)
      const existing = this.db.prepare('SELECT title, text FROM plan_insights WHERE plan_id=?').get(planId)
      if (existing !== undefined) {
        if (existing.title === title && existing.text === bodyText) return this.planInsight(planId)
        throw new SchedulerError('insight_conflict', planId)
      }
      const missing = this.pendingNotes(planId)
      if (missing.length > 0) throw new SchedulerError('executor_notes_pending', `cards without notes: ${missing.join(', ')}`)
      this.db.prepare('INSERT INTO plan_insights(plan_id, title, text, at) VALUES(?,?,?,?)')
        .run(planId, title, bodyText, this.clock())
      this.db.prepare('DELETE FROM card_notes WHERE plan_id=?').run(planId)
      this.event(planId, null, 'insight_consolidated', { title, text: bodyText })
      return this.planInsight(planId)
    })
  }

  planInsight(planId) {
    const row = this.db.prepare('SELECT title, text, at FROM plan_insights WHERE plan_id=?').get(planId)
    return row === undefined ? null : { plan_id: planId, title: row.title, text: row.text, at: row.at }
  }

  confirmations(planId) {
    return this.db.prepare(`SELECT card_id, terminal, decision, note, decided_by, at
      FROM confirmations WHERE plan_id=? ORDER BY card_id, terminal`).all(planId)
      .map(row => ({ ...row }))
  }

  // ---- failure / retry / rework --------------------------------------------

  cancelDependents(planId, cardId) {
    const queue = [cardId]
    const seen = new Set(queue)
    while (queue.length) {
      const previous = queue.shift()
      const next = this.db.prepare(`SELECT c.card_id FROM card_deps d JOIN cards c
        ON c.plan_id=d.plan_id AND c.card_id=d.card_id
        WHERE d.plan_id=? AND d.depends_on=? AND c.state='pending'`).all(planId, previous)
      for (const child of next) {
        if (seen.has(child.card_id)) continue
        seen.add(child.card_id)
        this.db.prepare("UPDATE cards SET state='cancelled',ended_at=?,fail_reason=? WHERE plan_id=? AND card_id=?")
          .run(this.clock(), `dependency ${cardId} failed`, planId, child.card_id)
        this.event(planId, child.card_id, 'card_cancelled', { reason: `dependency ${cardId} failed` })
        queue.push(child.card_id)
      }
    }
  }

  failMemberCards(room, member) {
    return this.write(() => {
      const affected = this.db.prepare(`SELECT c.plan_id,c.card_id FROM cards c JOIN plans p ON p.plan_id=c.plan_id
        WHERE p.room=? AND p.status='open' AND c.member=?
        AND c.state IN ('pending','dispatching','running','unknown') ORDER BY c.position`)
        .all(room, member)
      for (const { plan_id: planId, card_id: cardId } of affected) {
        this.db.prepare("UPDATE cards SET state='failed',ended_at=?,fail_reason=? WHERE plan_id=? AND card_id=?")
          .run(this.clock(), 'member left the group', planId, cardId)
        this.event(planId, cardId, 'card_failed', { reason: 'member left the group' })
        this.cancelDependents(planId, cardId)
      }
      return affected.map(row => ({ planId: row.plan_id, id: row.card_id }))
    })
  }

  failCard(planId, cardId, { reason }) {
    const why = text(reason, 'reason', 4000)
    return this.write(() => {
      this.plan(planId, true)
      const card = this.card(planId, cardId)
      if (!IN_FLIGHT.includes(card.state)) {
        throw new SchedulerError('invalid_state', `${cardId} is ${card.state}, expected one of ${IN_FLIGHT.join(',')}`)
      }
      if (this.db.prepare('SELECT 1 FROM results WHERE plan_id=? AND card_id=?').get(planId, cardId)) {
        throw new SchedulerError('result_already_submitted', `${cardId} has a result awaiting review`)
      }
      this.db.prepare("UPDATE cards SET state='failed', ended_at=?, fail_reason=? WHERE plan_id=? AND card_id=?")
        .run(this.clock(), why.slice(0, 500), planId, cardId)
      this.event(planId, cardId, 'card_failed', { reason: why.slice(0, 500) })
      return this.cardView(planId, cardId)
    })
  }

  resetToPending(planId, cardId, allowedStates) {
    const plan = this.plan(planId, true)
    const card = this.card(planId, cardId)
    if (!allowedStates.includes(card.state)) {
      throw new SchedulerError('invalid_state', `${cardId} is ${card.state}, expected one of ${allowedStates.join(',')}`)
    }
    if (card.attempts > plan.retry_limit) {
      throw new SchedulerError('retries_exhausted', `${cardId} used ${card.attempts} attempts (limit ${plan.retry_limit} retries)`)
    }
    this.db.prepare(`UPDATE cards SET state='pending', receipt=NULL, terminal_event_id=NULL,
      dispatched_at=NULL, started_at=NULL, ended_at=NULL, fail_reason=NULL WHERE plan_id=? AND card_id=?`)
      .run(planId, cardId)
    this.db.prepare('DELETE FROM results WHERE plan_id=? AND card_id=?').run(planId, cardId)
    this.db.prepare('DELETE FROM test_runs WHERE plan_id=? AND card_id=?').run(planId, cardId)
    this.db.prepare('DELETE FROM card_progress WHERE plan_id=? AND card_id=?').run(planId, cardId)
    this.event(planId, cardId, 'card_retried', { attempts_so_far: card.attempts })
    return this.cardView(planId, cardId)
  }

  touchMemberProgress(room, member) {
    if (!this.progressAvailable) return 0
    return this.write(() => this.db.prepare(`INSERT INTO card_progress(plan_id,card_id,at)
      SELECT c.plan_id,c.card_id,? FROM cards c JOIN plans p ON p.plan_id=c.plan_id
      WHERE p.room=? AND p.status='open' AND c.member=? AND c.state='running'
      AND NOT EXISTS (SELECT 1 FROM results r WHERE r.plan_id=c.plan_id AND r.card_id=c.card_id)
      ON CONFLICT(plan_id,card_id) DO UPDATE SET at=excluded.at`).run(this.clock(), room, member).changes)
  }

  executingMembers(room) {
    return this.db.prepare(`SELECT DISTINCT c.member FROM cards c JOIN plans p ON p.plan_id=c.plan_id
      WHERE p.room=? AND p.status='open' AND c.state IN ('dispatching','running')
      AND c.terminal_event_id IS NULL`).all(room).map(row => row.member)
  }

  stalledCards({ noStartSeconds = 300, noProgressSeconds = 3600 } = {}) {
    const now = this.clock()
    const progress = this.progressAvailable ? 'LEFT JOIN card_progress cp ON cp.plan_id=c.plan_id AND cp.card_id=c.card_id' : ''
    const last = this.progressAvailable ? 'COALESCE(cp.at,c.started_at)' : 'c.started_at'
    return this.db.prepare(`SELECT p.room,c.plan_id AS planId,c.card_id AS cardId,c.member,c.state,c.attempts
      FROM cards c JOIN plans p ON p.plan_id=c.plan_id ${progress}
      WHERE p.status='open' AND (
        (c.state='dispatching' AND c.dispatched_at<=?) OR
        (c.state='running' AND ${last}<=? AND NOT EXISTS (
          SELECT 1 FROM results r WHERE r.plan_id=c.plan_id AND r.card_id=c.card_id))
      ) ORDER BY c.dispatched_at`).all(now - noStartSeconds, now - noProgressSeconds)
  }

  settleFailure(planId, cardId) {
    return this.write(() => {
      const plan = this.plan(planId, true)
      const card = this.card(planId, cardId)
      if (card.state !== 'failed') throw new SchedulerError('invalid_state', `${cardId} is ${card.state}`)
      if (card.attempts <= plan.retry_limit) {
        this.resetToPending(planId, cardId, ['failed'])
        return { state: 'pending', attempts: card.attempts, limit: plan.retry_limit + 1 }
      }
      this.cancelDependents(planId, cardId)
      this.event(planId, cardId, 'retries_exhausted', { attempts: card.attempts })
      return { state: 'failed', attempts: card.attempts, limit: plan.retry_limit + 1 }
    })
  }

  failureReasons(planId, cardId) {
    return this.db.prepare("SELECT type,payload FROM events WHERE plan_id=? AND card_id=? AND type IN ('result_observed','card_failed') ORDER BY seq")
      .all(planId, cardId).flatMap(row => {
        const detail = JSON.parse(row.payload)
        return row.type === 'result_observed' && detail.status !== 'failed' ? [] : [detail.text ?? detail.reason ?? 'failed']
      })
  }

  retryCard(planId, cardId, { principal }) {
    return this.write(() => {
      const plan = this.plan(planId, true)
      this.requirePrincipal(plan, principal)
      return this.resetToPending(planId, cardId, ['failed'])
    })
  }

  reworkCard(planId, cardId, { principal }) {
    return this.write(() => {
      const plan = this.plan(planId, true)
      this.requirePrincipal(plan, principal)
      return this.resetToPending(planId, cardId, ['running'])
    })
  }

  resolveUnknown(planId, cardId, { principal, decision }) {
    if (decision !== 'retry' && decision !== 'fail') {
      throw new SchedulerError('unknown_decision', "decision must be 'retry' or 'fail'")
    }
    return this.write(() => {
      const plan = this.plan(planId, true)
      this.requirePrincipal(plan, principal)
      if (decision === 'retry') return this.resetToPending(planId, cardId, ['unknown'])
      const card = this.card(planId, cardId)
      if (card.state !== 'unknown') throw new SchedulerError('invalid_state', `${cardId} is ${card.state}, expected unknown`)
      this.db.prepare("UPDATE cards SET state='failed', ended_at=?, fail_reason='resolved unknown as failed' WHERE plan_id=? AND card_id=?")
        .run(this.clock(), planId, cardId)
      this.event(planId, cardId, 'unknown_resolved', { decision: 'fail' })
      this.cancelDependents(planId, cardId)
      return this.cardView(planId, cardId)
    })
  }

  // ---- completion / cancellation ------------------------------------------

  completionSnapshot(planId) {
    const plan = this.plan(planId)
    const cards = this.db.prepare('SELECT * FROM cards WHERE plan_id=? ORDER BY position').all(planId).map(card => ({
      id: card.card_id, member: card.member, goal: card.goal,
      dependencies: this.dependencies(planId, card.card_id),
      state: card.state, attempts: card.attempts,
    }))
    const results = {}
    for (const row of this.db.prepare('SELECT card_id, status, terminal_event_id, member, text FROM results WHERE plan_id=? ORDER BY card_id').all(planId)) {
      results[row.card_id] = { status: row.status, terminal_event_id: row.terminal_event_id, member: row.member, text: row.text }
    }
    const snapshot = {
      plan: {
        plan_id: plan.plan_id, room: plan.room, principal: plan.principal,
        concurrency: plan.concurrency, retry_limit: plan.retry_limit, status: plan.status,
      },
      cards,
      results,
    }
    const runs = {}
    for (const row of this.db.prepare('SELECT card_id, terminal, state FROM test_runs WHERE plan_id=? ORDER BY card_id').all(planId)) {
      runs[row.card_id] = { terminal: row.terminal, state: row.state }
    }
    if (Object.keys(runs).length > 0) snapshot.test_runs = runs
    const confirmations = this.db.prepare(`SELECT card_id, terminal, decision FROM confirmations
      WHERE plan_id=? ORDER BY card_id, terminal`).all(planId).map(row => ({ ...row }))
    if (confirmations.length > 0) snapshot.confirmations = confirmations
    const insight = this.db.prepare('SELECT title, text FROM plan_insights WHERE plan_id=?').get(planId)
    if (insight !== undefined) snapshot.insight = { title: insight.title, text: insight.text }
    return snapshot
  }

  finishPlan(planId, { principal, expectedSnapshot, evidence }) {
    if (expectedSnapshot === null || typeof expectedSnapshot !== 'object' || Array.isArray(expectedSnapshot)) {
      throw new SchedulerError('trusted_final_review_required', 'expected_snapshot object is required')
    }
    return this.write(() => {
      const plan = this.plan(planId, true)
      this.requirePrincipal(plan, principal)
      const snapshot = this.completionSnapshot(planId)
      if (canonicalJson(expectedSnapshot) !== canonicalJson(snapshot)) {
        throw new SchedulerError('plan_changed_during_confirmation', 'completion snapshot changed since review')
      }
      const unverified = snapshot.cards.filter(card => card.state !== 'verified').map(card => card.id)
      if (unverified.length > 0) throw new SchedulerError('not_all_verified', `cards not verified: ${unverified.join(', ')}`)
      const expected = digest(snapshot)
      if (evidence !== `principal-plan:${expected}` && evidence !== `human-plan:${expected}`) {
        throw new SchedulerError('evidence_mismatch', 'evidence must bind sha256 of the completion snapshot')
      }
      this.db.prepare("UPDATE plans SET status='completed', ended_at=? WHERE plan_id=?").run(this.clock(), planId)
      const workers = new Set(snapshot.cards.map(card => card.member).filter(member => member !== principal))
      for (const member of workers) {
        const points = this.botLevel(plan.room, member).tier === 'normal' ? 10 : 1
        this.db.prepare('INSERT OR IGNORE INTO bot_rewards(room,plan_id,bot_id,at,points) VALUES(?,?,?,?,?)')
          .run(plan.room, planId, member, this.clock(), points)
      }
      this.event(planId, null, 'plan_finished', { evidence })
      return this.planState(planId)
    })
  }

  requestCancel(planId, { principal, reason }) {
    const why = text(reason, 'reason', 4000)
    if (why.length > 500) throw new SchedulerError('invalid_text', 'reason must be <= 500 chars')
    return this.write(() => {
      const plan = this.plan(planId)
      this.requirePrincipal(plan, principal)
      if (plan.status !== 'open' && plan.status !== 'cancelling') {
        throw new SchedulerError('plan_not_open', `${planId} is ${plan.status}`)
      }
      if (plan.status === 'open') {
        this.db.prepare("UPDATE plans SET status='cancelling', cancel_reason=? WHERE plan_id=?")
          .run(why, planId)
        this.event(planId, null, 'plan_cancellation_requested', { reason: why })
      }
      const rows = this.db.prepare("SELECT member FROM cards WHERE plan_id=? AND state IN ('dispatching','running','unknown') ORDER BY position").all(planId)
      return { plan_id: planId, status: 'cancelling', stop_members: [...new Set(rows.map(row => row.member))] }
    })
  }

  finishCancel(planId, { principal }) {
    return this.write(() => {
      const plan = this.plan(planId)
      this.requirePrincipal(plan, principal)
      if (plan.status !== 'cancelling') throw new SchedulerError('cancel_not_pending', `${planId} is ${plan.status}`)
      this.db.prepare("UPDATE cards SET state='cancelled', ended_at=? WHERE plan_id=? AND state != 'verified'")
        .run(this.clock(), planId)
      this.db.prepare("UPDATE plans SET status='cancelled', ended_at=? WHERE plan_id=?")
        .run(this.clock(), planId)
      this.event(planId, null, 'plan_cancelled', { reason: plan.cancel_reason })
      return { plan_id: planId, status: 'cancelled' }
    })
  }

  // ---- projections ---------------------------------------------------------

  cardView(planId, cardId) {
    const card = this.card(planId, cardId)
    return {
      id: card.card_id, member: card.member, goal: card.goal,
      dependencies: this.dependencies(planId, cardId),
      state: card.state, attempts: card.attempts, receipt: card.receipt,
      terminal_event_id: card.terminal_event_id, fail_reason: card.fail_reason,
      dispatched_at: card.dispatched_at, started_at: card.started_at, ended_at: card.ended_at,
      confirm: this.cardGate(planId, cardId),
    }
  }

  planState(planId) {
    const plan = this.plan(planId)
    const cards = this.db.prepare('SELECT card_id FROM cards WHERE plan_id=? ORDER BY position').all(planId)
      .map(row => this.cardView(planId, row.card_id))
    return {
      plan_id: plan.plan_id, room: plan.room, principal: plan.principal, goal: plan.goal,
      group_goal_id: plan.group_goal_id ?? null,
      reflection_released: Boolean(plan.reflection_released),
      concurrency: plan.concurrency, retry_limit: plan.retry_limit,
      status: plan.status, created_at: plan.created_at, ended_at: plan.ended_at,
      cancel_reason: plan.cancel_reason, confirm_required: Boolean(plan.confirm_required),
      cards,
      in_flight: cards.filter(card => IN_FLIGHT.includes(card.state)).length,
      ready: plan.status === 'open' ? this.readyCards(planId) : [],
    }
  }

  events(planId, afterSeq = 0) {
    return this.db.prepare('SELECT seq, card_id, type, payload, at FROM events WHERE plan_id=? AND seq>? ORDER BY seq')
      .all(planId, afterSeq).map(row => ({
        seq: row.seq, card_id: row.card_id, type: row.type,
        payload: JSON.parse(row.payload), at: row.at,
      }))
  }

  timelinePlanIds(rooms) {
    if (!rooms.length) return []
    const slots = rooms.map(() => '?').join(',')
    return this.db.prepare(`SELECT plan_id FROM plans WHERE room IN (${slots})`).all(...rooms).map(row => row.plan_id)
  }

  timeline(rooms, limit = 120) {
    return this.timelinePage(rooms, { limit }).events
  }

  timelinePage(rooms, { limit = 120, before = null, planIds = null } = {}) {
    if (!rooms.length || (planIds && !planIds.length)) return { events: [], next: null }
    if (before !== null && (!Number.isFinite(before.at) || !Number.isSafeInteger(before.seq) || before.seq < 1)) {
      throw new Error('Invalid timeline cursor')
    }
    limit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(200, limit)) : 120
    const slots = rooms.map(() => '?').join(',')
    const planSlots = planIds?.map(() => '?').join(',')
    const rows = this.db.prepare(`SELECT e.seq, e.plan_id, e.card_id, e.type, e.payload, e.at,
      p.room, p.principal, c.member, c.goal AS card_goal
      FROM events e JOIN plans p ON p.plan_id=e.plan_id
      LEFT JOIN cards c ON c.plan_id=e.plan_id AND c.card_id=e.card_id
      WHERE p.room IN (${slots}) AND e.type IN
        ('plan_created','card_claimed','receipt_bound','result_observed','result_accepted',
         'card_failed','card_retried','plan_finished','plan_cancelled')
      ${planIds ? `AND p.plan_id IN (${planSlots})` : ''}
      ${before ? 'AND (e.at < ? OR (e.at = ? AND e.seq < ?))' : ''}
      ORDER BY e.at DESC, e.seq DESC LIMIT ?`)
      .all(...rooms, ...(planIds ?? []), ...(before ? [before.at, before.at, before.seq] : []), limit + 1)
      .map(row => ({ ...row, payload: JSON.parse(row.payload) }))
    const more = rows.length > limit
    const events = rows.slice(0, limit)
    const last = events.at(-1)
    return { events, next: more ? { at: last.at, seq: last.seq } : null }
  }

  // ---- room pointer -------------------------------------------------------

  currentPlanId(room) {
    return this.db.prepare('SELECT plan_id FROM room_plans WHERE room=?').get(room)?.plan_id ?? null
  }

  setCurrentPlan(room, planId) {
    this.db.prepare('INSERT OR REPLACE INTO room_plans(room, plan_id, updated_at) VALUES(?,?,?)')
      .run(room, planId, this.clock())
  }

  plansAwaitingReflection(room) {
    return this.db.prepare(`SELECT p.* FROM plans p WHERE p.room=? AND p.status IN ('open','completed')
      AND NOT EXISTS (SELECT 1 FROM plan_insights i WHERE i.plan_id=p.plan_id)
      ORDER BY p.created_at,p.plan_id`).all(room)
  }

  releaseReflections(room, goalId, plans) {
    this.write(() => {
      const update = this.db.prepare(`UPDATE plans SET reflection_released=1, group_goal_id=?
        WHERE room=? AND plan_id=? AND (group_goal_id IS NULL OR group_goal_id=?)`)
      for (const plan of plans) update.run(goalId, room, plan.plan_id, goalId)
    })
  }

  listPlans(room) {
    return this.db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM cards c WHERE c.plan_id=p.plan_id) AS card_count,
      (SELECT COUNT(*) FROM cards c WHERE c.plan_id=p.plan_id AND c.state='verified') AS verified_count
      FROM plans p WHERE p.room=? ORDER BY p.created_at DESC LIMIT 20`).all(room)
      .map(row => ({ ...row, confirm_required: Boolean(row.confirm_required) }))
  }

  workdir(planId) {
    return this.db.prepare('SELECT workdir FROM plan_workdirs WHERE plan_id=?').get(planId)?.workdir ?? null
  }
}

function isAbsolute(path) {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}
