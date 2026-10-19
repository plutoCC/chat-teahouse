import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,realpathSync,lstatSync} from 'node:fs';
import {resolve,join,dirname,basename} from 'node:path';
import {createServer} from 'node:net';
import {chromium} from 'playwright-core';
import {ToolCallId} from '@deepseek-ai/dsh-llm';
import {buildApp} from '../../server/app.js';
import {defaultFreeSettings} from '../../shared/free-chat.js';

test('chat bubbles, member CNY costs, private waiting journal and duplicate-name mention picker work together', {timeout:60000},async t=>{
  const root=resolve('.test-artifacts');mkdirSync(root,{recursive:true});const dataDir=mkdtempSync(join(root,'journal-ui-'));
  const port=await new Promise<number>((done,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const n=(s.address() as {port:number}).port;s.close(()=>done(n));});});
  const calls=new Map<string,number>();
  const runtime=await buildApp({dataDir,port,production:true,nativeGenerate:async options=>{
    const number=(calls.get(options.model)??0)+1;calls.set(options.model,number);
    if(options.model==='fixture-a'&&number===1)return {blocks:[{type:'text',text:'【本地模拟】尚未提交的私有草稿，不能自动发出。'}],inputTokens:100,outputTokens:30};
    let name='wait_for_messages',args:object={seconds:0,reason:'没有新增证据，先听完整个讨论。'};
    if(options.model==='fixture-a'&&number===2){name='post_message';args={content:'【本地模拟】我的判断是先进行小规模验证。\n\n理由是这个假设还缺少独立的数据支持。\n\n即使大家赞同，也需要检验成本是否合理。'};}
    if(options.model==='fixture-b'&&number===2){name='post_message';args={content:'【本地模拟】被点名后，我补充一个反例：样本过少会影响判断。'};}
    return {blocks:[{type:'tool-call',id:ToolCallId(crypto.randomUUID()),name,arguments:JSON.stringify(args)}],inputTokens:100,outputTokens:30,returnedReasoning:{text:'【模拟供应商摘要】当前论据尚未变化，因此等待新的证据。',label:'供应商返回的推理摘要'}};
  }});
  const host=`127.0.0.1:${port}`,boot=(await runtime.app.inject({url:'/api/bootstrap',headers:{host}})).json();
  const headers={host,origin:`http://${host}`,'x-csrf-token':boot.csrfToken};
  assert.equal((await runtime.app.inject({method:'PUT',url:'/api/providers/openai',headers,payload:{enabled:true,apiKey:'local-fixture-no-network',modelPrices:{'fixture-a':{inputPrice:2,outputPrice:4},'fixture-b':{inputPrice:2,outputPrice:4}}}})).statusCode,200);
  const group=runtime.store.groups()[0];group.name='日志与点名 · 本地模拟验收';group.conversationMode='free';
  group.participants=group.participants.slice(0,2).map((p,i)=>({...p,id:i?'bbb':'aaa',name:'讨论员（模拟）',providerId:'openai',model:i?'fixture-b':'fixture-a'}));
  group.freeSettings={...defaultFreeSettings,messageStyle:'segmented',messageGapMin:0,messageGapMax:0,typingGraceSeconds:0,quietSeconds:0,cooldownMin:300,cooldownMax:300,concurrency:1,wakeProbability:0,respondToAI:false};group.settings.budgetUSD=0;runtime.store.saveGroup(group);
  await runtime.app.listen({host:'127.0.0.1',port});
  const browser=await chromium.launch({channel:process.env.CHAT_TEA_BROWSER_CHANNEL??'msedge',headless:true,chromiumSandbox:true});
  t.after(async()=>{await browser.close();await runtime.app.close();assert.equal(lstatSync(dataDir).isSymbolicLink(),false);const target=realpathSync(dataDir);assert.equal(dirname(target),realpathSync(root));assert.ok(basename(target).startsWith('journal-ui-'));rmSync(target,{recursive:true,force:true});});
  const page=await browser.newPage({viewport:{width:1365,height:980}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>localStorage.setItem('teahouse-estimated-usd-cny','7'));
  await page.goto(`http://${host}`);await page.getByRole('heading',{name:group.name,exact:true}).waitFor();await page.getByRole('button',{name:'开始讨论',exact:true}).click();
  await page.getByText('即使大家赞同，也需要检验成本是否合理。',{exact:true}).waitFor();
  await page.getByRole('button',{name:'群聊日志与用量',exact:true}).click();
  await page.getByRole('dialog').getByText('等待原因（模型说明）：没有新增证据，先听完整个讨论。',{exact:true}).waitFor();
  assert.equal(runtime.store.messages(group.id).length,3);assert.deepEqual([...calls.values()],[2,1]);
  const dialog=page.getByRole('dialog');await dialog.getByRole('combobox',{name:'日志活动'}).selectOption('protocol');
  await dialog.locator('.journal-entry').getByText('系统提醒',{exact:true}).waitFor();await dialog.getByText('尚未收到有效群聊动作，系统将提醒模型提交发言或明确等待（最多一次，仍受群预算限制）；普通正文不会自动发布。',{exact:true}).waitFor();
  mkdirSync(resolve('output/playwright'),{recursive:true});await page.screenshot({path:resolve('output/playwright/protocol-reminder.png')});
  await dialog.getByRole('combobox',{name:'日志活动'}).selectOption('model');
  assert.equal(await dialog.getByText(/模型返回正文.*尚未发布/).count(),1);
  await dialog.getByText('供应商返回的推理摘要',{exact:true}).first().click();await dialog.getByText('【模拟供应商摘要】当前论据尚未变化，因此等待新的证据。',{exact:true}).first().waitFor();
  assert.equal(await dialog.getByText('¥0.00224',{exact:true}).count(),1);assert.equal(await dialog.getByText('¥0.00448',{exact:true}).count(),1);
  mkdirSync(resolve('output/playwright'),{recursive:true});await page.screenshot({path:resolve('output/playwright/group-journal.png')});
  await page.getByRole('button',{name:'关闭对话框',exact:true}).click();assert.equal(await page.locator('.messages').getByText('【模拟供应商摘要】当前论据尚未变化，因此等待新的证据。',{exact:true}).count(),0);assert.equal(await page.locator('.messages').getByText('【本地模拟】尚未提交的私有草稿，不能自动发出。',{exact:true}).count(),0);
  const input=page.getByRole('textbox',{name:'输入讨论问题',exact:true});await input.fill('@');await page.getByRole('listbox',{name:'可提及成员'}).waitFor();assert.equal(await page.getByRole('option').count(),2);
  const secondOption=page.getByRole('option').nth(1);
  // DOM visibility alone does not detect an absolutely positioned popup clipped by an ancestor.
  assert.equal(await secondOption.evaluate(element=>{const rect=element.getBoundingClientRect();return element.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2));}),true,'mention option must be painted and receive pointer input');
  await page.screenshot({path:resolve('output/playwright/mention-picker.png')});await secondOption.click();assert.equal(runtime.store.messages(group.id).length,3);assert.equal(await input.inputValue(),'@讨论员（模拟） ');
  await input.fill('@');await input.press('ArrowDown');await input.press('Enter');assert.equal(runtime.store.messages(group.id).length,3);assert.equal(await input.inputValue(),'@讨论员（模拟） ');
  await input.press('End');await input.pressSequentially('说说你的异议');await input.press('Enter');
  await page.getByText('【本地模拟】被点名后，我补充一个反例：样本过少会影响判断。',{exact:true}).waitFor();
  assert.deepEqual(runtime.store.messages(group.id).find(m=>m.kind==='user')!.mentions,['bbb']);assert.equal(calls.get('fixture-a'),2);assert.equal(calls.get('fixture-b'),2);
  await page.getByText('查看各成员 Token 与人民币费用',{exact:true}).click();await page.getByText('¥0.00448',{exact:true}).first().waitFor();
  await page.screenshot({path:resolve('output/playwright/segmented-chat.png')});
  await page.getByRole('button',{name:'暂停讨论',exact:true}).click();await page.getByRole('button',{name:'继续讨论',exact:true}).waitFor();
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'群聊日志与用量',exact:true}).click();await page.getByRole('dialog').waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:resolve('output/playwright/group-journal-mobile.png')});
  await page.getByRole('button',{name:'关闭对话框',exact:true}).click();await input.fill('@');
  const mobileOption=page.getByRole('option').nth(1);assert.equal(await mobileOption.evaluate(element=>{const r=element.getBoundingClientRect();return r.x>=0&&r.right<=innerWidth&&r.y>=0&&r.bottom<=innerHeight&&element.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true,'mobile popup must remain visible and clickable');
  await page.screenshot({path:resolve('output/playwright/mention-picker-mobile.png')});await mobileOption.click();assert.equal(await input.inputValue(),'@讨论员（模拟） ');assert.deepEqual(errors,[]);
});
