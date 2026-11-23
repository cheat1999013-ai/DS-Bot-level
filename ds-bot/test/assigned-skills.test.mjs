import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const preExecute = (ctx, exec) => (ctx.listeners.get('tools/pre-execute') ?? []).reduceRight(
  (next, listener) => () => listener(exec, next), async () => ({ kind: 'allow' }))()

test('an assigned-skill Bot cannot start task actions before selecting and loading relevant skills', async t => {
  const home = mkdtempSync(fileURLToPath(new URL('../.tmp-verify/assigned-skills-', import.meta.url)))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 1, mainBotIds: ['chief'],
    bots: { chief: { id: 'chief', name: 'Chief', createdAt: 1 }, worker: { id: 'worker', name: 'Worker', capabilities: ['writing'], createdAt: 2 } },
    rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, revision: 1,
    capabilities: { items: { writing: { name: 'writing', kind: 'skill', description: 'Write source-grounded reports', content: 'Load sources before writing.' } } },
  }))
  const ctx = fakeContext()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const rt = createRuntime(ctx, { home, diagnosticsFile: false, github: false })
  rt.resolveAgent = async id => ({ id, session: { id } })
  await rt.load()
  const decision = await preExecute(ctx, { name: 'post_to_group', arguments: { group: 'Ops', text: 'Claimed result' }, agent: { id: 'worker', session: { id: 'worker' } } })
  assert.equal(decision.kind, 'deny', 'Capability discovery alone must not authorize task execution')
  assert.match(decision.reason, /prepare_bot_skills/)
})
