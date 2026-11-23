import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const installed = process.env.DS_BOT_INSTALLED
if (!installed) throw new Error('Set DS_BOT_INSTALLED to the installed ds-bot folder')
const prior=JSON.parse(await fs.readFile(path.join(root,'.tmp-verify/readiness-candidate-manifest.json'),'utf8'))
const out=path.join(root,'.tmp-verify/continuation-candidate-3'),hash=b=>createHash('sha256').update(b).digest('hex')
const bodies=new Map()
for(const [name,h]of Object.entries(prior.candidate)){const body=await fs.readFile(path.join(installed,name));if(hash(body)!==h)throw Error(`Installed drift: ${name}`);bodies.set(name,body)}
const source=async name=>(await fs.readFile(path.join(root,name),'utf8')).replaceAll('\r\n','\n')
const replace=(s,a,b)=>{if(s.split(a).length!==2)throw Error(`Ambiguous seam: ${a.slice(0,80)}`);return s.replace(a,b)}
const section=(s,a,b)=>{if(s.split(a).length!==2||s.split(b).length!==2)throw Error('Section changed');return s.slice(s.indexOf(a),s.indexOf(b,s.indexOf(a)))}
let host=bodies.get('src/host/taskflow.js').toString('utf8').replaceAll('\r\n','\n')
host=replace(host,"import { groupAssignments } from './taskflow/group-activity.js'","import { groupAssignments } from './taskflow/group-activity.js'\nimport { createTaskflowContinuation } from './taskflow/continuation.js'")
host=replace(host,'  let progressOpening\n','  let progressOpening\n  rt.taskflowContinuation = createTaskflowContinuation(rt, state, () => scheduler)\n')
const current=await source('src/host/taskflow.js')
host=replace(host,'      const handled = []\n',section(current,'      const handled = []\n','      for (const cycle of knowledge.lifecycle.due())'))
bodies.set('src/host/taskflow.js',Buffer.from(host))
let turns=bodies.get('src/host/turns.js').toString('utf8').replaceAll('\r\n','\n')
const turnSource=await source('src/host/turns.js')
turns=replace(turns,section(turns,'        const retry =','        const replyText ='),section(turnSource,'        const taskPending =','        const replyText ='))
bodies.set('src/host/turns.js',Buffer.from(turns))
bodies.set('src/host/taskflow/continuation.js',Buffer.from(await source('src/host/taskflow/continuation.js')))
const pkg=JSON.parse(bodies.get('package.json'));pkg.version='0.3.31-task-continuation.1';bodies.set('package.json',Buffer.from(JSON.stringify(pkg,null,2)+'\n'))
await fs.mkdir(out,{recursive:true});for(const[name,body]of bodies){await fs.mkdir(path.dirname(path.join(out,name)),{recursive:true});await fs.writeFile(path.join(out,name),body)}
const candidate=Object.fromEntries([...bodies].map(([n,b])=>[n,hash(b)])),changed=Object.keys(candidate).filter(n=>candidate[n]!==prior.candidate[n]).sort()
if(JSON.stringify(changed)!==JSON.stringify(['package.json','src/host/taskflow.js','src/host/taskflow/continuation.js','src/host/turns.js']))throw Error(JSON.stringify(changed))
const bind=async names=>Object.fromEntries(await Promise.all(names.map(async name=>[name,hash(await fs.readFile(path.join(root,name)))])))
const reviewInputs=await bind(['test/taskflow-continuation.test.mjs','test/group-work.test.js','test/harness-resolve.mjs','.tmp-verify/installed-candidate-resolve.mjs','.tmp-verify/continuation-runtime-resolve.mjs'])
const sourcePatchInputs=await bind(['src/host/taskflow/continuation.js','src/host/taskflow.js','src/host/turns.js'])
await fs.writeFile(path.join(root,'.tmp-verify/continuation-candidate-manifest-3.json'),JSON.stringify({version:pkg.version,baseline:prior.candidate,candidate,changed,reviewInputs,sourcePatchInputs,scope:'Exact installed baseline plus isolated task fixes. Candidate hashes bind release bytes; reviewInputs bind tests/loaders; sourcePatchInputs are patch donors, not full published files. Paused single-Bot UI candidate excluded.'},null,2));console.log(JSON.stringify({version:pkg.version,files:bodies.size,changed,reviewInputCount:Object.keys(reviewInputs).length}))
