import { mentionSpans } from '../../shared/mentions.js'
import { taskflowReference } from '../../shared/taskflow-message.js'

const directive = /^(?:(?:请|麻烦|劳烦)\s*(?:你|您)?\s*(?:帮我|帮忙)?\s*|please\s+)?(?:补查|补跑|补充|核查|核实|核验|巡检|检查|检索|查询|调研|研究|收集|整理|汇总|分析|评估|追踪|关注|阅读|起草|撰写|编写|写|制作|开发|修复|实现|测试|执行|完成|提交|处理|负责|check\b|research\b|review\b|draft\b|write\b|implement\b|fix\b|test\b|collect\b|investigate\b)/iu
const normalize = text => String(text ?? '').replace(/\s+/g, ' ').trim()

// This is a read projection of retained messages, never a coordination ledger write.
export function groupAssignments(room, bots, plans = []) {
  if (!room?.admin) return []
  const members = (room.members ?? []).filter(id => bots[id]).map(id => ({ ...bots[id], id }))
  if (!members.some(member => member.id === room.admin)) return []
  const tasks = []
  const latest = new Map()
  const seen = new Set()
  for (const line of [...(room.log ?? [])].sort((a, b) => a.seq - b.seq)) {
    if (!Number.isSafeInteger(line.seq) || line.seq < 1) continue
    const previous = latest.get(line.botId)
    if (previous && !previous.reply && line.seq > previous.source.seq && typeof line.text === 'string' && line.text.trim()) {
      previous.state = 'replied'
      previous.reply = { seq: line.seq, botId: line.botId }
    }
    if (line.botId !== room.admin || line.kind || line.taskflowEvent || taskflowReference(line.text)) continue
    const text = String(line.text ?? '')
    const mentions = mentionSpans(text, members)
    for (const [index, mention] of mentions.entries()) {
      const member = mention.bot
      if (!member || member.id === room.admin) continue
      let goal = text.slice(mention.end, mentions[index + 1]?.start ?? text.length).trim()
      if (!goal) goal = text.slice(mentions.at(-1).end).trim()
      if (!directive.test(goal)) continue
      const key = `${line.seq}:${member.id}`
      if (seen.has(key)) continue
      seen.add(key)
      const registered = plans.some(plan => plan.cards?.some(card => card.member === member.id && normalize(card.goal) === normalize(goal)))
      if (registered) continue
      const task = { id: `group-${room.id}-${line.seq}-${member.id}`, member: member.id, member_name: member.name,
        room: room.id, room_name: room.name, goal, state: 'assigned',
        source: { kind: 'group_message', room: room.id, seq: line.seq, botId: line.botId, text,
          at: Number.isFinite(line.at) && line.at > 0 ? line.at : null } }
      tasks.push(task)
      latest.set(member.id, task)
    }
  }
  return tasks.reverse()
}
