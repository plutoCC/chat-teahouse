import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,realpathSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {SessionId} from '@deepseek-ai/dsh-session';
import {createAssistantMessage,createSystemMessage,createToolResultMessage,createUserMessage,ToolCallId,type GenerateOptions} from '@deepseek-ai/dsh-llm';
import {PublicSummary,PUBLIC_SUMMARY_SYSTEM} from '../server/runtime-adapters/public-summary.js';
import {ContextCompactor,CONTEXT_LIMITS,contextPayload} from '../server/runtime-adapters/context-compaction.js';
import type {RuntimeWake,Delivery} from '../server/runtime-adapters/types.js';
import type {NativeGenerate,NativeGenerateOptions} from '../server/runtime-adapters/native-model.js';
import {ModelCallError} from '../server/model-errors.js';
import {defaultSettings,type Group,type Participant,type ProviderConfig} from '../shared/types.js';
import {defaultFreeSettings} from '../shared/free-chat.js';

function fixture(){
  const controller=new AbortController(),reservations:{input:number;output:number}[]=[],settlements:unknown[]=[],logs:string[]=[];
  const participant:Participant={id:'a',name:'PRIVATE_MEMBER',role:'PRIVATE_ROLE',identityMode:'role',providerId:'deepseek',model:'member-model',enabled:true,avatar:'甲',color:'#123456'};
  const provider:ProviderConfig={id:'qwen',connectionId:'summary-key',model:'neutral-model',name:'SUMMARY',enabled:true,hasKey:true,region:'cn',inputPrice:1,outputPrice:2};
  const group:Group={id:'room-a',name:'group',goal:'public',createdAt:'',updatedAt:'',archived:false,participants:[participant],settings:{...defaultSettings,budgetUSD:0,maxOutputTokens:10000},freeSettings:{...defaultFreeSettings,publicSummary:{connectionId:'summary-key',model:'neutral-model'}}};
  const messages:Delivery['messages']=Array.from({length:90},(_,i)=>({seq:i+1,id:`message-${i}`,author:i%2?'乙':'甲',kind:'user',content:`公开-${i}:`+'议'.repeat(1000)}));
  // Even unexpected private properties attached to a public record must be stripped.
  Object.assign(messages[0],{reasoning:'PRIVATE_REASONING',apiKey:'PRIVATE_KEY',notes:'PRIVATE_NOTE'});
  const wake:RuntimeWake={sessionId:'private-a',group,participant,provider,apiKey:'PRIVATE_KEY',signal:controller.signal,firstWake:false,skills:[{id:'private',name:'PRIVATE_SKILL',description:'PRIVATE_METHOD',builtin:false}],summaryCycle:'cycle-1',
    assertActive:()=>controller.signal.throwIfAborted(),activity:()=>{},log:entry=>logs.push(entry.summary),
    publicHistory:()=>({messages,readThroughSeq:messages.at(-1)!.seq,more:false}),
    reserve:(input,output)=>{reservations.push({input,output});return String(reservations.length);},settle:(_id,usage)=>settlements.push(usage),outputLimit:()=>9000,
    read:()=>{throw Error('not a public history source');},post:()=>{throw Error('no group publishing');},wait:()=>{},attention:()=>{},loadSkill:()=>{throw Error('no skills');}};
  wake.summaryWake=()=>({...wake,participant:{...participant,id:'public-summary',name:'公共摘要',role:'',identityMode:'native'},skills:[],publicHistory:undefined,summaryWake:undefined});
  return {wake,messages,controller,reservations,settlements,logs};
}
const reply=()=>({blocks:[{type:'text' as const,text:'甲提出假设，乙质疑成本；证据尚不足，未形成共识。'}],inputTokens:100,outputTokens:200});

test('a long current wake above the soft trigger continues intact without regenerating a public summary',async()=>{
  const f=fixture(),callId=ToolCallId('pending-post');let summaries=0;
  const compactor=new ContextCompactor(async()=>{summaries++;return reply();});
  const input:GenerateOptions={provider:'deepseek',model:'member-model',sessionId:SessionId('private-a'),messages:[
    createSystemMessage('PRIVATE_ROLE'),
    createUserMessage({source:{kind:'user'},content:[{type:'text',text:'公开'.repeat(8000)}]}),
    createAssistantMessage({source:{provider:'deepseek',model:'member-model',replayState:{response:{opaque:'REPLAY'.repeat(9000)}}},content:[{type:'reasoning',text:'PRIVATE_REASONING'.repeat(4000)},{type:'tool-call',id:callId,name:'post_message',arguments:'{"content":"待发观点"}'}]}),
    createToolResultMessage({callId,isError:true,content:[{type:'text',text:'请先读取新的人类消息。'}]}),
  ]};
  const length=Buffer.byteLength(contextPayload(input)),before=JSON.stringify(input);
  assert.ok(length>CONTEXT_LIMITS.triggerBytes&&length<CONTEXT_LIMITS.hardBytes);
  assert.equal(await compactor.project(input,f.wake),input);
  assert.equal(JSON.stringify(input),before);assert.equal(summaries,0);
  assert.ok(f.logs.some(s=>s.includes('本轮保留完整上下文继续')));
  // A genuine overflow still stops, with an explicit size rather than a misleading summary failure.
  const oversized={...input,system:'x'.repeat(CONTEXT_LIMITS.hardBytes)};
  await assert.rejects(compactor.project(oversized,f.wake),/超过程序的 240000 字节安全限制/);
  assert.equal(summaries,0);assert.equal(f.reservations.length,0);
});

