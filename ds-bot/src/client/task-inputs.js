import { createElement as h } from 'react'
import { TaskInputCell, TaskSourceHeader } from './task-message.js'
import { taskMessageOf } from '../shared/taskflow-message.js'
import { canDrawUserMessages, UserMessageCell } from './user-message.js'
import { freePriority } from './surface.js'

export function installTaskInputs(slots, { roster, face, priority = -100 }) {
  const source = slots.inject('conversation.chat.user.before', () => slots.register({
    name: 'conversation.chat.user.before', priority,
    select: ({ source }) => {
      const task = taskMessageOf({ source })
      return typeof task?.planId === 'string' && task.planId ? task : null
    },
  }, TaskSourceHeader))
  const inputs = slots.inject('conversation.chat.node', () => {
    const custom = canDrawUserMessages()
    const offs = (custom ? ['user', 'steering'] : ['steering']).map(key => {
      const original = slots.entries('conversation.chat.node').find(entry => (entry.options?.key ?? entry.key) === key)
      // A foreign renderer's children cannot be redeclared or borrowed by a shadow.
      if (!original?.component || (!custom && Object.keys(original.children ?? {}).length)) return () => {}
      const inject = custom ? face : (...args) => {
        const existing = original.inject?.(...args) ?? {}
        return { ...existing, hooks: { ...existing.hooks, roster } }
      }
      return slots.register({ name: 'conversation.chat.node', key,
        priority: freePriority(slots.entries('conversation.chat.node'), { key, priority }),
        locale: original.locale ?? 'chat', inject,
      }, props => h(TaskInputCell, { ...props, Fallback: custom ? UserMessageCell : original.component }))
    })
    return () => { for (const off of offs.reverse()) off() }
  })
  return () => { inputs(); source() }
}
