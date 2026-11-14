import { randomUUID } from 'node:crypto'
import { own } from './store.js'
import { selectorOf, timingOf } from './schedules.js'

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

  rt.groupSchedulesView = entries => Object.values(records()).map(config => {
    const entry = entries.find(item => item.id === config.scheduleId && item.target?.sessionId === config.sessionId)
    const lastRun = config.lastRun?.state === 'dispatching' && !active.has(config.id)
      ? { ...config.lastRun, state: 'needs-review' } : config.lastRun
    return { ...entry, id: config.id, sessionId: config.sessionId, roomId: config.roomId, memberId: config.memberId,
      mode: 'group-card', title: config.title, prompt: config.prompt, lastRun,
      kind: entry?.kind ?? config.when.kind, time: entry?.time ?? config.when.time,
      timeZone: entry?.timeZone ?? config.when.timeZone,
      everySeconds: entry?.everySeconds ?? (config.when.kind === 'every' ? config.when.minutes * 60 : undefined),
      status: entry?.status ?? 'paused', schedulingError: config.error ?? (config.stage !== 'ready' ? 'The group schedule needs repair' : undefined) }
  })

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

  rt.groupScheduleEndpoint = async (endpoint, body = {}) => {
    await rt.load()
    writeCheck()
    if (endpoint === 'group-schedule-create') return create(body)
    if (endpoint === 'group-schedule-delete') return remove(body)
    throw new Error('Unknown group schedule action')
  }

  rt.cancelGroupSchedules = async roomId => {
    for (const config of Object.values(records()).filter(item => item.roomId === roomId)) await remove({ id: config.id })
  }

  const runOccurrence = async (config, occurrence) => {
    if (occurrence.schedule_id !== config.scheduleId || typeof occurrence.occurrence_at !== 'string'
      || !Number.isFinite(Date.parse(occurrence.occurrence_at))
      || new Date(occurrence.occurrence_at).toISOString() !== occurrence.occurrence_at) {
      throw new Error('The timer occurrence does not match its saved group task')
    }
    if (config.lastRun?.occurrenceAt === occurrence.occurrence_at) return
    config.lastRun = { occurrenceAt: occurrence.occurrence_at, state: 'dispatching' }
    active.add(config.id)
    try {
      await rt.save()
      if (own(records(), config.id) !== config || config.stage !== 'ready') return
      writeCheck()
      const result = await rt.taskflowDispatchScheduled({ scheduleId: config.scheduleId,
        occurrenceAt: occurrence.occurrence_at, roomId: config.roomId, memberId: config.memberId,
        title: config.title, prompt: config.prompt })
      config.lastRun = { occurrenceAt: occurrence.occurrence_at,
        state: result.duplicate ? 'duplicate' : result.sent?.length ? 'dispatched' : 'needs-review',
        planId: result.plan?.plan_id ?? result.planId,
        ...(result.held?.length ? { error: result.held.map(item => item.reason).join('; ') } : {}) }
      delete config.error
      await rt.save()
    } catch (error) {
      config.lastRun = { ...config.lastRun,
        state: ['plan_already_open', 'member_not_in_room', 'leader_only', 'leader_cannot_assign_self'].includes(error.code) ? 'blocked' : 'needs-review',
        error: errorText(error) }
      await rt.save().catch(failure => rt.warn('ds-bot: group task outcome could not be saved: %s', errorText(failure)))
    } finally { active.delete(config.id) }
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
