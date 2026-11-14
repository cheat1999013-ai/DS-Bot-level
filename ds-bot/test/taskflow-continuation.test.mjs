import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture } from './taskflow-fixture.mjs'
import { install } from '../src/host/taskflow.js'
import { createTaskflowContinuation } from '../src/host/taskflow/continuation.js'
import { Scheduler } from '../src/host/taskflow/scheduler.js'

function host() {
 const env = fixture(), effects = [], posts = [], deliveries = []
 env.rt.ctx.effect = register => effects.push(register())
 env.rt.postToRoom = async (_room,_sender,text,options) => { posts.push(text); deliveries.push(options?.taskflowEvent) }
 install(env.rt)
 return {...env,posts,deliveries,async open(){await env.rt.taskflowView({room:'room-1'})},stop(){for(const dispose of effects)dispose?.();env.cleanup()}}
}

test('an unfinished assigned worker has a bounded continuation obligation after using tools', async()=>{
 const env=host()
 try{
  await env.open()
  env.service.plan({planId:'unfinished',children:[{id:'write',member:'Writer',goal:'Finish the work',dependencies:[]}]},env.admin)
  await env.service.dispatch({planId:'unfinished'},env.admin)
  assert.equal(typeof env.rt.taskflowContinuation,'function')
  const one=env.rt.taskflowContinuation('group-a')
  assert.match(one.text,/taskflow_submit/)
  assert.equal(one.exhausted,false)
  assert.equal(env.rt.taskflowContinuation('group-a').exhausted,false)
  assert.equal(env.rt.taskflowContinuation('group-a').exhausted,true)
  await env.service.submit({planId:'unfinished',cardId:'write',result:'actual fixture result'},env.memberA)
  assert.equal(env.rt.taskflowContinuation('group-a'),undefined,'submitted work must wait for acceptance instead of reexecuting')
 }finally{env.stop()}
})

test('the principal is reminded of unissued cards and unknown delivery without auto-dispatch',async()=>{
 const env=host()
 try{
  await env.open()
  env.service.plan({planId:'ready',children:[{id:'write',member:'Writer',goal:'Finish',dependencies:[]}]},env.admin)
  const next=env.rt.taskflowContinuation('group-admin')
  assert.match(next.text,/taskflow_dispatch/)
  assert.equal(env.scheduler.cardView('ready','write').attempts,0)
  await env.service.dispatch({planId:'ready'},env.admin)
  env.scheduler.recoverDispatches()
  const unknown=env.rt.taskflowContinuation('group-admin')
  assert.match(unknown.text,/unknown/)
  assert.equal(env.scheduler.cardView('ready','write').state,'unknown')
  assert.equal(env.rt.taskflowContinuation('group-a'),undefined,'unknown delivery never resumes the worker automatically')
  assert.equal(env.posts.length,0,'checking an obligation must not send messages')
 }finally{env.stop()}
})

test('recovered unknown cards raise a retained attention notice without reissuing dependency cards',async()=>{
 const env=host()
 try{
  await env.open()
  env.service.plan({planId:'recovered',children:[
   {id:'write',member:'Writer',goal:'Write',dependencies:[]},
   {id:'review',member:'Reviewer',goal:'Review',dependencies:['write']},
  ]},env.admin)
  await env.service.dispatch({planId:'recovered'},env.admin)
  env.scheduler.recoverDispatches()
  const handled=await env.rt.taskflowSweep()
  assert.equal(handled.some(item=>item.cardId==='write'&&item.attention===true),true)
  assert.equal(env.posts.length,1)
  assert.match(env.posts[0],/送达状态不明/)
  assert.equal(env.scheduler.cardView('recovered','write').state,'unknown')
  assert.equal(env.scheduler.cardView('recovered','review').attempts,0)
  await env.rt.taskflowSweep()
  assert.equal(env.posts.length,1,'normal repeated sweeps reuse the durable notice marker')
 }finally{env.stop()}
})

test('continuation reservations and the exhaustion notice survive a new coordinator instance',async()=>{
 const env=host();let reopened
 try{
  await env.open()
  env.service.plan({planId:'durable',children:[{id:'write',member:'Writer',goal:'Write',dependencies:[]}]},env.admin)
  await env.service.dispatch({planId:'durable'},env.admin)
  assert.equal(env.rt.taskflowContinuation('group-a').exhausted,false)
  reopened=new Scheduler(env.scheduler.path,{recoverOnOpen:false})
  const second=createTaskflowContinuation(env.rt,env.botState,()=>reopened)
  assert.equal(second('group-a').exhausted,false)
  const third=createTaskflowContinuation(env.rt,env.botState,()=>env.scheduler)
  const exhausted = third('group-a')
  assert.deepEqual([exhausted.exhausted,exhausted.report],[true,true])
  assert.equal(third('group-a').report,false)
  assert.equal(reopened.events('durable').filter(e=>e.type==='continuation_reserved').length,2)
  assert.equal(reopened.events('durable').filter(e=>e.type==='continuation_exhausted').length,1)
 }finally{reopened?.close();env.stop()}
})

