import { createElement as h, useEffect, useState } from 'react'
import { t } from './i18n.js'

const empty = () => ({ name: '', description: '', capabilities: [], plugins: [] })
const KINDS = [['skill', 'Skills'], ['pack', 'Packs']]

export function ProfilesPage({ actions }) {
  const [data, setData] = useState(null)
  const [draft, setDraft] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState('')
  useEffect(() => {
    let alive = true
    actions.profiles().then(value => { if (alive) setData(value) }, failure => { if (alive) setError(failure.message) })
    return () => { alive = false }
  }, [actions])
  const change = (key, value) => setDraft(previous => ({ ...previous, [key]: value }))
  const run = async operation => {
    setBusy(true)
    setError('')
    try { const value = await operation(); setData(value); return value } catch (failure) { setError(failure?.message ?? String(failure)); return null } finally { setBusy(false) }
  }
  const toggle = (key, name) => change(key, draft[key].includes(name) ? draft[key].filter(value => value !== name) : [...draft[key], name])
  const save = event => {
    event.preventDefault()
    const { name, description, capabilities } = draft
    void run(() => actions.saveProfile({ name, description, capabilities }, draft.originalName)).then(value => {
      if (value) setDraft(null)
    })
  }
  const remove = name => {
    if (confirmDelete !== name) { setConfirmDelete(name); return }
    setConfirmDelete('')
    void run(() => actions.deleteProfile(name))
  }
  const botProfiles = data?.profiles ?? []
  const used = new Set(botProfiles.flatMap(profile => profile.capabilities))
  const visible = name => !data?.capabilities.some(item => item.name === name && item.kind === 'mcp')
  const unassigned = (data?.capabilities ?? []).filter(item => item.kind !== 'mcp' && !used.has(item.name))
  return h('div', null,
    error ? h('p', { role: 'alert', className: 'bt-danger bt-set-hint' }, error) : null,
    !data ? h('section', { className: 'bt-set-section' }, h('h3', null, t('Profiles')), h('p', null, t('Loading…'))) : null,
    data ? h('section', { className: 'bt-set-section' },
      h('h3', null, t('DSH profiles')),
      h('p', { className: 'bt-set-hint' }, t('Plugins and global MCP services are shared by the active DSH profile.')),
      h('div', { className: 'bt-set-card' },
        data.dshProfiles.length ? data.dshProfiles.map(profile => h('div', { className: 'bt-set-row', key: profile.name },
          h('span', { className: 'bt-set-copy' },
            h('span', null, profile.name, profile.active === true ? ` · ${t('Active')}` : ''),

            h('span', { className: 'bt-set-hint' }, `${t('Stored skills')}: ${(profile.skills ?? []).map(name =>
              `${name} (${data.skills.items.some(skill => skill.name === name && skill.profile === profile.name) ? t('Selected') : t('Not selected')})`).join(', ') || t('None')}`))))
          : h('div', { className: 'bt-set-row' }, t('No DSH profiles found'))),
      h('h3', null, t('DSH skills')),
      data.skillRoots?.global ? h('p', { className: 'bt-set-hint' }, `${t('Shared skill directory')}: `, h('code', null, data.skillRoots.global)) : null,
      data.skillRoots?.profile ? h('p', { className: 'bt-set-hint' }, `${t('Active profile skill directory')}: `, h('code', null, data.skillRoots.profile)) : null,
      h('p', { className: 'bt-set-hint' }, t('Use <name>/SKILL.md with name and description in YAML frontmatter.')),
      h('p', { className: 'bt-set-hint' }, t('DSH skills are discovered from filesystem and plugin providers; this list shows their actual source, not an assignment to a Bot.')),
      h('p', { className: 'bt-set-hint' }, t('Copying a skill keeps its source files and loads the copy from the active DSH profile.')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void run(() => actions.profiles()) }, t('Refresh')),
      h('div', { className: 'bt-set-card' },
        !data.skills.available ? h('div', { className: 'bt-set-row' }, t('DSH skill catalog is unavailable'))
          : !data.skills.complete ? h('div', { className: 'bt-set-row' }, t('Skill discovery is incomplete')) : null,
        data.skills.items.map(skill => h('div', { key: skill.name, className: 'bt-set-row' },
          h('span', { className: 'bt-set-copy' }, h('span', null, skill.name),
            h('span', { className: 'bt-set-hint' }, skill.profile ? `${t('DSH profile')}: ${skill.profile}` : `${t('Outside a DSH profile')} · ${skill.provider ?? skill.source}`)),
          skill.importable && !skill.profile && data.profileSkillAvailable
            ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
              onClick: () => void run(() => actions.copyProfileSkill(skill.name)) }, t('Copy to active DSH profile')) : null)))) : null,
    data ? h('section', { className: 'bt-set-section' },
      h('h3', null, t('Bot profiles')),
      h('p', { className: 'bt-set-hint' }, t('A Bot profile assigns saved skills and packs. Global plugins and MCP services need no per-Bot selection.')),
      data.bots.some(bot => !bot.profile) ? h('div', { className: 'bt-set-card' },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
          onClick: () => void run(() => actions.classifyBotProfiles()) }, t('Classify existing Bots')),
        h('p', { className: 'bt-set-hint' }, t('Create one profile per unassigned Bot from its current capabilities, including empty Bots. Existing assignments stay as they are.'))) : null,
      draft ? h('form', { className: 'bt-set-card bt-task-form', onSubmit: save },
        h('label', { className: 'bt-set-row bt-bs-stack' }, t('Name'), h('input', { className: 'bt-input', value: draft.name, disabled: Boolean(draft.originalName), maxLength: 32, onChange: event => change('name', event.target.value) })),
        h('label', { className: 'bt-set-row bt-bs-stack' }, t('Description'), h('textarea', { className: 'bt-input bt-input-area', value: draft.description, maxLength: 500, onChange: event => change('description', event.target.value) })),
        KINDS.map(([kind, label]) => h('div', { key: kind },
          h('h3', null, t(label)),
          data.capabilities.filter(item => item.kind === kind).map(item => h('label', { className: 'bt-set-row', key: item.name },
            h('span', null, item.name, item.scope === 'group' ? ` · ${t('Group chats')}` : ''),
            h('input', { type: 'checkbox', checked: draft.capabilities.includes(item.name), onChange: () => toggle('capabilities', item.name) }))))),

        h('div', { className: 'bt-set-row bt-task-foot' },
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setDraft(null) }, t('Cancel')),
          h('button', { type: 'submit', className: 'bt-send bt-soft-sm', disabled: busy }, t('Save'))))
        : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setDraft(empty()) }, t('Create profile')),
      botProfiles.map(profile => h('div', { key: profile.name, className: 'bt-set-card' },
        h('div', { className: 'bt-set-row' },
          h('span', { className: 'bt-set-copy' }, h('strong', null, profile.name),
            h('span', { className: 'bt-set-hint' }, profile.description || profile.capabilities.filter(visible).join(', ') || t('No capabilities saved'))),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setDraft({ ...profile, originalName: profile.name }) }, t('Edit')),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => remove(profile.name) },
            confirmDelete === profile.name ? t('Click again to delete.') : t('Delete'))),
        profile.missing.filter(visible).length ? h('div', { className: 'bt-set-row bt-danger' }, `${t('Missing capabilities')}: ${profile.missing.filter(visible).join(', ')}`) : null)),
      h('h3', null, t('Assign to Bots')),
      h('div', { className: 'bt-set-card' }, data.bots.map(bot => h('label', { key: bot.id, className: 'bt-set-row' },
        h('span', null, bot.name),
        h('select', { className: 'bt-select', value: bot.profile ?? '', disabled: busy,
          onChange: event => void run(() => event.target.value ? actions.applyProfile(event.target.value, bot.id) : actions.clearProfile(bot.id)) },
        h('option', { value: '' }, t('No profile')), botProfiles.map(profile => h('option', { key: profile.name, value: profile.name }, profile.name)))))),
      h('h3', null, t('Unclassified capabilities')),
      h('div', { className: 'bt-set-card' }, h('div', { className: 'bt-set-row bt-set-hint' }, unassigned.map(item => item.name).join(', ') || t('None')))) : null)
}
