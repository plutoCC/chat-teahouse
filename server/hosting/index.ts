import { resolve, join } from 'node:path';
import { openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../app.js';
import { SecretVault } from '../vault.js';
import { hostingConfig, hostingDataDir } from './config.js';
import { HostingBudget } from './budget.js';
import { hostedProviders, hostedGenerators } from './models.js';
import { buildHostingGateway } from './gateway.js';
import type { HostingUser } from './accounts.js';
import {HostingSettingsStore} from './settings.js';
import {SharedMemberPool,importHostingProfiles} from './shared-members.js';

async function availablePort():Promise<number> {
  const probe=createServer();await new Promise<void>((done,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',done);});
  const address=probe.address();const port=typeof address==='object'&&address?address.port:0;
  await new Promise<void>((done,reject)=>probe.close(error=>error?reject(error):done()));return port;
}
function processLock(dir:string):()=>void {
  const path=join(dir,'hosting-process.lock');
  try{const fd=openSync(path,'wx',0o600);writeFileSync(fd,String(process.pid));closeSync(fd);}
  catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    const pid=Number(readFileSync(path,'utf8'));if(!Number.isSafeInteger(pid)||pid<=0)throw new Error('网站进程锁无效，请先确认旧服务已停止。');
    let alive=true;try{process.kill(pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')alive=false;}
    if(alive)throw new Error('此网站数据目录已有运行中的服务。');
    unlinkSync(path);return processLock(dir);
  }
  return ()=>{if(readFileSync(path,'utf8')===String(process.pid))unlinkSync(path);};
}

export async function startHosting(env:NodeJS.ProcessEnv=process.env) {
  const config=hostingConfig(env),dataDir=hostingDataDir(env.CHAT_TEA_HOST_DATA_DIR??'data-hosted');
  // Protect the root before account sessions, quotas or user workspaces are created.
  new SecretVault(dataDir);
  const settings=new HostingSettingsStore(dataDir,config.limits);
  const unlock=processLock(dataDir);
  const pool=new SharedMemberPool(dataDir);
  let admin:Awaited<ReturnType<typeof buildApp>>|undefined,gateway:Awaited<ReturnType<typeof buildHostingGateway>>|undefined,budget:HostingBudget|undefined;
  const tenants=new Map<string,Promise<Awaited<ReturnType<typeof buildApp>> & {port:number}>>();
  const retiring=new Set<Promise<void>>();
  let revocationTimer:ReturnType<typeof setInterval>|undefined,closing=false,closePromise:Promise<void>|undefined;
  const close=():Promise<void>=>closePromise??=(async()=>{
    closing=true;clearInterval(revocationTimer);
    // Close upstream streams before waiting for the gateway's HTTP server to drain.
    await Promise.allSettled([...retiring,...[...tenants.values()].map(async p=>(await p).app.close())]);
    try{if(gateway)await gateway.app.close();if(admin)await admin.app.close();}finally{budget?.close();pool.close();unlock();}
  })();
  try{
    budget=new HostingBudget(dataDir,config.limits,Date.now,()=>settings.values());
    admin=await buildApp({dataDir:join(dataDir,'owner'),port:config.adminPort,production:true,hostingAdmin:true,sharedMembers:{pool,userId:'owner',userName:'站主',workspaceId:'hosting-owner',admin:true},resourceLimits:()=>settings.values()});
    await admin.app.listen({host:'127.0.0.1',port:config.adminPort});
    const source={providers:()=>admin!.store.providers(),getKey:(id:string)=>admin!.vault.get(id)};
    async function getTenant(user:HostingUser) {
      if(closing||!gateway?.accounts.get(user.id))throw new Error('Hosting account unavailable');
      let task=tenants.get(user.id);
      if(!task){
        task=(async()=>{
          const port=await availablePort();
          const app=await buildApp({port,dataDir:join(dataDir,'users',user.id),production:true,
            hosting:{userName:user.name,providers:()=>hostedProviders(source),getKey:source.getKey},
            sharedMembers:{pool,userId:user.id,userName:user.name,workspaceId:user.id},resourceLimits:()=>settings.values(),
            ...hostedGenerators(user.id,source,budget!,()=>!closing&&!!gateway?.accounts.get(user.id))});
          try{await app.app.listen({host:'127.0.0.1',port});return {...app,port};}
          catch(error){await app.app.close();throw error;}
        })();
        tenants.set(user.id,task);void task.catch(()=>tenants.delete(user.id));
      }
      const tenant=await task;return {port:tenant.port};
    }
    gateway=await buildHostingGateway({origin:config.origin,dataDir,getTenant,usage:user=>budget!.usage(user.id),settings:()=>settings.values()});
    // Only the real personal installation opts in automatically. Fixture/custom hosting directories remain isolated.
    importHostingProfiles(pool,dataDir,resolve(dataDir)===resolve('data-hosted')?resolve('data'):join(dataDir,'personal'),new Map(gateway.accounts.list().map(user=>[user.id,user.name])));
    await gateway.app.listen({host:'127.0.0.1',port:config.port});
    revocationTimer=setInterval(()=>{
      for(const [id,task] of tenants)if(!gateway!.accounts.get(id)){
        tenants.delete(id);const retiringTask=task.then(t=>t.app.close()).catch(()=>{});
        retiring.add(retiringTask);void retiringTask.finally(()=>retiring.delete(retiringTask));
      }
    },2000);revocationTimer.unref();
    return {config,dataDir,admin,gateway,budget,settings,pool,close};
  }catch(error){await close();throw error;}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{
    const host=await startHosting();
    console.log(`\n茶馆邀请制网站已启动（尚未建立公网隧道）。\n本机站长管理：http://127.0.0.1:${host.config.adminPort}/\n隧道仅连接：http://127.0.0.1:${host.config.port}/\n网站来源：${host.config.origin}\n请勿公开本机管理端口。按 Ctrl+C 停止。`);
    for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>void host.close().then(()=>process.exit(0)));
  }catch(error){console.error(error instanceof Error?error.message:'网站启动失败。');process.exitCode=1;}
}
