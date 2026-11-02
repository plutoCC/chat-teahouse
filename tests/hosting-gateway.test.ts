import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,realpathSync,lstatSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {dirname,basename,join,resolve} from 'node:path';
import {createServer,request as httpRequest,type IncomingMessage,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import test,{type TestContext} from 'node:test';
import {HostingAccounts,HostingAccountError} from '../server/hosting/accounts.js';
import {buildHostingGateway} from '../server/hosting/gateway.js';

const origin='https://tea.example.test';
const headers={host:'tea.example.test',origin};
function temp(t:TestContext){
  const base=resolve('.test-artifacts');mkdirSync(base,{recursive:true});const root=realpathSync(base),dir=mkdtempSync(join(root,'hosting-test-'));
  t.after(()=>{const target=realpathSync(dir);assert.equal(dirname(target),root);assert.ok(basename(target).startsWith('hosting-test-'));assert.equal(lstatSync(dir).isSymbolicLink(),false);rmSync(target,{recursive:true,force:true});});return dir;
}
async function start(server:Server){await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});return (server.address() as AddressInfo).port;}
async function stop(server:Server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
function login(runtime:ReturnType<typeof buildHostingGateway>,code:string){return runtime.app.inject({method:'POST',url:'/_host/login',headers,payload:{code}});}
async function access(runtime:ReturnType<typeof buildHostingGateway>,name='测试成员'){
  const {user,code}=runtime.accounts.add(name),result=await login(runtime,code);assert.equal(result.statusCode,200,result.body);
  const value=String(result.headers['set-cookie']);assert.match(value,/HttpOnly; Secure; SameSite=Strict/);return {user,code,cookie:value.split(';')[0]};
}

test('host accounts store only hashes, cap users and sessions, expire and revoke across database connections',t=>{
  const dir=temp(t);let clock=1_800_000_000_000;
  const a=new HostingAccounts(dir,()=>clock),b=new HostingAccounts(dir,()=>clock);
  try{
    const first=a.add('成员一');assert.equal(first.code.length,43);assert.equal(b.authenticateCode(first.code)?.id,first.user.id);
    const sessions=Array.from({length:8},()=>a.createSession(first.user.id));assert.throws(()=>a.createSession(first.user.id),HostingAccountError);
    assert.equal(b.session(sessions[0].token)?.name,'成员一');assert.equal(a.authenticateCode('incorrect'),undefined);
    for(const file of ['accounts.db','accounts.db-wal'])if(existsSync(join(dir,file))){const bytes=readFileSync(join(dir,file));assert.equal(bytes.includes(Buffer.from(first.code)),false);assert.equal(bytes.includes(Buffer.from(sessions[0].token)),false);}
    for(let i=1;i<10;i++)a.add('成员'+i);assert.throws(()=>a.add('超额成员'),HostingAccountError);
    clock+=7*24*60*60*1000;assert.equal(b.session(sessions[0].token),undefined);
    const renewed=a.createSession(first.user.id);assert.ok(b.session(renewed.token));assert.ok(b.revoke(first.user.id));assert.equal(a.session(renewed.token),undefined);assert.equal(a.authenticateCode(first.code),undefined);assert.equal(a.get(first.user.id),undefined);
    assert.equal(a.list().length,10);assert.ok(a.list().find(u=>u.id===first.user.id)?.revokedAt);assert.ok(a.add('新成员').user.id);
  }finally{b.close();a.close();}
});

test('gateway requires exact host/origin and sessions for API, assets and usage',async t=>{
  const dir=temp(t);let calls=0;
  const runtime=buildHostingGateway({dataDir:dir,origin,getTenant:async()=>{calls++;throw Error('private detail');}});
  try{
    let r=await runtime.app.inject({url:'/',headers:{host:'tea.example.test'}});assert.equal(r.statusCode,200);assert.match(r.body,/邀请制/);assert.match(String(r.headers['content-security-policy']),/script-src 'self';/);
    r=await runtime.app.inject({url:'/assets/app.js',headers:{host:'tea.example.test'}});assert.equal(r.statusCode,200);assert.match(r.body,/邀请制/);
    for(const url of ['/api/bootstrap','/api/events','/_host/session'])assert.equal((await runtime.app.inject({url,headers})).statusCode,401);
    const invited=runtime.accounts.add('邀请成员');
    for(const fake of [{host:'127.0.0.1:4317',origin},{host:'evil.test',origin,'x-forwarded-host':'tea.example.test'},{host:'tea.example.test',origin:'https://evil.test'},{host:'tea.example.test'},{...headers,'sec-fetch-site':'cross-site'}])assert.equal((await runtime.app.inject({method:'POST',url:'/_host/login',headers:fake,payload:{code:invited.code}})).statusCode,403);
    for(const url of ['/api/%62ootstrap','//api/bootstrap','/api/%2fbootstrap'])assert.equal((await runtime.app.inject({url,headers})).statusCode,400,url);
    assert.equal(calls,0);
    assert.equal((await login(runtime,invited.code)).statusCode,200);
  }finally{await runtime.app.close();}
});

test('invalid login flood cannot exhaust valid-code admission and failure budget resets',async t=>{
  const dir=temp(t);let clock=1_800_000_000_000,calls=0;
  const runtime=buildHostingGateway({dataDir:dir,origin,now:()=>clock,getTenant:async()=>{calls++;return {port:80};}});
  try{
    const a=runtime.accounts.add('甲'),b=runtime.accounts.add('乙');
    for(let i=0;i<60;i++){
      const result=await runtime.app.inject({method:'POST',url:'/_host/login',headers:{...headers,'x-forwarded-for':`192.0.2.${i+1}`,'x-real-ip':`198.51.100.${i+1}`},payload:{code:String(i).padStart(43,'x')}});
      assert.equal(result.statusCode,i<30?401:429);assert.equal(result.headers['set-cookie'],undefined);
      if(i>=30)assert.equal(result.headers['retry-after'],'60');
    }
    assert.equal((await login(runtime,a.code)).statusCode,200);
    assert.equal((await login(runtime,b.code)).statusCode,200);
    clock+=59999;
    const limited=await login(runtime,'not-the-code');assert.equal(limited.statusCode,429);assert.equal(limited.headers['retry-after'],'1');
    clock++;assert.equal((await login(runtime,'not-the-code')).statusCode,401);
    assert.equal(calls,0);
  }finally{await runtime.app.close();}
});

test('verified login churn is limited per account without deleting its existing session and resets at the window boundary',async t=>{
  const dir=temp(t);let clock=1_800_000_000_000;
  const runtime=buildHostingGateway({dataDir:dir,origin,now:()=>clock,getTenant:async()=>({port:80})});
  try{
    const a=runtime.accounts.add('甲'),b=runtime.accounts.add('乙');let currentCookie='';
    for(let i=0;i<30;i++){
      const result=await runtime.app.inject({method:'POST',url:'/_host/login',headers:{...headers,cookie:currentCookie},payload:{code:a.code}});
      assert.equal(result.statusCode,200,result.body);currentCookie=String(result.headers['set-cookie']).split(';')[0];
    }
    const limited=await runtime.app.inject({method:'POST',url:'/_host/login',headers:{...headers,cookie:currentCookie,'x-forwarded-for':'203.0.113.1'},payload:{code:a.code}});
    assert.equal(limited.statusCode,429);assert.equal(limited.headers['set-cookie'],undefined);assert.equal(limited.headers['retry-after'],'60');
    assert.equal((await runtime.app.inject({url:'/_host/session',headers:{...headers,cookie:currentCookie}})).statusCode,200);
    assert.equal((await login(runtime,b.code)).statusCode,200);
    assert.equal((await login(runtime,'not-the-code')).statusCode,401);
    clock+=59999;assert.equal((await login(runtime,a.code)).statusCode,429);
    clock++;assert.equal((await login(runtime,a.code)).statusCode,200);
  }finally{await runtime.app.close();}
});

test('malformed and oversized login bodies do not spend account admission and only bounded valid bodies are verified',async t=>{
  const dir=temp(t),runtime=buildHostingGateway({dataDir:dir,origin,getTenant:async()=>({port:80})});
  try{
    const invited=runtime.accounts.add('邀请成员');let verifications=0;
    const authenticate=runtime.accounts.authenticateCode.bind(runtime.accounts);
    runtime.accounts.authenticateCode=code=>{verifications++;return authenticate(code);};
    for(const payload of ['{','null','[]','{}','{"code":42}',JSON.stringify({code:invited.code,extra:true})]){
      const result=await runtime.app.inject({method:'POST',url:'/_host/login',headers:{...headers,'content-type':'application/json'},payload});
      assert.equal(result.statusCode,400,payload);assert.equal(result.headers['set-cookie'],undefined);
    }
    const validBody=JSON.stringify({code:invited.code});
    const oversized=await runtime.app.inject({method:'POST',url:'/_host/login',headers:{...headers,'content-type':'application/json'},payload:validBody.padEnd(4097,' ')});
    assert.equal(oversized.statusCode,413);assert.equal(verifications,0);
    for(let i=0;i<30;i++)await runtime.app.inject({method:'POST',url:'/_host/login',headers,payload:{code:false}});
    const bounded=await runtime.app.inject({method:'POST',url:'/_host/login',headers:{...headers,'content-type':'application/json'},payload:validBody.padEnd(4096,' ')});
    assert.equal(bounded.statusCode,200);assert.equal(verifications,1);
  }finally{await runtime.app.close();}
});

test('login window capacity survives repeated account replacement without evicting active-account limits',async t=>{
  const dir=temp(t),runtime=buildHostingGateway({dataDir:dir,origin,getTenant:async()=>({port:80})});
  try{
    const retained=runtime.accounts.add('保留成员');let currentCookie='';
    for(let i=0;i<30;i++){
      const result=await runtime.app.inject({method:'POST',url:'/_host/login',headers:{...headers,cookie:currentCookie},payload:{code:retained.code}});
      assert.equal(result.statusCode,200);currentCookie=String(result.headers['set-cookie']).split(';')[0];
    }
    for(let i=0;i<24;i++){
      const account=runtime.accounts.add('轮换成员'+i);assert.equal((await login(runtime,account.code)).statusCode,200);
      runtime.accounts.revoke(account.user.id);assert.equal((await login(runtime,account.code)).statusCode,401);
      assert.equal((await login(runtime,retained.code)).statusCode,429);
    }
    for(let i=0;i<9;i++){const account=runtime.accounts.add('活跃成员'+i);assert.equal((await login(runtime,account.code)).statusCode,200);}
    assert.equal((await login(runtime,retained.code)).statusCode,429);
  }finally{await runtime.app.close();}
});

test('gateway proxies only the authenticated tenant with vetted headers and blocks redirects and upstream cookies',async t=>{
  const dir=temp(t),servers:Server[]=[];const ports=new Map<string,number>();
  const runtime=buildHostingGateway({dataDir:dir,origin,getTenant:async user=>{
    if(!ports.has(user.id)){
      const server=createServer((req,res)=>{let data='';req.on('data',c=>{data+=c;});req.on('end',()=>{
        if(req.url==='/redirect'){res.writeHead(302,{location:'https://evil.test', 'set-cookie':'stolen=1'});res.end();return;}
        res.writeHead(200,{'content-type':'application/json','set-cookie':'stolen=1','access-control-allow-origin':'*'});res.end(JSON.stringify({owner:user.id,url:req.url,headers:req.headers,data}));
      });});servers.push(server);ports.set(user.id,await start(server));
    }
    return {port:ports.get(user.id)!};
  },usage:user=>({owner:user.id,calls:3})});
  try{
    const a=await access(runtime,'甲'),b=await access(runtime,'乙');
    for(const account of [a,b]){
      const result=await runtime.app.inject({method:'POST',url:'/api/groups?view=1',headers:{...headers,cookie:account.cookie,'x-csrf-token':'local-csrf',authorization:'Bearer unwanted','x-forwarded-host':'evil.test','x-hosted-user':b.user.id},payload:{message:'演示'}});
      assert.equal(result.statusCode,200,result.body);const data=result.json();assert.equal(data.owner,account.user.id);assert.equal(data.headers['x-csrf-token'],'local-csrf');assert.equal(data.headers.host,`127.0.0.1:${ports.get(account.user.id)}`);assert.equal(data.headers.origin,`http://127.0.0.1:${ports.get(account.user.id)}`);
      for(const name of ['cookie','authorization','x-forwarded-host','x-hosted-user'])assert.equal(data.headers[name],undefined,name);
      assert.deepEqual(JSON.parse(data.data),{message:'演示'});assert.equal(result.headers['set-cookie'],undefined);assert.equal(result.headers['access-control-allow-origin'],undefined);
      const session=await runtime.app.inject({url:'/_host/session',headers:{...headers,cookie:account.cookie}});assert.deepEqual(session.json(),{user:{id:account.user.id,name:account.user.name},usage:{owner:account.user.id,calls:3}});
    }
    const redirect=await runtime.app.inject({url:'/redirect',headers:{...headers,cookie:a.cookie}});assert.equal(redirect.statusCode,502);assert.equal(redirect.headers.location,undefined);
    const logout=await runtime.app.inject({method:'POST',url:'/_host/logout',headers:{...headers,cookie:a.cookie}});assert.equal(logout.statusCode,200);assert.match(String(logout.headers['set-cookie']),/Max-Age=0/);
    assert.equal((await runtime.app.inject({url:'/api/bootstrap',headers:{...headers,cookie:a.cookie}})).statusCode,401);
    assert.equal((await runtime.app.inject({url:'/api/bootstrap',headers:{...headers,cookie:b.cookie}})).statusCode,200);
  }finally{await runtime.app.close();await Promise.all(servers.map(stop));}
});

async function openStream(port:number,cookie:string){
  return new Promise<IncomingMessage>((yes,no)=>{const req=httpRequest({host:'127.0.0.1',port,path:'/api/events',headers:{...headers,cookie}},res=>yes(res));req.once('error',no);req.end();});
}
test('gateway limits streams per user and disconnects existing streams after local revocation', {timeout:15000},async t=>{
  const dir=temp(t);const streams:IncomingMessage[]=[];
  const tenant=createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: fixture\n\n');});const tenantPort=await start(tenant);
  const runtime=buildHostingGateway({dataDir:dir,origin,sessionCheckMs:30,getTenant:async()=>({port:tenantPort})});
  try{
    const a=await access(runtime,'甲'),b=await access(runtime,'乙');
    await runtime.app.listen({host:'127.0.0.1',port:0});const port=(runtime.app.server.address() as AddressInfo).port;
    for(let i=0;i<4;i++){const stream=await openStream(port,a.cookie);streams.push(stream);assert.equal(stream.statusCode,200);stream.resume();}
    const capped=await openStream(port,a.cookie);streams.push(capped);assert.equal(capped.statusCode,429);capped.resume();
    const other=await openStream(port,b.cookie);streams.push(other);assert.equal(other.statusCode,200);other.resume();
    const closed=Promise.all(streams.slice(0,4).map(stream=>new Promise<void>(resolve=>stream.once('close',()=>resolve()))));
    const cli=new HostingAccounts(dir);try{cli.revoke(a.user.id);}finally{cli.close();}
    await closed;assert.equal(other.destroyed,false);
    const denied=await openStream(port,a.cookie);streams.push(denied);assert.equal(denied.statusCode,401);denied.resume();
  }finally{for(const stream of streams)stream.destroy();await runtime.app.close();await stop(tenant);}
});

test('gateway rejects bad tenant ports and revocation while waiting for tenant start',async t=>{
  const dir=temp(t);let userId='';
  const runtime=buildHostingGateway({dataDir:dir,origin,getTenant:async()=>{runtime.accounts.revoke(userId);return {port:4318};}});
  try{
    const a=await access(runtime);userId=a.user.id;
    assert.equal((await runtime.app.inject({url:'/api/bootstrap',headers:{...headers,cookie:a.cookie}})).statusCode,401);
  }finally{await runtime.app.close();}
  for(const invalidOrigin of ['http://tea.example.test','https://tea.example.test/','https://user:pass@tea.example.test','https://tea.example.test/path'])assert.throws(()=>buildHostingGateway({dataDir:dir,origin:invalidOrigin,getTenant:async()=>({port:80})}));
  const invalid=buildHostingGateway({dataDir:dir,origin,getTenant:async()=>({port:80})});
  try{const a=await access(invalid);assert.equal((await invalid.app.inject({url:'/api/bootstrap',headers:{...headers,cookie:a.cookie}})).statusCode,503);}finally{await invalid.app.close();}
});

test('raw HTTP ambiguous paths cannot reach any tenant',async t=>{
  const dir=temp(t);let calls=0;
  const runtime=buildHostingGateway({dataDir:dir,origin,getTenant:async()=>{calls++;return {port:4318};}});
  try{
    const a=await access(runtime);await runtime.app.listen({host:'127.0.0.1',port:0});const port=(runtime.app.server.address() as AddressInfo).port;
    for(const path of ['/api/../bootstrap','/api/%2e%2e/bootstrap','http://127.0.0.1:99/api','/api\\bootstrap']){
      const status=await new Promise<number|undefined>((yes,no)=>{const req=httpRequest({host:'127.0.0.1',port,path,headers:{...headers,cookie:a.cookie}},res=>{res.resume();res.on('end',()=>yes(res.statusCode));});req.once('error',no);req.end();});
      assert.equal(status,400,path);
    }
    assert.equal(calls,0);
  }finally{await runtime.app.close();}
});

test('gateway bounds pending tenant requests and keeps logout available during a cold start', {timeout:5000},async t=>{
  const dir=temp(t);let release!:()=>void,calls=0;
  const ready=new Promise<void>(resolve=>{release=resolve;});
  const runtime=buildHostingGateway({dataDir:dir,origin,getTenant:async()=>{calls++;await ready;return {port:80};}});
  const requests:Promise<unknown>[]=[];
  try{
    const a=await access(runtime);
    for(let i=0;i<8;i++)requests.push(runtime.app.inject({url:'/api/bootstrap',headers:{...headers,cookie:a.cookie}}).then(result=>result.statusCode));
    for(let i=0;i<100&&calls<8;i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(calls,8);
    const ninth=await runtime.app.inject({url:'/api/bootstrap',headers:{...headers,cookie:a.cookie}});assert.equal(ninth.statusCode,429);
    const logout=await runtime.app.inject({method:'POST',url:'/_host/logout',headers:{...headers,cookie:a.cookie}});assert.equal(logout.statusCode,200);
    release();await Promise.all(requests);
  }finally{release();await Promise.all(requests);await runtime.app.close();}
});
