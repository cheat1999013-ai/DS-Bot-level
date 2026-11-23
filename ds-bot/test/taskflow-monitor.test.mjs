import assert from 'node:assert/strict'
import test from 'node:test'
import { installTaskflowMonitor, taskflowRoomEnabled } from '../src/host/taskflow/monitor.js'

test('standalone monitor checks enabled groups with open work independently of selected chat', async () => {
  const calls = [], timers = [], disposed = []
  const rooms = [{ id: 'working' }, { id: 'off', taskflowEnabled: false }, { id: 'paused', goal: { status: 'paused' } }, { id: 'idle' }]
  const rt = { readOnly: () => undefined, ctx: { effect: register => disposed.push(register()) }, warn: () => {} }
  let selected = 'off'
  installTaskflowMonitor(rt, {
    rooms: () => rooms, openPlans: room => room === 'working' ? [{ plan_id: 'original', status: 'open' }] : [],
    remind: async (room, plan) => { calls.push([room.id, plan.plan_id]); return true },
    setTimer: (fn, delay) => { timers.push({ fn, delay }); return 7 }, clearTimer: id => calls.push(['clear', id]),
  })
  assert.equal(timers.length, 1)
  assert.equal(timers[0].delay, 300000)
  await rt.taskflowCheck()
  selected = 'idle'
  await rt.taskflowCheck()
  assert.equal(selected, 'idle')
  assert.deepEqual(calls, [['working', 'original'], ['working', 'original']])
  assert.equal(rt.taskflowMonitorState().rooms.working.active, true)
  assert.equal(rt.taskflowMonitorState().rooms.off.active, false)
  assert.equal(rt.taskflowMonitorState().rooms.idle.active, false)
  assert.equal(taskflowRoomEnabled(rooms[2]), false)
  disposed.forEach(fn => fn())
  assert.deepEqual(calls.at(-1), ['clear', 7])
})

test('disabled and paused groups are skipped before querying their task ledger', async () => {
  let queries = 0
  const rt = { readOnly: () => undefined, ctx: { effect: () => {} }, warn: () => {} }
  const room = { id: 'r', taskflowEnabled: false }
  installTaskflowMonitor(rt, { rooms: () => [room], openPlans: () => { queries++; return [] }, remind: async () => true })
  await rt.taskflowCheck()
  assert.equal(queries, 0)
  room.taskflowEnabled = true
  await rt.taskflowCheck()
  assert.equal(queries, 1)
  room.goal = { status: 'paused' }
  await rt.taskflowCheck()
  assert.equal(queries, 1)
})

test('task completion or group disabling after asynchronous work prevents later reminders', async () => {
  const calls = []
  const room = { id: 'r' }
  const rt = { readOnly: () => undefined, ctx: { effect: () => {} }, warn: () => {} }
  let open = true
  installTaskflowMonitor(rt, { rooms: () => [room], openPlans: () => open ? [{ plan_id: 'p', status: 'open' }] : [],
    remind: async () => { calls.push('remind'); return true } })
  await rt.taskflowCheck()
  open = false
  await rt.taskflowCheck()
  room.taskflowEnabled = false
  await rt.taskflowCheck()
  assert.deepEqual(calls, ['remind'])
})
