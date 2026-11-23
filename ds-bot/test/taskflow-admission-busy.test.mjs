import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { Scheduler } from '../src/host/taskflow/scheduler.js'

test('a busy database before plan admission is safe to retry after the lock clears', () => {
  const dir = join(process.cwd(), '.tmp-verify', 'same-room-race')
  mkdirSync(dir, { recursive:true })
  const home = mkdtempSync(join(dir, 'busy-'))
  const a = new Scheduler(join(home, 'ledger.sqlite'), { recoverOnOpen:false })
  const b = new Scheduler(join(home, 'ledger.sqlite'), { recoverOnOpen:false })
  const plan = { planId:'plan', room:'room', principal:'chief', cards:[{ id:'card', member:'worker', goal:'work', dependencies:[] }] }
  try {
    a.db.exec('BEGIN IMMEDIATE')
    assert.throws(() => b.createPlan(plan), error => error.code === 'taskflow_admission_busy')
    a.db.exec('ROLLBACK')
    assert.equal(b.createPlan(plan).plan_id, 'plan')
  } finally { if (a.db.isTransaction) a.db.exec('ROLLBACK'); a.close(); b.close() }
})
