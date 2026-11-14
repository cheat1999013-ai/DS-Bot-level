import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, test } from 'node:test'
import { parsePrimaryRuntime, workspaceDependencyPaths } from '@deepseek-ai/dsh-tool-workspace-dependencies'
import { preparePrimaryRuntime, primaryRuntimeManifest, runtimeReusable, runtimeTarget } from '../scripts/prepare-runtime.mjs'

const testRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '.tmp-test')
mkdirSync(testRoot, { recursive: true })

describe('runtimeTarget', () => {
  test('maps the platforms electron-builder packs for to the lock\'s targets', () => {
    assert.equal(runtimeTarget('win32', 'x64'), 'win-x64')
    assert.equal(runtimeTarget('darwin', 'x64'), 'mac-x64')
    assert.equal(runtimeTarget('darwin', 'arm64'), 'mac-arm64')
    assert.equal(runtimeTarget('linux', 'x64'), 'linux-x64')
    assert.equal(runtimeTarget('linux', 'arm64'), 'linux-arm64')
    assert.equal(runtimeTarget('win32', 'arm64'), undefined)
    assert.equal(runtimeTarget('freebsd', 'x64'), undefined)
  })
})

describe('primaryRuntimeManifest', () => {
  test('carries the platform, both interpreters and the locked wheels, but no pnpm', () => {
    const manifest = primaryRuntimeManifest('win-x64', '0.2.2')
    assert.equal(manifest.platform, 'win32')
    assert.equal(manifest.arch, 'x64')
    assert.equal(manifest.desktopVersion, '0.2.2')
    assert.match(manifest.payloadDigest, /^[a-f0-9]{64}$/u)
    assert.match(manifest.node, /^\d+\.\d+\.\d+$/u)
    assert.equal('pnpm' in manifest, false)
    assert.match(manifest.python, /^\d+\.\d+\.\d+$/u)
    assert.equal(manifest.pythonPackages['python-docx'], '1.2.0')
    // The tool validates the manifest the same way it reads one from a prepared payload.
    assert.deepEqual(parsePrimaryRuntime(manifest).payloadDigest, manifest.payloadDigest)
  })

  test('maps mac and linux targets to the manifest platform names', () => {
    assert.deepEqual([primaryRuntimeManifest('mac-arm64', '1').platform, primaryRuntimeManifest('mac-arm64', '1').arch], ['darwin', 'arm64'])
    assert.deepEqual([primaryRuntimeManifest('linux-x64', '1').platform, primaryRuntimeManifest('linux-x64', '1').arch], ['linux', 'x64'])
  })

  test('changes the digest with the target', () => {
    assert.notEqual(primaryRuntimeManifest('mac-x64', '1').payloadDigest, primaryRuntimeManifest('mac-arm64', '1').payloadDigest)
  })
})

describe('runtimeReusable', () => {
  const target = runtimeTarget(process.platform, process.arch)
  const manifest = primaryRuntimeManifest(target ?? 'win-x64', '1.0.0')
  let output
  let root
  before(() => {
    output = mkdtempSync(join(testRoot, 'ds-bot-runtime-'))
    root = join(output, 'primary-runtime')
  })
  after(() => { rmSync(output, { recursive: true, force: true }) })

  test('is false without a payload, true with a complete one, false on a digest change', () => {
    assert.equal(runtimeReusable(output, manifest), false)
    const entries = workspaceDependencyPaths(root, manifest)
    for (const path of [entries.python, entries.node]) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, '')
    }
    mkdirSync(entries.pythonPackages, { recursive: true })
    writeFileSync(join(root, 'runtime.json'), JSON.stringify(manifest))
    assert.equal(runtimeReusable(output, manifest), true)
    writeFileSync(join(root, 'runtime.json'), JSON.stringify({ ...manifest, payloadDigest: '0'.repeat(64) }))
    assert.equal(runtimeReusable(output, manifest), false)
  })
})

test('a reused runtime records the new app version without rebuilding its payload', async () => {
  const target = runtimeTarget(process.platform, process.arch) ?? 'win-x64'
  const output = mkdtempSync(join(testRoot, 'ds-bot-version-'))
  const root = join(output, 'primary-runtime')
  const old = primaryRuntimeManifest(target, '0.3.3')
  const entries = workspaceDependencyPaths(root, old)
  try {
    for (const path of [entries.python, entries.node]) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, 'original payload')
    }
    mkdirSync(entries.pythonPackages, { recursive: true })
    writeFileSync(join(root, 'runtime.json'), JSON.stringify(old))
    const skillSource = join(output, 'office-source')
    mkdirSync(skillSource)
    writeFileSync(join(skillSource, 'SKILL.md'), 'test skill')
    await preparePrimaryRuntime({ target, output, cache: join(output, 'cache'), version: '0.3.4', skillSource })
    assert.equal(JSON.parse(readFileSync(join(root, 'runtime.json'), 'utf8')).desktopVersion, '0.3.4')
    assert.equal(readFileSync(entries.node, 'utf8'), 'original payload')
    assert.equal(runtimeReusable(output, primaryRuntimeManifest(target, '0.3.4')), true)
  } finally { rmSync(output, { recursive: true, force: true }) }
})