test('a public replacement that grows a safe request does not block the current wake',async()=>{
  const f=fixture();let summaries=0;
  const compactor=new ContextCompactor(async()=>{summaries++;return reply();});
  const input:GenerateOptions={provider:'deepseek',model:'member-model',sessionId:SessionId('private-a'),messages:[
    createSystemMessage('PRIVATE_ROLE'),
    createUserMessage({source:{kind:'user'},content:[{type:'text',text:'earlier small wake'}]}),
    createUserMessage({source:{kind:'user'},content:[{type:'text',text:'本轮'.repeat(28000)}]}),
  ]};
  const before=JSON.stringify(input);assert.equal(await compactor.project(input,f.wake),input);
  assert.equal(JSON.stringify(input),before);assert.ok(summaries>0);
  assert.ok(f.logs.some(s=>s.includes('替换后无法进一步缩小')));
});

test('concurrent members share exactly one neutral public summary and private data never enters its prompt',async()=>{
  const f=fixture(),seen:NativeGenerateOptions[]=[];let release!:()=>void;
  const held=new Promise<void>(r=>release=r);
  const service=new PublicSummary(async(options,p)=>{seen.push(options);assert.equal(p.model,'neutral-model');assert.equal(options.system,PUBLIC_SUMMARY_SYSTEM);assert.equal(options.maxTokens,9000);assert.equal(options.timeoutMs,600000);assert.equal(options.tools,undefined);assert.doesNotMatch(JSON.stringify(options),/PRIVATE_|member-model/);await held;return reply();});
  const a=service.prepare(f.wake,false,()=>{}),b=service.prepare({...f.wake,sessionId:'other-private',participant:{...f.wake.participant,id:'b',role:'OTHER_PERSONA'}},false,()=>{});
  release();const [first,second]=await Promise.all([a,b]);
  assert.deepEqual(first,second);assert.equal(seen.length,2,'public source is two bounded chunks, each generated once for both members');assert.equal(f.reservations.length,2);assert.equal(f.settlements.length,2);
  assert.equal(first.historySummary!.throughSeq,70);assert.equal(first.messages.length,20);assert.ok(f.logs.some(s=>s.includes('全群复用')));
});

test('public memory survives restart, batches small additions, updates incrementally and isolates rooms/models/source edits',async t=>{
  const root=resolve('.test-artifacts');mkdirSync(root,{recursive:true});const dir=mkdtempSync(join(root,'public-summary-'));
  t.after(()=>{assert.equal(dirname(realpathSync(dir)),realpathSync(root));rmSync(dir,{recursive:true,force:true});});
  const f=fixture(),requests:NativeGenerateOptions[]=[];const generate:NativeGenerate=async o=>{requests.push(o);return reply();};
  const first=await new PublicSummary(generate,dir).prepare(f.wake,false,()=>{}),calls=requests.length;
  const service=new PublicSummary(generate,dir);assert.deepEqual(await service.prepare(f.wake,false,()=>{}),first);assert.equal(requests.length,calls);
  f.messages.push({seq:91,id:'new-small',author:'我',kind:'user',content:'新意见'});await service.prepare(f.wake,false,()=>{});assert.equal(requests.length,calls,'small additions remain verbatim');
  for(let i=92;i<130;i++)f.messages.push({seq:i,id:`new-${i}`,author:'我',kind:'user',content:'新'.repeat(1000)});
  await service.prepare(f.wake,false,()=>{});assert.ok(requests.length>calls);assert.doesNotMatch(JSON.stringify(requests[calls].messages),/公开-0:/);assert.match(JSON.stringify(requests[calls].messages),/previousSummary/);
  let count=requests.length;await service.prepare({...f.wake,group:{...f.wake.group,id:'other-room'}},false,()=>{});assert.ok(requests.length>count);
  count=requests.length;f.messages[0].content='修改后的公开源';await service.prepare(f.wake,false,()=>{});assert.ok(requests.length>count,'edited source invalidates saved prefix');
  count=requests.length;const old=f.wake.summaryWake!;f.wake.summaryWake=()=>{const w=old();return {...w,provider:{...w.provider,model:'different-model'}};};await service.prepare(f.wake,false,()=>{});assert.ok(requests.length>count);
});

