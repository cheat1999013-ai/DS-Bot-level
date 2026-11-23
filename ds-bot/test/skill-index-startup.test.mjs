import test from 'node:test'
import assert from 'node:assert/strict'
import { install, TOOL_NAMES } from '../src/host/skill-index.js'

for (const available of [false, true]) test(`skill index optional web service (${available}) never reads an uninjected getter`, () => {
  const registrations = [], cleanups = []
  const webServer = { register(route) { registrations.push(route); return () => {} } }
  const ctx = {
    get webServer() { throw new Error('cannot get property "webServer" without inject') },
    get: name => name === 'webServer' && available ? webServer : undefined,
    effect: register => { const dispose = register(); if (dispose) cleanups.push(dispose) },
  }
  const rt = { ctx, teamTools: [] }
  const result = install(rt, async () => null, { rooms: () => [] })
  assert.equal(result.endpoint, available ? 'mounted' : 'inert')
  assert.deepEqual(rt.teamTools.map(tool => tool.name), TOOL_NAMES)
  assert.equal(registrations.length, available ? 1 : 0)
  for (const dispose of cleanups) dispose()
})
