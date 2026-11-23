import { taskIdentityOf, validateTaskEvent } from './taskflow-message.js'

// A task row keeps its persisted identity and body through group-rows and history.
export function groupTaskRecord(record, who) {
  if (record.kind !== 'task') return null
  const native = record.taskSchemaVersion !== undefined
  const task = native ? record.taskSchemaVersion === 1 && validateTaskEvent(record.taskflowEvent)
    : taskIdentityOf(record.taskflowEvent)
  if (native && !task) return { kind: 'task-error', ...who, time: record.time }
  return { kind: task ? 'task' : 'notice', ...who, text: record.text ?? '', time: record.time,
    ...(task ? { taskflowEvent: task } : {}) }
}
