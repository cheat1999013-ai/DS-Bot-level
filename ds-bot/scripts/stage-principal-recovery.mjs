import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const out=path.join(root,'.tmp-verify/recovery-principal-candidate-1')
const target = process.env.DS_BOT_INSTALLED
if (!target) throw new Error('Set DS_BOT_INSTALLED to the installed ds-bot folder')
const previous=JSON.parse(await fs.readFile(path.join(root,'.tmp-verify/continuation-candidate-manifest-3.json'),'utf8'))
const hash=b=>createHash('sha256').update(b).digest('hex')
const normalize=s=>s.replaceAll('\r\n','\n')
const source=async n=>normalize(await fs.readFile(path.join(root,n),'utf8'))
const replace=(s,a,b)=>{if(s.split(a).length!==2)throw Error(`Ambiguous seam: ${a.slice(0,60)}`);return s.replace(a,b)}
const section=(s,a,b)=>{if(s.split(a).length!==2||s.split(b).length!==2)throw Error('Section changed');return s.slice(s.indexOf(a),s.indexOf(b,s.indexOf(a)))}
const bodies=new Map()
for(const[name,h]of Object.entries(previous.candidate)){
 const body=await fs.readFile(path.join(target,name));if(hash(body)!==h)throw Error(`Installed drift: ${name}`)
 bodies.set(name,body)
}
let host=normalize(bodies.get('src/host/taskflow.js').toString('utf8'))
host=replace(host,"import { createTaskflowContinuation } from './taskflow/continuation.js'","import { createTaskflowContinuation } from './taskflow/continuation.js'\nimport { createTaskflowRecovery } from './taskflow/recovery.js'")
host=replace(host,'  rt.taskflowContinuation = createTaskflowContinuation(rt, state, () => scheduler)\n','  rt.taskflowContinuation = createTaskflowContinuation(rt, state, () => scheduler)\n  const recovery = createTaskflowRecovery(rt, state, () => scheduler)\n  rt.taskflowClaimRecovery = recovery.claim\n')
const start="          for (const card of plan.cards.filter(card => card.state === 'unknown')) {"
const end='\n        }\n      }\n      for (const cycle of knowledge.lifecycle.due())'
host=replace(host,section(host,start,end),section(await source('src/host/taskflow.js'),start,end))
bodies.set('src/host/taskflow.js',Buffer.from(host))
let groups=normalize(bodies.get('src/host/groups.js').toString('utf8'))
const groupSource=await source('src/host/groups.js')
const old=section(groups,'  function openingCall(room, opener) {','    if (opener.done) return at(members.filter(bot => bot.id === opener.askedBy))')
const updated=section(groupSource,'  const recoveryCalls = new WeakMap()','    if (opener.done) return at(members.filter(bot => bot.id === opener.askedBy))')
groups=replace(groups,old,updated)
bodies.set('src/host/groups.js',Buffer.from(groups))
for(const name of ['src/host/taskflow/continuation.js','src/host/taskflow/recovery.js'])bodies.set(name,Buffer.from(await source(name)))
const pkg=JSON.parse(bodies.get('package.json'));pkg.version='0.3.32-principal-recovery.1';bodies.set('package.json',Buffer.from(JSON.stringify(pkg,null,2)+'\n'))
await fs.mkdir(out,{recursive:true})
for(const[n,b]of bodies){await fs.mkdir(path.dirname(path.join(out,n)),{recursive:true});await fs.writeFile(path.join(out,n),b)}
const candidate=Object.fromEntries([...bodies].map(([n,b])=>[n,hash(b)]))
const changed=Object.keys(candidate).filter(n=>candidate[n]!==previous.candidate[n]).sort()
if(JSON.stringify(changed)!==JSON.stringify(['package.json','src/host/groups.js','src/host/taskflow.js','src/host/taskflow/continuation.js','src/host/taskflow/recovery.js']))throw Error(JSON.stringify(changed))
const bind=async names=>Object.fromEntries(await Promise.all(names.map(async name=>[name,hash(await fs.readFile(path.join(root,name)))])))
const reviewInputs=await bind(['test/group-work.test.js','test/taskflow-continuation.test.mjs','test/harness-resolve.mjs','.tmp-verify/installed-candidate-resolve.mjs','.tmp-verify/continuation-runtime-resolve.mjs'])
const sourcePatchInputs=await bind(['src/host/groups.js','src/host/taskflow.js','src/host/taskflow/continuation.js','src/host/taskflow/recovery.js'])
const manifest={version:pkg.version,baseline:previous.candidate,candidate,changed,reviewInputs,sourcePatchInputs,scope:'Bounded recovery wakes the live principal through group dispatch; no automatic unknown redispatch. Exact installed baseline preserves unrelated runtime changes and paused UI stays excluded.'}
await fs.writeFile(path.join(root,'.tmp-verify/recovery-principal-manifest-1.json'),JSON.stringify(manifest,null,2))
console.log(JSON.stringify({version:pkg.version,files:bodies.size,changed}))
