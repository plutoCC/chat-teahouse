import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, realpathSync, lstatSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { buildApp } from '../../server/app.js';
import { fixtureModelCatalog } from './model-list-fixture.js';

test('free chat UI configures independent members, imports skills, shows silence, accepts interruption and resumes', {timeout:60000}, async t=>{
  const root=resolve('.test-artifacts');mkdirSync(root,{recursive:true});const dataDir=mkdtempSync(join(root,'free-ui-'));
  const port=await new Promise<number>((done,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const n=(s.address() as {port:number}).port;s.close(()=>done(n));});});
  let calls=0;
  const runtime=await buildApp({dataDir,port,production:true,modelCatalogFetcher:fixtureModelCatalog,nativeGenerate:async options=>{
    calls++;const idx=options.messages.findLastIndex(m=>m.role==='user');
    const message=options.messages[idx],body=message.content.filter(b=>b.type==='text').map(b=>b.text).join('');
    const wake=JSON.parse(body);let name='wait_for_messages',args:object={seconds:0};
    if(options.model==='fixture-talk'){
      if(wake.messages.some((m:{kind:string})=>m.kind==='user')){
        const loaded=options.messages.slice(idx+1).some(m=>m.role==='tool');
        name=loaded?'post_message':'load_skill';args=loaded?{content:'【本地测试 · 非真实模型】已读取新观点和论证检查技能；人的看法也需要证据。'}:{id:'argument-check'};
      }else if(wake.firstWake){name='post_message';args={content:'【本地测试 · 非真实模型】我提出一个观点；另一位成员可以选择聆听。'};}
    }
    return {blocks:[{type:'tool-call',id:ToolCallId(crypto.randomUUID()),name,arguments:JSON.stringify(args)}],inputTokens:100,outputTokens:30};
  }});
  const host=`127.0.0.1:${port}`;const boot=(await runtime.app.inject({url:'/api/bootstrap',headers:{host}})).json();
  const headers={host,origin:`http://${host}`,'x-csrf-token':boot.csrfToken};
  const saved=await runtime.app.inject({method:'PUT',url:'/api/providers/openai',headers,payload:{enabled:true,apiKey:'test-only-local-no-external-calls',modelPrices:{'fixture-talk':{inputPrice:1,outputPrice:1},'fixture-quiet':{inputPrice:1,outputPrice:1}}}});assert.equal(saved.statusCode,200);
  await runtime.app.listen({host:'127.0.0.1',port});
  const browser=await chromium.launch({channel:process.env.CHAT_TEA_BROWSER_CHANNEL??'msedge',headless:true,chromiumSandbox:true});
  t.after(async()=>{await browser.close();await runtime.app.close();assert.equal(lstatSync(dataDir).isSymbolicLink(),false);const target=realpathSync(dataDir);assert.equal(dirname(target),realpathSync(root));assert.ok(basename(target).startsWith('free-ui-'));rmSync(target,{recursive:true,force:true});});
  const page=await browser.newPage({viewport:{width:1365,height:900}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://${host}/`);await page.getByRole('button',{name:'新建群聊',exact:true}).click();
  await page.getByRole('textbox',{name:'圆桌名称',exact:true}).fill('自主群聊 · 本地验收');await page.getByRole('textbox',{name:/^讨论目标/}).fill('测试发言与沉默，不调用外部模型');
  for(const name of ['演示成员 A','演示成员 B','演示成员 C'])await page.getByRole('checkbox',{name:`邀请 ${name}`,exact:true}).check();
  await page.getByRole('button',{name:'创建圆桌',exact:true}).click();await page.getByRole('heading',{name:'自主群聊 · 本地验收',exact:true}).waitFor();
  await page.getByRole('button',{name:'成员与设置',exact:true}).click();await page.getByRole('button',{name:'管理技能库',exact:true}).click();
  await page.getByRole('textbox',{name:'检查技能内容后导入',exact:true}).fill('---\nname: ui-review\ndescription: 界面验收方法\n---\n检查公开讨论中的依据。');
  await page.getByRole('button',{name:'导入文字技能',exact:true}).click();await page.getByRole('dialog').getByText('ui-review',{exact:true}).waitFor();await page.getByRole('button',{name:'关闭对话框',exact:true}).click();
  await page.getByRole('button',{name:'编辑 演示成员 A',exact:true}).click();
  await page.getByRole('textbox',{name:'显示名称',exact:true}).fill('发言成员（模拟）');await page.getByRole('combobox',{name:'模型供应商',exact:true}).selectOption('openai');await page.getByRole('combobox',{name:'模型名称',exact:true}).selectOption('fixture-talk');
  await page.getByRole('checkbox',{name:/^论证检查/}).check();await page.getByRole('button',{name:'保存成员',exact:true}).click();
  await page.getByRole('button',{name:'编辑 演示成员 B',exact:true}).click();await page.getByRole('textbox',{name:'显示名称',exact:true}).fill('聆听成员（模拟）');await page.getByRole('combobox',{name:'模型供应商',exact:true}).selectOption('openai');await page.getByRole('combobox',{name:'模型名称',exact:true}).selectOption('fixture-quiet');await page.getByRole('button',{name:'保存成员',exact:true}).click();
  await page.getByRole('checkbox',{name:'停用 演示成员 C',exact:true}).click();await page.getByRole('checkbox',{name:'启用 演示成员 C',exact:true}).waitFor();
  await page.locator('.details-tabs').getByRole('button',{name:'讨论设置',exact:true}).click();
  assert.equal(await page.getByRole('combobox',{name:/^讨论模式/}).inputValue(),'free');
  for(const label of ['最短发言间隔（秒）','最长发言间隔（秒）','阅读速度（字 / 秒，0 关闭）','用户输入保护（秒）'])await page.getByRole('spinbutton',{name:label,exact:true}).fill('0');
  await page.getByRole('spinbutton',{name:'合并消息等待（秒）',exact:true}).fill('0');await page.getByRole('spinbutton',{name:'最短冷却（秒）',exact:true}).fill('1');await page.getByRole('spinbutton',{name:'最长冷却（秒）',exact:true}).fill('1');
  await page.getByRole('button',{name:'保存自主群聊设置',exact:true}).click();await page.getByText('自主群聊设置已保存',{exact:true}).waitFor();
  await page.getByRole('button',{name:'关闭设置',exact:true}).click();await page.getByRole('button',{name:'开始讨论',exact:true}).click();
  await page.getByText('【本地测试 · 非真实模型】我提出一个观点；另一位成员可以选择聆听。',{exact:true}).waitFor();
  await page.getByRole('region',{name:'成员实时状态',exact:true}).getByText('聆听成员（模拟）',{exact:true}).waitFor();
  assert.equal(await page.locator('.round-divider').count(),0);
  await page.getByRole('textbox',{name:'输入讨论问题',exact:true}).fill('人类中途补充：请检查这个观点的依据。');await page.getByRole('button',{name:'加入讨论',exact:true}).click();
  await page.getByText('【本地测试 · 非真实模型】已读取新观点和论证检查技能；人的看法也需要证据。',{exact:true}).waitFor();
  const group=runtime.store.groups().find(g=>g.name==='自主群聊 · 本地验收')!;assert.equal(runtime.store.messages(group.id).filter(m=>m.kind==='assistant').length,2);
  assert.match(runtime.store.messages(group.id).at(-1)!.reasoning,/读取技能：论证检查/);
  const sessionId=runtime.store.freeSession(group.id)!.id;
  mkdirSync(resolve('output/playwright'),{recursive:true});await page.screenshot({path:resolve('output/playwright/free-chat-desktop.png')});
  await page.getByRole('button',{name:'暂停讨论',exact:true}).click();await page.getByRole('button',{name:'继续讨论',exact:true}).waitFor();await runtime.roomEngine.settle(group.id);
  const before=calls;await page.getByRole('textbox',{name:'输入讨论问题',exact:true}).fill('暂停时保存的消息');await page.getByRole('button',{name:'发送',exact:true}).click();
  assert.equal(calls,before);await page.getByRole('button',{name:'继续讨论',exact:true}).click();
  await page.getByRole('button',{name:'暂停讨论',exact:true}).waitFor();assert.equal(runtime.store.freeSession(group.id)!.id,sessionId);
  await page.setViewportSize({width:390,height:844});
  await page.waitForFunction(()=>{const p=document.querySelector('.groups-panel');return p?.hasAttribute('inert')&&p.getBoundingClientRect().right<=0;});
  await page.screenshot({path:resolve('output/playwright/free-chat-mobile.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
  await page.getByRole('button',{name:'暂停讨论',exact:true}).click();await page.getByRole('button',{name:'继续讨论',exact:true}).waitFor();
});
