import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { Scheduler } from '../src/host/taskflow/scheduler.js'

test('independent worker threads race plan admission against the same ledger', async () => {
  const root = join(process.cwd(), '.tmp-verify', 'same-room-race')
  mkdirSync(root, { recursive:true })
  const db = join(mkdtempSync(join(root, 'workers-')), 'ledger.sqlite')
  const initial = new Scheduler(db, { recoverOnOpen:false })
  initial.close()
  const shared = new SharedArrayBuffer(4)
  const gate = new Int32Array(shared)
  const workerSource = `
    import { parentPort, workerData } from 'node:worker_threads';
    import { Scheduler } from ${JSON.stringify(new URL('../src/host/taskflow/scheduler.js', import.meta.url).href)};
    const s = new Scheduler(workerData.db, {recoverOnOpen:false});
    parentPort.postMessage({ready:true});
    Atomics.wait(new Int32Array(workerData.shared), 0, 0);
    try { s.createPlan({planId:workerData.id,room:'room',principal:'chief',cards:[{id:'card',member:'worker',goal:'work',dependencies:[]}]}); parentPort.postMessage({result:'created'}); }
    catch(e) { parentPort.postMessage({result:e.code,errcode:e.errcode}); }
    finally { s.close(); }
  `
  const workers = []
  try {
    const start = id => {
      const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(workerSource)}`), {workerData:{db,shared,id}})
      workers.push(worker)
      const ready = new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject) })
      const outcome = new Promise((resolve, reject) => { worker.on('message', m => { if (m.result) resolve(m.result) }); worker.once('error', reject) })
      const exit = new Promise((resolve, reject) => { worker.once('exit', code => code === 0 ? resolve() : reject(new Error(`Worker exited ${code}`))); worker.once('error', reject) })
      return { ready, outcome, exit }
    }
    const a = start('a')
    await a.ready
    const b = start('b')
    await b.ready
    Atomics.store(gate, 0, 1)
    Atomics.notify(gate, 0, 2)
    const result = await Promise.all([a.outcome, b.outcome])
    await Promise.all([a.exit, b.exit])
    assert.equal(result.filter(x => x === 'created').length, 1)
    assert.ok(result.some(x => ['taskflow_admission_busy','plan_already_open'].includes(x)), JSON.stringify(result))
    const reader = new Scheduler(db, {recoverOnOpen:false})
    try { assert.equal(reader.db.prepare("SELECT COUNT(*) AS n FROM plans WHERE room='room' AND status='open'").get().n, 1) } finally { reader.close() }
  } finally { await Promise.all(workers.map(w => w.terminate())) }
})
