import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
const {createRuntime}=await import(process.env.BOT_RUNTIME_SOURCE??'../index.js')
import {fakeContext} from './fake-ctx.js'

async function fixture(t){
 const home=mkdtempSync(join(fileURLToPath(new URL('../.tmp-verify/',import.meta.url)),'task-only-'))
 const bots={a:{id:'a',name:'Chief',sessionId:'a',createdAt:1},b:{id:'b',name:'Worker',sessionId:'b',createdAt:2}}
 const rooms={r1:{id:'r1',name:'First',admin:'a',members:['a','b'],sessions:{a:'ga',b:'gb'},log:[],seq:0,seen:{}},r2:{id:'r2',name:'Second',admin:'b',members:['a','b'],sessions:{a:'ha',b:'hb'},log:[],seq:0,seen:{}}}
 writeFileSync(join(home,'state.json'),JSON.stringify({version:1,mainBotIds:['a'],bots,rooms,agents:{},exchanges:[],exchangeTurns:{},questions:{},prefs:{},revision:0}))
 const ctx=fakeContext(),posted=[]
 ctx.llm={listProviders:()=>[],listModels:async()=>[],resolveModelInfo:async()=>({})}
 ctx.workspaceRegistry={get:()=>undefined,resolveByPath:async()=>undefined,create:async path=>({id:'w',path}),archiveSession:async()=>{}}
 ctx.sessionController={resolveAgent:async sessionId=>({agent:{session:{id:sessionId},followup:message=>posted.push({sessionId,message}),steer:message=>posted.push({sessionId,message})}})}
 ctx.sessions={flush:async()=>{}}
 ctx.sessionTitle={rename:async()=>{}}
 const rt=createRuntime(ctx,{home})
 t.after(()=>ctx.dispose())
 await rt.load()
 return {rt,posted}
}

test('formal assignment and submission persist a real result and address the leader without a duplicate report',async t=>{
 const {rt,posted}=await fixture(t)
 rt.groupOwners.set('ga',{botId:'a',roomId:'r1'})
 rt.groupOwners.set('gb',{botId:'b',roomId:'r1'})
 const tool=async(name,args,id)=>JSON.parse(await rt.teamTools.find(value=>value.name===name).execute(args,{agent:{id}}))
 const planned=await tool('taskflow_plan',{group:'r1',goal:'Verified task-only result',children:[{id:'deliver',member:'Worker',goal:'Produce the requested result',dependencies:[]}]},'ga')
 assert.ok(planned.plan?.plan_id,JSON.stringify(planned))
 const planId=planned.plan.plan_id
 const dispatched=await tool('taskflow_dispatch',{planId},'ga')
 assert.equal(dispatched.sent?.length,1,JSON.stringify(dispatched))
 const submitted=await tool('taskflow_submit',{planId,cardId:'deliver',result:'Actual fixture result'},'gb')
 assert.equal(submitted.observed?.status,'settled',JSON.stringify(submitted))
 const board=await rt.taskflowView({room:'r1'})
 assert.equal(board.plan.cards.find(card=>card.id==='deliver').result,'Actual fixture result')
 const resultPost=posted.find(value=>value.message.source.taskflowEvent?.event==='submitted')
 assert.ok(resultPost)
 assert.equal(resultPost.message.source.taskflowEvent.planId,planId)
 assert.equal(resultPost.message.source.taskflowEvent.cardId,'deliver')
 assert.equal(resultPost.message.source.taskflowEvent.from.id,'b')
 assert.equal(resultPost.message.source.taskflowEvent.to.id,'a')
 assert.deepEqual(resultPost.message.source.mentions.ids,['a'])
 assert.equal((await tool('taskflow_accept',{planId,cardId:'deliver'},'ga')).success,true)
 assert.equal((await tool('taskflow_finish',{planId},'ga')).finished?.status,'completed')
 const note=await tool('taskflow_sleep_note',{planId,cardId:'deliver',text:'## 做了什么\n提交了隔离测试结果。\n## 为什么这么做\n验证结果与任务身份一同送达。\n## 里面的错误怎么避免\n不以普通聊天冒充提交。\n## 要在下次任务中做的更好我需要什么\n保留可回放的提交证据。'},'gb')
 assert.equal(note.notification?.sent,true,JSON.stringify(note))
 const reflection=posted.find(value=>value.message.source.taskflowEvent?.event==='reflection')
 assert.ok(reflection)
 assert.equal(reflection.message.source.taskflowEvent.cardId,'deliver')
 assert.equal(reflection.message.source.taskflowEvent.to.id,'a')
 await assert.rejects(rt.postToRoom(rt.roomOf('r1'),rt.botOf('b'),'Duplicate ordinary summary'),/taskflow_submit/)
 assert.equal(posted.filter(value=>value.message.source.senderSessionId==='b'&&!value.message.source.taskflowEvent).length,0)
})

