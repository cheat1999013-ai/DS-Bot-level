import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),out=path.join(root,'.tmp-verify/principal-chat-candidate-1')
const baseline=JSON.parse(await fs.readFile(path.join(root,'.tmp-verify/empty-group-post-manifest-1.json'),'utf8')).candidate
const installed = process.env.DS_BOT_INSTALLED
if (!installed) throw new Error('Set DS_BOT_INSTALLED to the installed ds-bot folder')
const hash=body=>createHash('sha256').update(body).digest('hex')
const bodies=new Map()
for(const[n,h]of Object.entries(baseline)){const body=await fs.readFile(path.join(installed,n));if(hash(body)!==h)throw Error('Installed drift '+n);bodies.set(n,body)}
for(const n of ['src/client/task-inputs.js','src/client/task-message.js'])bodies.set(n,await fs.readFile(path.join(root,n)))
let index=bodies.get('src/client/index.js').toString('utf8')
const indexSeam='registerTaskInputs(ctx.slots, { roster, face, priority: BOT_PRIORITY })'
if(index.split(indexSeam).length!==2)throw Error('Principal installer seam')
index=index.replace(indexSeam,'registerTaskInputs(ctx.slots, { roster, face, principalReply: TriggerCell, priority: BOT_PRIORITY })')
bodies.set('src/client/index.js',Buffer.from(index))
const pkg=JSON.parse(bodies.get('package.json'));pkg.version='0.3.35-principal-chat.1';bodies.set('package.json',Buffer.from(JSON.stringify(pkg,null,2)+'\n'))
for(const[n,b]of bodies){await fs.mkdir(path.dirname(path.join(out,n)),{recursive:true});await fs.writeFile(path.join(out,n),b)}
// The official builder is retained as an unshipped verification helper; npm files excludes scripts/.
await fs.mkdir(path.join(out,'scripts'),{recursive:true});await fs.copyFile(path.join(root,'scripts/build-client.mjs'),path.join(out,'scripts/build-client.mjs'))
const {bundleClient}=await import(pathToFileURL(path.join(out,'scripts/build-client.mjs')).href)
const client=await bundleClient();await fs.writeFile(path.join(out,'client.js'),client);bodies.set('client.js',Buffer.from(client))
const candidate=Object.fromEntries([...bodies].map(([n,b])=>[n,hash(b)]))
const changed=Object.keys(candidate).filter(n=>candidate[n]!==baseline[n]).sort()
const expected=['client.js','package.json','src/client/index.js','src/client/task-inputs.js','src/client/task-message.js']
if(JSON.stringify(changed)!==JSON.stringify(expected))throw Error('Unexpected change set '+changed)
const bind=async names=>Object.fromEntries(await Promise.all(names.map(async n=>[n,hash(await fs.readFile(path.join(root,n)))])))
const manifest={version:pkg.version,baseline,candidate,changed,reviewInputs:await bind(['test/task-inputs.test.js','test/task-message.test.js','test/harness-resolve.mjs']),sourcePatchInputs:await bind(['src/client/index.js','src/client/task-inputs.js','src/client/task-message.js','src/client/sources.js','scripts/build-client.mjs']),scope:'Resolve current room admin through indexed stable Bot identity and membership. Ordinary principal replies reuse the existing TriggerCell/GroupMessage chat; explicit task events retain cards. Preserve empty guard, attachment/native fallbacks and native hook ownership. Host untouched.'}
await fs.writeFile(path.join(root,'.tmp-verify/principal-chat-manifest-1.json'),JSON.stringify(manifest,null,2))
console.log(JSON.stringify({version:pkg.version,files:bodies.size,changed}))
