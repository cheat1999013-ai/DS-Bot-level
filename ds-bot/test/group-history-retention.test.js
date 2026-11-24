import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as navigation from '../src/client/open-listed.js'

function source(value) {
  const listeners = new Set()
  return { getSnapshot: () => value, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }, set(next) { value = next; for (const fn of listeners) fn() } }
}

test('switching A to B and back reuses the native history and keeps only recent group parts', async () => {
  const rooms = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, sessionId: `${id}-part` }))
  const roster = source({ rooms })
  const list = source({ byId: {} })
  const references = new Map()
  const reads = []
  const retain = (id, { source }) => {
    if (!references.has(id)) reads.push(id)
    references.set(id, (references.get(id) ?? 0) + 1)
    if (source !== 'mainView') assert.equal(source, 'dsBotGroupHistory')
    return { ready: Promise.resolve(), release() {
      const count = references.get(id) - 1
      if (count === 0) references.delete(id)
      else references.set(id, count)
    } }
  }
  const stop = navigation.retainRecentGroupHistory?.({ roster, sessions: { list, retain }, onError: assert.fail }) ?? (() => {})
  let main
  async function open(id) {
    const next = retain(id, { source: 'mainView' })
    main?.release()
    main = next
    list.set({ byId: { [id]: { id, retainedBy: { mainView: 1 } } } })
    await Promise.resolve()
  }
  await open('a-part')
  await open('b-part')
  await open('a-part')
  assert.deepEqual(reads, ['a-part', 'b-part'])
  for (const id of ['c-part', 'd-part', 'e-part', 'ordinary']) await open(id)
  assert.deepEqual([...references.keys()], ['c-part', 'd-part', 'e-part', 'ordinary'])
  roster.set({ rooms: rooms.filter(room => room.id !== 'd').map(room => room.id === 'e' ? { ...room, sessionId: 'e-new' } : room) })
  await Promise.resolve()
  assert.deepEqual([...references.keys()], ['c-part', 'ordinary'])
  stop()
  await open('c-part')
  main.release()
  assert.equal(references.size, 0)
})