test('ordinary executor posts cannot enter a group or manufacture task identity',async t=>{
 const {rt,posted}=await fixture(t),room=rt.roomOf('r1')
 await assert.rejects(rt.postToRoom(room,rt.botOf('b'),'My ordinary report'),/taskflow_submit|formal task/i)
 assert.equal(posted.length,0)
 assert.equal(room.log.length,0)
})

test('progress and late finals stay quiet even after the assignment quiet marker is cleared',async t=>{
 const {rt,posted}=await fixture(t)
 rt.groupOwners.set('gb',{botId:'b',roomId:'r1'})
 rt.taskflowQuietWorker('r1','b',false)
 const info={role:'room',roomId:'r1',exchangeId:'finished-worker-turn',askedBy:'a'}
 await rt.roomStepText('gb',info,'Ordinary progress @Chief',false)
 await rt.lateRoomReply('gb',info,'Duplicate final after submission')
 assert.equal(posted.length,0)
 assert.equal(rt.roomOf('r1').log.length,0)
})

test('post_to_group refuses an executor before attaching content and message_bot cannot silently bypass it',async t=>{
 const {rt,posted}=await fixture(t)
 rt.groupOwners.set('gb',{botId:'b',roomId:'r1'})
 rt.attachLong=()=>{throw Error('Ordinary report must be rejected before file staging')}
 const post=await rt.teamTools.find(value=>value.name==='post_to_group').execute({group:'r1',message:'Result'}, {agent:{id:'gb'}})
 assert.match(post,/taskflow_submit/)
 const message=await rt.teamTools.find(value=>value.name==='message_bot').execute({to:'Chief',message:'Untracked result'}, {agent:{id:'gb'}})
 assert.match(message,/^Not sent:.*formal tasks/)
 assert.equal(posted.length,0)
})

test('leader transfer and a group created after startup use the same task-only rule',async t=>{
 const {rt,posted}=await fixture(t),room=rt.roomOf('r1')
 room.admin='b'
 await rt.postToRoom(room,rt.botOf('b'),'New leader ordinary answer')
 await assert.rejects(rt.postToRoom(room,rt.botOf('a'),'Former leader ordinary answer'),/formal task/)
 rt.state.rooms.fresh={id:'fresh',name:'New group',admin:'a',members:['a','b'],sessions:{},log:[],seq:0,seen:{}}
 await assert.rejects(rt.postToRoom(rt.roomOf('fresh'),rt.botOf('b'),'New group ordinary report'),/formal task/)
 await rt.postToRoom(rt.roomOf('fresh'),rt.botOf('a'),'New group leader answer')
 assert.equal(posted.length,2)
})

test('private Bot messages retain their existing private delivery',async t=>{
 const {rt,posted}=await fixture(t)
 await rt.teamTools.find(value=>value.name==='message_bot').execute({to:'Chief',message:'Private question'}, {agent:{id:'b'}})
 assert.equal(posted.length,1)
 assert.equal(posted[0].sessionId,'a')
 assert.ok(posted[0].message.content.some(value=>value.text?.includes('Private question')))
})

test('only the current-room leader may post ordinary text, including when global Main differs',async t=>{
 const {rt,posted}=await fixture(t)
 await rt.postToRoom(rt.roomOf('r1'),rt.botOf('a'),'Leader reply')
 await rt.postToRoom(rt.roomOf('r2'),rt.botOf('b'),'Other room leader reply')
 await assert.rejects(rt.postToRoom(rt.roomOf('r2'),rt.botOf('a'),'Global Main is not this leader'),/taskflow_submit|formal task/i)
 assert.equal(posted.length,2)
})

test('a real explicitly identified task event still reaches the room with the leader as recipient',async t=>{
 const {rt,posted}=await fixture(t)
 const taskflowEvent={planId:'existing-plan',cardId:'existing-card',event:'submitted',from:{id:'b',name:'Worker'},to:{id:'a',name:'Chief'}}
 await assert.rejects(rt.postToRoom(rt.roomOf('r1'),rt.botOf('b'),'Existing task result',{taskflowEvent}),/native task delivery/)
 await rt.postTaskToRoom(rt.roomOf('r1'),rt.botOf('b'),'Existing task result',{taskflowEvent,mentions:{ids:['a'],all:false}})
 assert.equal(posted.length,1)
 assert.deepEqual(posted[0].message.source.taskflowEvent,taskflowEvent)
 assert.equal(posted[0].message.source.kind,'taskflow')
 assert.deepEqual(posted[0].message.source.mentions.ids,['a'])
})
