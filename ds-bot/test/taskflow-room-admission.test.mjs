import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { Scheduler } from '../src/host/taskflow/scheduler.js'

test('two connections cannot create overlapping plans in one room even when pointer is stale', () => {
  const dir = join(process.cwd(), '.tmp-verify', 'same-room-race')
  mkdirSync(dir, { recursive: true })
  const home = mkdtempSync(join(dir, 'ledger-'))
  const first = new Scheduler(join(home, 'coordination.sqlite'))
  const second = new Scheduler(join(home, 'coordination.sqlite'))
  const make = id => ({ planId:id, room:'room', principal:'chief', cards:[{ id:'card', member:'worker', goal:'work', dependencies:[] }] })
  try {
    assert.equal(second.currentPlanId('room'), null)
    first.createPlan(make('plan-a'))
    first.db.prepare('DELETE FROM room_plans WHERE room=?').run('room')
    assert.throws(() => second.createPlan(make('plan-b')), error => error.code === 'plan_already_open')
    second.createPlan({ ...make('other-room'), room: 'other-room' })
    first.requestCancel('plan-a', { principal:'chief', reason:'fixture' })
    assert.throws(() => second.createPlan(make('plan-b')), error => error.code === 'plan_already_open')
    first.finishCancel('plan-a', { principal:'chief' })
    second.createPlan(make('plan-b'))
    assert.equal(first.currentPlanId('room'), 'plan-b')
  } finally { first.close(); second.close() }
})
