import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {createServer} from 'node:net';
import {chromium} from 'playwright-core';
import {buildApp} from '../../server/app.js';
import type {RuntimeWake} from '../../server/runtime-adapters/types.js';

test('standby members appear in the mention picker and respond once while the group stays paused',{timeout:60000},async t=>{
 const root=resolve('.test-artifacts');mkdirSync(root,{recursive:true});const dataDir=mkdtempSync(join(root,'standby-ui-'));
 const port=await new Promise<number>((done,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const n=(s.address() as {port:number}).port;s.close(()=>done(n));});});
 const wakes:RuntimeWake[]=[];let release!:()=>void;const held=new Promise<void>(r=>release=r);
 const runtime=await buildApp({dataDir,port,production:true,participantRuntime:{async run(w){wakes.push(w);w.read(20);await held;await w.post('这里是仅一次的总结。',undefined,'standby-test');},async shutdown(){release();}}});
 const group=runtime.store.groups()[0];group.participants[0].enabled=false;group.freeSettings={...group.freeSettings!,typingGraceSeconds:0,messageGapMin:0,messageGapMax:0};runtime.store.saveGroup(group);
 await runtime.app.listen({host:'127.0.0.1',port});const url=`http://127.0.0.1:${port}`;
 const browser=await chromium.launch({channel:process.env.CHAT_TEA_BROWSER_CHANNEL??'msedge',headless:true,chromiumSandbox:true});
 t.after(async()=>{release();await browser.close();await runtime.app.close();assert.equal(dirname(realpathSync(dataDir)),realpathSync(root));rmSync(dataDir,{recursive:true,force:true});});
 const page=await browser.newPage({viewport:{width:1365,height:980}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
 await page.route('**/*',r=>r.request().url().startsWith(url)?r.continue():r.abort());await page.goto(url);
 const input=page.getByRole('textbox',{name:'输入讨论问题',exact:true});await input.fill('@');
 const option=page.getByRole('option',{name:new RegExp(group.participants[0].name)});await option.waitFor();assert.match(await option.innerText(),/仅回应人类 @/);await option.click();await input.press('End');await input.pressSequentially('请总结');await input.press('Enter');
 await page.getByRole('button',{name:'停止单次回应',exact:true}).waitFor();assert.equal(wakes.length,1);assert.equal(wakes[0].singleResponse,true);assert.equal(runtime.store.freeSession(group.id)!.status,'paused');
 release();await page.getByText('这里是仅一次的总结。',{exact:true}).waitFor();await page.getByRole('button',{name:'继续讨论',exact:true}).waitFor();assert.equal(runtime.store.group(group.id)!.participants[0].enabled,false);
 await input.fill('没有点名的普通消息');await input.press('Enter');await page.getByText('没有点名的普通消息',{exact:true}).waitFor();assert.equal(wakes.length,1);assert.equal(runtime.store.freeSession(group.id)!.status,'paused');
 await page.getByRole('button',{name:'成员与设置',exact:true}).click();await page.getByText('待命 · 仅回应人类 @',{exact:true}).waitFor();
 mkdirSync(resolve('output/playwright'),{recursive:true});await page.screenshot({path:resolve('output/playwright/standby-member.png')});assert.deepEqual(errors,[]);
});
