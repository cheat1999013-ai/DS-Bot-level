// Bot Profiles: named resource bundles (skills, MCP servers, packs, DSH
// plugins) that can be applied to a Bot as one unit.
//
// The DS Bot capability engine already knows how to mount/unmount skills and
// MCP servers per Bot. A profile is only the durable naming layer: it records
// one capability set plus the DSH bundles the profile expects, and applying it
// replaces the Bot's attached capabilities with that set. DSH bundles are
// process-wide, so a profile can record/check them but cannot mount one Bot at
// a time; the UI labels that difference instead of pretending otherwise.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { cp, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const MAX_PROFILES = 100
const MAX_CAPABILITIES = 128
const MAX_PLUGINS = 128
const MAX_IMPORT_BYTES = 20 * 1024 * 1024
const MAX_IMPORT_ENTRIES = 2000

const text = (value, max) => String(value ?? '').trim().slice(0, max)

async function checkSkillTree(src) {
  let bytes = 0
  let entries = 0
  const pending = [src]
  while (pending.length) {
    const path = pending.pop()
    const stat = await lstat(path)
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('Skills with links or special files cannot be copied.')
    if (++entries > MAX_IMPORT_ENTRIES || (bytes += stat.size) > MAX_IMPORT_BYTES) throw new Error('Skill exceeds the copy limit.')
    if (stat.isDirectory()) pending.push(...(await readdir(path)).map(child => join(path, child)))
  }
}

export async function stageSkillCopy(src, staging) {
  // Copy links as links, never follow them. Check the copied bytes before they
  // enter the watched skills root; the source may change after its first scan.
  await checkSkillTree(src)
  await cp(src, staging, { recursive: true, force: false, errorOnExist: true, dereference: false })
  await checkSkillTree(staging)
}

export async function publishSkillCopy(staged, root, target, original) {
  const current = await lstat(root)
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== original.dev || current.ino !== original.ino ||
      resolve(await realpath(root)) !== resolve(root)) {
    throw new Error('The active profile skill directory changed during the copy.')
  }
  if (existsSync(target)) throw new Error('A skill with this name already exists in the active DSH profile.')
  await rename(staged, target)
}

