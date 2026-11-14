import { readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), 'skills', 'taskflow')
const LOCATOR = join(DIRECTORY, 'SKILL.md')
const PROVIDER = 'ds-bot-taskflow'
const description = 'Use when coordinating a DS Bot group with a dependency plan, task submissions, verification and final acceptance.'

export function taskflowProvider() {
  const item = {
    name: 'taskflow', description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER, source: 'bundled', rank: 550,
    resourceBase: { kind: 'directory', path: DIRECTORY.split(sep).join('/') },
    locator: LOCATOR,
  }
  return {
    name: PROVIDER,
    list: async () => [item],
    get: async () => ({ ...item, content: readFileSync(LOCATOR, 'utf8').replace(/^---[\s\S]*?---\s*/, '').trim() }),
  }
}

export function install(rt) {
  rt.ctx.inject?.({ skills: null }, ctx => ctx.skills.registerProvider(() => taskflowProvider()))
}
