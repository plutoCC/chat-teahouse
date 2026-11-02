import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,realpathSync,lstatSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {createServer} from 'node:net';
import {setTimeout as sleep} from 'node:timers/promises';
import {chromium,type Locator} from 'playwright-core';
import {buildApp} from '../../server/app.js';
import {PROVIDER_DEFAULTS} from '../../server/providers.js';

async function fixture(t:TestContext,mobile:boolean){
  const root=resolve('.test-artifacts');mkdirSync(root,{recursive:true});const dataDir=mkdtempSync(join(root,'ime-ui-'));
  const port=await new Promise<number>(done=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const port=(s.address() as {port:number}).port;s.close(()=>done(port));});});
  const runtime=await buildApp({dataDir,port,production:true,hosting:{userName:'输入测试会员',providers:()=>[{...PROVIDER_DEFAULTS.find(p=>p.id==='deepseek')!,enabled:true,hasKey:true,inputPrice:1,outputPrice:2}],getKey:()=>{throw Error('IME tests must not read credentials');}},generate:async()=>{throw Error('IME tests must not call models');},nativeGenerate:async()=>{throw Error('IME tests must not call models');}});
  const group=runtime.store.groups()[0];group.conversationMode='round';group.name='中文输入测试';group.participants=[{id:'chinese-member',name:'中立观察员',providerId:'deepseek',model:'deepseek-flash',avatar:'中',color:'#34705a',role:'',enabled:true,channel:'api'}];runtime.store.saveGroup(group);
  const other=runtime.store.createGroup('另一张茶桌','');other.participants=[];other.updatedAt='2020-01-01';runtime.store.saveGroup(other);
  await runtime.app.listen({host:'127.0.0.1',port});const browser=await chromium.launch({channel:process.env.CHAT_TEA_BROWSER_CHANNEL??'msedge',headless:true,chromiumSandbox:true});
  t.after(async()=>{await browser.close();await runtime.app.close();assert.equal(lstatSync(dataDir).isSymbolicLink(),false);assert.equal(dirname(realpathSync(dataDir)),realpathSync(root));rmSync(dataDir,{recursive:true,force:true});});
  // Chromium executes the regression event replay; mobile metrics do not emulate Gecko or a physical IME.
  const page=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1365,height:980},isMobile:mobile,hasTouch:mobile});const url=`http://127.0.0.1:${port}`;
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(8000);
  await page.route('**/*',r=>r.request().url().startsWith(url)?r.continue():r.abort());
  await page.goto(url);await page.getByRole('heading',{name:group.name,exact:true}).waitFor();
  return {page,runtime,group,other,errors,input:page.getByRole('textbox',{name:'输入讨论问题',exact:true})};
}

// Native setters bypass React's value tracker like a browser editing the DOM.
async function composedValue(input:Locator,value:string,data:string,type:'compositionupdate'|'compositionend'){
  await input.evaluate((node:HTMLTextAreaElement,args)=>{
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(node,args.value);
    node.setSelectionRange(args.value.length,args.value.length);
    node.dispatchEvent(new CompositionEvent(args.type,{bubbles:true,data:args.data}));
  },{value,data,type});
}

