import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { bundleClient } from './build-client.mjs'
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const installed = process.env.DS_BOT_INSTALLED
if (!installed) throw new Error('Set DS_BOT_INSTALLED to the installed ds-bot folder')
const prior = JSON.parse(await fs.readFile(path.join(root, '.tmp-verify/reminders-manifest-1.json'), 'utf8'))
const out = path.join(root, '.tmp-verify/native-candidate-1')
const hash = body => createHash('sha256').update(body).digest('hex')
const bodies = new Map()
for (const [name, expected] of Object.entries(prior.candidate)) {
  const body = await fs.readFile(path.join(installed, name))
  if (hash(body) !== expected) throw Error(`Installed drift: ${name}`)
  bodies.set(name, body)
}
const source = async name => (await fs.readFile(path.join(root, name), 'utf8')).replaceAll('\r\n', '\n')
const replace = (body, before, after) => {
  if (body.split(before).length !== 2) throw Error(`Ambiguous seam: ${before.slice(0, 140)}`)
  return body.replace(before, after)
}
const section = (body, start, end) => {
  if (body.split(start).length !== 2 || body.split(end).length !== 2) throw Error(`Section changed: ${start}`)
  return body.slice(body.indexOf(start), body.indexOf(end, body.indexOf(start)))
}
const swap = async (name, transform) => {
  try { bodies.set(name, Buffer.from(transform(bodies.get(name).toString('utf8').replaceAll('\r\n', '\n'), await source(name)))) }
  catch (error) { throw Error(`${name}: ${error.message}`) }
}
const donors = ['src/host/taskflow/recovery.js', 'src/host/taskflow/continuation.js', 'src/shared/taskflow-message.js',
  'src/shared/group-task-record.js', 'src/client/task-message.js', 'src/client/task-inputs.js', 'src/client/group-settings.js',
  'src/host/taskflow/monitor.js', 'src/client/task-projection.js', 'src/shared/taskflow-types.d.ts']
