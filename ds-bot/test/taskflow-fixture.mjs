import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BotState } from '../src/host/taskflow/state.js'
import { Scheduler } from '../src/host/taskflow/scheduler.js'
import { Knowledge } from '../src/host/taskflow/knowledge.js'
import { TaskflowService } from '../src/host/taskflow/tools.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '.tmp-test')
mkdirSync(root, { recursive: true })

export function fixture() {
  const home = mkdtempSync(join(root, 'native-taskflow-'))
  const state = {
    bots: {
      'bot-admin': { id: 'bot-admin', name: 'Chief', role: 'lead', instructions: 'lead' },
      'bot-a': { id: 'bot-a', name: 'Writer', role: 'writer', model: 'm' },
      'bot-b': { id: 'bot-b', name: 'Reviewer', role: 'reviewer' },
    },
    rooms: {
      'room-1': { id: 'room-1', name: 'IT-create', admin: 'bot-admin',
        members: ['bot-admin', 'bot-a', 'bot-b'], sessions: { 'bot-admin': 'group-admin', 'bot-a': 'group-a', 'bot-b': 'group-b' } },
      'room-2': { id: 'room-2', name: 'Empty room', admin: 'bot-a', members: ['bot-a'], sessions: {} },
    },
  }
  const owner = new Map([['group-admin', { botId: 'bot-admin', roomId: 'room-1' }],
    ['group-a', { botId: 'bot-a', roomId: 'room-1' }], ['group-b', { botId: 'bot-b', roomId: 'room-1' }]])
  const taskflowHome = join(home, 'plugin-data', 'hermes-bot-taskflow')
  mkdirSync(taskflowHome, { recursive: true })
  const rt = {
    home, taskflowHome, state, groupOwners: owner, teamTools: [],
    botOf: id => state.bots[id], roomOf: id => state.rooms[id],
    selfOf: id => owner.get(id)?.botId ?? ({ 'own-admin': 'bot-admin', 'own-a': 'bot-a', 'own-b': 'bot-b' })[id],
    isBotSession: id => owner.has(id) || ['own-admin', 'own-a', 'own-b'].includes(id),
    readOnly: () => undefined, load: async () => {}, warn: () => {},
    postToRoom: async () => {}, ctx: { effect: () => {} },
  }
  const botState = new BotState(rt)
  const scheduler = new Scheduler(join(taskflowHome, 'coordination.sqlite'))
  const knowledge = new Knowledge(join(taskflowHome, 'knowledge.sqlite'))
  const posts = []
  const service = new TaskflowService({ botState, scheduler, knowledge, stopMemberWork: async () => {},
    approveTest: async () => {}, approveConfirmation: async () => {}, approveSkill: async () => {},
    post: async ({ scope, text, taskflowEvent }) => posts.push({ scope, text, ...(taskflowEvent ? { taskflowEvent } : {}) }), log: () => {} })
  const cleanup = () => { scheduler.close(); knowledge.close(); rmSync(home, { recursive: true, force: true }) }
  return { rt, botState, scheduler, knowledge, service, posts, cleanup,
    admin: { session: { id: 'group-admin' } }, memberA: { session: { id: 'group-a' } },
    memberB: { session: { id: 'group-b' } }, outsider: { session: { id: 'not-a-bot' } } }
}
