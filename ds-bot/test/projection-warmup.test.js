import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { projectionWarmup } from '../src/client/projection-warmup.js'

function setup() {
  const calls = []
  const errors = []
  const pending = new Map()
  const queue = projectionWarmup({
    refresh(id) {
      calls.push(id)
      const job = Promise.withResolvers()
      pending.set(id, job)
      return job.promise
    },
    onError: error => errors.push(error),
  })
  return { queue, calls, errors, pending }
}

test('a large roster starts only two background reads and prioritizes the latest selected group', async () => {
  const { queue, calls, pending } = setup()
  const ids = Array.from({ length: 80 }, (_, i) => `room-${i}`)
  queue.add(ids)
  await setImmediate()
  assert.deepEqual(calls, ids.slice(0, 2))
  queue.prioritize('room-78')
  queue.prioritize('room-79')
  queue.add(ids)
  pending.get('room-0').resolve()
  await setImmediate()
  assert.deepEqual(calls, ['room-0', 'room-1', 'room-79'])
  pending.get('room-1').resolve()
  await setImmediate()
  assert.deepEqual(calls, ['room-0', 'room-1', 'room-79', 'room-2'])
})

test('failed reads free a slot and stopping prevents queued requests from starting', async () => {
  const { queue, calls, pending, errors } = setup()
  queue.add(['a', 'b', 'c', 'd'])
  await setImmediate()
  const error = new Error('failed')
  pending.get('a').reject(error)
  await setImmediate()
  assert.deepEqual(errors, [error])
  assert.deepEqual(calls, ['a', 'b', 'c'])
  queue.stop()
  pending.get('c').resolve()
  queue.add(['e'])
  await setImmediate()
  assert.deepEqual(calls, ['a', 'b', 'c'])
})
