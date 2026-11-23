// Resolve taskflow callers from DS Bot's live, owned roster. Never trust a tool argument
// for caller identity or read a second snapshot of state.json.
export class BotState {
  constructor(rt) { this.rt = rt }

  bot(id) { return this.rt.botOf(id) ?? null }
  room(ref) {
    if (typeof ref !== 'string' || ref === '') return null
    const exact = this.rt.roomOf(ref) ?? Object.values(this.rt.state.rooms).find(room => room.name === ref)
    if (exact) return exact
    const folded = ref.toLowerCase()
    return Object.values(this.rt.state.rooms).find(room => room.name?.toLowerCase() === folded) ?? null
  }
  rooms() { return Object.values(this.rt.state.rooms) }
  callerOf(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return null
    const botId = this.rt.selfOf(sessionId)
    const bot = botId && this.bot(botId)
    if (!bot || !this.rt.isBotSession(sessionId)) return null
    const owner = this.rt.groupOwners.get(sessionId)
    const room = owner ? this.room(owner.roomId) : null
    if (owner && (!room || !room.members.includes(botId))) return null
    return { kind: room ? 'group' : 'own', sessionId, botId, bot, room, roomId: room?.id ?? null }
  }
  roomFor(caller, ref) {
    if (caller?.room) {
      if (!ref || ref === caller.room.id || ref === caller.room.name) return caller.room
      return this.room(ref)?.id === caller.room.id ? caller.room : null
    }
    return null
  }
  members(room) {
    return (room?.members ?? []).map(id => {
      const bot = this.bot(id)
      return bot ? {
        id, name: bot.name, role: bot.role ?? '', instructions: bot.instructions ?? '',
        model: bot.appliedModel ?? bot.model ?? '', admin: room.admin === id, private: bot.private === true,
      } : null
    }).filter(Boolean)
  }
  member(room, ref) {
    if (typeof ref !== 'string' || !ref.trim()) return null
    const members = this.members(room)
    return members.find(item => item.id === ref) ?? members.find(item => item.name === ref)
      ?? members.find(item => item.name.toLowerCase() === ref.toLowerCase()) ?? null
  }
  names(room) { return Object.fromEntries(this.members(room).map(member => [member.id, member.name])) }
  groupSessionId(room) { return room?.id ?? null }
  admin(room) { return room?.admin ? this.bot(room.admin) : null }
}
