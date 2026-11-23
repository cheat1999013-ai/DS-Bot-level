import { taskMessageOf } from '../shared/taskflow-message.js'

export const TASK_NODE_KIND = 'ds-bot-native-task'
export function installTaskProjection(ctx) {
  if (typeof ctx.uiConversation?.events?.register !== 'function') return () => {}
  return ctx.uiConversation.events.register({
    kind: TASK_NODE_KIND, target: 'chat',
    match: { 'user/message': event => event.data?.source?.kind === 'taskflow'
      && event.data.source.role === 'post'
      ? { id: event.data.source.exchangeId ?? String(event.seq), role: 'start' } : null },
    start: (_context, matched) => {
      const data = matched.event.data
      const task = taskMessageOf(data)
      return { task, error: !task,
        text: (data.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n'),
        time: matched.event.time, logged: data.source.logged }
    },
    publication: () => 'immediate',
    buildViewNode: context => !context.start || !context.state || context.state.logged !== undefined ? null : ({
      key: context.key, id: context.id, kind: TASK_NODE_KIND, target: 'chat',
      anchorSeq: context.start.event.seq, location: context.start.location,
      visibility: 'visible', groupTree: 'exchange', data: context.state,
    }),
  })
}
