import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const root = fileURLToPath(new URL('../.tmp-test/', import.meta.url))
mkdirSync(root, { recursive: true })

test('production group schedule channel persists its binding and keeps ordinary Bot reminders intact', async t => {
  const home = mkdtempSync(join(root, 'group-schedule-channel-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 1, revision: 1, mainBotIds: ['chief'],
    bots: { chief: { id: 'chief', name: 'Chief', sessionId: 'chief' }, writer: { id: 'writer', name: 'Writer', sessionId: 'writer' } },
    rooms: { group: { id: 'group', name: 'Example', members: ['chief', 'writer'], admin: 'chief', mode: 'admin' } } }))
  const tasks = new Map([['legacy', { id: 'legacy', kind: 'daily', title: 'Bot reminder', prompt: 'Read the news',
    scheduledAt: '2030-01-01T01:00:00.000Z', status: 'active', target: { kind: 'session', sessionId: 'chief' } }]])
  const schedule = {
    async create({ title, prompt, timing, target }) {
      tasks.set('new-timer', { id: 'new-timer', kind: timing.kind, title, prompt, target, scheduledAt: '2030-01-01T01:00:00.000Z', status: 'active' })
      return { id: 'new-timer' }
    },
    async catalog() { return [...tasks.values()] },
    async edit({ id, action }) { assert.equal(action, 'delete'); tasks.delete(id); return { id } },
  }
  const ctx = fakeContext({ services: { schedule } })
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = route => { ctx.route = route; return register(route) }
  const rt = createRuntime(ctx, { home, taskflowHome: join(home, 'taskflow') })
  rt.createSession = async () => 'controlled-trigger'
  ctx.workspaceRegistry = { archiveSession: async () => {} }
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const call = async (endpoint, payload) => (await ctx.route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const created = await call('group-schedule-create', { target: 'group', memberId: 'writer', title: 'Daily evidence',
    prompt: 'Check the evidence', when: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } })
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.equal(created.value.tasks.length, 2)
  assert.ok(created.value.tasks.some(task => task.id === 'legacy' && task.botId === 'chief'))
  const cardSchedule = created.value.tasks.find(task => task.mode === 'group-card')
  const persisted = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).groupSchedules[cardSchedule.id]
  assert.equal(persisted.stage, 'ready')
  assert.equal(persisted.scheduleId, 'new-timer')
  assert.equal(tasks.get('new-timer').target.sessionId, persisted.sessionId)
  assert.equal(persisted.roomId, 'group')
  assert.equal(persisted.memberId, 'writer')
  const deleted = await call('group-schedule-delete', { id: cardSchedule.id })
  assert.equal(deleted.ok, true, JSON.stringify(deleted))
  assert.deepEqual(deleted.value.tasks.map(task => task.id), ['legacy'])
  assert.ok(tasks.has('legacy'))
})