test('principal continuation distinguishes dispatch, accept and finish obligations',async()=>{
 const env=host()
 try{
  await env.open()
  env.service.plan({planId:'principal',children:[{id:'write',member:'Writer',goal:'Write',dependencies:[]}]},env.admin)
  assert.match(env.rt.taskflowContinuation('group-admin').text,/taskflow_dispatch/)
  await env.service.dispatch({planId:'principal'},env.admin)
  await env.service.submit({planId:'principal',cardId:'write',result:'Actual result'},env.memberA)
  assert.match(env.rt.taskflowContinuation('group-admin').text,/taskflow_accept/)
  await env.service.accept({planId:'principal',cardId:'write'},env.admin)
  assert.match(env.rt.taskflowContinuation('group-admin').text,/taskflow_finish/)
  assert.deepEqual(env.scheduler.events('principal').filter(e=>e.type==='continuation_reserved').map(e=>e.payload.action),['dispatch','accept','finish'])
 }finally{env.stop()}
})

test('a recovered unissued plan gets one dispatch notice while a preflight gate stays closed',async()=>{
 const env=host()
 try{
  await env.open()
  env.service.plan({planId:'unissued',children:[{id:'write',member:'Writer',goal:'Write',dependencies:[]}]},env.admin)
  await env.rt.taskflowSweep()
  await env.rt.taskflowSweep()
  assert.equal(env.posts.length,1)
  assert.match(env.posts[0],/taskflow_dispatch/)
  assert.equal(env.scheduler.cardView('unissued','write').attempts,0)
  assert.equal(env.scheduler.cardView('unissued','write').state,'pending')
  env.scheduler.requestCancel('unissued',{principal:'bot-admin',reason:'fixture complete'})
  env.scheduler.finishCancel('unissued',{principal:'bot-admin'})
  env.service.plan({planId:'still-gated',children:[{id:'spend',member:'Writer',goal:'Spend',dependencies:[],confirm:'Proceed?'}]},env.admin)
  await env.rt.taskflowSweep()
  assert.equal(env.posts.length,1,'a closed approval gate must not produce a ready-to-dispatch notice')
 }finally{env.stop()}
})

for (const state of ['pending','unknown']) test(`a ${state} recovery notice reserves before send and survives an interrupted delivery`,async()=>{
 const env=host();let reopened
 try{
  await env.open()
  env.service.plan({planId:'interrupted',children:[{id:'write',member:'Writer',goal:'Write',dependencies:[]}]},env.admin)
  if(state==='unknown'){
   await env.service.dispatch({planId:'interrupted'},env.admin)
   env.scheduler.recoverDispatches()
  }
  const post=env.rt.postToRoom
  env.rt.postToRoom=async(...args)=>{await post(...args);throw Error('simulated interruption after send')}
  await assert.rejects(env.rt.taskflowSweep(),/simulated interruption/)
  reopened=new Scheduler(env.scheduler.path,{recoverOnOpen:false})
  const type=state==='pending'?'dispatch_attention':'recovery_attention'
  assert.equal(reopened.events('interrupted').filter(e=>e.type===type).length,1)
  env.rt.postToRoom=post
  await env.rt.taskflowSweep()
  assert.equal(env.posts.length,1,'persisted reservation must prevent another send')
  assert.equal(env.scheduler.cardView('interrupted','write').state,state)
 }finally{reopened?.close();env.stop()}
})

test('a recovery wake is ledger scoped, single-use, and rejected after leadership or task changes',async()=>{
 const env=host()
 try{
  await env.open()
  env.service.plan({planId:'wake',children:[{id:'fix-ui',member:'Writer',goal:'Recover',dependencies:[]}]},env.admin)
  await env.rt.taskflowSweep()
  const event=env.deliveries.at(-1)
  assert.equal(event.event,'recovery')
  assert.equal(event.to.id,'bot-admin')
  const claim=env.rt.taskflowClaimRecovery
  assert.equal(claim('room-2','bot-admin',event),false)
  assert.equal(claim('room-1','bot-a',event),false)
  assert.equal(claim('room-1','bot-admin',{...event,recovery:{...event.recovery,key:'forged'}}),false)
  env.rt.readOnly=()=> 'another host owns this team'
  assert.equal(claim('room-1','bot-admin',event),false)
  env.rt.readOnly=()=>undefined
  env.rt.state.rooms['room-1'].admin='bot-a'
  assert.equal(claim('room-1','bot-admin',event),false)
  env.rt.state.rooms['room-1'].admin='bot-admin'
  assert.equal(claim('room-1','bot-admin',event),true)
  assert.equal(claim('room-1','bot-admin',event),false,'a replay cannot launch another paid round')
  assert.equal(env.scheduler.events('wake').filter(e=>e.type==='recovery_wake_claimed').length,1)
  assert.equal(env.scheduler.cardView('wake','fix-ui').attempts,0)
  env.scheduler.requestCancel('wake',{principal:'bot-admin',reason:'fixture'})
  assert.equal(claim('room-1','bot-admin',event),false)
 }finally{env.stop()}
})

test('gated, cancelled, foreign and read-only work never produces an automatic execution obligation',async()=>{
 const env=host()
 try{
  await env.open()
  env.service.plan({planId:'gated',children:[{id:'write',member:'Writer',goal:'Publish',dependencies:[],confirm:'Publish now?'}]},env.admin)
  assert.equal(env.rt.taskflowContinuation('group-admin'),undefined)
  assert.equal(env.rt.taskflowContinuation('not-a-bot'),undefined)
  env.rt.readOnly=()=> 'locked'
  assert.equal(env.rt.taskflowContinuation('group-admin'),undefined)
  env.rt.readOnly=()=>undefined
  env.scheduler.requestCancel('gated',{principal:'bot-admin',reason:'user stopped'})
  assert.equal(env.rt.taskflowContinuation('group-admin'),undefined)
 }finally{env.stop()}
})
