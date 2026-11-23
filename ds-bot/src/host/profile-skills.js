// Mount the active DSH profile's skills with DSH's own filesystem provider.
// The app launcher identifies its profile; another host without that signal
// cannot safely guess which profile should become process-wide.
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const PROFILE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

export function install(rt) {
  const name = process.env.DS_BOT_DSH_PROFILE
  if (!PROFILE.test(name ?? '') || !existsSync(join(rt.dshHome, 'profiles', name, 'package.json'))) return
  const dir = join(rt.dshHome, 'profiles', name, 'skills')
  rt.ctx.inject?.({ skills: null }, async ctx => {
    try {
      const { FileSystemSkillProvider } = await import('@deepseek-ai/dsh-skill-filesystem')
      let provider
      ctx.skills.registerProvider(control => {
        provider = new FileSystemSkillProvider(ctx, control, {
          providerName: 'ds-bot-dsh-profile', includeDefaultRoots: false,
          customSkillDirs: [dir], watch: true, watchFollowSymlinks: false,
        })
        rt.invalidateProfileSkills = control.invalidate
        return provider
      })
      ctx.effect(function* () { yield async () => { rt.invalidateProfileSkills = undefined; await provider.dispose() } }, 'ds-bot profile skill watcher')
    } catch (error) {
      rt.warn('ds-bot: DSH profile skills unavailable: %s', error)
    }
  })
}