for (const name of donors) bodies.set(name, Buffer.from(await source(name)))
await swap('src/host/taskflow.js', (body, donor) => {
  body = replace(body, "import { createTaskflowRecovery } from './taskflow/recovery.js'", "import { createTaskflowRecovery } from './taskflow/recovery.js'\nimport { installTaskflowMonitor, taskflowRoomEnabled } from './taskflow/monitor.js'")
  body = replace(body, section(body, '        post: async', '        log: (_level'), section(donor, '        post: async', '        log: (_level'))
  body = replace(body, "        if (!room.admin || !state.member(room, room.admin)) continue", "        if (!taskflowRoomEnabled(room) || !room.admin || !state.member(room, room.admin)) continue")
  body = replace(body, section(body, '          const reminderCard =', '        }\n      }\n      for (const cycle'), '')
  body = replace(body, "        if (!room?.admin) continue", "        if (!taskflowRoomEnabled(room) || !room?.admin) continue")
  body = replace(body, "        if (!room || room.admin !== plan.principal || !room.members.includes(plan.principal)) continue", "        if (!taskflowRoomEnabled(room) || room.admin !== plan.principal || !room.members.includes(plan.principal)) continue")
  const timer = '  rt.ctx.effect(() => {\n    const timer = setInterval(() => {'
  return replace(body, timer, section(donor, '  installTaskflowMonitor(rt,', timer) + timer)
})
await swap('src/host/groups.js', (body, donor) => {
  body = replace(body, "import { failureLine } from './turns.js'", "import { failureLine } from './turns.js'\nimport { nativeTaskSource, taskMessageOf, validateTaskEvent } from '../shared/taskflow-message.js'")
  body = replace(body, "round.replies.push({ kind: 'notice', text, time: Date.now() })", "round.replies?.push({ kind: 'notice', text, time: Date.now() })")
  body = replace(body, 'files = [] }, note, signal, round, by, said = [], heard = () => {}, onWork = () => {}) {', 'files = [], taskflowEvent }, note, signal, round, by, said = [], heard = () => {}, onWork = () => {}) {')
  body = replace(body, 'text, images, files, steer: busy, ...(by ? { askedBy: by } : {})', 'text, images, files, steer: busy, ...(taskflowEvent ? { taskflowEvent } : {}), ...(by ? { askedBy: by } : {})')
  body = replace(body, '{ text, images: prompt.images, files: prompt.files }, slot.note', '{ text, images: prompt.images, files: prompt.files, taskflowEvent: slot.taskflowEvent }, slot.note')
  body = replace(body, "        ...(post.taskflowEvent ? { kind: 'task', taskflowEvent: post.taskflowEvent } : {}),", "        ...(post.taskflowEvent ? { kind: 'task', taskflowEvent: post.taskflowEvent, ...(post.taskSchemaVersion ? { taskSchemaVersion: post.taskSchemaVersion } : {}) } : {}),")
  body = replace(body, "        id: member.id, name: member.name, status: 'waiting', batch: 1,", "        id: member.id, name: member.name, status: 'waiting', batch: 1,\n        ...(opener.taskflowEvent ? { taskflowEvent: opener.taskflowEvent } : {}),")
  const give = '    if (wake !== undefined) giveResults(round, extra.askedBy, wake)'
  body = replace(body, give, section(donor, '    if (extra.taskflowEvent) for (const peer of speakers)', '    if (rt.isAdminOf(room, sender.id))') + give)
  const signature = '  async function postToRoom(room, sender, text, extra = {}, files = []) {'
  body = replace(body, signature, section(donor, signature, '    if (!maySpeakInRoom(room, sender.id)'))
  body = replace(body, "        const task = extra.taskflowEvent ? { kind: 'task', taskflowEvent: extra.taskflowEvent } : {}", "        const task = extra.taskflowEvent ? { kind: 'task', taskflowEvent: extra.taskflowEvent, ...(extra.nativeTask ? { taskSchemaVersion: 1 } : {}) } : {}")
  body = replace(body, 'text: `[Group post from ${sender.name}]\\n${text}`', 'text: extra.nativeTask ? text : `[Group post from ${sender.name}]\\n${text}`')
  const oldSource = "      source: { kind: SOURCE_KIND, form: 'relay', role: 'post', exchangeId: randomUUID(), senderName: sender.name, senderSessionId: sender.id, roomId: room.id, ...extra },"
  body = replace(body, oldSource, "      source: extra.nativeTask ? nativeTaskSource(room.id, extra.taskflowEvent, { ...extra, exchangeId: randomUUID() }) : { kind: SOURCE_KIND, form: 'relay', role: 'post', exchangeId: randomUUID(), senderName: sender.name, senderSessionId: sender.id, roomId: room.id, ...extra },")
  body = replace(body, '  rt.postToRoom = postToRoom', '  rt.postToRoom = postToRoom\n  rt.postTaskToRoom = postTaskToRoom')
  body = replace(body, "message.source?.kind === 'schedule' || (message.source?.kind === SOURCE_KIND", "message.source?.kind === 'schedule' || message.source?.kind === 'taskflow' && !!taskMessageOf(message) || (message.source?.kind === SOURCE_KIND")
  return body
})
await swap('src/host/turns.js', body => {
  body = replace(body, "import { cleanText } from './diagnostics.js'", "import { cleanText } from './diagnostics.js'\nimport { taskMessageOf } from '../shared/taskflow-message.js'\nconst isTeamSource = source => source?.kind === SOURCE_KIND || source?.kind === 'taskflow' && !!taskMessageOf({ source })")
  body = body.replaceAll('source?.kind === SOURCE_KIND', 'isTeamSource(source)')
  body = replace(body, "const isTeamSource = source => isTeamSource(source)", "const isTeamSource = source => source?.kind === SOURCE_KIND")
  body = replace(body, '      ...(info?.work ? { work: info.work } : {}),', "      ...(info?.work ? { work: info.work } : {}),\n      ...(info?.kind === 'taskflow' ? { taskflowEvent: info.taskflowEvent } : {}),")
  return replace(body, '            ...(source.taskflowEvent ? { taskflowEvent: source.taskflowEvent } : {}),', "            ...(source.taskflowEvent ? { taskflowEvent: source.taskflowEvent } : {}),\n            ...(source.kind === 'taskflow' ? { taskSchemaVersion: source.version } : {}),")
})
await swap('src/host/delivery.js', body => {
  body = replace(body, "import { headOf, textOf } from './text.js'", "import { headOf, textOf } from './text.js'\nimport { nativeTaskSource } from '../shared/taskflow-message.js'")
  body = replace(body, 'length, work }) {', 'length, work, taskflowEvent }) {')
  body = replace(body, '    const source = {\n      kind: SOURCE_KIND,', '    let source = {\n      kind: SOURCE_KIND,')
  return replace(body, '    const targetSessionId = sessionId ?? rt.chatOf(toId)', '    if (taskflowEvent) source = { ...nativeTaskSource(roomId, taskflowEvent, source), role }\n    const targetSessionId = sessionId ?? rt.chatOf(toId)')
})
await swap('src/host/parts.js', body => {
  body = replace(body, "import { legacyTaskCandidate, taskMessageOf } from '../shared/taskflow-message.js'", "import { legacyTaskCandidate, taskMessageOf, isTeamMessageSource } from '../shared/taskflow-message.js'")
  body = replace(body, "source?.kind !== 'user' && source?.kind !== SOURCE_KIND", "source?.kind !== 'user' && !isTeamMessageSource(source)")
  body = replace(body, '  const ours = source.kind === SOURCE_KIND', '  const ours = isTeamMessageSource(source)')
  body = replace(body, "const inboxTargetOf = message => (message.source?.kind === 'user' || message.source?.kind === SOURCE_KIND", "const inboxTargetOf = message => (message.source?.kind === 'user' || isTeamMessageSource(message.source)")
  body = replace(body, "} else if (source?.kind === SOURCE_KIND && source.role === 'post') {", "} else if ((source?.kind === SOURCE_KIND || source?.kind === 'taskflow') && source.role === 'post') {")
  return replace(body, "          kind: task ? 'task' : 'post',", "          kind: task ? 'task' : source.kind === 'taskflow' ? 'task-error' : 'post',")
})
await swap('src/host/resume.js', (body, donor) => {
  body = replace(body, "MESSAGE_INLINE_MAX, SOURCE_KIND, STEER_CUT", 'MESSAGE_INLINE_MAX, STEER_CUT')
  body = replace(body, "import { textOf } from './text.js'", "import { textOf } from './text.js'\nimport { isTeamMessageSource } from '../shared/taskflow-message.js'")
  body = replace(body, 'const triggerOf = info => ({\n  role: info.role,', "const triggerOf = info => ({\n  role: info.role,\n  ...(info.kind === 'taskflow' ? { kind: 'taskflow', taskflowEvent: info.taskflowEvent } : {}),")
  body = replace(body, 'message?.source?.kind === SOURCE_KIND', 'isTeamMessageSource(message?.source)')
  body = replace(body, 'event.data?.source?.kind === SOURCE_KIND', 'isTeamMessageSource(event.data?.source)')
  body = replace(body, 'event.data?.source?.kind !== SOURCE_KIND', '!isTeamMessageSource(event.data?.source)')
  const start = "      await rt.deliver({ toId: bot.id, sessionId: room.sessions?.[bot.id] ?? sessionId, role: 'room'"
  return replace(body, section(body, start, '\n      return\n    }\n    if (record.resumed)'), section(donor, start, '\n      return\n    }\n    if (record.resumed)'))
})
await swap('src/host/channel.js', body => replace(body, '            notice: body.notice,\n            mode:', '            notice: body.notice,\n            taskflowEnabled: body.taskflowEnabled,\n            mode:'))
await swap('src/host/roster.js', (body, donor) => {
  const notice = '    const notice = patch.notice === undefined ? undefined : cleanNotice(patch.notice)'
  body = replace(body, notice, section(donor, notice, '    if (patch.workDir !== undefined && byAdmin)'))
  return replace(body, '    room.admin = admin\n', section(donor, '    room.admin = admin\n', '    if (patch.mode !== undefined && patch.mode !== room.mode)'))
})
await swap('src/client/index.js', body => {
  body = replace(body, "import { TASK_MESSAGE_CSS } from './task-message.js'", "import { TASK_MESSAGE_CSS, NativeTaskCell } from './task-message.js'\nimport { installTaskProjection, TASK_NODE_KIND } from './task-projection.js'")
  body = replace(body, '  actions.groupReplyNodes = supportsGroupReplyProjection(ctx)', "  actions.groupReplyNodes = supportsGroupReplyProjection(ctx)\n  actions.nativeTaskNodes = typeof ctx.uiConversation?.events?.register === 'function'")
  return replace(body, '  const installConversation = () => [', "  const installConversation = () => [\n    () => installTaskProjection(ctx),\n    () => shadow('conversation.chat.node', { key: TASK_NODE_KIND, priority: BOT_PRIORITY, locale: 'chat', inject: face }, NativeTaskCell),")
})
await swap('src/client/cells.js', body => {
  body = replace(body, 'TaskMessage, TaskInputCell, markdownLabels', 'TaskMessage, TaskInputCell, TaskError, markdownLabels')
  body = replace(body, "    case 'task': return h(TaskMessage", "    case 'task-error': return h(TaskError, { key })\n    case 'task': return h(TaskMessage")
  body = replace(body, '  function triggerBody() {', "  function triggerBody() {\n    if (source.kind === 'taskflow') return null")
  return replace(body, 'function RelayEvent({ reply, bot, sessionId, actions }) {', "function RelayEvent({ reply, bot, sessionId, actions }) {\n  if (reply.kind === 'task-error') return h(TaskError)")
})
const pkg = JSON.parse(bodies.get('package.json'))
pkg.version = '0.3.42-native-taskflow.1'
pkg.exports['./taskflow'] = { types: './src/shared/taskflow-types.d.ts', default: './src/shared/taskflow-message.js' }
bodies.set('package.json', Buffer.from(JSON.stringify(pkg, null, 2) + '\n'))
for (const [name, body] of bodies) {
  await fs.mkdir(path.dirname(path.join(out, name)), { recursive: true })
  await fs.writeFile(path.join(out, name), body)
}
bodies.set('client.js', Buffer.from(await bundleClient(out)))
await fs.writeFile(path.join(out, 'client.js'), bodies.get('client.js'))
const candidate = Object.fromEntries([...bodies].map(([name, body]) => [name, hash(body)]))
const changed = Object.keys(candidate).filter(name => candidate[name] !== prior.candidate[name]).sort()
const bind = async names => Object.fromEntries(await Promise.all(names.map(async name => [name, hash(await fs.readFile(path.join(root, name)))])))
const reviewInputs = await bind(['test/retention.test.mjs', 'test/plugin.test.mjs', 'test/task-row-projection.test.mjs', 'test/task-markdown-contract.test.mjs', 'test/executor-task-only.test.mjs', 'test/install.test.js', 'test/group-work.test.js', 'test/taskflow-native.test.mjs', 'test/taskflow-monitor.test.mjs', 'test/taskflow-reminders.test.mjs', 'test/taskflow-exhaustion.test.mjs', 'test/taskflow-continuation.test.mjs', 'test/taskflow-fixture.mjs', 'test/task-message.test.js', 'test/harness-resolve.mjs', 'scripts/stage-native-taskflow.mjs', 'scripts/build-client.mjs', '.tmp-verify/native-runtime-loader.mjs'])
const sourcePatchInputs = await bind([...new Set([...donors, ...changed.filter(name => name.startsWith('src/'))])])
await fs.writeFile(path.join(root, '.tmp-verify/native-manifest-1.json'), JSON.stringify({ version: pkg.version, baseline: prior.candidate, candidate, changed, reviewInputs, sourcePatchInputs,
  scope: 'Installed .41 baseline plus standalone activity-gated task monitor, explicit native task source/delivery/projection/history/restart and group enablement. Client rebuilt from exact candidate sources; unrelated workspace runtime/client branches excluded.' }, null, 2))
console.log(JSON.stringify({ version: pkg.version, files: bodies.size, changed }))
