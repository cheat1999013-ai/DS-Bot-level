import { randomUUID } from 'node:crypto'
import { own } from './store.js'
import { selectorOf, timingOf } from './schedules.js'
import { taskflowRoomEnabled } from './taskflow/monitor.js'

export function scheduleOccurrences(text) {
  const batch = /^reminders_json: (.*)$/m.exec(text)
  if (batch) return JSON.parse(batch[1])
  const id = /^schedule_id_json: (.*)$/m.exec(text)
  const at = /^occurrence_at: (.*)$/m.exec(text)
  if (!id || !at) throw new Error('The scheduled task has no occurrence identity')
  return [{ schedule_id: JSON.parse(id[1]), occurrence_at: at[1] }]
}

export function install(rt) {
  const records = () => rt.state.groupSchedules ?? {}
  const recordForSession = id => Object.values(records()).find(config => config.sessionId === id)
  const writeCheck = () => { const reason = rt.readOnly(); if (reason !== undefined) throw new Error(reason) }
  const service = () => {
    const schedule = rt.scheduleService?.()
    if (typeof schedule?.edit !== 'function') throw new Error('Group task cards require DSH Automation tasks')
    return schedule
  }
  const errorText = error => (rt.redactSecrets?.(String(error?.message ?? error)) ?? String(error?.message ?? error)).slice(0, 500)
  const active = new Set()
  const connecting = new Set()
  const removeTimers = async config => {
    const schedule = service()
    for (const entry of await schedule.catalog()) {
      if (entry.target?.kind === 'session' && entry.target.sessionId === config.sessionId) {
        await schedule.edit({ id: entry.id, action: 'delete' })
      }
    }
    if ((await schedule.catalog()).some(entry => entry.target?.kind === 'session' && entry.target.sessionId === config.sessionId)) {
      throw new Error('The group task timer could not be removed')
    }
  }

  rt.groupSchedulesView = entries => Object.values(records()).flatMap(config => {
    const timer = entries.find(item => item.id === config.scheduleId)
    if (config.sourceSessionId && timer?.target?.sessionId === config.sourceSessionId) return []
    const entry = timer?.target?.sessionId === config.sessionId ? timer : undefined
    const lastRun = config.lastRun?.state === 'dispatching' && !active.has(config.id)
      ? { ...config.lastRun, state: 'needs-review' } : config.lastRun
    return { ...entry, id: config.id, sessionId: config.sessionId, roomId: config.roomId, memberId: config.memberId,
      mode: 'group-card', title: config.title, prompt: config.prompt, lastRun, pendingCount: config.pendingOccurrences?.length ?? 0,
      kind: entry?.kind ?? config.when.kind, time: entry?.time ?? config.when.time,
      timeZone: entry?.timeZone ?? config.when.timeZone,
      everySeconds: entry?.everySeconds ?? (config.when.kind === 'every' ? config.when.minutes * 60 : undefined),
      status: entry?.status ?? 'paused', schedulingError: config.error ?? (config.stage !== 'ready' ? 'The group schedule needs repair' : undefined) }
  })

  rt.assertGroupScheduleDelivery = (roomId, event) => {
    if (event?.event !== 'assigned' || !event.schedule) return
    const config = Object.values(records()).find(item => item.scheduleId === event.schedule.id)
    const room = rt.roomOf(roomId)
    if (!config || config.stage !== 'ready' || config.roomId !== roomId || !taskflowRoomEnabled(room)
      || room.admin !== event.from?.id || config.memberId !== event.to?.id || !room.members.includes(event.to?.id)) {
      throw Object.assign(new Error('Scheduled assignment cancelled because the group or schedule changed'), { code: 'taskflow_delivery_cancelled' })
    }
  }

  const create = async body => {
    const schedule = service()
    const room = rt.roomOf(body.target)
    const member = rt.botOf(body.memberId)
    if (!room || !room.members.includes(room.admin) || !rt.botOf(room.admin)) throw new Error('Choose a group with a current principal')
    if (!member || !room.members.includes(body.memberId) || body.memberId === room.admin) throw new Error('Choose a non-principal executor in this group')
    const title = String(body.title ?? '').trim()
    const prompt = String(body.prompt ?? '').trim()
    if (!title || title.length > 120) throw new Error('Give the group task a name under 120 characters')
    if (!prompt || Buffer.byteLength(prompt, 'utf8') > 48000) throw new Error('Give the group task a goal under 48000 bytes')
    const timing = timingOf(selectorOf(body.when))
    const config = { id: randomUUID(), roomId: room.id, memberId: body.memberId, title, prompt,
      when: structuredClone(body.when), sessionId: null, scheduleId: null, stage: 'creating' }
    rt.state.groupSchedules ??= {}
    rt.state.groupSchedules[config.id] = config
    try {
      await rt.save()
      config.sessionId = await rt.createSession(`Group task schedule · ${title}`)
      await rt.save()
      const created = await schedule.create({ title, prompt, timing, target: { kind: 'session', sessionId: config.sessionId } })
      if (typeof created?.id !== 'string' || !created.id) throw new Error('The schedule service did not return a task id')
      config.scheduleId = created.id
      config.stage = 'ready'
      await rt.save()
    } catch (error) {
      config.stage = 'repair'
      config.error = errorText(error)
      if (config.sessionId) {
        try { await removeTimers(config) } catch (cleanup) { config.error += `; ${errorText(cleanup)}` }
      }
      await rt.save().catch(failure => rt.warn('ds-bot: group schedule repair state could not be saved: %s', errorText(failure)))
      throw error
    }
    return rt.scheduleEndpoint('schedules')
  }

  const remove = async body => {
    const config = own(records(), body.id)
    if (!config) throw new Error('No such group schedule')
    config.stage = 'deleting'
    await rt.save()
    if (config.sessionId) {
      await removeTimers(config)
      await rt.ctx.workspaceRegistry?.archiveSession(config.sessionId, { stopActivity: true })
    }
    delete rt.state.groupSchedules[config.id]
    try { await rt.save() } catch (error) { rt.state.groupSchedules[config.id] = config; throw error }
    return rt.scheduleEndpoint('schedules')
  }

  const update = async body => {
    const config = own(records(), body.id)
    if (!config || config.stage !== 'ready') throw new Error('No editable group schedule')
    const room = rt.roomOf(config.roomId)
    if (!room || !rt.botOf(body.memberId) || !room.members.includes(body.memberId) || body.memberId === room.admin) {
      throw new Error('Choose a non-principal executor in this group')
    }
    const oldMember = config.memberId
    config.memberId = body.memberId
    try { await rt.save() } catch (error) { config.memberId = oldMember; throw error }
    return rt.scheduleEndpoint('schedules')
  }

  const connect = async body => {
    const schedule = service()
    const { id, sessionId } = body
    const validateOwner = () => {
      const owner = rt.groupOwners.get(sessionId)
      const room = owner && rt.roomOf(owner.roomId)
      if (!room?.members.includes(owner.botId) || room.sessions?.[owner.botId] !== sessionId
        || room.admin === owner.botId || !room.members.includes(room.admin) || !rt.botOf(room.admin)) {
        throw new Error('Choose a timer for a current non-principal group member')
      }
      return { owner, room }
    }
    const { owner, room } = validateOwner()
    if (connecting.has(id)) throw new Error('This timer is already being connected')
    connecting.add(id)
    try {
      const entry = (await schedule.catalog()).find(item => item.id === id && item.target?.kind === 'session')
      let config = Object.values(records()).find(item => item.scheduleId === id)
      if (config && (config.sourceSessionId !== sessionId || config.stage !== 'ready')) throw new Error('This timer has another group binding')
      if (config && entry?.target.sessionId === config.sessionId) return rt.scheduleEndpoint('schedules')
      if (!entry || entry.target.sessionId !== sessionId || entry.status === 'ended') throw new Error('This timer no longer belongs to that group member')
      if (body.expectedUpdatedAt !== undefined && body.expectedUpdatedAt !== (entry.updatedAt ?? null)) throw new Error('The timer changed. Refresh and try again')
      if (!config) {
        const controller = await rt.createSession(`Group task schedule · ${entry.title}`)
        config = { id: randomUUID(), roomId: room.id, memberId: owner.botId, title: entry.title, prompt: entry.prompt,
          when: { kind: entry.kind }, sourceSessionId: sessionId, sessionId: controller, scheduleId: id, stage: 'ready' }
        rt.state.groupSchedules ??= {}
        rt.state.groupSchedules[config.id] = config
      } else {
        config.title = entry.title
        config.prompt = entry.prompt
      }
      // Persist the binding before the scheduler can deliver to the controller.
      await rt.save()
      const current = validateOwner()
      if (own(records(), config.id) !== config || config.stage !== 'ready'
        || current.room.id !== config.roomId || current.owner.botId !== config.memberId) {
        throw new Error('The group timer binding changed. Refresh and try again')
      }
      const result = await schedule.edit({ id, action: 'update', expectedUpdatedAt: entry.updatedAt ?? null,
        patch: { target: { kind: 'session', sessionId: config.sessionId } } })
      if (result?.target?.sessionId !== config.sessionId) throw new Error('The timer was not moved. Refresh and try again')
      return rt.scheduleEndpoint('schedules')
    } finally { connecting.delete(id) }
  }

  rt.groupScheduleEndpoint = async (endpoint, body = {}) => {
    await rt.load()
    writeCheck()
    if (endpoint === 'group-schedule-connect') return connect(body)
    if (endpoint === 'group-schedule-create') return create(body)
    if (endpoint === 'group-schedule-delete') return remove(body)
    if (endpoint === 'group-schedule-update') return update(body)
    throw new Error('Unknown group schedule action')
  }

  rt.cancelGroupSchedules = async roomId => {
    for (const config of Object.values(records()).filter(item => item.roomId === roomId)) {
      if (config.sessionId && typeof rt.scheduleService?.()?.edit !== 'function') {
        // Keep the controller binding inert until Automation can remove its timer.
        config.stage = 'deleting'
        await rt.save()
      } else await remove({ id: config.id })
    }
  }

  const drainingRooms = new Set()
  const waiting = error => ['plan_already_open', 'group_task_disabled', 'member_not_in_room', 'leader_only', 'leader_cannot_assign_self', 'taskflow_delivery_cancelled', 'taskflow_admission_busy'].includes(error.code)

  const drain = async () => {
    await rt.load()
    if (rt.readOnly() !== undefined) return
    for (const config of Object.values(records()).filter(item => item.stage === 'deleting' && !rt.roomOf(item.roomId))) {
      if (typeof rt.scheduleService?.()?.edit === 'function') {
        try { await remove({ id: config.id }) } catch (error) { rt.warn('ds-bot: deferred timer cleanup: %s', errorText(error)) }
      }
    }
    const frozenRooms = new Set(Object.values(records()).filter(config => config.stage === 'ready'
      && ['dispatching', 'needs-review'].includes(config.lastRun?.state)).map(config => config.roomId))
    const all = Object.values(records()).filter(config => config.stage === 'ready' && config.pendingOccurrences?.length
      && !frozenRooms.has(config.roomId) && taskflowRoomEnabled(rt.roomOf(config.roomId)))
      .sort((a, b) => a.pendingOccurrences[0].localeCompare(b.pendingOccurrences[0]) || a.id.localeCompare(b.id))
    const attemptedRooms = new Set()
    for (const config of all) {
      if (attemptedRooms.has(config.roomId) || drainingRooms.has(config.roomId) || own(records(), config.id) !== config) continue
      attemptedRooms.add(config.roomId)
      drainingRooms.add(config.roomId)
      active.add(config.id)
      const occurrenceAt = config.pendingOccurrences.shift()
      const previous = config.lastRun
      config.lastRun = { occurrenceAt, state: 'dispatching' }
      let admitted = false
      try {
        // Persist admission before creating a card. An interrupted admission is never replayed blindly.
        await rt.save()
        admitted = true
        if (own(records(), config.id) !== config || config.stage !== 'ready') continue
        writeCheck()
        const result = await rt.taskflowDispatchScheduled({ scheduleId: config.scheduleId,
          occurrenceAt, roomId: config.roomId, memberId: config.memberId, title: config.title, prompt: config.prompt })
        config.lastRun = { occurrenceAt, state: result.duplicate ? 'duplicate' : result.sent?.length ? 'dispatched' : 'needs-review',
          planId: result.plan?.plan_id ?? result.planId,
          ...(result.held?.length ? { error: result.held.map(item => item.reason).join('; ') } : {}) }
        delete config.error
        await rt.save()
      } catch (error) {
        if (!admitted) {
          config.lastRun = previous
          config.pendingOccurrences.unshift(occurrenceAt)
        } else if (waiting(error)) {
          config.pendingOccurrences.unshift(occurrenceAt)
          config.lastRun = { occurrenceAt, state: 'blocked', error: errorText(error) }
        } else config.lastRun = { occurrenceAt, state: 'needs-review', error: errorText(error) }
        await rt.save().catch(failure => rt.warn('ds-bot: group task outcome could not be saved: %s', errorText(failure)))
      } finally { active.delete(config.id); drainingRooms.delete(config.roomId) }
    }
  }
  rt.drainGroupSchedules = drain
  rt.ctx.effect(() => {
    const timer = setInterval(() => void drain().catch(error => rt.warn('ds-bot: scheduled task queue: %s', errorText(error))), 300000)
    void drain().catch(error => rt.warn('ds-bot: scheduled task queue: %s', errorText(error)))
    return () => clearInterval(timer)
  }, 'ds-bot: scheduled group task queue')

  const runOccurrence = async (config, occurrence) => {
    if (occurrence.schedule_id !== config.scheduleId || typeof occurrence.occurrence_at !== 'string'
      || !Number.isFinite(Date.parse(occurrence.occurrence_at))
      || new Date(occurrence.occurrence_at).toISOString() !== occurrence.occurrence_at) {
      throw new Error('The timer occurrence does not match its saved group task')
    }
    if (config.lastRun?.occurrenceAt === occurrence.occurrence_at || config.pendingOccurrences?.includes(occurrence.occurrence_at)) return
    config.pendingOccurrences ??= []
    config.pendingOccurrences.push(occurrence.occurrence_at)
    config.pendingOccurrences.sort()
    await rt.save()
    await drain()
  }

  rt.ctx.on('llm/stream', (options, next) => {
    return (async function* dispatchGroupTask() {
      await rt.load()
      const config = recordForSession(options.sessionId)
      if (!config) { yield* next(); return }
      if (config?.stage === 'ready' && rt.readOnly() === undefined) {
        const latest = [...options.messages].reverse().find(message => ['assistant', 'tool'].includes(message.role)
          || (message.role === 'user' && ['user', 'schedule'].includes(message.source?.kind)))
        if (latest?.role === 'user' && latest.source?.kind === 'schedule') {
          try {
            const text = typeof latest.content === 'string' ? latest.content : (latest.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
            const occurrences = scheduleOccurrences(text)
            if (!Array.isArray(occurrences) || !occurrences.length) throw new Error('The timer has no scheduled occurrence')
            for (const occurrence of occurrences) await runOccurrence(config, occurrence)
          } catch (error) {
            config.error = errorText(error)
            await rt.save().catch(() => {})
            rt.warn('ds-bot: group task trigger rejected: %s', errorText(error))
          }
        }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  })
}
