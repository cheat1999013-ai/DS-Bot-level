import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),out=path.join(root,'.tmp-verify/card-navigation-candidate-1')
const baseline=JSON.parse(await fs.readFile(path.join(root,'.tmp-verify/slot-trace-manifest-1.json'),'utf8')).candidate
const installed = process.env.DS_BOT_INSTALLED
if (!installed) throw new Error('Set DS_BOT_INSTALLED to the installed ds-bot folder')
const hash=body=>createHash('sha256').update(body).digest('hex'),bodies=new Map()
for(const[n,h]of Object.entries(baseline)){const b=await fs.readFile(path.join(installed,n));if(hash(b)!==h)throw Error('Installed drift '+n);bodies.set(n,b)}
bodies.set('src/client/task-message.js',await fs.readFile(path.join(root,'src/client/task-message.js')))
const locale=bodies.get('src/client/i18n.js').toString('utf8'),localeSeam="  Copied: '已复制',"
if(locale.split(localeSeam).length!==2)throw Error('Installed translation seam changed')
bodies.set('src/client/i18n.js',Buffer.from(locale.replace(localeSeam,localeSeam+"\n  'Wrap lines': '自动换行',\n  'Unwrap lines': '取消自动换行',")))
let cells=bodies.get('src/client/cells.js').toString('utf8')
const donor=(await fs.readFile(path.join(root,'src/client/cells.js'),'utf8')).replaceAll('\r\n','\n')
const a=donor.indexOf('function GroupMessage(props) {'),b=donor.indexOf('function PrincipalGroupMessage(',a)
if(a<0||b<a)throw Error('Donor group policy seam missing')
const seam='function GroupMessage({ bot, text, texts = [text], room, roster, actions, msgKey, useUi, whole, time, duration }) {'
if(cells.split(seam).length!==2)throw Error('Installed group policy seam changed')
const imp="import { TaskMessage, TaskInputCell } from './task-message.js'"
if(cells.split(imp).length!==2)throw Error('Installed task component imports changed')
const labelsSeam="const mdLabels = () => ({ code: { copyLabel: t('Copy'), copiedLabel: t('Copied') }, footnotes: t('Footnotes') })"
if(cells.split(labelsSeam).length!==2)throw Error('Installed Markdown copy factory changed')
cells=cells.replace(labelsSeam,'').replace(imp,"import { TaskMessage, TaskInputCell, GroupPostCard, markdownLabels as mdLabels } from './task-message.js'").replace(seam,donor.slice(a,b)+seam.replace('function GroupMessage(','function PrincipalGroupMessage('))
bodies.set('src/client/cells.js',Buffer.from(cells))
const pkg=JSON.parse(bodies.get('package.json'));pkg.version='0.3.38-card-navigation.1';bodies.set('package.json',Buffer.from(JSON.stringify(pkg,null,2)+'\n'))
for(const[n,b]of bodies){await fs.mkdir(path.dirname(path.join(out,n)),{recursive:true});await fs.writeFile(path.join(out,n),b)}
await fs.mkdir(path.join(out,'scripts'),{recursive:true});await fs.copyFile(path.join(root,'scripts/build-client.mjs'),path.join(out,'scripts/build-client.mjs'))
const {bundleClient}=await import(pathToFileURL(path.join(out,'scripts/build-client.mjs')).href)
const client=await bundleClient();await fs.writeFile(path.join(out,'client.js'),client);bodies.set('client.js',Buffer.from(client))
const candidate=Object.fromEntries([...bodies].map(([n,b])=>[n,hash(b)])),changed=Object.keys(candidate).filter(n=>candidate[n]!==baseline[n]).sort()
const expected=['client.js','package.json','src/client/cells.js','src/client/i18n.js','src/client/task-message.js']
if(JSON.stringify(changed)!==JSON.stringify(expected))throw Error('Unexpected changes '+changed)
const bind=async names=>Object.fromEntries(await Promise.all(names.map(async n=>[n,hash(await fs.readFile(path.join(root,n)))])))
const manifest={version:pkg.version,baseline,candidate,changed,reviewInputs:await bind(['test/i18n.test.js','test/task-markdown-contract.test.mjs','test/task-inputs.test.js','test/task-message.test.js','test/task-row-projection.test.mjs','test/harness-resolve.mjs','.tmp-verify/build-markdown-navigation.mjs','.tmp-verify/markdown-navigation-case.js','.tmp-verify/run-markdown-navigation.cjs']),sourcePatchInputs:await bind(['src/client/cells.js','src/client/i18n.js','src/client/task-message.js','scripts/build-client.mjs','scripts/stage-card-navigation.mjs']),scope:'Two reproduced repairs: required native Markdown labels on formal/group/invalid-history cards; centralized current-room stable-admin ordinary bubble policy for persisted/replayed/live GroupMessage. Preserve installed .37 index/host and read-only observer, formal identity priority, attachment whole-reader, public SDK and all group IDs.'}
await fs.writeFile(path.join(root,'.tmp-verify/card-navigation-manifest-1.json'),JSON.stringify(manifest,null,2))
console.log(JSON.stringify({version:pkg.version,files:bodies.size,changed}))
