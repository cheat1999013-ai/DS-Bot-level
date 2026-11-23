// Task identity belongs to the notification, independently of the model transport role.
const REFERENCE = /\[Taskflow ([A-Za-z0-9_.:-]+)(?:\/([A-Za-z0-9_.:-]+))?\]/
export const taskflowReference = text => {
  const match = REFERENCE.exec(String(text ?? ''))
  return match ? { planId: match[1], ...(match[2] ? { cardId: match[2] } : {}) } : null
}
const token = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]+$/.test(value) && value.length <= 256
export const validateTaskEvent = task => {
  if (!task || typeof task !== 'object' || Array.isArray(task) || !token(task.planId)) return null
  if (Object.hasOwn(task, 'cardId') && !token(task.cardId)) return null
  if (!token(task.event) || !token(task.from?.id) || !token(task.to?.id)) return null
  return task
}
export const nativeTaskSource = (roomId, taskflowEvent, extra = {}) => {
  if (!token(roomId) || !validateTaskEvent(taskflowEvent)) throw new Error('Invalid native task identity')
  return { ...extra, kind: 'taskflow', version: 1, form: 'task', role: 'post', roomId, taskflowEvent,
    senderSessionId: taskflowEvent.from.id, senderName: taskflowEvent.from.name ?? taskflowEvent.from.id }
}
export const taskMessageOf = data => {
  const source = data?.source
  if (source?.kind === 'taskflow') return source.version === 1 && token(source.roomId) ? validateTaskEvent(source.taskflowEvent) : null
  if (source?.kind !== 'bot') return null
  return taskIdentityOf(source.taskflowEvent)
}
export const isTeamMessageSource = source => source?.kind === 'bot'
  || source?.kind === 'taskflow' && !!taskMessageOf({ source })
export const taskIdentityOf = task => {
  if (!task || typeof task !== 'object' || Array.isArray(task) || !Object.hasOwn(task, 'planId') || !token(task.planId)) return null
  if (Object.hasOwn(task, 'cardId') && !token(task.cardId)) return null
  if (task.event !== undefined && typeof task.event !== 'string') return null
  return task
}
export const legacyTaskCandidate = data => {
  if (data?.source?.kind !== 'user' || typeof data.source.rpcId !== 'string') return null
  if (!Array.isArray(data.content) || data.content.some(block => block.type !== 'text')) return null
  const text = data.content.map(block => block.text ?? '').join('\n')
  const match = /^@([^\r\n]+?) \[Taskflow ([A-Za-z0-9_.:-]+)\/([A-Za-z0-9_.:-]+)\] 已提报，等待逐卡验收。$/.exec(text)
  return match && Number.isFinite(data.time) ? { planId: match[2], cardId: match[3], principalName: match[1] } : null
}
export const confirmedLegacyTask = (data, board) => {
  const candidate = legacyTaskCandidate(data)
  if (!candidate) return null
  const event = board?.timeline?.find(event => event.type === 'result_observed'
    && event.plan_id === candidate.planId && event.card_id === candidate.cardId
    && event.principal_name === candidate.principalName && event.payload?.status === 'settled'
    && data.time >= event.at * 1000 && data.time - event.at * 1000 <= 10000)
  return event ? { planId: candidate.planId, cardId: candidate.cardId, event: 'submitted' } : null
}
