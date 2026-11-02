import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,realpathSync,lstatSync} from 'node:fs';
import {resolve,join,dirname,basename} from 'node:path';
import {createServer} from 'node:net';
import {chromium} from 'playwright-core';
import {buildApp} from '../../server/app.js';

test('edited reading speed and both discussion modes can become defaults for new groups', {timeout:60000},async t=>{
  const root=resolve('.test-artifacts');mkdirSync(root,{recursive:true});const dataDir=mkdtempSync(join(root,'group-defaults-ui-'));
  const port=await new Promise<number>((done,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const n=(s.address() as {port:number}).port;s.close(()=>done(n));});});
  const runtime=await buildApp({dataDir,port,production:true,modelCatalogFetcher:async provider=>({providerId:provider.id,region:provider.region,source:'account',models:[{id:'neutral-fixture',label:'中立摘要测试模型'},{id:'other-fixture',label:'另一个测试模型'}],message:'虚构模型目录，无网络调用'})});
  runtime.store.saveProvider({...runtime.store.providers().find(p=>p.id==='deepseek')!,enabled:true,model:'neutral-fixture'});await runtime.app.listen({host:'127.0.0.1',port});
  const browser=await chromium.launch({channel:process.env.CHAT_TEA_BROWSER_CHANNEL??'msedge',headless:true,chromiumSandbox:true});
  t.after(async()=>{await browser.close();await runtime.app.close();assert.equal(lstatSync(dataDir).isSymbolicLink(),false);const target=realpathSync(dataDir);assert.equal(dirname(target),realpathSync(root));assert.ok(basename(target).startsWith('group-defaults-ui-'));rmSync(target,{recursive:true,force:true});});
  const page=await browser.newPage({viewport:{width:1365,height:980}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}`);
  const openSettings=async()=>{await page.getByRole('button',{name:'成员与设置',exact:true}).click();await page.locator('.details-tabs').getByRole('button',{name:'讨论设置',exact:true}).click();};
  const saveTemplate=async()=>{const saved=page.waitForResponse(r=>r.url().endsWith('/default-template')&&r.request().method()==='POST');await page.getByRole('button',{name:'设为新群默认模板',exact:true}).click();assert.equal((await saved).status(),200);};
  const newGroup=async(name:string)=>{await page.getByRole('button',{name:'关闭设置',exact:true}).click();await page.getByRole('button',{name:'新建群聊',exact:true}).click();await page.getByRole('textbox',{name:'圆桌名称',exact:true}).fill(name);await page.getByRole('button',{name:'创建圆桌',exact:true}).click();await page.getByRole('heading',{name,exact:true}).waitFor();};
  await openSettings();await page.getByRole('spinbutton',{name:'阅读速度（字 / 秒，0 关闭）',exact:true}).fill('20');await page.getByRole('spinbutton',{name:/^最多模型调用次数/}).fill('50');
  await page.getByRole('spinbutton',{name:'每位成员每次唤醒最多模型调用',exact:true}).fill('12');
  await page.getByRole('combobox',{name:'公共摘要连接',exact:true}).selectOption('deepseek');await page.getByRole('combobox',{name:'公共摘要模型',exact:true}).selectOption('other-fixture');await page.getByRole('spinbutton',{name:'公共摘要请求超时（秒）',exact:true}).fill('900');
  for(const [name,value] of [['最多 tokens','100000000'],['单次输出上限','65536']]){const input=page.getByRole('spinbutton',{name,exact:true});assert.equal(await input.getAttribute('max'),null);await input.fill(value);}
  await saveTemplate();assert.equal(runtime.store.groupDefaults().freeSettings.maxModelCallsPerWake,12);assert.equal(runtime.store.groupDefaults().freeSettings.readingCharsPerSecond,20);assert.equal(runtime.store.groupDefaults().settings.maxCalls,50);
  await newGroup('阅读节奏 · 模板验收');const fresh=runtime.store.groups().find(g=>g.name==='阅读节奏 · 模板验收')!;assert.deepEqual(fresh.freeSettings!.publicSummary,{connectionId:'deepseek',model:'other-fixture'});assert.equal(fresh.freeSettings!.summaryTimeoutSeconds,900);assert.equal(fresh.settings.maxOutputTokens,65536);assert.equal(fresh.settings.maxTotalTokens,100000000);assert.equal(fresh.freeSettings!.maxModelCallsPerWake,12);assert.equal(fresh.freeSettings!.readingCharsPerSecond,20);assert.equal(fresh.settings.maxCalls,50);assert.equal(fresh.participants.length,0);
  await openSettings();assert.equal(await page.getByRole('spinbutton',{name:'阅读速度（字 / 秒，0 关闭）',exact:true}).inputValue(),'20');
  mkdirSync(resolve('output/playwright'),{recursive:true});await page.getByRole('spinbutton',{name:'阅读速度（字 / 秒，0 关闭）',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:resolve('output/playwright/reading-speed-settings.png')});
  await page.getByRole('button',{name:'设为新群默认模板',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:resolve('output/playwright/group-default-template.png')});
  await page.getByRole('combobox',{name:/^讨论模式/}).selectOption('round');await page.getByRole('spinbutton',{name:'轮数',exact:true}).fill('4');for(const [name,value] of [['累计 token 上限','200000000'],['单次最大输出 token','131072']]){const input=page.getByRole('spinbutton',{name,exact:true});assert.equal(await input.getAttribute('max'),null);await input.fill(value);}await saveTemplate();
  await newGroup('圆桌模式 · 模板验收');const round=runtime.store.groups().find(g=>g.name==='圆桌模式 · 模板验收')!;assert.equal(round.conversationMode,'round');assert.equal(round.settings.rounds,4);assert.equal(round.settings.maxOutputTokens,131072);assert.equal(round.settings.maxTotalTokens,200000000);assert.equal(round.freeSettings!.readingCharsPerSecond,20);
  await page.setViewportSize({width:390,height:844});await openSettings();await page.getByRole('button',{name:'设为新群默认模板',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:resolve('output/playwright/group-default-template-mobile.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
});
