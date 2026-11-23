import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const out=path.join(root,'.tmp-verify/bot-row-candidate-2')
const installed = process.env.DS_BOT_INSTALLED
if (!installed) throw new Error('Set DS_BOT_INSTALLED to the installed ds-bot folder')
const prior=JSON.parse(await fs.readFile(path.join(root,'.tmp-verify/readiness-candidate-manifest.json'),'utf8'))
const hash=b=>createHash('sha256').update(b).digest('hex')
const bodies=new Map()
for(const [name,expected] of Object.entries(prior.candidate)){
 const body=await fs.readFile(path.join(installed,name));if(hash(body)!==expected)throw Error(`Installed baseline changed: ${name}`);bodies.set(name,body)
}
let board=(await fs.readFile(path.join(root,'src/client/taskflow-dashboard.js'),'utf8')).replaceAll('\r\n','\n')
// Keep the source tree's independent schedule entry outside this UI repair.
board=board.replace(", onConfirm, onSchedule })",", onConfirm })")
board=board.replace("    onSchedule: actions?.openSettings && scope !== 'all' && (!roomId || roomId === scope)\n      ? () => actions.openSettings('schedules', `group:${scope}`) : undefined,\n",'')
board=board.replace("      onSchedule ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onSchedule }, t('New group task')) : null,\n",'')
if(board.includes('onSchedule'))throw Error('Unexpected schedule seam')
bodies.set('src/client/taskflow-dashboard.js',Buffer.from(board))
let locale=bodies.get('src/client/i18n.js').toString('utf8')
const anchor="  'Task history': '任务历史',"
if(locale.split(anchor).length!==2)throw Error('Locale seam changed')
locale=locale.replace(anchor,"  'Tasks and history ({count})': '任务与历史（{count}）',\n"+anchor)
bodies.set('src/client/i18n.js',Buffer.from(locale))
let host=bodies.get('src/host/taskflow.js').toString('utf8').replaceAll('\r\n','\n')
for(const indent of ['        ','      ']){
 const line=`\n${indent}members: scopeAll ? Object.assign({}, `
 const start=host.indexOf(line)
 if(start<0||host.indexOf(line,start+1)!==-1)throw Error('Unexpected member DTO seam')
 host=host.slice(0,start+1)+`${indent}membersByRoom: Object.fromEntries((scopeAll ? rooms : [room]).filter(Boolean).map(item => [item.id, membersOf(item)])),\n`+host.slice(start+1)
}
bodies.set('src/host/taskflow.js',Buffer.from(host))
const pkg=JSON.parse(bodies.get('package.json'));pkg.version='0.3.30-bot-rows.1';bodies.set('package.json',Buffer.from(JSON.stringify(pkg,null,2)+'\n'))
await fs.mkdir(out,{recursive:true})
for(const [name,body] of bodies){await fs.mkdir(path.dirname(path.join(out,name)),{recursive:true});await fs.writeFile(path.join(out,name),body)}
const {bundleClient}=await import(pathToFileURL(path.join(out,'scripts/build-client.mjs')).href)
await fs.writeFile(path.join(out,'client.js'),await bundleClient())
const candidate=Object.fromEntries(await Promise.all([...bodies.keys()].map(async name=>[name,hash(await fs.readFile(path.join(out,name)))])))
const changed=Object.keys(candidate).filter(name=>candidate[name]!==prior.candidate[name]).sort()
const allowed=['client.js','package.json','src/client/i18n.js','src/client/taskflow-dashboard.js','src/host/taskflow.js']
if(JSON.stringify(changed)!==JSON.stringify(allowed))throw Error(`Unexpected delta: ${changed}`)
await fs.writeFile(path.join(root,'.tmp-verify/bot-row-candidate-manifest.json'),JSON.stringify({version:pkg.version,baseline:prior.candidate,candidate,changed},null,2))
console.log(JSON.stringify({version:pkg.version,files:bodies.size,changed}))
