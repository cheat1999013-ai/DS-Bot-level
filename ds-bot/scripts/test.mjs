// On Windows, these files need a clean, isolated exit: force-exit can close live
// handles, while concurrent files can exhaust the short work-dir fixture deadlines.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const plugin = resolve(import.meta.dirname, '..')
const files = readdirSync(join(plugin, 'test')).filter(name => name.endsWith('.test.js'))
  .map(name => `test/${name}`)
const cleanExit = ['test/member-status.test.js', 'test/connectors-gateway.test.js', 'test/taskflow-panel.test.js',
  'test/task-message.test.js', 'test/group-relay-tool-view.test.js', 'test/taskflow-group-activity.test.js', 'test/group-schedule-channel.test.js',
  'test/group-schedule-ui.test.js', 'test/profile-settings-view.test.js', 'test/local-agents.test.js', 'test/work-dir.test.js']

function run(tests, forceExit) {
  const args = ['--import', './test/harness-resolve.mjs', '--test', '--test-timeout=120000',
    ...(process.platform === 'win32' ? ['--test-concurrency=1'] : []),
    ...(forceExit ? ['--test-force-exit'] : []), ...tests]
  const result = spawnSync(process.execPath, args, { cwd: plugin, stdio: 'inherit' })
  if (result.error) console.error(`test: ${result.error.message}`)
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (process.platform === 'win32') {
  for (const file of cleanExit) run([file], false)
  run(files.filter(file => !cleanExit.includes(file)), true)
} else run(files, true)
