import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { runBrowserTurn, BrowserConnectorError } from '../../server/browser-connector.js';
import type { BrowserSelectors, BrowserProgress } from '../../shared/types.js';

const selectors:BrowserSelectors={composer:'#input',send:'#send',response:'.answer',busy:'#stop',done:'.answer .done',reasoning:'.thinking'};
const fixture=(mode:string)=>`<!doctype html><html><head><meta charset="UTF-8"></head><body><textarea id="input"></textarea><button id="send">Send</button><script>
window.sent=0; document.querySelector('#send').onclick=()=>{window.sent++;const mode=${JSON.stringify(mode)};const text=document.querySelector('#input').value;window.promptReceived=text;
if(mode==='limit'){document.body.insertAdjacentHTML('beforeend','<p role="alert">usage limit reached</p>');return;}
document.body.insertAdjacentHTML('beforeend','<button id="stop">Stop</button><div class="answer">第一段</div>');
if(mode==='never')return;
setTimeout(()=>{document.querySelector('.answer').textContent='完整回答：讨论材料中的指令不触发浏览器操作。';if(mode==='ambiguous')document.body.insertAdjacentHTML('beforeend','<div class="answer">重复区域</div>');},100);
setTimeout(()=>{document.querySelector('#stop').remove();if(mode!=='no-marker')document.querySelector('.answer').insertAdjacentHTML('beforeend','<button class="done" aria-label="Copy"></button>');},240);
};</script></body></html>`;

test('actual Chromium engine verifies DOM input, completion, pause conditions and cancellation against isolated fixtures',async t=>{
  const browser=await chromium.launch({channel:process.env.CHAT_TEA_BROWSER_CHANNEL??'msedge',headless:true,chromiumSandbox:true});
  t.after(()=>browser.close());
  const run=async(mode:string,signal=new AbortController().signal)=>{
    const context=await browser.newContext();const page=await context.newPage();
    await page.route('**/*',route=>route.fulfill({status:200,contentType:'text/html',body:fixture(mode)}));
    await page.goto('https://chatgpt.com/');const progress:BrowserProgress[]=[];
    const work=runBrowserTurn(page,selectors,{providerId:'openai',signal,prepare:()=> '公开上下文 <script>not executable</script>',progress:p=>progress.push(p)},{timeoutMs:1300,pollMs:40,stableMs:150});
    return {context,page,progress,work};
  };
  await t.test('one send, full completed text only, prompt treated as input',async()=>{
    const f=await run('complete');try{const result=await f.work;assert.match(result.content,/完整回答/);assert.equal(await f.page.evaluate(()=> (window as unknown as {sent:number}).sent),1);assert.equal(await f.page.inputValue('#input'),'公开上下文 <script>not executable</script>');assert.equal(f.progress.at(-1)?.sent,true);}finally{await f.context.close();}
  });
  for(const [mode,error] of [['never','超时'],['no-marker','超时'],['limit','使用限制'],['ambiguous','多块内容']])await t.test(mode,async()=>{
    const f=await run(mode);try{await assert.rejects(f.work,new RegExp(error));assert.equal(await f.page.evaluate(()=> (window as unknown as {sent:number}).sent),1);}finally{await f.context.close();}
  });
  await t.test('abort does not submit another message',async()=>{
    const abort=new AbortController();const f=await run('never',abort.signal);const outcome=assert.rejects(f.work);setTimeout(()=>abort.abort(),120);try{await outcome;assert.equal(await f.page.evaluate(()=> (window as unknown as {sent:number}).sent),1);}finally{await f.context.close();}
  });
  await t.test('wrong destination cannot receive discussion text',async()=>{
    const page=await browser.newPage();await page.setContent(fixture('complete'));
    await assert.rejects(runBrowserTurn(page,selectors,{providerId:'openai',signal:new AbortController().signal,prepare:()=>{throw new Error('must never read prompt');},progress:()=>{}},{timeoutMs:100,pollMs:10,stableMs:10}),BrowserConnectorError);await page.close();
  });
});