test('failed public summary is not regenerated by each member in the same run; explicit continue can retry',async()=>{
  const f=fixture();let calls=0;const service=new PublicSummary(async()=>{calls++;throw new ModelCallError('测试失败');});
  const before=JSON.stringify(f.messages);
  const results=await Promise.allSettled([service.prepare(f.wake,false,()=>{}),service.prepare({...f.wake,sessionId:'peer'},false,()=>{})]);assert.ok(results.every(r=>r.status==='rejected'));
  await assert.rejects(service.prepare(f.wake,false,()=>{}),/测试失败/);assert.equal(calls,1);assert.equal(f.settlements.length,1);assert.equal(JSON.stringify(f.messages),before);
  f.wake.summaryCycle='explicit-continue';await assert.rejects(service.prepare(f.wake,false,()=>{}));assert.equal(calls,2);
});

test('budget admission can recover without caching a nonexistent model failure',async()=>{
  const f=fixture();let calls=0;const reserve=f.wake.reserve;
  f.wake.reserve=()=>{throw new ModelCallError('等待在途结算');};
  const service=new PublicSummary(async()=>{calls++;return reply();});
  await assert.rejects(service.prepare(f.wake,false,()=>{}),/等待在途结算/);assert.equal(calls,0);
  f.wake.reserve=reserve;const result=await service.prepare(f.wake,false,()=>{});assert.ok(result.historySummary);assert.equal(calls,2);
});

test('public timeout is labelled as summary generation and keeps unknown usage reserved',async t=>{
  const f=fixture(),timeout=new AbortController();let requested:number|undefined;
  t.mock.method(AbortSignal,'timeout',(ms:number)=>{requested=ms;queueMicrotask(()=>timeout.abort(new DOMException('fixture','TimeoutError')));return timeout.signal;});
  const service=new PublicSummary(async options=>{await new Promise<void>((_resolve,reject)=>options.signal!.addEventListener('abort',()=>reject(options.signal!.reason),{once:true}));return reply();});
  await assert.rejects(service.prepare(f.wake,false,()=>{}),/公共摘要生成超过 600 秒/);assert.equal(requested,600000);assert.deepEqual(f.settlements,[undefined]);assert.ok(f.logs.some(s=>s.includes('未自动重试')));
});

test('partial progress is durable and cancellation or malformed output cannot install a public summary',async t=>{
  const root=resolve('.test-artifacts');mkdirSync(root,{recursive:true});const dir=mkdtempSync(join(root,'public-progress-'));
  t.after(()=>{assert.equal(dirname(realpathSync(dir)),realpathSync(root));rmSync(dir,{recursive:true,force:true});});
  const f=fixture();let calls=0,admissions=0;const generate:NativeGenerate=async()=>{calls++;return reply();};
  await assert.rejects(new PublicSummary(generate,dir).prepare(f.wake,false,()=>{if(++admissions>1)throw new ModelCallError('摘要批次保护');}),/批次保护/);assert.equal(calls,1);
  await new PublicSummary(generate,dir).prepare(f.wake,false,()=>{});assert.equal(calls,2);
  const g=fixture();await assert.rejects(new PublicSummary(async()=>{g.controller.abort();return reply();}).prepare(g.wake,false,()=>{}));assert.equal(g.settlements.length,1);
  for(const bad of ['', '超'.repeat(5000)]){const h=fixture();await assert.rejects(new PublicSummary(async()=>({...reply(),blocks:[{type:'text',text:bad}]})).prepare(h.wake,false,()=>{}),/为空、过长/);assert.equal(h.settlements.length,1);}
});

test('private context projection reuses shared public memory without sending personas, drafts or old tool history to the summarizer',async()=>{
  const f=fixture(),requests:NativeGenerateOptions[]=[];
  const compactor=new ContextCompactor(async o=>{requests.push(o);assert.equal(o.system,PUBLIC_SUMMARY_SYSTEM);assert.doesNotMatch(JSON.stringify(o),/PRIVATE_|DRAFT_SECRET/);return reply();});
  const input:GenerateOptions={provider:'deepseek',model:'member-model',sessionId:SessionId('private-a'),system:'PRIVATE_SYSTEM',messages:[createSystemMessage('PRIVATE_ROLE'),...Array.from({length:8},(_,i)=>createUserMessage({source:{kind:'user'},content:[{type:'text',text:`DRAFT_SECRET-${i}:`+'私'.repeat(12000)}]})),createUserMessage({source:{kind:'user'},content:[{type:'text',text:'CURRENT_PRIVATE_TURN'}]})],maxTokens:10000};
  const before=JSON.stringify(input),result=await compactor.project(input,f.wake);assert.equal(JSON.stringify(input),before);assert.equal(result.messages[0],input.messages[0]);assert.equal(result.messages.at(-1),input.messages.at(-1));assert.equal(result.system,input.system);assert.match(contextPayload(result),/public-context-summary/);assert.ok(Buffer.byteLength(contextPayload(result))<160000);
  const count=requests.length;await compactor.project({...input,sessionId:SessionId('private-b')},{...f.wake,sessionId:'private-b',participant:{...f.wake.participant,id:'b',role:'PRIVATE_B'}});assert.equal(requests.length,count);
});
