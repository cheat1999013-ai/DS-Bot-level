import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './taskflow-fixture.mjs'

async function recovered(t) {
  const env = fixture()
  t.after(env.cleanup)
  const planId = 'race'
  const cardId = 'write'
  env.service.plan({ planId, children: [{ id: cardId, member: 'Writer', goal: 'Write', dependencies: [] }] }, env.admin)
  await env.service.dispatch({ planId }, env.admin)
  env.scheduler.recoverDispatches()
  assert.equal(env.scheduler.cardView(planId, cardId).state, 'unknown')
  return { ...env, args: { planId, cardId }, view: () => env.scheduler.cardView(planId, cardId) }
}

test('the original submission wins before a principal retry', async t => {
  const env = await recovered(t)
  const original = env.view()
  await env.service.submit({ ...env.args, result: 'original result' }, env.memberA)
  await assert.rejects(env.service.retry({ ...env.args, decision: 'retry' }, env.admin))
  assert.equal(env.view().receipt, original.receipt)
  assert.equal(env.view().attempts, 1)
})

test('a different group member cannot submit even with the correct receipt', async t => {
  const env = await recovered(t)
  await assert.rejects(env.service.submit({ ...env.args, receipt: env.view().receipt, result: 'foreign result' }, env.memberB), { code: 'not_card_executor' })
  assert.equal(env.view().state, 'unknown')
})

test('a submission started during retry cannot attach to the replacement receipt', async t => {
  const env = await recovered(t)
  const original = env.view()
  const post = env.service.post
  const gate = Promise.withResolvers()
  env.service.post = async request => {
    if (request.taskflowEvent?.event === 'assigned') await gate.promise
    return post(request)
  }
  const retry = env.service.retry({ ...env.args, decision: 'retry' }, env.admin)
  assert.equal(env.view().state, 'dispatching')
  const submission = env.service.submit({ ...env.args, result: 'old attempt result' }, env.memberA)
  const rejected = assert.rejects(submission, { code: 'result_attempt_mismatch' })
  gate.resolve()
  await retry
  assert.notEqual(env.view().receipt, original.receipt)
  await rejected
  await assert.rejects(env.service.submit({ ...env.args, attempt: 1, result: 'old attempt result' }, env.memberA), { code: 'result_attempt_mismatch' })
  assert.equal(env.view().terminal_event_id, null)
  assert.match(env.posts.at(-1).text, /attempt=2/)
  await env.service.submit({ ...env.args, attempt: 2, result: 'replacement result' }, env.memberA)
  assert.equal(env.scheduler.resultPayload(env.args.planId, env.args.cardId).text, 'replacement result')
})
