import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { install, publishSkillCopy, stageSkillCopy } from '../src/host/profiles.js'
import { install as installProfileSkills } from '../src/host/profile-skills.js'

function fixture({ dshHome = join(process.cwd(), 'dev', 'profile-fixture-not-created'), entries = [{ name: 'process-plugin' }] } = {}) {
  const saved = []
  const refreshed = []
  const state = {
    capabilities: { items: {
      'review-skill': { name: 'review-skill', kind: 'skill', content: 'private skill text' },
      'tool-server': { name: 'tool-server', kind: 'mcp', env: { TOKEN: 'private' } },
    } },
    profiles: {}, rooms: {},
    bots: { one: { id: 'one', name: 'One', capabilities: [], profileCapabilities: [] } },
  }
  const rt = { dshHome, state,
    ctx: { loader: { entries: () => entries }, get: key => key === 'skills' ? { snapshot: async () => ({ complete: true, skills: [
      { name: 'inside', path: join(dshHome, 'profiles', 'work', 'skills', 'inside', 'SKILL.md'), provider: 'filesystem' },
      { name: 'outside', path: join(dshHome, 'skills', 'outside', 'SKILL.md'), provider: 'filesystem' },
    ] }) } : undefined },
    save: async () => { saved.push(structuredClone(state)) },
    ensureCapabilities: async sessionId => { refreshed.push(sessionId) },
    chatOf: () => 'session-one', scheduleCapabilitiesReconcile: () => {}, warn: () => {},
  }
  install(rt)
  return { rt, state, saved, refreshed }
}

test('Bot profile saves, assigns, changes live resources and clears its assignment', async () => {
  const { rt, state, saved, refreshed } = fixture()
  const first = await rt.profileEndpoint('profile-save', { profile: { name: 'work', capabilities: ['review-skill'], plugins: ['process-plugin'] } })
  assert.equal(first.profiles[0].name, 'work')
  assert.equal(first.skills.items.find(item => item.name === 'inside').profile, 'work')
  assert.equal(first.skills.items.find(item => item.name === 'outside').source, 'outside-profile')
  assert.equal(JSON.stringify(first).includes('private'), false)
  await rt.profileEndpoint('profile-apply', { name: 'work', botId: 'one' })
  assert.deepEqual(state.bots.one.capabilities, ['review-skill'])
  assert.equal(state.bots.one.profile, 'work')
  await rt.profileEndpoint('profile-save', { profile: { name: 'work', capabilities: ['tool-server'], plugins: [] } })
  assert.deepEqual(state.bots.one.capabilities, ['tool-server'])
  const cleared = await rt.profileEndpoint('profile-clear', { botId: 'one' })
  assert.deepEqual(cleared.bots[0].capabilities, [])
  assert.equal(cleared.bots[0].profile, null)
  assert.equal(saved.length, 4)
  assert.deepEqual(refreshed, ['session-one', 'session-one', 'session-one'])
})

test('skill locations use this host root and do not invent an unmounted profile provider', async () => {
  const { rt } = fixture()
  const view = await rt.profileEndpoint('profiles')
  assert.equal(view.skillRoots.global, join(rt.dshHome, 'skills'))
  assert.equal(view.skillRoots.profile, null)
})

test('editing skills without plugin selectors preserves existing and stale process references', async () => {
  const { rt, state } = fixture()
  await rt.profileEndpoint('profile-save', { profile: { name: 'work', plugins: ['process-plugin'] } })
  state.profiles.work.plugins.push('removed-plugin')
  await rt.profileEndpoint('profile-save', { profile: { name: 'work', capabilities: ['review-skill'] } })
  assert.deepEqual(state.profiles.work.plugins, ['process-plugin', 'removed-plugin'])
  assert.deepEqual(state.profiles.work.capabilities, ['review-skill'])
})

test('missing capability is rejected and deleting a profile refreshes assigned sessions', async () => {
  const { rt, state, refreshed } = fixture()
  await assert.rejects(rt.profileEndpoint('profile-save', { profile: { name: 'work', capabilities: ['missing'] } }), /No skill/)
  await rt.profileEndpoint('profile-save', { profile: { name: 'work', capabilities: ['review-skill'] } })
  await rt.profileEndpoint('profile-apply', { name: 'work', botId: 'one' })
  await rt.profileEndpoint('profile-delete', { name: 'work' })
  assert.deepEqual(state.bots.one.capabilities, [])
  assert.equal(state.bots.one.profile, null)
  assert.deepEqual(refreshed, ['session-one', 'session-one'])
})

