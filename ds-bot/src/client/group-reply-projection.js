// A group relay carries chat replies, so its visible row belongs to the
// exchange, outside DSH's foldable tool process. Keep the native tool node intact.
export const GROUP_REPLY_KIND = 'ds-bot-group-reply'
export const supportsGroupReplyProjection = ctx => typeof ctx.uiConversation?.events?.register === 'function'

export function installGroupReplyProjection(ctx) {
  if (!supportsGroupReplyProjection(ctx)) return () => {}
  const match = event => {
    if (event.type === 'tool/call' && event.data?.name === 'group_relay' && typeof event.data.callId === 'string') {
      return { id: event.data.callId, role: 'start' }
    }
    if (event.type === 'tool/result' && event.surfaceOp === 'append') {
      const source = event.data?.message?.source
      if (source?.kind === 'tool' && typeof source.callId === 'string') return { id: source.callId, role: 'update' }
    }
    if ((event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch')
      && event.data?.name === 'group_relay' && typeof event.data.subCallId === 'string') {
      return { id: event.data.subCallId, role: 'start' }
    }
    return null
  }
  const completed = (state, message, error) => ({ ...state, phase: 'result', block: {
    content: message.content ?? [], isError: message.isError === true,
    ...(error === undefined ? {} : { error }),
  } })
  return ctx.uiConversation.events.register({
    kind: GROUP_REPLY_KIND, target: 'chat',
    match: { 'tool/call': match, 'tool/result': match, 'tool/ptc-dispatch-start': match, 'tool/ptc-dispatch': match },
    start: (_context, matched) => {
      const event = matched.event
      const state = { callId: event.data.subCallId ?? event.data.callId, phase: 'start', block: null }
      return event.type === 'tool/ptc-dispatch' ? completed(state, event.data, event.data.error) : state
    },
    update: (context, matched) => {
      const event = matched.event
      if (event.type === 'tool/ptc-dispatch') return completed(context.state, event.data, event.data.error)
      if (event.type === 'tool/result') return completed(context.state, event.data.message, event.data.error)
      return context.state
    },
    publication: () => 'immediate',
    buildViewNode: context => {
      // An orphan result or model-only replacement cannot establish a group call.
      if (!context.start || !context.state) return null
      return {
        key: context.key, kind: GROUP_REPLY_KIND, id: context.id, target: 'chat',
        anchorSeq: context.start.event.seq, location: context.start.location,
        visibility: 'visible', groupTree: 'exchange', data: context.state,
      }
    },
  })
}
