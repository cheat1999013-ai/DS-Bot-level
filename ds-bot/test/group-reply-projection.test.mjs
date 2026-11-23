import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeProjection, relayEvents } from './helpers/native-chat-projection.mjs'
const feature = await import(process.env.GROUP_REPLY_PROJECTION_SOURCE ?? new URL('../src/client/group-reply-projection.js', import.meta.url).href).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes('group-reply-projection.js')) return {}
  throw error
})
const KIND = 'ds-bot-group-reply'
const replies = result => Array.from(result.snapshot.nodes.values()).filter(node => node.kind === KIND && node.visibility === 'visible')
const setup = () => nativeProjection(feature.installGroupReplyProjection)

test('a principal reply cursor has one independent visible row outside the native collapsed process group', t => {
  const f = setup(); t.after(() => f.dispose())
  const result = f.replay(relayEvents())
  const ordinary = replies(result)
  assert.equal(ordinary.length, 1, 'The group reply must have a visible transcript row independent of the folded tool process')
  assert.ok(result.grouped.root.some(entry => entry.kind === 'node' && entry.key === ordinary[0].key))
  assert.equal(ordinary[0].data.phase, 'result')
  assert.deepEqual(JSON.parse(ordinary[0].data.block.content[0].text), { from: 683, anchor: 'fixture-anchor-343' })
  assert.ok([...result.grouped.groups.values()].some(group => group.members.some(member => result.snapshot.nodes.get(member.key)?.kind === 'tool-call')),
    'The native tool tree remains a process; only the group reply gains an independent row')
})

test('two reported consecutive relay turns keep separate reply identities and cursor ranges', t => {
  const f = setup(); t.after(() => f.dispose())
  const result = f.replay([...relayEvents(), ...relayEvents({ turn: 344, seq: 7, from: 685 })])
  const ordinary = replies(result)
  assert.equal(ordinary.length, 2)
  assert.equal(new Set(ordinary.map(node => node.key)).size, 2)
  assert.deepEqual(ordinary.map(node => JSON.parse(node.data.block.content[0].text).from), [683, 685])
})

test('ordinary tools and orphan results cannot impersonate group replies', t => {
  const f = setup(); t.after(() => f.dispose())
  assert.equal(replies(f.replay(relayEvents({ name: 'read_file' }))).length, 0)
  const records = relayEvents(); records.splice(2, 1)
  assert.equal(replies(f.replay(records, true)).length, 0)
})

test('a call arriving before its result shows progress then updates the same visible row once', t => {
  const f = setup(); t.after(() => f.dispose())
  const records = relayEvents()
  let result = f.replay(records.slice(0, 3))
  const before = replies(result)
  assert.equal(before.length, 1)
  assert.equal(before[0].data.phase, 'start')
  const key = before[0].key
  for (const event of records.slice(3)) f.assembler.append({ type: 'event', event })
  f.assembler.flush()
  result = { snapshot: f.assembler.snapshot('chat'), grouped: f.assembler.grouped('chat') }
  assert.equal(replies(result).length, 1)
  assert.equal(replies(result)[0].key, key)
  assert.equal(replies(result)[0].data.phase, 'result')
})

for (const withStart of [true, false]) test(`PTC group relay has one independent reply with dispatch start ${withStart}`, t => {
  const f = setup(); t.after(() => f.dispose())
  const original = relayEvents({ name: 'run_code' })
  const data = { rootCallId: 'fixture-call-343', parentCallId: 'fixture-call-343', subCallId: 'fixture-subcall', name: 'group_relay', arguments: {},
    content: original[3].data.message.content, isError: false }
  const records = [...original.slice(0, 3),
    ...(withStart ? [{ type: 'tool/ptc-dispatch-start', seq: 4, time: original[2].time + 1, data }] : []),
    { type: 'tool/ptc-dispatch', seq: 5, time: original[2].time + 2, data },
    ...original.slice(3).map((event, index) => ({ ...event, seq: 6 + index }))]
  const result = f.replay(records)
  assert.equal(replies(result).length, 1)
  assert.equal(replies(result)[0].data.callId, 'fixture-subcall')
  assert.equal(replies(result)[0].data.phase, 'result')
  assert.ok(result.grouped.root.some(entry => entry.kind === 'node' && entry.key === replies(result)[0].key))
})

test('replacement copies do not replace an append-origin reply and disposal removes the contributed row', t => {
  const f = setup(); t.after(() => f.dispose())
  const records = relayEvents()
  const copy = { ...records[3], seq: 7, surfaceOp: 'replace', data: { ...records[3].data,
    message: { ...records[3].data.message, content: [{ type: 'text', text: 'model-only replacement' }] } } }
  const route = [...f.ctx.uiConversation.events.forEvent('tool/result')].find(route => route.definition.kind === KIND)
  assert.equal(route.match(copy), null, 'A model-only copy must not update the visible reply')
  const result = f.replay(records)
  assert.equal(replies(result).length, 1)
  assert.match(replies(result)[0].data.block.content[0].text, /fixture-anchor-343/)
  f.dispose(); f.assembler.rebuildRegistry(); f.assembler.flush()
  assert.equal(replies({ snapshot: f.assembler.snapshot('chat') }).length, 0)
})
