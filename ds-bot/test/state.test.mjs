import assert from 'node:assert/strict'
import test from 'node:test'
import { BotState } from '../src/host/taskflow/state.js'
import { fixture } from './taskflow-fixture.mjs'

test('native roster resolves owned sessions and rejects foreign identities', () => {
  const env = fixture()
  try {
    const state = env.botState
    assert.equal(state.callerOf('own-a').kind, 'own')
    assert.equal(state.callerOf('group-a').kind, 'group')
    assert.equal(state.callerOf('group-a').roomId, 'room-1')
    assert.equal(state.callerOf('group-a').botId, 'bot-a')
    assert.equal(state.callerOf('room-1'), null)
    env.rt.selfOf = id => id === 'archived-own-a' ? 'bot-a' :
      env.rt.groupOwners.get(id)?.botId ?? ({ 'own-admin': 'bot-admin', 'own-a': 'bot-a', 'own-b': 'bot-b' })[id]
    assert.equal(state.callerOf('archived-own-a'), null)
    assert.equal(state.groupSessionId(state.room('IT-create')), 'room-1')
    assert.equal(state.groupSessionId(state.room('Empty room')), 'room-2')
    env.rt.groupOwners.set('spoofed', { botId: 'bot-a', roomId: 'missing' })
    assert.equal(state.callerOf('spoofed'), null)
  } finally { env.cleanup() }
})

test('room membership is read live from DS Bot, including changes', () => {
  const env = fixture()
  try {
    const state = env.botState
    const room = state.room('IT-create')
    assert.deepEqual(state.members(room).map(member => member.name), ['Chief', 'Writer', 'Reviewer'])
    assert.equal(state.member(room, 'writer').id, 'bot-a')
    assert.equal(state.member(room, 'Nobody'), null)
    assert.equal(state.names(room)['bot-b'], 'Reviewer')
    assert.equal(state.admin(room).name, 'Chief')
    room.members = ['bot-admin', 'bot-b']
    assert.equal(state.callerOf('group-a'), null)
  } finally { env.cleanup() }
})

test('empty native roster has no plans or callers', () => {
  const state = new BotState({ state: { bots: {}, rooms: {} }, botOf: () => undefined,
    roomOf: () => undefined, selfOf: () => undefined, isBotSession: () => false, groupOwners: new Map() })
  assert.deepEqual(state.rooms(), [])
  assert.equal(state.callerOf('anything'), null)
})