test('mobile IME text survives parent refresh and compositionend before final input; Enter inserts a newline',{timeout:45000},async t=>{
  const {page,input,runtime,group,errors}=await fixture(t,true);await input.fill('讨论：');
  await input.dispatchEvent('compositionstart',{data:''});
  await composedValue(input,'讨论：中文','中文','compositionupdate');
  // The room clock re-renders its parent each second. It must never overwrite preedit DOM.
  await sleep(1200);assert.equal(await input.inputValue(),'讨论：中文','uncommitted characters must survive periodic room updates');
  await composedValue(input,'讨论：中文观点','中文观点','compositionend');
  await sleep(30);assert.equal(await input.inputValue(),'讨论：中文观点','compositionend must not restore an older controlled value');
  await input.dispatchEvent('input',{data:'中文观点',inputType:'insertCompositionText',isComposing:false});
  await input.press('Enter');assert.equal(runtime.store.messages(group.id).length,0,'mobile return must not send a partial sentence');assert.equal(await input.inputValue(),'讨论：中文观点\n');
  await page.keyboard.insertText('第二行 123 ABC ☕');await page.getByRole('button',{name:'发送',exact:true}).click();await page.getByText('第二行 123 ABC ☕',{exact:false}).first().waitFor();
  assert.equal(runtime.store.messages(group.id).length,1);assert.equal(runtime.store.messages(group.id)[0].content,'讨论：中文观点\n第二行 123 ABC ☕');assert.equal(await input.inputValue(),'');
  mkdirSync(resolve('output/playwright'),{recursive:true});await page.screenshot({path:resolve('output/playwright/mobile-chinese-input-fixture.png')});assert.deepEqual(errors,[]);
});

test('Chinese mention composition and keyCode 229 never select or send early; desktop shortcuts and per-room drafts still work',{timeout:45000},async t=>{
  const {page,input,runtime,group,other,errors}=await fixture(t,false);
  await input.fill('@');await page.getByRole('listbox',{name:'可提及成员'}).waitFor();
  await input.dispatchEvent('compositionstart',{data:''});await page.getByRole('listbox',{name:'可提及成员'}).waitFor({state:'hidden'});
  await composedValue(input,'@中','中','compositionend');await input.dispatchEvent('input',{data:'中',inputType:'insertCompositionText',isComposing:false});
  await page.getByRole('listbox',{name:'可提及成员'}).waitFor();
  const prevented=await input.evaluate(node=>!node.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Enter',keyCode:229,isComposing:false})));
  assert.equal(prevented,false);assert.equal(await input.inputValue(),'@中');assert.equal(runtime.store.messages(group.id).length,0);
  await input.dispatchEvent('keyup',{key:'Enter',keyCode:229});await input.press('Enter');assert.equal(await input.inputValue(),'@中立观察员 ');assert.equal(runtime.store.messages(group.id).length,0);
  await page.keyboard.insertText('中文草稿');await page.locator('.group-item').filter({hasText:other.name}).click();await page.getByRole('heading',{name:other.name,exact:true}).waitFor();assert.equal(await input.inputValue(),'');
  await page.locator('.group-item').filter({hasText:group.name}).click();await page.getByRole('heading',{name:group.name,exact:true}).waitFor();assert.equal(await input.inputValue(),'@中立观察员 中文草稿');
  await input.press('Enter');await page.locator('.messages').getByText('@中立观察员 中文草稿',{exact:true}).waitFor();assert.equal(runtime.store.messages(group.id).length,1);assert.deepEqual(runtime.store.messages(group.id)[0].mentions,['chinese-member']);assert.equal(await input.inputValue(),'');assert.deepEqual(errors,[]);
});

test('native Chromium composition commits Chinese without duplication or losing the caret',{timeout:45000},async t=>{
  const {page,input,runtime,group,errors}=await fixture(t,true);await input.focus();
  const session=await page.context().newCDPSession(page);
  await session.send('Input.imeSetComposition',{text:'nihao',selectionStart:5,selectionEnd:5});
  await sleep(1200);assert.equal(await input.inputValue(),'nihao');
  await session.send('Input.insertText',{text:'你好'});assert.equal(await input.inputValue(),'你好');
  await session.send('Input.imeSetComposition',{text:'中文',selectionStart:2,selectionEnd:2});
  await session.send('Input.insertText',{text:'中文'});assert.equal(await input.inputValue(),'你好中文');
  assert.equal(await input.evaluate(node=>document.activeElement===node),true);
  await page.getByRole('button',{name:'发送',exact:true}).click();await page.locator('.messages').getByText('你好中文',{exact:true}).waitFor();
  assert.equal(runtime.store.messages(group.id).length,1);assert.equal(await input.inputValue(),'');assert.deepEqual(errors,[]);
});
