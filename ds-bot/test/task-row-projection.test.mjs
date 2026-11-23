import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { groupTaskRecord } from '../src/shared/group-task-record.js'
const task = { planId: 'formal-plan', cardId: 'review', event: 'submitted', from: { name: 'Worker' }, to: { name: 'Chief' } }

test('group task record retains explicit identity, body, sender and time without mutating the ledger row', () => {
  const record = { kind: 'task', text: 'Original result body', time: 1700000000000, taskflowEvent: task }
  const before = JSON.stringify(record)
  const who = { botId: 'worker', name: 'Worker', color: 'blue' }
  assert.deepEqual(groupTaskRecord(record, who), { kind: 'task', ...who, text: record.text, time: record.time, taskflowEvent: task })
  assert.equal(JSON.stringify(record), before)
  assert.equal(groupTaskRecord({ kind: 'notice' }, who), null)
  for (const invalid of [undefined, null, {}, [], { planId: '' }]) {
    const row = groupTaskRecord({ ...record, taskflowEvent: invalid }, who)
    assert.equal(row.kind, 'notice')
    assert.equal(row.text, record.text)
    assert.equal(Object.hasOwn(row, 'taskflowEvent'), false)
  }
})

const requireApp = createRequire(new URL('../../app/package.json', import.meta.url))
const react = requireApp('react')
const { renderToStaticMarkup } = requireApp('react-dom/server')
const result = await build({ stdin: { contents: "export {TaskMessage,TaskSourceHeader} from './src/client/task-message.js'", resolveDir: process.env.STAGED_BOT_ROOT ?? fileURLToPath(new URL('..', import.meta.url)) }, bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', '@deepseek-ai/dsh-client-ui-primitives'] })
const m = { exports: {} }
runInNewContext(result.outputFiles[0].text, { module: m, exports: m.exports, require: name => name === 'react' ? react : { MarkdownText: ({ text }) => react.createElement('span', null, text) } })
const { TaskMessage, TaskSourceHeader } = m.exports

test('missing task metadata cannot crash a message tree or fabricate formal task identity', () => {
  for (const invalid of [undefined, null, {}, [], { planId: '' }]) {
    const html = renderToStaticMarkup(react.createElement(react.Fragment, null,
      react.createElement(TaskMessage, { task: invalid, text: 'Retain historical body' }),
      react.createElement(TaskSourceHeader, { matched: invalid }),
      react.createElement(TaskMessage, { task, text: 'Valid following task' })))
    assert.match(html, /role="alert"/)
    assert.doesNotMatch(html, /Retain historical body/)
    assert.match(html, /Valid following task/)
    assert.equal((html.match(/data-task-reference=/g) ?? []).length, 1)
    assert.match(html, /data-task-reference="formal-plan\/review"/)
  }
  assert.match(renderToStaticMarkup(react.createElement(TaskMessage, {})), /role="alert"/)
})
