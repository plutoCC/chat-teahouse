import { resolve } from 'node:path';
import { buildApp } from './app.js';
import {configuredLocalPool} from './hosting/shared-members.js';
import {HostingSettingsStore} from './hosting/settings.js';

const port=Number(process.env.PORT??4317);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('PORT 必须在 1024–65535 之间。');
const dataDir=resolve(process.env.CHAT_TEA_DATA_DIR??'data');
const shared=configuredLocalPool(process.cwd(),dataDir);
const settings=shared?new HostingSettingsStore(resolve('data-hosted')):undefined;
const {app}=await buildApp({port,dataDir,production:process.argv.includes('--production'),...(shared?{sharedMembers:shared.context,resourceLimits:()=>settings!.values()}:{} )});
if(shared)app.addHook('onClose',async()=>shared.close());
await app.listen({host:'127.0.0.1',port});
console.log(`\n  chat 茶馆 · 多一种观点\n  Local: http://127.0.0.1:${port}\n  仅本机可访问。按 Ctrl+C 停止。\n`);
let closing=false;
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,async()=>{if(closing)return;closing=true;await app.close();process.exit(0);});
