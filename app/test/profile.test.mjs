import { LEGACY_ENGINE } from '../src/legacy.mjs'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { BUNDLES, claimBundles, loadAppProfile, loadCheckProfile } from '../src/profile.mjs'

// Packages of DSH's own Web front end and its browser runtime, which the window shows.
const DSH_WEB_FRONT_END = /^@deepseek-ai\/dsh-(client-ui-|web-app|web-frontend|client-modules|host-frontend-static|cordis-client-runner|client-hmr)/u

// Every row of an entry list, with the rows inside groups and agent presets.
function rows(entries) {
  return entries.flatMap((entry) => [
    entry,
    ...rows(Array.isArray(entry.config) ? entry.config : []),
    ...rows(Array.isArray(entry.config?.plugins) ? entry.config.plugins : []),
  ])
}

describe('the app profile', () => {
  let home
  let entries
  const previousHome = process.env.DSH_HOME
  const previousProfile = process.env.DS_BOT_DSH_PROFILE
  before(() => {
    home = mkdtempSync(join(tmpdir(), 'ds-bot-app-profile-'))
    process.env.DSH_HOME = home
    delete process.env.DS_BOT_DSH_PROFILE
    const profile = loadAppProfile()
    assert.equal(process.env.DS_BOT_DSH_PROFILE, 'ds-bot')
    assert.deepEqual(profile.layers.map((layer) => layer.packageName), BUNDLES)
    assert.deepEqual(profile.skippedBundles, [])
    entries = composeEntries([...profile.layers.map((layer) => layer.patches), profile.patches])
  })
  after(() => {
    rmSync(home, { recursive: true, force: true })
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousProfile === undefined) delete process.env.DS_BOT_DSH_PROFILE
    else process.env.DS_BOT_DSH_PROFILE = previousProfile
  })

  test('mounts DSH Web, which the window shows, and the Bot team', () => {
    const on = new Set(entries.filter((entry) => entry.disabled !== true).map((entry) => entry.id))
    for (const id of ['webserver', 'connection', 'bot']) assert.ok(on.has(id), `${id} is mounted`)
    assert.ok(rows(entries).some((entry) => DSH_WEB_FRONT_END.test(entry.name ?? '')), 'the DSH Web front end is mounted')
  })

  test('check profile clears the app skill scope', () => {
    loadCheckProfile()
    assert.equal(process.env.DS_BOT_DSH_PROFILE, undefined)
  })
})

describe('claimBundles', () => {
  let dir
  before(() => { dir = mkdtempSync(join(tmpdir(), 'ds-bot-app-bundles-')) })
  after(() => { rmSync(dir, { recursive: true, force: true }) })

  const write = (bundles) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-ds-bot', private: true, dependencies: { 'a-plugin': '1.0.0' }, dsh: { profile: { bundles } } }, undefined, 2)}\n`)
  }
  const read = () => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))

  test('puts the app bundles first, keeps the user bundles and drops the retired ones', () => {
    write(['@deepseek-ai/dsh-base', LEGACY_ENGINE, 'dsbot-engine', 'ds-bot', 'a-plugin'])
    claimBundles(dir)
    assert.deepEqual(read().dsh.profile.bundles, [...BUNDLES, 'a-plugin'])
    assert.deepEqual(read().dependencies, { 'a-plugin': '1.0.0' })
  })

  test('leaves a profile that already lists them alone', () => {
    write([...BUNDLES, 'a-plugin'])
    const before = readFileSync(join(dir, 'package.json'), 'utf8')
    claimBundles(dir)
    assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), before)
  })
})
