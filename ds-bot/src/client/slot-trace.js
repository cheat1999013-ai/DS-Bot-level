const SLOT = 'conversation.chat.node'
const KEYS = new Set(['user', 'steering', 'turn-trigger', 'turn-error', 'model-retry', 'ds-bot-group-reply'])
const tag = value => typeof value === 'string' && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(value) && value.length <= 100 ? value : undefined
const REGISTRANTS = new Set(['ds-bot', 'native-chat', '@deepseek-ai/dsh-client-ui-chat'])
const entryFacts = entry => ({
  key: KEYS.has(entry?.options?.key) ? entry.options.key : undefined,
  component: tag(entry?.component?.displayName ?? entry?.component?.name) ?? 'anonymous',
  registrant: REGISTRANTS.has(entry?.options?.registrant ?? entry?.registrant) ? (entry?.options?.registrant ?? entry?.registrant) : 'other',
  priority: Number.isFinite(entry?.options?.priority) ? entry.options.priority : 0,
})

// Keep only function names and numeric bundle positions, never URLs or the error body.
export function slotFailureFacts(error) {
  const message = typeof error?.message === 'string' ? error.message : ''
  const known = message.match(/^Cannot read properties of (undefined|null) \(reading '(code|planId)'\)$/)
  if (error?.name !== 'TypeError' || !known) return { type: 'other' }
  const frames = String(error?.stack ?? '').split('\n').slice(1, 11).flatMap(line => {
    const match = line.match(/^\s*at (?:(.*?) \()?.*?:(\d+):(\d+)\)?\s*$/)
    return match ? [{ function: tag(match[1]?.trim()) ?? 'anonymous', line: Number(match[2]), column: Number(match[3]) }] : []
  })
  return { type: 'TypeError', read: `${known[1]}.${known[2]}`, frames }
}

// Public, read-only slot supervision. Do not remount, abdicate, or alter an entry here.
export function installSlotTrace(slots, { getFacts = () => ({}), observables = [], write = value => console.info('[ds-bot-slot-trace]', JSON.stringify(value)) } = {}) {
  if (typeof slots?.onEntryError !== 'function' || typeof slots?.entriesOfSlot !== 'function') return () => {}
  let stopped = false; let pending = false; let count = 0; let previous
  const emit = value => { if (!stopped && count < 200) { count += 1; try { write(value) } catch { /* diagnostics must not break the surface */ } } }
  const context = () => {
    const facts = getFacts() ?? {}
    return { mode: facts.mode === 'agent' ? 'agent' : 'bot', plain: facts.plain === true,
      ready: facts.ready === true, mainIsRoom: facts.mainIsRoom === true, mainIsBot: facts.mainIsBot === true }
  }
  const snapshot = phase => {
    try {
      const winners = slots.entriesOfSlot(SLOT).filter(e => KEYS.has(e.options?.key)).map(entryFacts)
      const raw = (slots.entries?.(SLOT) ?? []).filter(e => KEYS.has(e.options?.key)).map(entryFacts)
      const value = { context: context(), winners, raw }
      const fingerprint = JSON.stringify(value)
      if (phase !== 'change' || fingerprint !== previous) emit({ phase, ...value })
      previous = fingerprint
    } catch { /* an unavailable slot is not an application failure */ }
  }
  const changed = () => {
    if (stopped || pending) return
    pending = true
    try {
      if (typeof globalThis.queueMicrotask !== 'function') { pending = false; return }
      globalThis.queueMicrotask(() => { pending = false; if (!stopped) snapshot('change') })
    } catch { pending = false }
  }
  const disposers = []
  try {
    disposers.push(slots.onEntryError((key, entry, error, info) => {
      if (stopped || key !== SLOT) return
      try { emit({ phase: 'crash', entry: entryFacts(entry), abdicated: info?.abdicated === true, failure: slotFailureFacts(error), context: context() }); snapshot('after-crash') } catch { /* read-only */ }
    }))
    if (typeof slots.subscribe === 'function') disposers.push(slots.subscribe(SLOT, changed))
    for (const observable of observables) if (typeof observable?.subscribe === 'function') disposers.push(observable.subscribe(changed))
    snapshot('mount')
  } catch { /* unsupported diagnostic hooks must not disable the plugin */ }
  return () => { stopped = true; for (const off of disposers.reverse()) { try { off?.() } catch { /* dispose all */ } } }
}
