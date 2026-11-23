import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),out=path.join(root,'.tmp-verify/task-only-candidate-1')
const installed = process.env.DS_BOT_INSTALLED
if (!installed) throw new Error('Set DS_BOT_INSTALLED to the installed ds-bot folder')
const baseline=JSON.parse(await fs.readFile(path.join(root,'.tmp-verify/card-navigation-manifest-1.json'),'utf8')).candidate
const hash=body=>createHash('sha256').update(body).digest('hex'),bodies=new Map()
for(const[n,digest]of Object.entries(baseline)){const body=await fs.readFile(path.join(installed,n));if(hash(body)!==digest)throw Error('Installed baseline drift '+n);bodies.set(n,body)}
const read=async n=>(await fs.readFile(path.join(root,n),'utf8')).replaceAll('\r\n','\n')
const once=(text,old,next)=>{if(text.split(old).length!==2)throw Error('Missing or ambiguous seam '+old.slice(0,90));return text.replace(old,next)}
let cells=bodies.get('src/client/cells.js').toString('utf8')
const donor=await read('src/client/cells.js'),a=donor.indexOf('function GroupMessage(props) {'),b=donor.indexOf('function PrincipalGroupMessage(',a)
const ia=cells.indexOf('function GroupMessage(props) {'),ib=cells.indexOf('function PrincipalGroupMessage(',ia)
if(a<0||b<a||ia<0||ib<ia)throw Error('Group policy seam changed')
cells=cells.slice(0,ia)+donor.slice(a,b)+cells.slice(ib)
cells=once(cells,"import { TaskMessage, TaskInputCell, GroupPostCard, markdownLabels as mdLabels } from './task-message.js'","import { TaskMessage, TaskInputCell, markdownLabels as mdLabels } from './task-message.js'")
bodies.set('src/client/cells.js',Buffer.from(cells))
bodies.set('src/client/task-message.js',await fs.readFile(path.join(root,'src/client/task-message.js')))

