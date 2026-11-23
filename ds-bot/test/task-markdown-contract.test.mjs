import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {runInNewContext} from 'node:vm'
import {fileURLToPath} from 'node:url'
import {createRequire} from 'node:module'
const requireApp=createRequire(new URL('../../app/package.json',import.meta.url))
const React=requireApp('react'),{renderToStaticMarkup}=requireApp('react-dom/server')
const result=await build({stdin:{contents:"export {TaskMessage} from './src/client/task-message.js';export {TriggerCell} from './src/client/cells.js';export {installLocale} from './src/client/i18n.js'",resolveDir:process.env.STAGED_BOT_ROOT??fileURLToPath(new URL('..',import.meta.url))},bundle:true,platform:'node',format:'cjs',write:false,external:['react','react-dom','@deepseek-ai/dsh-client-ui-primitives']})
const received=[]
function MarkdownContract({text,labels}){
  // The runtime navigation probe uses the real shipped MarkdownText. This fast test pins its required copy contract on every task-card branch.
  assert.equal(typeof labels?.code?.copyLabel,'string')
  assert.equal(typeof labels?.code?.copiedLabel,'string')
  assert.equal(typeof labels?.code?.toolbarLabels?.codeLabel,'string')
  assert.equal(typeof labels?.code?.toolbarLabels?.wrapLabel,'string')
  assert.equal(typeof labels?.code?.toolbarLabels?.unwrapLabel,'string')
  assert.equal(typeof labels?.footnotes,'string')
  received.push(text)
  return React.createElement('span',null,text)
}
const m={exports:{}}
runInNewContext(result.outputFiles[0].text,{module:m,exports:m.exports,require:n=>n==='react'?React:n==='react-dom'?requireApp('react-dom'):{MarkdownText:MarkdownContract}})
const {TaskMessage,TriggerCell,installLocale}=m.exports
const text='Code\n```\nfixture\n```\n\nNote[^1]\n\n[^1]: Fixture'

test('formal task bodies keep complete native Markdown labels and invalid tasks show an error',()=>{
  received.length=0
  const html=renderToStaticMarkup(React.createElement(React.Fragment,null,
    React.createElement(TaskMessage,{task:{planId:'plan',cardId:'review',event:'submitted'},text}),

    React.createElement(TaskMessage,{text})))
  assert.equal(received.length,1)
  assert.deepEqual(received,[text])
  assert.match(html,/role="alert"/)
})

test('five minute reminder appears as a task card addressed to the principal',()=>{
  const html=renderToStaticMarkup(React.createElement(TaskMessage,{
    task:{planId:'plan',cardId:'review',event:'recovery',recovery:{kind:'reminder'},from:{id:'chief',name:'Chief'},to:{id:'chief',name:'Chief'}},
    text:'Check the original plan and follow up with executors.'
  }))
  assert.match(html,/data-task-reference="plan\/review"/)
  assert.match(html,/Task reminder/)
  assert.match(html,/To principal: Chief/)
  assert.match(html,/Check the original plan and follow up with executors/)
})

test('reminder card displays Chinese title and principal',()=>{
  let zh={}
  const dispose=installLocale({register(_namespace,lang,dict){if(lang==='zh')zh=dict; return ()=>{}},bind(){return (key,params)=>String(zh[key]??key).replace(/\{(\w+)\}/g,(_,name)=>params?.[name]??'')}})
  try {
    const html=renderToStaticMarkup(React.createElement(TaskMessage,{
      task:{planId:'plan',cardId:'review',event:'recovery',recovery:{kind:'reminder'},from:{id:'chief',name:'主理'},to:{id:'chief',name:'主理'}},text:'提醒正文'
    }))
    assert.match(html,/任务提醒/)
    assert.match(html,/接收主理：主理/)
  } finally { dispose() }
})

for (const formal of [false,true]) test(`a worker ordinary post is hidden while a formal submission stays a real card (${formal})`,()=>{
  received.length=0
  const worker={id:'worker',name:'Worker',color:'blue'},chief={id:'chief',name:'Chief',color:'green'}
  const roster={byId:{worker,chief},bots:[worker,chief],roomsById:{room:{id:'room',admin:'chief',members:['worker','chief']}},exchangeTurns:{},prefs:{}}
  const html=renderToStaticMarkup(React.createElement(TriggerCell,{
    node:{kind:'turn-trigger',key:'worker-post',location:{turn:{turn:1}},data:{seq:1,time:1700000000000,source:{kind:'bot',role:'post',senderSessionId:'worker',senderName:'Worker',...(formal?{taskflowEvent:{planId:'plan',cardId:'review',event:'submitted',from:{id:'worker',name:'Worker'},to:{id:'chief',name:'Chief'}}}:{})},content:[{type:'text',text}]}},
    sessionId:'room',useRoster:f=>f(roster),useSessions:f=>f({byId:{}}),useTurnClock:f=>f({}),useUi:f=>f({visits:{}}),actions:{noteTurnPeer(){},toggleReaction(){}},
  }))
  if(formal){
    assert.match(html,/data-task-reference="plan\/review"/)
    assert.match(html,/Worker → Chief/)
    assert.doesNotMatch(html,/data-bot-post|Group update/)
    assert.deepEqual(received,[text])
  }else{
    assert.equal(html,'')
    assert.equal(received.length,0)
  }
})
