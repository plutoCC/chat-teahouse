import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { createServer } from 'node:net';
import { startHosting } from '../server/hosting/index.js';
import { PROVIDER_DEFAULTS } from '../server/providers.js';

async function freePort(){const server=createServer();await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const port=(server.address() as {port:number}).port;await new Promise<void>(done=>server.close(()=>done()));return port;}
test('real hosting apps isolate groups, notebooks, assets and csrf, hide owner data, and retain isolation after restart',async t=>{
  const root=resolve('.test-artifacts');mkdirSync(root,{recursive:true});const dataDir=mkdtempSync(join(root,'hosting-integration-'));
  const adminPort=await freePort(),port=await freePort(),origin='https://tea.example.test';
  const env={CHAT_TEA_HOST_DATA_DIR:dataDir,CHAT_TEA_PUBLIC_ORIGIN:origin,CHAT_TEA_ADMIN_PORT:String(adminPort),CHAT_TEA_HOST_PORT:String(port)};
  let host=await startHosting(env);t.after(()=>host.close());
  const ownerGroup=host.admin.store.createGroup('owner-private-marker','owner-secret-topic');
  host.admin.store.saveAvatarAsset('a'.repeat(64),Buffer.from('owner-private-image'));
  const a=host.gateway.accounts.add('Fixture A'),b=host.gateway.accounts.add('Fixture B');
  const headers=(id:string)=>({host:'tea.example.test',origin,cookie:'__Host-teahouse_session='+host.gateway.accounts.createSession(id).token});
  let ha=headers(a.user.id),hb=headers(b.user.id);
  const bootstrap=async(h:typeof ha)=>{const result=await host.gateway.app.inject({url:'/api/bootstrap',headers:h});assert.equal(result.statusCode,200,result.body);return result.json();};
  let ba=await bootstrap(ha),bb=await bootstrap(hb);
  assert.equal(ba.security.hosted,true);assert.ok(!JSON.stringify(ba).includes('owner-private'));
  assert.notEqual(ba.csrfToken,bb.csrfToken);assert.notEqual(ba.groups[0].id,bb.groups[0].id);
  const writeHeaders={...ha,'x-csrf-token':ba.csrfToken};
  const created=await host.gateway.app.inject({method:'POST',url:'/api/groups',headers:writeHeaders,payload:{name:'A private discussion',goal:'fixture-topic'}});assert.equal(created.statusCode,201,created.body);
  const group=created.json();
  const note=await host.gateway.app.inject({method:'POST',url:'/api/notebook',headers:writeHeaders,payload:{groupId:group.id,kind:'note',body:'A-private-notebook-marker'}});assert.equal(note.statusCode,201,note.body);
  assert.equal((await host.gateway.app.inject({url:'/api/groups/'+group.id,headers:hb})).statusCode,404);
  assert.equal((await host.gateway.app.inject({url:'/api/groups/'+ownerGroup.id,headers:ha})).statusCode,404);
  assert.equal((await host.gateway.app.inject({url:'/api/avatars/'+'a'.repeat(64),headers:ha})).statusCode,404);
  assert.ok(!(await host.gateway.app.inject({url:'/api/notebook',headers:hb})).body.includes('A-private'));
  assert.equal((await host.gateway.app.inject({method:'POST',url:'/api/groups',headers:{...hb,'x-csrf-token':ba.csrfToken},payload:{name:'csrf-forgery'}})).statusCode,403);
  for(const url of ['/api/providers/openai/billing','/api/providers/openai/subscription','/api/browser'])assert.equal((await host.gateway.app.inject({url,headers:ha})).statusCode,403,url);
  assert.equal((await host.gateway.app.inject({method:'POST',url:'/api/service/stop',headers:writeHeaders,payload:{}})).statusCode,403);
  await host.close();host=await startHosting(env);ha=headers(a.user.id);hb=headers(b.user.id);
  assert.ok((await bootstrap(ha)).groups.some((g:{id:string})=>g.id===group.id));
  assert.ok((await host.gateway.app.inject({url:'/api/notebook',headers:ha})).body.includes('A-private'));
  assert.ok(!(await host.gateway.app.inject({url:'/api/notebook',headers:hb})).body.includes('A-private'));
  host.gateway.accounts.revoke(a.user.id);
  assert.equal((await host.gateway.app.inject({url:'/api/bootstrap',headers:ha})).statusCode,401);
  assert.equal((await host.gateway.app.inject({url:'/api/bootstrap',headers:hb})).statusCode,200);
});

test('revoking an account cancels its in-flight model and repeated close awaits the same shutdown',async t=>{
  const root=resolve('.test-artifacts');mkdirSync(root,{recursive:true});const dataDir=mkdtempSync(join(root,'hosting-revoke-'));
  const host=await startHosting({CHAT_TEA_HOST_DATA_DIR:dataDir,CHAT_TEA_PUBLIC_ORIGIN:'https://tea.example.test',CHAT_TEA_ADMIN_PORT:String(await freePort()),CHAT_TEA_HOST_PORT:String(await freePort())});
  t.after(()=>host.close());
  const provider={...PROVIDER_DEFAULTS.find(p=>p.id==='deepseek')!,enabled:true,hasKey:true,inputPrice:1,outputPrice:2};
  host.admin.store.saveProvider(provider);host.admin.vault.set('deepseek','fixture-not-a-real-key');
  const account=host.gateway.accounts.add('Revocation fixture'),session=host.gateway.accounts.createSession(account.user.id);
  const basic={host:'tea.example.test',origin:'https://tea.example.test',cookie:'__Host-teahouse_session='+session.token};
  const boot=(await host.gateway.app.inject({url:'/api/bootstrap',headers:basic})).json(),headers={...basic,'x-csrf-token':boot.csrfToken};
  const member={id:crypto.randomUUID(),name:'测试讨论者',role:'',avatar:'茶',color:'#34705a',enabled:true,channel:'api',providerId:'deepseek',model:provider.model};
  const created=await host.gateway.app.inject({method:'POST',url:'/api/groups',headers,payload:{name:'Revocation test',goal:'Discuss a synthetic fixture.',participants:[member]}});assert.equal(created.statusCode,201,created.body);
  let calls=0,aborted=false;const original=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{
    assert.equal(String(url),'https://api.deepseek.com/chat/completions');calls++;
    return new Promise<Response>((_resolve,reject)=>{const signal=init!.signal!;const abort=()=>{aborted=true;reject(signal.reason);};if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});});
  };
  try{
    const started=await host.gateway.app.inject({method:'POST',url:`/api/groups/${created.json().id}/free/start`,headers,payload:{}});assert.equal(started.statusCode,201,started.body);
    const wait=async(check:()=>boolean)=>{const deadline=Date.now()+8000;while(!check()){if(Date.now()>deadline)throw new Error('Revocation test timed out');await new Promise(r=>setTimeout(r,20));}};
    await wait(()=>calls===1);host.gateway.accounts.revoke(account.user.id);await wait(()=>aborted);
    assert.equal(calls,1);assert.equal(host.budget.usage(account.user.id).calls,1);
    const first=host.close(),second=host.close();assert.equal(first,second);await first;
  }finally{globalThis.fetch=original;}
});
