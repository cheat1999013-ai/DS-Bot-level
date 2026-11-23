import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),out=path.join(root,'.tmp-verify/slot-trace-candidate-1')
const baseline=JSON.parse(await fs.readFile(path.join(root,'.tmp-verify/task-row-manifest-1.json'),'utf8')).candidate
const installed = process.env.DS_BOT_INSTALLED
if (!installed) throw new Error('Set DS_BOT_INSTALLED to the installed ds-bot folder')
const hash=body=>createHash('sha256').update(body).digest('hex')
const bodies=new Map()
for(const[n,h]of Object.entries(baseline)){const body=await fs.readFile(path.join(installed,n));if(hash(body)!==h)throw Error('Installed drift '+n);bodies.set(n,body)}
bodies.set('src/client/slot-trace.js',await fs.readFile(path.join(root,'src/client/slot-trace.js')))
let index=bodies.get('src/client/index.js').toString('utf8')
const donor=await fs.readFile(path.join(root,'src/client/index.js'),'utf8')
const begin=donor.indexOf('  ctx.effect(() => installSlotTrace(ctx.slots, {')
const end=donor.indexOf("  }), 'ds-bot: slot trace')",begin)+"  }), 'ds-bot: slot trace')".length
if(begin<0||end<begin)throw Error('Trace donor seam missing')
const seam="  const surface = createSource({ mode: readMode(), plain: false })"
if(index.split(seam).length!==2)throw Error('Installed surface seam changed')
index="import { installSlotTrace } from './slot-trace.js'\n"+index.replace(seam,seam+'\n'+donor.slice(begin,end))
bodies.set('src/client/index.js',Buffer.from(index))
const pkg=JSON.parse(bodies.get('package.json'));pkg.version='0.3.37-slot-trace.1';bodies.set('package.json',Buffer.from(JSON.stringify(pkg,null,2)+'\n'))
for(const[n,b]of bodies){await fs.mkdir(path.dirname(path.join(out,n)),{recursive:true});await fs.writeFile(path.join(out,n),b)}
// The official builder is retained as an unshipped verification helper; npm files excludes scripts/.
await fs.mkdir(path.join(out,'scripts'),{recursive:true});await fs.copyFile(path.join(root,'scripts/build-client.mjs'),path.join(out,'scripts/build-client.mjs'))
const {bundleClient}=await import(pathToFileURL(path.join(out,'scripts/build-client.mjs')).href)
const client=await bundleClient();await fs.writeFile(path.join(out,'client.js'),client);bodies.set('client.js',Buffer.from(client))
const candidate=Object.fromEntries([...bodies].map(([n,b])=>[n,hash(b)]))
const changed=Object.keys(candidate).filter(n=>candidate[n]!==baseline[n]).sort()
const expected=['client.js','package.json','src/client/index.js','src/client/slot-trace.js']
if(JSON.stringify(changed)!==JSON.stringify(expected))throw Error('Unexpected change set '+changed)
const bind=async names=>Object.fromEntries(await Promise.all(names.map(async n=>[n,hash(await fs.readFile(path.join(root,n)))])))
const manifest={version:pkg.version,baseline,candidate,changed,reviewInputs:await bind(['test/slot-trace.test.mjs','test/task-inputs.test.js','test/task-message.test.js','test/task-row-projection.test.mjs','test/harness-resolve.mjs']),sourcePatchInputs:await bind(['src/client/index.js','src/client/slot-trace.js','scripts/build-client.mjs','scripts/stage-slot-trace.mjs']),scope:'Diagnostic-only: public onEntryError + read-only raw/winner snapshots, safe stack function/line positions. Preserve .36 runtime exactly except observer import/effect. No DSH modifications, node/text/credential logging, remount or recovery.'}
await fs.writeFile(path.join(root,'.tmp-verify/slot-trace-manifest-1.json'),JSON.stringify(manifest,null,2))
console.log(JSON.stringify({version:pkg.version,files:bodies.size,changed}))