test('process catalog shows stored profile skills and active plugins outside manifests', async () => {
  const dshHome = join(process.cwd(), 'test', 'fixtures', 'profile-skill-home')
  const { rt } = fixture({ dshHome, entries: [{ name: 'unlisted-plugin' }] })
  const view = await rt.profileEndpoint('profiles')
  assert.deepEqual(view.dshProfiles[0].skills, ['profile-demo'])
  assert.deepEqual(view.plugins.find(plugin => plugin.name === 'unlisted-plugin').profiles, [])
  assert.equal(view.plugins.find(plugin => plugin.name === 'unlisted-plugin').active, true)
})

test('Bot plugin references must exist in the DSH catalog, and stale references remain visible', async () => {
  const dshHome = join(process.cwd(), 'test', 'fixtures', 'profile-skill-home')
  const { rt, state } = fixture({ dshHome })
  await assert.rejects(rt.profileEndpoint('profile-save', { profile: { name: 'work', plugins: ['fabricated'] } }), /No DSH plugin reference/)
  await rt.profileEndpoint('profile-save', { profile: { name: 'work', plugins: ['ds-bot'] } })
  state.profiles.work.plugins.push('removed-plugin')
  const view = await rt.profileEndpoint('profiles')
  assert.deepEqual(view.profiles[0].inactivePlugins, ['ds-bot'])
  assert.deepEqual(view.profiles[0].missingPlugins, ['removed-plugin'])
})

test('classifying current Bots creates one native profile per Bot without changing capabilities', async () => {
  const { rt, state, saved } = fixture()
  state.bots.one.name = 'Chief'
  state.bots.one.capabilities = ['review-skill']
  state.bots.two = { id: 'two', name: 'Chief', capabilities: ['tool-server'], profileCapabilities: [] }
  state.bots.three = { id: 'three', name: 'Empty', capabilities: [], profileCapabilities: [] }
  state.bots.four = { id: 'four', name: 'Assigned', capabilities: ['review-skill'], profile: 'manual', profileCapabilities: ['review-skill'] }
  state.profiles.manual = { name: 'manual', capabilities: ['review-skill'], plugins: [] }
  await rt.profileEndpoint('profile-classify-bots')
  assert.deepEqual(state.bots.one.capabilities, ['review-skill'])
  assert.deepEqual(state.bots.two.capabilities, ['tool-server'])
  assert.deepEqual(state.bots.three.capabilities, [])
  assert.equal(state.bots.four.profile, 'manual')
  assert.deepEqual([state.bots.one.profile, state.bots.two.profile, state.bots.three.profile], ['bot-chief', 'bot-chief-2', 'bot-empty'])
  assert.deepEqual(state.profiles['bot-chief'].capabilities, ['review-skill'])
  assert.deepEqual(state.profiles['bot-chief-2'].capabilities, ['tool-server'])
  assert.equal(saved.length, 1)
  await rt.profileEndpoint('profile-classify-bots')
  assert.equal(saved.length, 1)
})

test('classifying Bots fails before writing when an existing capability is missing', async () => {
  const { rt, state, saved } = fixture()
  state.bots.one.capabilities = ['removed-skill']
  await assert.rejects(rt.profileEndpoint('profile-classify-bots'), /missing capabilities/)
  assert.deepEqual(state.profiles, {})
  assert.equal(saved.length, 0)
})

test('active DSH profile skills are discovered and loaded by the official filesystem provider', async () => {
  const dshHome = join(process.cwd(), 'test', 'fixtures', 'profile-skill-home')
  const original = process.env.DS_BOT_DSH_PROFILE
  let pending
  let provider
  const warnings = []
  const ctx = { get: () => undefined, logger: { warn(...message) { warnings.push(message) } }, effect() {}, skills: {
    registerProvider(factory) { provider = factory({ invalidate() {}, signal: new AbortController().signal }) },
  } }
  try {
    process.env.DS_BOT_DSH_PROFILE = 'work'
    installProfileSkills({ dshHome, ctx: { inject: (_services, callback) => { pending = callback(ctx) } }, warn: () => {} })
    await pending
    assert.ok(provider)
    const list = await provider.list({ cwd: process.cwd() })
    const candidate = (Array.isArray(list) ? list : list.candidates).find(item => item.name === 'profile-demo')
    assert.ok(candidate, JSON.stringify({ list, warnings }))
    const skill = await provider.get(candidate, {})
    assert.match(skill.content, /profile skill provider/)
  } finally {
    if (provider) await provider.dispose()
    if (original === undefined) delete process.env.DS_BOT_DSH_PROFILE
    else process.env.DS_BOT_DSH_PROFILE = original
  }
})

