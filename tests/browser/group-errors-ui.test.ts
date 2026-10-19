import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, realpathSync, lstatSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { buildApp } from '../../server/app.js';
import { fixtureModelCatalog } from './model-list-fixture.js';
import { classifyProviderFailure } from '../../server/model-errors.js';

test('group UI explains exhausted credit and publishes a corrected peer contribution, with no extra quota attempts', {timeout:60000},async t=>{
  const root=resolve('.test-artifacts');mkdirSync(root,{recursive:true});const dataDir=mkdtempSync(join(root,'group-errors-ui-'));
  const port=await new Promise<number>((done,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const n=(server.address() as {port:number}).port;server.close(()=>done(n));});});
  let gptCalls=0,peerCalls=0;
  const runtime=await buildApp({dataDir,port,production:true,modelCatalogFetcher:fixtureModelCatalog,nativeGenerate:async options=>{
    if(options.model==='fixture-quota'){gptCalls++;throw classifyProviderFailure(429,{error:{code:'credit_balance_exhausted',message:'MUST-NOT-LEAK'}},'openai');}
    peerCalls++;
    return {blocks:[{type:'tool-call',id:ToolCallId(crypto.randomUUID()),name:'post_message',arguments:JSON.stringify({content:peerCalls===1?'【本地模拟】海是屏障。\n你想往哪个方向走？':'【本地模拟 · 非真实模型】我认为海既是屏障，也是连接。航海技术改变了跨海成本，港口网络又改变了人们对距离的理解。'})}],inputTokens:30,outputTokens:20};
  }});
  t.after(async()=>{await runtime.app.close();assert.equal(lstatSync(dataDir).isSymbolicLink(),false);const target=realpathSync(dataDir);assert.equal(dirname(target),realpathSync(root));assert.ok(basename(target).startsWith('group-errors-ui-'));rmSync(target,{recursive:true,force:true});});
  const host=`127.0.0.1:${port}`,boot=(await runtime.app.inject({url:'/api/bootstrap',headers:{host}})).json();
  const headers={host,origin:`http://${host}`,'x-csrf-token':boot.csrfToken};
  await runtime.app.inject({method:'PUT',url:'/api/providers/openai',headers,payload:{enabled:true,apiKey:'local-fixture-no-network',inputPrice:1,outputPrice:1}});
  const group=runtime.store.groups()[0];group.name='群聊修复 · 本地模拟验收';group.goal='谈一谈海';group.conversationMode='free';
  group.participants=group.participants.slice(0,2).map((p,i)=>({...p,providerId:'openai',model:i?'fixture-peer':'fixture-quota',name:i?'讨论成员（模拟）':'GPT（额度错误模拟）',enabled:true,identityMode:'native'}));
  group.freeSettings={messageGapMin:0,messageGapMax:0,readingCharsPerSecond:0,typingGraceSeconds:0,quietSeconds:0,cooldownMin:1,cooldownMax:1,concurrency:1,maxMinutes:5,wakeProbability:1,respondToAI:true};group.settings={...group.settings,maxCalls:10,maxTotalTokens:1000000,budgetUSD:0};runtime.store.saveGroup(group);
  await runtime.app.listen({host:'127.0.0.1',port});
  const browser=await chromium.launch({channel:process.env.CHAT_TEA_BROWSER_CHANNEL??'msedge',headless:true,chromiumSandbox:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1365,height:950}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
  await page.goto(`http://${host}/`);await page.getByRole('button',{name:'开始讨论',exact:true}).click();
  await page.getByText(/OpenAI API 预付余额已耗尽/).waitFor();
  await page.getByText(/当前可正常参与的 AI 少于两位/).waitFor();
  await page.getByText('【本地模拟 · 非真实模型】我认为海既是屏障，也是连接。航海技术改变了跨海成本，港口网络又改变了人们对距离的理解。',{exact:true}).waitFor();
  assert.equal(await page.getByText('你想往哪个方向走？',{exact:false}).count(),0);assert.equal(gptCalls,1);assert.equal(peerCalls,2);
  assert.equal(runtime.store.freeSession(group.id)!.uncertainCalls,0);assert.doesNotMatch(await page.locator('body').innerText(),/MUST-NOT-LEAK/);
  mkdirSync(resolve('output/playwright'),{recursive:true});await page.screenshot({path:resolve('output/playwright/group-errors-desktop.png')});
  await page.getByRole('button',{name:'暂停讨论',exact:true}).click();await page.getByRole('button',{name:'继续讨论',exact:true}).waitFor();
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:resolve('output/playwright/group-errors-mobile.png')});assert.deepEqual(errors,[]);
});
