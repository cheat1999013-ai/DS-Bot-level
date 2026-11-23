import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture } from './taskflow-fixture.mjs'
import { Scheduler } from '../src/host/taskflow/scheduler.js'

test('a lock after plan commit cannot make successful plan creation fail', () => {
  const env = fixture()
  const lock = new Scheduler(env.scheduler.path, { recoverOnOpen: false })
  const create = env.scheduler.createPlan.bind(env.scheduler)
  env.scheduler.createPlan = args => { const result = create(args); lock.db.exec('BEGIN IMMEDIATE'); return result }
  try {
    const result = env.service.plan({ planId:'committed', goal:'work', children:[{id:'card',member:'bot-a',goal:'work'}] }, env.admin)
    assert.equal(result.plan.plan_id, 'committed')
    assert.equal(env.scheduler.currentPlanId('room-1'), 'committed')
  } finally {
    if (lock.db.isTransaction) lock.db.exec('ROLLBACK')
    lock.close(); env.scheduler.close(); env.knowledge.close()
  }
})