export function install(rt) {
  const { state } = rt
  state.profiles ??= {}

  const library = () => state.capabilities.items
  const profileList = () => Object.values(state.profiles)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.name.localeCompare(b.name))

  // Capability metadata only: skill content and MCP env/headers stay in the
  // existing capabilities page and never ride the profile roster.
  const publicCapability = item => ({
    name: item.name,
    kind: item.kind,
    scope: item.scope ?? 'global',
    description: item.description ?? '',
    ...(item.kind === 'pack' ? { items: [...(item.items ?? [])] } : {}),
  })

  const capabilityView = () => Object.values(library()).map(publicCapability)
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))

  const dshProfiles = () => {
    const root = join(rt.dshHome, 'profiles')
    const activeName = process.env.DS_BOT_DSH_PROFILE
    const activeDir = rt.ctx.get?.('pluginManager')?.profile?.dir
    let names = []
    try { names = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) } catch { /* no profiles */ }
    return names.flatMap(name => {
      try {
        const manifest = JSON.parse(readFileSync(join(root, name, 'package.json'), 'utf8'))
        const bundles = manifest?.dsh?.profile?.bundles
        let skills = []
        try {
          const skillRoot = join(root, name, 'skills')
          skills = readdirSync(skillRoot, { withFileTypes: true }).flatMap(entry => {
            if (entry.isDirectory() && NAME.test(entry.name) && existsSync(join(skillRoot, entry.name, 'SKILL.md'))) return [entry.name]
            if (entry.isFile() && entry.name.endsWith('.md') && NAME.test(entry.name.slice(0, -3))) return [entry.name.slice(0, -3)]
            return []
          })
        } catch { /* no profile skills */ }
        return [{ name, bundles: Array.isArray(bundles) ? bundles.filter(value => typeof value === 'string') : [],
          skills,
          active: activeDir ? resolve(activeDir) === resolve(root, name) : activeName ? activeName === name : null }]
      } catch { return [] }
    }).sort((a, b) => a.name.localeCompare(b.name))
  }

  const skillCatalog = async () => {
    const skills = rt.ctx.get?.('skills')
    if (typeof skills?.snapshot !== 'function') return { available: false, complete: false, items: [] }
    let snapshot
    try { snapshot = await skills.snapshot() } catch { return { available: true, complete: false, items: [] } }
    if (!Array.isArray(snapshot?.skills)) return { available: true, complete: false, items: [] }
    const root = resolve(rt.dshHome, 'profiles')
    return { available: true, complete: snapshot.complete === true,
      items: snapshot.skills.map(skill => {
        const path = skill.path
        const within = typeof path === 'string' && isAbsolute(path) ? relative(root, resolve(path)) : null
        const profile = within !== null && within !== '' && !within.startsWith('..' + sep) && within !== '..' && !isAbsolute(within)
          ? within.split(sep)[0] : null
        return { name: skill.name, provider: skill.provider ?? null, profile,
          importable: typeof path === 'string' && isAbsolute(path) && !['project-dsh', 'project-agents', 'custom'].includes(skill.source) && (basename(path) === 'SKILL.md' || basename(path) === `${skill.name}.md`),
          source: profile ? 'dsh-profile' : 'outside-profile' }
      }) }
  }

  async function copySkill(name) {
    if (!NAME.test(name)) throw new Error('Choose a valid skill name.')
    const profile = process.env.DS_BOT_DSH_PROFILE
    if (!NAME.test(profile ?? '') || typeof rt.invalidateProfileSkills !== 'function') {
      throw new Error('The active DSH profile skill provider is unavailable.')
    }
    const profileDir = join(rt.dshHome, 'profiles', profile)
    if ((await lstat(profileDir)).isSymbolicLink()) throw new Error('Linked profile directories cannot receive copied skills.')
    const skills = rt.ctx.get?.('skills')
    const snapshot = await skills?.snapshot?.()
    const entry = snapshot?.skills?.find(skill => skill.name === name)
    const source = entry?.path
    if (typeof source !== 'string' || !isAbsolute(source) || ['project-dsh', 'project-agents', 'custom'].includes(entry.source) || !['SKILL.md', `${name}.md`].includes(basename(source))) {
      throw new Error('Choose a filesystem skill with a SKILL.md or a named Markdown file.')
    }
    const root = join(profileDir, 'skills')
    const src = basename(source) === 'SKILL.md' ? dirname(source) : source
    await mkdir(root, { recursive: true })
    const original = await lstat(root)
    if (!original.isDirectory() || original.isSymbolicLink()) throw new Error('Linked skill directories cannot receive copied skills.')
    if (resolve(await realpath(root)) !== resolve(root)) throw new Error('Linked skill directories cannot receive copied skills.')
    const target = join(root, basename(source) === 'SKILL.md' ? name : `${name}.md`)
    if (existsSync(join(root, name)) || existsSync(join(root, `${name}.md`))) {
      throw new Error('A skill with this name already exists in the active DSH profile.')
    }
    const stagingDir = await mkdtemp(join(profileDir, '.skill-copy-'))
    try {
      const staged = join(stagingDir, basename(target))
      await stageSkillCopy(src, staged)
      await publishSkillCopy(staged, root, target, original)
    } finally {
      await rm(stagingDir, { recursive: true, force: true })
    }
    rt.invalidateProfileSkills()
    const expected = basename(source) === 'SKILL.md' ? join(target, 'SKILL.md') : target
    const selected = (await skills.snapshot()).skills.find(skill => skill.name === name)
    const loaded = selected?.path && resolve(selected.path) === resolve(expected) ? await skills.get(name) : null
    if (!loaded?.path || resolve(loaded.path) !== resolve(expected)) {
      throw new Error('The skill was copied, but the DSH registry did not select its profile copy.')
    }
    return profileView()
  }

  // Manifest declarations across DSH profiles, plus live loader entries.
  // A declaration does not prove installation; only the loader proves activity.
  const pluginCatalog = () => {
    const found = new Map()
    const profilesDir = join(rt.dshHome, 'profiles')
    let dirs = []
    try {
      dirs = readdirSync(profilesDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
    } catch { /* no profiles directory */ }
    for (const dir of dirs) {
      const manifestPath = join(profilesDir, dir, 'package.json')
      if (!existsSync(manifestPath)) continue
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        for (const bundle of manifest?.dsh?.profile?.bundles ?? []) {
          if (typeof bundle !== 'string' || bundle === '') continue
          const entry = found.get(bundle) ?? { name: bundle, profiles: new Set(), active: false }
          entry.profiles.add(dir)
          found.set(bundle, entry)
        }
      } catch { /* one unreadable manifest does not hide the rest */ }
    }
    const active = new Set()
    try {
      for (const row of rt.ctx.loader?.entries?.() ?? []) {
        const name = row?.options?.name ?? row?.name ?? row?.options?.id
        if (typeof name === 'string' && name !== '') active.add(name)
      }
    } catch { /* loader diagnostics are optional */ }
    for (const name of active) if (!found.has(name)) found.set(name, { name, profiles: new Set(), active: true })
    return [...found.values()]
      .map(entry => ({ name: entry.name, profiles: [...entry.profiles].sort(), active: active.has(entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  const missingFor = profile => (profile.capabilities ?? [])
    .filter(name => library()[name] === undefined)

  const profileView = async () => {
    const catalog = pluginCatalog()
    const plugins = new Map(catalog.map(item => [item.name, item]))
    return {
      profiles: profileList().map(profile => {
        const counts = { skill: 0, mcp: 0, pack: 0 }
        for (const name of profile.capabilities ?? []) {
          const item = library()[name]
          if (item && counts[item.kind] !== undefined) counts[item.kind] += 1
        }
        return {
          name: profile.name,
          description: profile.description ?? '',
          capabilities: [...(profile.capabilities ?? [])],
          plugins: [...(profile.plugins ?? [])],
          missingPlugins: (profile.plugins ?? []).filter(name => !plugins.has(name)),
          inactivePlugins: (profile.plugins ?? []).filter(name => plugins.has(name) && !plugins.get(name).active),
          counts,
          missing: missingFor(profile),
          assigned: Object.values(state.bots).filter(bot => bot.profile === profile.name).map(bot => bot.id),
          createdAt: profile.createdAt ?? null,
          updatedAt: profile.updatedAt ?? null,
        }
      }),
      bots: Object.values(state.bots).map(bot => ({
        id: bot.id,
        name: bot.name,
        role: bot.role ?? '',
        profile: bot.profile ?? null,
        capabilities: [...(bot.capabilities ?? [])],
        profileCapabilities: [...(bot.profileCapabilities ?? [])],
      })),
      capabilities: capabilityView(),
      plugins: catalog,
      dshProfiles: dshProfiles(),
      profileSkillAvailable: typeof rt.invalidateProfileSkills === 'function',
      skillRoots: {
        global: join(rt.dshHome, 'skills'),
        profile: typeof rt.invalidateProfileSkills === 'function' && NAME.test(process.env.DS_BOT_DSH_PROFILE ?? '')
          ? join(rt.dshHome, 'profiles', process.env.DS_BOT_DSH_PROFILE, 'skills') : null,
      },
      skills: await skillCatalog(),
    }
  }

  const normalize = body => {
    const name = text(body?.name, 32).toLowerCase()
    if (name.length === 0 || !NAME.test(name)) {
      throw new Error('Profile name must use lowercase letters, digits and single hyphens, starting with a letter.')
    }
    const description = text(body?.description, 500)
    const capabilities = []
    for (const raw of body?.capabilities ?? []) {
      const name = String(raw ?? '').trim()
      if (name === '' || capabilities.includes(name)) continue
      const item = library()[name]
      if (!item || !['skill', 'mcp', 'pack'].includes(item.kind)) {
        throw new Error(`No skill, MCP server or pack named ${name}.`)
      }
      capabilities.push(name)
    }
    if (capabilities.length > MAX_CAPABILITIES) throw new Error(`A profile may hold at most ${MAX_CAPABILITIES} capabilities.`)
    const plugins = body?.plugins === undefined && Object.hasOwn(state.profiles ?? {}, name)
      ? [...(state.profiles[name].plugins ?? [])] : []
    const availablePlugins = new Set(pluginCatalog().map(plugin => plugin.name))
    for (const raw of body?.plugins ?? []) {
      const name = text(raw, 120)
      if (name === '' || plugins.includes(name)) continue
      if (!availablePlugins.has(name)) throw new Error(`No DSH plugin reference named ${name}.`)
      plugins.push(name)
    }
    if (plugins.length > MAX_PLUGINS) throw new Error(`A profile may hold at most ${MAX_PLUGINS} plugins.`)
    return { name, description, capabilities, plugins }
  }

  async function refreshSessions(bot) {
    const sessions = new Set()
    const own = rt.chatOf(bot.id)
    if (own) sessions.add(own)
    for (const room of Object.values(state.rooms)) {
      if (room.members?.includes(bot.id) && room.sessions?.[bot.id]) sessions.add(room.sessions[bot.id])
    }
    for (const sessionId of sessions) {
      try {
        await rt.ensureCapabilities(sessionId)
      } catch (error) {
        rt.warn('ds-bot: profile %s refresh for %s failed: %s', bot.profile ?? '-', bot.name, error)
      }
    }
  }

  async function applyToBot(profile, bot) {
    bot.profile = profile.name
    bot.profileCapabilities = [...profile.capabilities]
    bot.capabilities = [...profile.capabilities]
    await rt.save()
    rt.scheduleCapabilitiesReconcile?.()
    await refreshSessions(bot)
  }

  async function saveProfile(body) {
    const input = body?.profile ?? body
    const next = normalize(input)
    const originalName = text(body?.originalName ?? input?.originalName ?? next.name, 32)
    if (!Object.hasOwn(state.profiles, next.name) && originalName !== next.name && !Object.hasOwn(state.profiles, originalName)) {
      if (profileList().length >= MAX_PROFILES) throw new Error(`At most ${MAX_PROFILES} profiles are allowed.`)
    }
    const previous = Object.hasOwn(state.profiles, originalName) ? state.profiles[originalName] : undefined
    if (originalName !== next.name && Object.hasOwn(state.profiles, next.name)) {
      throw new Error(`A profile named ${next.name} already exists.`)
    }
    if (originalName !== next.name && previous) {
      delete state.profiles[originalName]
      for (const bot of Object.values(state.bots)) {
        if (bot.profile === originalName) bot.profile = next.name
      }
    } else if (!previous && profileList().length >= MAX_PROFILES) {
      throw new Error(`At most ${MAX_PROFILES} profiles are allowed.`)
    }
    const now = Date.now()
    const saved = {
      name: next.name,
      description: next.description,
      capabilities: next.capabilities,
      plugins: next.plugins,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }
    state.profiles[next.name] = saved
    // Assigned Bots follow their profile's capability edits immediately.
    for (const bot of Object.values(state.bots)) {
      if (bot.profile !== next.name) continue
      bot.profileCapabilities = [...next.capabilities]
      bot.capabilities = [...next.capabilities]
    }
    await rt.save()
    rt.scheduleCapabilitiesReconcile?.()
    for (const bot of Object.values(state.bots)) {
      if (bot.profile === next.name) await refreshSessions(bot)
    }
    return profileView()
  }

  async function deleteProfile(name) {
    const profile = Object.hasOwn(state.profiles, name) ? state.profiles[name] : undefined
    if (!profile) throw new Error(`No profile named ${name}.`)
    const affected = []
    for (const bot of Object.values(state.bots)) {
      if (bot.profile !== name) continue
      affected.push(bot)
      const applied = new Set(bot.profileCapabilities ?? profile.capabilities ?? [])
      bot.capabilities = (bot.capabilities ?? []).filter(capability => !applied.has(capability))
      bot.profile = null
      bot.profileCapabilities = []
    }
    delete state.profiles[name]
    await rt.save()
    rt.scheduleCapabilitiesReconcile?.()
    for (const bot of affected) await refreshSessions(bot)
    return profileView()
  }

  async function applyProfile(name, botId) {
    const profile = Object.hasOwn(state.profiles, name) ? state.profiles[name] : undefined
    if (!profile) throw new Error(`No profile named ${name}.`)
    const bot = state.bots[botId]
    if (!bot) throw new Error('Choose a Bot in this team.')
    const missing = missingFor(profile)
    if (missing.length > 0) throw new Error(`Profile ${name} references missing capabilities: ${missing.join(', ')}.`)
    await applyToBot(profile, bot)
    return profileView()
  }

  async function clearProfile(botId) {
    const bot = state.bots[botId]
    if (!bot) throw new Error('Choose a Bot in this team.')
    const applied = new Set(bot.profileCapabilities ?? [])
    bot.capabilities = (bot.capabilities ?? []).filter(capability => !applied.has(capability))
    bot.profile = null
    bot.profileCapabilities = []
    await rt.save()
    rt.scheduleCapabilitiesReconcile?.()
    await refreshSessions(bot)
    return profileView()
  }

  async function classifyBots() {
    const occupied = new Set(Object.keys(state.profiles))
    const pending = []
    for (const bot of Object.values(state.bots).sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
      if (bot.profile) {
        if (!Object.hasOwn(state.profiles, bot.profile)) throw new Error(`Bot ${bot.name} references a missing profile.`)
        continue
      }
      const capabilities = [...(bot.capabilities ?? [])]
      const missing = capabilities.filter(name => !Object.hasOwn(library(), name))
      if (missing.length) throw new Error(`Bot ${bot.name} has missing capabilities: ${missing.join(', ')}.`)
      if (capabilities.length > MAX_CAPABILITIES) throw new Error(`Bot ${bot.name} exceeds the profile capability limit.`)
      const slug = String(bot.name ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'member'
      const base = `bot-${slug}`.slice(0, 32).replace(/-$/, '')
      let name = base
      for (let number = 2; occupied.has(name); number++) {
        name = `${base.slice(0, 31 - String(number).length).replace(/-$/, '')}-${number}`
      }
      occupied.add(name)
      pending.push({ bot, name, capabilities })
    }
    if (!pending.length) return profileView()
    if (occupied.size > MAX_PROFILES) throw new Error(`At most ${MAX_PROFILES} profiles are allowed.`)
    const now = Date.now()
    for (const { bot, name, capabilities } of pending) {
      state.profiles[name] = { name, description: '', capabilities, plugins: [], createdAt: now, updatedAt: now }
      bot.profile = name
      bot.profileCapabilities = [...capabilities]
    }
    await rt.save()
    rt.scheduleCapabilitiesReconcile?.()
    for (const { bot } of pending) await refreshSessions(bot)
    return profileView()
  }

  async function profileEndpoint(endpoint, body) {
    if (endpoint === 'profiles') return profileView()
    if (endpoint === 'profile-save') return saveProfile(body ?? {})
    if (endpoint === 'profile-delete') return deleteProfile(String(body?.name ?? ''))
    if (endpoint === 'profile-apply') return applyProfile(String(body?.name ?? ''), String(body?.botId ?? ''))
    if (endpoint === 'profile-clear') return clearProfile(String(body?.botId ?? ''))
    if (endpoint === 'profile-classify-bots') return classifyBots()
    if (endpoint === 'profile-skill-copy') return copySkill(String(body?.name ?? ''))
    throw new Error('Unknown profile operation.')
  }

  Object.assign(rt, { profilesView: profileView, profileEndpoint })
}
