import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, realpathSync, lstatSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { createServer } from 'node:net';
import { buildApp } from '../server/app.js';

test('a stalled provider returns a 12-second diagnostic over real HTTP instead of the local 10-second socket disconnect', { timeout: 25000 }, async t => {
  const root=resolve('.test-artifacts'); mkdirSync(root,{recursive:true}); const dataDir=mkdtempSync(join(root,'provider-connection-'));
  const port=await new Promise<number>((done,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const n=(s.address() as {port:number}).port;s.close(()=>done(n));});});
  const runtime=await buildApp({dataDir,port,production:true,serveUI:false});
  const original=globalThis.fetch;
  t.after(async()=>{globalThis.fetch=original;await runtime.app.close();assert.equal(lstatSync(dataDir).isSymbolicLink(),false);const target=realpathSync(dataDir);assert.equal(dirname(target),realpathSync(root));assert.ok(basename(target).startsWith('provider-connection-'));rmSync(target,{recursive:true,force:true});});
  await runtime.app.listen({host:'127.0.0.1',port});
  const url=`http://127.0.0.1:${port}`,host=`127.0.0.1:${port}`;
  const boot=(await runtime.app.inject({url:'/api/bootstrap',headers:{host}})).json();
  const headers={host,origin:url,'x-csrf-token':boot.csrfToken,'Content-Type':'application/json'};
  assert.equal((await runtime.app.inject({method:'PUT',url:'/api/providers/openai',headers,payload:{apiKey:'fake-key-never-sent'}})).statusCode,200);
  let called=false;
  globalThis.fetch=async(input,init)=>{
    if(String(input)!=='https://api.openai.com/v1/models')throw new Error('unexpected upstream');
    assert.equal(init?.method,'GET');assert.equal(init?.body,undefined);called=true;
    return new Promise((_done,reject)=>init!.signal!.addEventListener('abort',()=>reject(init!.signal!.reason),{once:true}));
  };
  const started=Date.now();
  const response=await original(url+'/api/providers/openai/test',{method:'POST',headers,body:'{}',signal:AbortSignal.timeout(18000)});
  assert.equal(response.status,200);const result=await response.json() as {ok:boolean;message:string};
  assert.equal(result.ok,false);assert.match(result.message,/12 秒/);assert.doesNotMatch(result.message,/120 秒|fake-key/);
  assert.ok(called);assert.ok(Date.now()-started>=11000);
});