test('skill copies are staged outside the watched root and preserve local resources', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.tmp-profile-copy-'))
  try {
    const src = join(dir, 'source')
    const staged = join(dir, 'staging', 'profile-demo')
    await mkdir(join(src, 'references'), { recursive: true })
    await mkdir(join(dir, 'staging'))
    await writeFile(join(src, 'SKILL.md'), 'safe skill')
    await writeFile(join(src, 'references', 'example.md'), 'local resource')
    await stageSkillCopy(src, staged)
    assert.equal(await readFile(join(staged, 'references', 'example.md'), 'utf8'), 'local resource')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('staged skills reject links before activation', async t => {
  const dir = await mkdtemp(join(process.cwd(), '.tmp-profile-copy-'))
  try {
    const src = join(dir, 'source')
    await mkdir(src)
    await writeFile(join(src, 'SKILL.md'), 'safe skill')
    await writeFile(join(dir, 'private.md'), 'secret')
    try { await symlink(join(dir, 'private.md'), join(src, 'linked.md')) } catch (error) {
      if (!['EPERM', 'EACCES'].includes(error.code)) throw error
      await mkdir(join(dir, 'private'))
      await writeFile(join(dir, 'private', 'SKILL.md'), 'secret')
      try { await symlink(join(dir, 'private'), join(src, 'linked'), 'junction') } catch (junctionError) {
        if (['EPERM', 'EACCES'].includes(junctionError.code)) { t.skip('links and junctions unavailable'); return }
        throw junctionError
      }
    }
    await assert.rejects(stageSkillCopy(src, join(dir, 'staged')), /links or special files/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('publication rejects a replaced skill directory after staging', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.tmp-profile-copy-'))
  try {
    const root = join(dir, 'skills')
    const staged = join(dir, 'staged')
    const target = join(root, 'sample.md')
    await mkdir(root)
    const original = await lstat(root)
    await writeFile(staged, 'safe skill')
    await rename(root, join(dir, 'old-skills'))
    await mkdir(root)
    await assert.rejects(publishSkillCopy(staged, root, target, original), /changed during the copy/)
    assert.equal(await readFile(staged, 'utf8'), 'safe skill')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('copying a skill activates its profile copy and retains the original', async () => {
  const dshHome = await mkdtemp(join(process.cwd(), '.tmp-profile-copy-'))
  const original = process.env.DS_BOT_DSH_PROFILE
  const profile = join(dshHome, 'profiles', 'work')
  const source = join(dshHome, 'skills', 'sample', 'SKILL.md')
  const copied = join(profile, 'skills', 'sample', 'SKILL.md')
  let invalidated = false
  try {
    await mkdir(join(profile, 'skills'), { recursive: true })
    await mkdir(join(dshHome, 'skills', 'sample'), { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }))
    await writeFile(source, 'original skill')
    process.env.DS_BOT_DSH_PROFILE = 'work'
    const skills = {
      snapshot: async () => ({ complete: true, skills: [{ name: 'sample', source: 'global-dsh', path: invalidated ? copied : source }] }),
      get: async () => ({ path: copied, content: await readFile(copied, 'utf8') }),
    }
    const rt = { dshHome, state: { profiles: {}, capabilities: { items: {} }, bots: {} },
      ctx: { get: name => name === 'skills' ? skills : undefined },
      invalidateProfileSkills: () => { invalidated = true } }
    install(rt)
    const view = await rt.profileEndpoint('profile-skill-copy', { name: 'sample' })
    assert.equal(await readFile(copied, 'utf8'), 'original skill')
    assert.equal(await readFile(source, 'utf8'), 'original skill')
    assert.deepEqual(view.dshProfiles[0].skills, ['sample'])
  } finally {
    if (original === undefined) delete process.env.DS_BOT_DSH_PROFILE
    else process.env.DS_BOT_DSH_PROFILE = original
    await rm(dshHome, { recursive: true, force: true })
  }
})
