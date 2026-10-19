import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, realpathSync, lstatSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { buildApp } from '../../server/app.js';
import { fixtureModelCatalog } from './model-list-fixture.js';

test('provider toggle persists immediately, isolates drafts, reports rejection and survives reopening and restart', {timeout:60000}, async t => {
  const root=resolve('.test-artifacts');mkdirSync(root,{recursive:true});const dataDir=mkdtempSync(join(root,'provider-toggle-'));
  const port=await new Promise<number>((done,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const n=(s.address() as {port:number}).port;s.close(()=>done(n));});});
  const url=`http://127.0.0.1:${port}`,host=`127.0.0.1:${port}`;
  let calls=0;
  const options={dataDir,port,production:true,modelCatalogFetcher:fixtureModelCatalog,nativeGenerate:async()=>{
    calls++;
    return {blocks:[{type:'tool-call' as const,id:ToolCallId(crypto.randomUUID()),name:'wait_for_messages',arguments:'{"seconds":0}'}],inputTokens:1,outputTokens:1};
  }};
  let runtime=await buildApp(options);
  const browser=await chromium.launch({channel:process.env.CHAT_TEA_BROWSER_CHANNEL??'msedge',headless:true,chromiumSandbox:true});
  t.after(async()=>{await browser.close();await runtime.app.close();assert.equal(lstatSync(dataDir).isSymbolicLink(),false);const target=realpathSync(dataDir);assert.equal(dirname(target),realpathSync(root));assert.ok(basename(target).startsWith('provider-toggle-'));rmSync(target,{recursive:true,force:true});});
  const boot=(await runtime.app.inject({url:'/api/bootstrap',headers:{host}})).json();
  const headers={host,origin:url,'x-csrf-token':boot.csrfToken};
  assert.equal((await runtime.app.inject({method:'PUT',url:'/api/providers/openai',headers,payload:{apiKey:'test-only-not-a-real-key',model:'fixture-model',inputPrice:1,outputPrice:1}})).statusCode,200);
  const group=boot.groups[0];
  const participant={...group.participants[0],profileId:undefined,profileRevision:undefined,providerId:'openai',model:'fixture-model',name:'GPT 本地模拟'};
  assert.equal((await runtime.app.inject({method:'PATCH',url:`/api/groups/${group.id}`,headers,payload:{goal:'只验证启用状态，不调用外部模型',participants:[participant],conversationMode:'free'}})).statusCode,200);
  const initiallyRejected=await runtime.app.inject({method:'POST',url:`/api/groups/${group.id}/free/start`,headers,payload:{}});
  assert.equal(initiallyRejected.statusCode,400);assert.match(initiallyRejected.json().error,/连接未启用/);
  await runtime.app.listen({host:'127.0.0.1',port});
  const page=await browser.newPage({viewport:{width:1365,height:900}});const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const updates:unknown[]=[];page.on('request',request=>{if(request.method()==='PUT'&&request.url()===url+'/api/providers/openai')updates.push(request.postDataJSON());});
  await page.goto(url);await page.getByRole('button',{name:'模型连接',exact:true}).click();
  const toggle=page.getByRole('checkbox',{name:'启用此连接',exact:true});assert.equal(await toggle.isChecked(),false);
  // The switch must save just its own field, without committing a key/model draft.
  await page.getByLabel('默认模型',{exact:true}).selectOption('unsaved-draft');
  await page.getByLabel(/^API Key/).fill('unsaved-key-never-sent');
  await toggle.click();await page.getByText('连接已启用并保存',{exact:true}).waitFor();
  assert.equal(await toggle.isChecked(),true);assert.deepEqual(updates,[{enabled:true}]);
  assert.equal(runtime.store.providers().find(p=>p.id==='openai')!.enabled,true);
  assert.equal(runtime.store.providers().find(p=>p.id==='openai')!.model,'fixture-model');
  assert.equal(runtime.vault.get('openai'),'test-only-not-a-real-key');
  // Closing without pressing Save must retain the enabled flag.
  await page.getByRole('button',{name:'关闭对话框',exact:true}).click();
  await page.getByRole('button',{name:'模型连接',exact:true}).click();assert.equal(await toggle.isChecked(),true);
  assert.equal(await page.getByLabel('默认模型',{exact:true}).inputValue(),'fixture-model');
  await page.getByRole('navigation',{name:'模型供应商'}).getByRole('button',{name:/Claude/}).click();
  await page.getByRole('navigation',{name:'模型供应商'}).getByRole('button',{name:/OpenAI/}).click();assert.equal(await toggle.isChecked(),true);
  // Real chat admission now observes the persisted flag; generation is a local fixture.
  const started=await runtime.app.inject({method:'POST',url:`/api/groups/${group.id}/free/start`,headers,payload:{}});assert.equal(started.statusCode,201);
  await toggle.click();await page.getByRole('alert').filter({hasText:'请停止正在运行的讨论'}).waitFor();
  assert.equal(await toggle.isChecked(),true);assert.equal(runtime.store.providers().find(p=>p.id==='openai')!.enabled,true);
  const deadline=Date.now()+5000;while(!calls){assert.ok(Date.now()<deadline);await new Promise(done=>setTimeout(done,20));}
  await runtime.app.inject({method:'POST',url:`/api/groups/${group.id}/free/pause`,headers,payload:{}});await runtime.roomEngine.settle(group.id);
  await toggle.click();await page.getByText('连接已停用并保存',{exact:true}).waitFor();assert.equal(await toggle.isChecked(),false);
  await page.reload();await page.getByRole('button',{name:'模型连接',exact:true}).click();assert.equal(await toggle.isChecked(),false);
  await toggle.click();await page.getByText('连接已启用并保存',{exact:true}).waitFor();
  await runtime.app.close();runtime=await buildApp(options);await runtime.app.listen({host:'127.0.0.1',port});
  await page.reload();await page.getByRole('button',{name:'模型连接',exact:true}).click();assert.equal(await toggle.isChecked(),true);
  assert.equal(runtime.store.providers().find(p=>p.id==='openai')!.enabled,true);assert.deepEqual(errors,[]);
  mkdirSync(resolve('output/playwright'),{recursive:true});await page.screenshot({path:resolve('output/playwright/provider-toggle-persisted.png')});
});