// Apply only the current Host diff, preserving installed projection and integration changes.
const hostNames=['src/host/groups.js','src/host/tools.js']
const diff=execFileSync('git',['diff','--no-ext-diff','--unified=4','--',...hostNames],{cwd:root,encoding:'utf8'}).replaceAll('\r\n','\n')
const sections=diff.split(/^diff --git /m).slice(1),developmentHostBase={}
if(sections.length!==hostNames.length)throw Error('Unexpected Host patch scope')
function applyHunks(body,section){
 let lines=body.match(/[^\n]*\n|[^\n]+$/g)??[]
 const clean=line=>line.replace(/\r?\n$/,'')
 const newline=lines.some(line=>line.endsWith('\r\n'))?'\r\n':'\n'
 for(const block of section.split(/^@@[^\n]*\n/m).slice(1)){
  const edits=block.split('\n').filter(line=>/^[ +\-]/.test(line)),old=edits.filter(line=>line[0]!=='+').map(line=>line.slice(1))
  const hits=[]
  for(let i=0;i<=lines.length-old.length;i++)if(old.every((line,j)=>line===clean(lines[i+j])))hits.push(i)
  if(hits.length!==1)throw Error('Host hunk must match exactly once: '+old.slice(0,2).join(' / '))
  let cursor=hits[0];const replacement=[]
  for(const edit of edits){if(edit[0]===' ')replacement.push(lines[cursor++]);else if(edit[0]==='-')cursor++;else replacement.push(edit.slice(1)+newline)}
  lines.splice(hits[0],old.length,...replacement)
 }
 return lines.join('')
}
for(const section of sections){
 const name=section.match(/^a\/ds-bot\/(\S+) b\/ds-bot\/\S+/)?.[1]
 if(!hostNames.includes(name))throw Error('Unexpected Host file '+name)
 const base=execFileSync('git',['show','HEAD:ds-bot/'+name],{cwd:root})
 developmentHostBase[name]=hash(base)
 if(applyHunks(base.toString('utf8'),section).replaceAll('\r\n','\n')!==await read(name))throw Error('Host patch did not reproduce donor '+name)
 if(name==='src/host/groups.js'){
  const donor=await read(name),header='  async function postToRoom(room, sender, text, extra = {}, files = []) {'
  const guard=donor.slice(donor.indexOf(header)+header.length,donor.indexOf('\n    const running =',donor.indexOf(header)))
  const leads='    const leads = rt.isAdminOf(room, member.id)'
  const rule=donor.slice(donor.indexOf('\n    const replyRule =')+1,donor.indexOf('\n    const lines =',donor.indexOf('\n    const replyRule =')))
  let installed=bodies.get(name).toString('utf8')
  const calls=installed.match(/^const ROOM_CALLS = .+$/m)?.[0]
  installed=once(installed,calls,donor.match(/^const ROOM_CALLS = .+$/m)?.[0])
  const goalBridge=donor.match(/  function reportGoalSubmission[\s\S]+?  ctx\.effect\(\(\) => rt\.onRoomLine\(reportGoalSubmission\), 'ds-bot: formal goal submissions'\)/)?.[0]
  if(!goalBridge)throw Error('Formal goal submission bridge missing')
  installed=once(installed,'  rt.roomFolderNotice = roomFolderNotice','  rt.roomFolderNotice = roomFolderNotice\n\n'+goalBridge)
  const quiet=/  const isQuietWorker = \(roomId, botId\) => ([^\r\n]+)\r?\n    \|\| rt\.taskflowIsQuietWorker\?\.\(roomId, botId\) === true/g
  const matches=[...installed.matchAll(quiet)]
  if(matches.length!==1||!rule.startsWith('    const replyRule =')||!guard.includes('throw new Error'))throw Error('Installed group policy fragments changed')
  const may=donor.match(/^  const maySpeakInRoom = .+$/m)?.[0]
  installed=installed.replace(quiet,may+'\n  const isQuietWorker = (roomId, botId) => {\n    const room = rt.roomOf(roomId)\n    return (room !== undefined && !maySpeakInRoom(room, botId))\n      || '+matches[0][1]+'\n      || rt.taskflowIsQuietWorker?.(roomId, botId) === true\n  }')
  installed=once(installed,leads,leads+'\n'+rule)
  const kickoff="    if (round.kickoff) return { text: [members, notice, leads ? adminNote(room) : '', roomKickoff(rt.uiLanguage?.())].filter(Boolean).join('\\n\\n'), images: [], files: [] }"
  const newKickoff=donor.split('\n').find(line=>line.startsWith('    if (round.kickoff) return { text:'))
  installed=once(installed,kickoff,newKickoff)
  installed=once(installed,'      ROOM_REPLY,','      replyRule,')
  const found='    const found = named.filter(bot => bot.id !== opener.botId)'
  const routing=donor.slice(donor.indexOf(found)+found.length,donor.indexOf('\n    if (opener.progress)',donor.indexOf(found)))
  if(!routing.includes('opener.botId === undefined'))throw Error('User-to-principal routing seam missing')
  installed=once(installed,found,found+routing)
  installed=once(installed,'    if (by === undefined || callees.length === 0) return undefined',
    donor.split('\n').find(line=>line.startsWith('    if (by === undefined || callees.length === 0 ||')))
  installed=once(installed,header,header+guard)
  bodies.set(name,Buffer.from(installed))
 }else bodies.set(name,Buffer.from(applyHunks(bodies.get(name).toString('utf8'),section)))
}
const pkg=JSON.parse(bodies.get('package.json'));pkg.version='0.3.39-task-only.1';bodies.set('package.json',Buffer.from(JSON.stringify(pkg,null,2)+'\n'))
for(const[n,body]of bodies){await fs.mkdir(path.dirname(path.join(out,n)),{recursive:true});await fs.writeFile(path.join(out,n),body)}
await fs.mkdir(path.join(out,'scripts'),{recursive:true});await fs.copyFile(path.join(root,'scripts/build-client.mjs'),path.join(out,'scripts/build-client.mjs'))
const {bundleClient}=await import(pathToFileURL(path.join(out,'scripts/build-client.mjs')).href)
const client=await bundleClient();await fs.writeFile(path.join(out,'client.js'),client);bodies.set('client.js',Buffer.from(client))
const candidate=Object.fromEntries([...bodies].map(([n,body])=>[n,hash(body)])),changed=Object.keys(candidate).filter(n=>candidate[n]!==baseline[n]).sort()
const expected=['client.js','package.json','src/client/cells.js','src/client/task-message.js','src/host/groups.js','src/host/tools.js']
if(JSON.stringify(changed)!==JSON.stringify(expected))throw Error('Unexpected candidate changes '+changed)
const bind=async names=>Object.fromEntries(await Promise.all(names.map(async n=>[n,hash(await fs.readFile(path.join(root,n)))])))
const manifest={version:pkg.version,baseline,candidate,changed,developmentHostBase,hostDiffSha256:hash(diff),reviewInputs:await bind(['test/executor-task-only.test.mjs','test/task-inputs.test.js','test/task-markdown-contract.test.mjs','test/tool-cells.test.js','test/group-work.test.js','test/group-status.test.js','test/rounds.test.js','test/group-goal.test.js','test/request-id.test.js','test/install.test.js','test/plugin.test.mjs','test/harness-resolve.mjs']),sourcePatchInputs:await bind(['src/client/cells.js','src/client/task-message.js',...hostNames,'scripts/build-client.mjs','scripts/stage-task-only.mjs']),scope:'All groups: executor results/reflections use genuine taskflow submission and current-leader delivery; ordinary executor progress/finals/posts and historical report cards are suppressed without inventing task IDs. Current leader ordinary chat, actual formal task cards, private Bot messages and installed .38 Markdown/navigation fixes remain. Installed Host is patched only at exact matching hunks, never replaced from the divergent donor.'}
await fs.writeFile(path.join(root,'.tmp-verify/task-only-manifest-1.json'),JSON.stringify(manifest,null,2))
await fs.writeFile(path.join(root,'.tmp-verify/task-only-host-diff-1.patch'),diff)
console.log(JSON.stringify({version:pkg.version,files:bodies.size,changed}))
