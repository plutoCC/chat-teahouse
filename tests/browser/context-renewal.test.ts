import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {createServer} from 'node:net';
import {chromium,type Browser} from 'playwright-core';
import {buildApp} from '../../server/app.js';

test('budget-exhausted room offers an explicit renewal that preserves member sessions and history', {timeout:60000},async t=>{
  const root=resolve('.test-artifacts');mkdirSync(root,{recursive:true});const dataDir=mkdtempSync(join(root,'renewal-ui-'));
  const port=await new Promise<number>((done,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const n=(s.address() as {port:number}).port;s.close(()=>done(n));});});
  const runtime=await buildApp({dataDir,port,production:true,participantRuntime:{run:async wake=>{wake.read();wake.wait(0,'测试等待');},shutdown:async()=>{}}});let browser:Browser|undefined;
  t.after(async()=>{await browser?.close();await runtime.app.close();assert.equal(dirname(realpathSync(dataDir)),realpathSync(root));rmSync(dataDir,{recursive:true,force:true});});
  const group=runtime.store.groups()[0];group.participants=group.participants.slice(0,1);group.goal='本地虚构续开测试';runtime.store.saveGroup(group);
  runtime.roomEngine.start(group.id);await new Promise(r=>setTimeout(r,50));await runtime.roomEngine.settle(group.id);runtime.roomEngine.pause(group.id);
  runtime.store.mutateFree(group.id,s=>{s.status='limit';s.error='达到本场模型调用次数上限。';});const original=runtime.store.freeSession(group.id)!;
  await runtime.app.listen({host:'127.0.0.1',port});browser=await chromium.launch({channel:process.env.CHAT_TEA_BROWSER_CHANNEL??'msedge',headless:true,chromiumSandbox:true});
  const page=await browser.newPage();await page.goto(`http://127.0.0.1:${port}`);
  const button=page.getByRole('button',{name:'续开讨论（保留上下文）',exact:true});await button.waitFor();assert.match(await button.getAttribute('title')??'',/新的本场预算/);
  const response=page.waitForResponse(r=>r.url().endsWith('/free/start')&&r.request().method()==='POST');await button.click();const result=await response;
  assert.equal(result.status(),201);assert.equal(result.request().postDataJSON().renew,true);
  const renewed=runtime.store.freeSession(group.id)!;assert.notEqual(renewed.id,original.id);assert.equal(renewed.members[0].sessionId,original.members[0].sessionId);assert.equal(renewed.deadline,undefined);
  await page.getByRole('button',{name:'暂停讨论',exact:true}).waitFor();
});

test('pause UI drains a speech and duration settings are absent, including legacy expired rooms', {timeout:60000},async t=>{
  const root=resolve('.test-artifacts');mkdirSync(root,{recursive:true});const dataDir=mkdtempSync(join(root,'pause-ui-'));
  const port=await new Promise<number>((done,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const n=(s.address() as {port:number}).port;s.close(()=>done(n));});});
  let speak=false,calls=0;
  const runtime=await buildApp({dataDir,port,production:true,participantRuntime:{run:async wake=>{calls++;wake.read();if(speak)await wake.post('甲'.repeat(60)+'\n\n第二段结束。',undefined,'ui-speech');else wake.wait(0);},shutdown:async()=>{}}});let browser:Browser|undefined;
  t.after(async()=>{await browser?.close();await runtime.app.close();assert.equal(dirname(realpathSync(dataDir)),realpathSync(root));rmSync(dataDir,{recursive:true,force:true});});
  const group=runtime.store.groups()[0];group.participants=group.participants.slice(0,1);group.goal='本地虚构连发验收';group.freeSettings={...group.freeSettings!,messageStyle:'segmented',messageGapMin:0,messageGapMax:0,readingCharsPerSecond:20};runtime.store.saveGroup(group);
  runtime.roomEngine.start(group.id);await new Promise(r=>setTimeout(r,50));await runtime.roomEngine.settle(group.id);runtime.roomEngine.pause(group.id);
  runtime.store.mutateFree(group.id,s=>{s.status='limit';s.error='达到本场自动讨论时限。';s.deadline=Date.now()-1;});
  await runtime.app.listen({host:'127.0.0.1',port});browser=await chromium.launch({channel:process.env.CHAT_TEA_BROWSER_CHANNEL??'msedge',headless:true,chromiumSandbox:true});
  const page=await browser.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${port}`);
  await page.getByRole('button',{name:'成员与设置',exact:true}).click();await page.locator('.details-tabs').getByRole('button',{name:'讨论设置',exact:true}).click();
  assert.equal(await page.getByRole('spinbutton',{name:'最长持续时间（分钟）',exact:true}).count(),0);await page.getByText('不限制讨论时长；达到调用次数、Token 或金额预算时仍会停止。',{exact:true}).waitFor();
  await page.getByRole('button',{name:'关闭设置',exact:true}).click();speak=true;
  await page.getByRole('button',{name:'继续讨论',exact:true}).click();await page.getByText('甲'.repeat(60),{exact:true}).waitFor();
  await page.getByRole('button',{name:'暂停讨论',exact:true}).click();
  const draining=page.getByRole('button',{name:'正在暂停 · 等待连发完成',exact:true});await draining.waitFor();assert.ok(await draining.isDisabled());
  await page.getByText('第二段结束。',{exact:true}).waitFor();await page.getByRole('button',{name:'继续讨论',exact:true}).waitFor();
  assert.equal(calls,2);assert.equal(runtime.store.freeSession(group.id)!.status,'paused');assert.ok(runtime.store.messages(group.id).every(m=>m.speech?.state==='complete'));assert.deepEqual(errors,[]);
});
