import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAssistantMessage,createSystemMessage,createToolResultMessage,createUserMessage,ToolCallId,type GenerateOptions} from '@deepseek-ai/dsh-llm';
import {SessionId} from '@deepseek-ai/dsh-session';
import {ContextCompactor,CONTEXT_LIMITS,contextPayload} from '../server/runtime-adapters/context-compaction.js';
import type {RuntimeWake} from '../server/runtime-adapters/types.js';
import type {NativeGenerate} from '../server/runtime-adapters/native-model.js';
import {nativeRequest} from '../server/runtime-adapters/native-model.js';
import {ModelCallError,ModelResponseError,ProviderRequestError} from '../server/model-errors.js';
import {defaultSettings,type Group,type Participant,type ProviderConfig} from '../shared/types.js';
import type {LogInput} from '../shared/room-journal.js';
import {prepareDelivery} from '../server/runtime-adapters/delivery-context.js';
import type {Delivery} from '../server/runtime-adapters/types.js';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,realpathSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';

const provider:ProviderConfig={id:'openai',name:'fixture',model:'fixture-model',region:'cn',enabled:true,hasKey:true,inputPrice:1,outputPrice:2};
const participant:Participant={id:'a',name:'成员甲',providerId:'openai',model:'fixture-model',role:'PRIVATE_MEMBER_A',identityMode:'role',avatar:'甲',color:'#000000',enabled:true};
function fixture(session='test-session',person=participant,groupId='test-room'){
  const reservations:{id:string;input:number;output:number}[]=[],settlements:{id:string;usage?:{inputTokens:number;outputTokens:number}}[]=[],logs:LogInput[]=[];
  const controller=new AbortController();
  const group:Group={id:groupId,name:'演示讨论',goal:'公开议题',createdAt:'2026-01-01',updatedAt:'2026-01-01',archived:false,participants:[person],settings:{...defaultSettings,maxOutputTokens:2048,budgetUSD:0}};
  const wake:RuntimeWake={sessionId:session,group,participant:person,provider,signal:controller.signal,firstWake:false,skills:[],apiKey:'local-fixture-no-network',
    assertActive:()=>controller.signal.throwIfAborted(),activity:()=>{},log:entry=>logs.push(entry),
    reserve:(input,output)=>{const id=String(reservations.length+1);reservations.push({id,input,output});return id;},
    settle:(id,usage)=>settlements.push({id,usage}),read:()=>({messages:[],readThroughSeq:0,more:false}),post:()=>{throw new Error('compaction must not publish');},wait:()=>{},attention:()=>{},loadSkill:()=>{}};
  return {wake,reservations,settlements,logs,controller};
}
function turn(index:number,textLength=6000):GenerateOptions['messages']{
  const callId=ToolCallId(`call-${index}`);
  return [
    createUserMessage({source:{kind:'user'},content:[{type:'text',text:JSON.stringify({type:'room-wakeup',messages:[{id:`public-${index}`,author:'其他成员',content:`公开观点-${index}：`+'讨论'.repeat(textLength/2)}]})}]}),
    createAssistantMessage({source:{provider:'openai',model:'fixture-model',replayState:{response:{kind:'teahouse-openai-v1',items:[{type:'reasoning',encrypted_content:'OPAQUE_BLOB_SECRET'+'r'.repeat(3000)},{type:'function_call',call_id:callId,name:'post_message',arguments:JSON.stringify({content:`本人已发表的观点-${index}`})}]}}},content:[{type:'reasoning',text:'HIDDEN_REASONING_SECRET'+'r'.repeat(3000)},{type:'tool-call',id:callId,name:'post_message',arguments:JSON.stringify({content:`本人已发表的观点-${index}`})}]}),
    createToolResultMessage({callId,content:[{type:'text',text:JSON.stringify({published:true,messageId:`own-${index}`})}],isError:false}),
  ];
}
function history(count=12):GenerateOptions{
  return {provider:'openai',model:'fixture-model',sessionId:SessionId('test-session'),messages:[createSystemMessage('CURRENT_SYSTEM_AND_PERSONA'),...Array.from({length:count},(_,i)=>turn(i)).flat(),createUserMessage({source:{kind:'user'},content:[{type:'text',text:'最新公开消息，请继续讨论。'}]})],tools:[{name:'post_message',description:'群聊发言',parameters:{type:'object'}}],maxTokens:2048};
}
const reply=()=>({blocks:[{type:'text' as const,text:'各方正在讨论一个待验证的方案，尚无一致结论。甲维持先做小规模实验的立场；下一步需要检验适用条件。'}],inputTokens:1234,outputTokens:67});

test('every summary path uses the live 8000-token setting including reasoning and respects budget clipping',async t=>{
  for(const path of ['private','public','fragments','cached'] as const)for(const allowance of [8000,3000])await t.test(`${path}: ${allowance}`,async()=>{
    const f=fixture();f.wake.group.settings.maxOutputTokens=8000;
    f.wake.provider={...provider,id:'deepseek'};
    f.wake.outputLimit=ticket=>{assert.ok(f.reservations.some(r=>r.id===ticket));return allowance;};
    let calls=0;
    const compactor=new ContextCompactor(async(options,p)=>{
      calls++;assert.equal(options.maxTokens,allowance);
      assert.equal(nativeRequest(options,p,'fixture-key').body.max_tokens,allowance);
      return {...reply(),outputTokens:2100}; // Reasoning may exceed 1024 while the summary stays short.
    });
    const input=history();input.maxTokens=1024;const before=JSON.stringify(input);
    if(path==='private')await compactor.project(input,f.wake);
    else if(path==='public'){backlog(f,100,1200);await prepareDelivery(f.wake,compactor,()=>{});}
    else if(path==='fragments')await compactor.summarizeRecords([{text:'议'.repeat(60000)}],input,f.wake,()=>{});
    else {await compactor.summarizeCached(input,f.wake,()=>{});await compactor.summarizeCached(input,f.wake,()=>{});assert.equal(calls,1);}
    assert.ok(calls>0);assert.ok(f.reservations.every(r=>r.output===8000));
    assert.equal(f.settlements.length,calls);assert.ok(f.settlements.every(s=>s.usage?.outputTokens===2100));
    assert.equal(JSON.stringify(input),before);
    assert.ok(f.logs.some(l=>l.summary.includes(`群设置 8000 Token，本次可用 ${allowance} Token`)));
  });
});

test('summary limit errors report configured and allocated budgets, settle once and do not retry or cache a failure',async()=>{
  for(const allowance of [8000,3000]){
    const f=fixture();f.wake.group.settings.maxOutputTokens=8000;f.wake.outputLimit=()=>allowance;
    let calls=0,fail=true;
    const compactor=new ContextCompactor(async()=>{
      calls++;if(fail)throw new ModelResponseError('旧的通用上限提示','output_limit',{inputTokens:50,outputTokens:allowance});return reply();
    });
    const input=history(),before=JSON.stringify(input);
    await assert.rejects(compactor.summarizeCached(input,f.wake,()=>{}),error=>{
      assert.ok(error instanceof ModelCallError);
      assert.match(error.message,new RegExp(`群设置 8000 Token，本次摘要输出预算 ${allowance} Token`));
      assert.doesNotMatch(error.message,/旧的通用上限提示|新开一场讨论/);
      assert.equal(error.message.includes('剩余预算压低'),allowance<8000);return true;
    });
    assert.equal(calls,1);assert.deepEqual(f.settlements,[{id:'1',usage:{inputTokens:50,outputTokens:allowance}}]);
    assert.equal(JSON.stringify(input),before);
    fail=false;await compactor.summarizeCached(input,f.wake,()=>{});assert.equal(calls,2);
    await compactor.summarizeCached(input,f.wake,()=>{});assert.equal(calls,2);
  }
});

function backlog(f:ReturnType<typeof fixture>,count:number,chars=1400){
  const messages:Delivery['messages']=Array.from({length:count},(_,i)=>({id:`public-${i}`,seq:i+1,author:'群友',kind:'user',senderKind:'human',content:`观点-${i}:`+'议'.repeat(chars)}));
  let cursor=0;
  f.wake.read=(limit=12)=>{const batch=messages.slice(cursor,cursor+limit);cursor+=batch.length;return {messages:batch,readThroughSeq:cursor,more:cursor<messages.length};};
  return messages;
}

test('unread history batches without model pagination and summarizes only old public records, preserving recent whole speeches',async()=>{
  const f=fixture(),messages=backlog(f,100,1200),original=JSON.stringify(messages),calls:GenerateOptions[]=[];
  // The retained boundary falls inside this speech; retain all three segments.
  for(let i=78;i<=80;i++)messages[i].speech={id:'retained-speech',index:i-77,total:3,state:'complete'};
  const before=JSON.stringify(messages);
  const compactor=new ContextCompactor(async options=>{calls.push(options);assert.equal(options.tools,undefined);assert.ok(Buffer.byteLength(contextPayload(options))<=CONTEXT_LIMITS.summaryInputBytes);assert.doesNotMatch(JSON.stringify(options.messages),/PRIVATE_MEMBER_A|fixture-no-network/);return reply();});
  let summaries=0;const result=await prepareDelivery(f.wake,compactor,()=>{assert.ok(++summaries<=3);});
  assert.equal(result.more,false);assert.equal(result.readThroughSeq,100);assert.equal(result.historySummary?.messageCount,78);assert.deepEqual(result.messages,messages.slice(78));
  assert.equal(JSON.stringify(messages),before);assert.notEqual(before,original);assert.equal(calls.length,summaries);assert.ok(summaries>=2);assert.equal(f.settlements.length,summaries);
  assert.match(JSON.stringify(calls[1].messages),/previousSummary/);assert.ok(f.logs.some(l=>l.summary.includes('历史消息已批量整理')));
  const small=fixture(),short=backlog(small,99,10);let charged=false;
  const batch=await prepareDelivery(small.wake,compactor,()=>{charged=true;});assert.deepEqual(batch.messages,short);assert.equal(batch.historySummary,undefined);assert.equal(charged,false);
});

test('delivery summary failure, bounded admission and stalled server cursor stop rather than lose history or loop',async()=>{
  const f=fixture(),messages=backlog(f,100),before=JSON.stringify(messages);
  await assert.rejects(prepareDelivery(f.wake,new ContextCompactor(async()=>{throw new ProviderRequestError('拒绝','auth',401,true);}),()=>{}),/拒绝/);
  assert.equal(JSON.stringify(messages),before);assert.equal(f.settlements.length,1);
  const g=fixture();backlog(g,100);let calls=0;
  await assert.rejects(prepareDelivery(g.wake,new ContextCompactor(async()=>{calls++;return reply();}),()=>{throw new ModelCallError('摘要次数保护');}),/摘要次数保护/);assert.equal(calls,0);assert.equal(g.reservations.length,0);
  const stalled=fixture();stalled.wake.read=()=>({messages:[],readThroughSeq:0,more:true});
  await assert.rejects(prepareDelivery(stalled.wake,new ContextCompactor(async()=>reply()),()=>{}),/读取没有进展/);
});
function balanced(options:GenerateOptions){
  const pending=new Set<string>();
  for(const message of options.messages){
    if(message.role==='assistant')for(const block of message.content)if(block.type==='tool-call')pending.add(block.id);
    if(message.role==='tool')assert.ok(pending.delete(message.toolCallId),'orphan tool result');
  }
  assert.equal(pending.size,0);
}

test('long private history projects to a bounded summary and intact recent tool/replay turns, charging once and preserving originals',async()=>{
  const f=fixture(),input=history(),original=JSON.stringify(input),calls:GenerateOptions[]=[];
  const compactor=new ContextCompactor(async options=>{calls.push(options);assert.equal(options.tools,undefined);assert.equal(options.toolHistory,undefined);assert.ok(Buffer.byteLength(contextPayload(options))<=CONTEXT_LIMITS.summaryInputBytes);assert.equal(options.maxTokens,f.wake.group.settings.maxOutputTokens);const source=JSON.stringify(options.messages);assert.doesNotMatch(source,/HIDDEN_REASONING_SECRET|OPAQUE_BLOB_SECRET|replayState|CURRENT_SYSTEM_AND_PERSONA/);return reply();});
  let admission=0;const projected=await compactor.project(input,f.wake,()=>{admission++;});
  assert.ok(calls.length>=1);assert.equal(admission,calls.length);assert.equal(f.reservations.length,calls.length);assert.equal(f.settlements.length,calls.length);
  assert.ok(f.reservations.every(r=>r.input>100&&r.output===f.wake.group.settings.maxOutputTokens));assert.deepEqual(f.settlements[0].usage,{inputTokens:1234,outputTokens:67});
  assert.ok(Buffer.byteLength(contextPayload(projected))<CONTEXT_LIMITS.triggerBytes);assert.equal(JSON.stringify(input),original);
  assert.equal(projected.messages[0],input.messages[0]);assert.equal(projected.tools,input.tools);assert.deepEqual(projected.messages.slice(-7),input.messages.slice(-7));balanced(projected);
  const wire=JSON.stringify(nativeRequest(projected,provider,'fixture-key').body);assert.match(wire,/CURRENT_SYSTEM_AND_PERSONA/);assert.match(wire,/private-context-summary/);assert.match(wire,/OPAQUE_BLOB_SECRET/);
  assert.ok(f.logs.some(log=>log.kind==='model'&&log.summary.includes('上下文摘要')&&log.inputTokens===1234));assert.ok(f.logs.every(log=>!log.reasoning));
  const before=calls.length;assert.deepEqual((await compactor.project(input,f.wake)).messages,projected.messages);assert.equal(calls.length,before,'validated cache should not incur another summary call');
});

test('summary cache is isolated by session, group, persona and source prefix, and grows incrementally',async()=>{
  const calls:GenerateOptions[]=[];const compactor=new ContextCompactor(async options=>{calls.push(options);return reply();});
  const input=history(),f=fixture();await compactor.project(input,f.wake);let count=calls.length;
  const extended={...input,messages:[...input.messages.slice(0,-1),...Array.from({length:5},(_,i)=>turn(i+20)).flat(),input.messages.at(-1)!]};
  await compactor.project(extended,f.wake);assert.ok(calls.length>count);assert.match(JSON.stringify(calls[count].messages),/previousSummary/);assert.ok((JSON.parse((calls[count].messages[0].content[0] as {text:string}).text)).previousSummary);
  for(const alternative of [fixture('other-session'),fixture('test-session',{...participant,id:'b',role:'PRIVATE_MEMBER_B'}),fixture('test-session',participant,'other-room')]){count=calls.length;await compactor.project(input,alternative.wake);assert.ok(calls.length>count);assert.equal(JSON.parse((calls[count].messages[0].content[0] as {text:string}).text).previousSummary,null);}
  const changed={...input,messages:[...input.messages]};changed.messages[1]=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'changed prefix '+ '新'.repeat(6000)}]});count=calls.length;
  await compactor.project(changed,f.wake);assert.ok(calls.length>count);assert.equal(JSON.parse((calls[count].messages[0].content[0] as {text:string}).text).previousSummary,null);
  compactor.clear();count=calls.length;await compactor.project(input,f.wake);assert.ok(calls.length>count);
});

test('compaction failures retain exact originals, settle partial usage, never log summary reasoning and allow a later retry',async()=>{
  const f=fixture(),input=history(),original=JSON.stringify(input);let fail=true;
  const compactor=new ContextCompactor(async()=>{if(fail)throw new ModelResponseError('达到输出上限','output_limit',{inputTokens:456,outputTokens:1024},{text:'SUMMARY_REASONING_SECRET',label:'not-public'});return reply();});
  await assert.rejects(compactor.project(input,f.wake),error=>error instanceof ModelCallError&&!(error instanceof ModelResponseError)&&error.message.includes('原始历史已保留'));
  assert.equal(JSON.stringify(input),original);assert.deepEqual(f.settlements,[{id:'1',usage:{inputTokens:456,outputTokens:1024}}]);assert.doesNotMatch(JSON.stringify(f.logs),/SUMMARY_REASONING_SECRET/);
  fail=false;assert.ok((await compactor.project(input,f.wake)).messages.length<input.messages.length);
});

test('empty/tool/oversized summaries and cancelled generation never replace history',async()=>{
  const malformed=[{blocks:[]},{blocks:[{type:'tool-call' as const,id:ToolCallId('bad'),name:'post_message',arguments:'{}'}]},{blocks:[{type:'text' as const,text:'超'.repeat(5000)}]}];
  for(const bad of malformed){const f=fixture(),input=history(),before=JSON.stringify(input);await assert.rejects(new ContextCompactor(async()=>({...bad,inputTokens:2,outputTokens:2})).project(input,f.wake),/摘要/);assert.equal(JSON.stringify(input),before);assert.equal(f.settlements.length,1);}
  const f=fixture(),input=history(),before=JSON.stringify(input);await assert.rejects(new ContextCompactor(async()=>{f.controller.abort();return reply();}).project(input,f.wake));assert.equal(JSON.stringify(input),before);assert.equal(f.settlements.length,1);
});

test('demo skips compaction; denied admission/budget and provider rejections never make unaccounted calls',async()=>{
  let calls=0;const generate:NativeGenerate=async()=>{calls++;return reply();};const compactor=new ContextCompactor(generate),input=history();
  for(const p of [{...provider,id:'demo' as const}]){const f=fixture();f.wake.provider=p;assert.equal(await compactor.project(input,f.wake),input);assert.equal(f.reservations.length,0);}
  const f=fixture();await assert.rejects(compactor.project(input,f.wake,()=>{throw new ModelCallError('5 次调用上限');}),/5 次/);assert.equal(f.reservations.length,0);assert.equal(calls,0);
  f.wake.reserve=()=>{throw new ModelCallError('预算不足');};await assert.rejects(compactor.project(input,f.wake),/预算不足/);assert.equal(calls,0);
  const rejected=fixture();await assert.rejects(new ContextCompactor(async()=>{throw new ProviderRequestError('拒绝','auth',401,true);}).project(input,rejected.wake),/拒绝/);assert.deepEqual(rejected.settlements,[{id:'1',usage:{inputTokens:0,outputTokens:0}}]);
});

test('a single oversized or unbalanced current turn is never cut to fit',async()=>{
  const f=fixture();let calls=0;const compactor=new ContextCompactor(async()=>{calls++;return reply();});
  const huge:GenerateOptions={...history(0),messages:[createSystemMessage('protected'),...turn(100,100000)]};
  await assert.rejects(compactor.project(huge,f.wake),/当前请求仍过长/);assert.equal(calls,0);
  const invalid=history();invalid.messages.splice(3,1);await assert.rejects(compactor.project(invalid,f.wake),/当前请求仍过长/);assert.equal(calls,0);
});

test('short requests are unchanged and the bounded cache evicts old sessions without crossing identities',async()=>{
  let calls=0;const compactor=new ContextCompactor(async()=>{calls++;return reply();});const short=history(1);
  assert.equal(await compactor.project(short,fixture().wake),short);assert.equal(calls,0);
  const long=history();await compactor.project(long,fixture('first').wake);
  for(let i=0;i<CONTEXT_LIMITS.maxSessions;i++)await compactor.project(long,fixture(`session-${i}`).wake);
  let before=calls;await compactor.project(long,fixture(`session-${CONTEXT_LIMITS.maxSessions-1}`).wake);assert.equal(calls,before);
  before=calls;await compactor.project(long,fixture('first').wake);assert.ok(calls>before,'evicted sessions rebuild from their own original history');
});

test('subscription and API recover consecutive failed broadcasts and relax three-wake retention without losing latest content',async()=>{
  const broadcast=(n:number)=>createUserMessage({source:{kind:'user'},content:[{type:'text',text:`消息-${n}:`+'议'.repeat(26000)}]});
  for(const subscription of [false,true]){
    const f=fixture();if(subscription)f.wake.provider={...provider,billingMode:'subscription'};
    const input={...history(0),messages:[createSystemMessage('protected'),broadcast(1),broadcast(2),broadcast(2),broadcast(3)]};const before=JSON.stringify(input);let calls=0;
    const compact=new ContextCompactor(async(_options,p)=>{assert.equal(p.billingMode,subscription?'subscription':undefined);calls++;return reply();});
    const result=await compact.project(input,f.wake,()=>{assert.ok(calls<3);});
    assert.ok(calls>=1&&calls<=3);assert.ok(Buffer.byteLength(contextPayload(result))<CONTEXT_LIMITS.triggerBytes);assert.equal(result.messages.at(-1),input.messages.at(-1));assert.equal(JSON.stringify(input),before);
    assert.ok(f.logs.some(l=>l.summary.includes('降至')));
  }
});

test('an oversized completed tool turn is summarized in labelled chunks while latest tools retain valid pairs',async()=>{
  const f=fixture(),large=turn(5,100000),input={...history(0),messages:[createSystemMessage('protected'),...large,...turn(6,1000),createUserMessage({source:{kind:'user'},content:[{type:'text',text:'最新补充不可省略'}]})]};const before=JSON.stringify(input);let calls=0;
  const compact=new ContextCompactor(async options=>{calls++;assert.ok(Buffer.byteLength(contextPayload(options))<=CONTEXT_LIMITS.summaryInputBytes);assert.equal(options.tools,undefined);assert.doesNotMatch(JSON.stringify(options.messages),/HIDDEN_REASONING_SECRET|OPAQUE_BLOB_SECRET/);return reply();});
  const result=await compact.project(input,f.wake,()=>{assert.ok(calls<3);});
  assert.ok(calls>=2);assert.ok(Buffer.byteLength(contextPayload(result))<CONTEXT_LIMITS.triggerBytes);balanced(result);assert.equal(result.messages.at(-1),input.messages.at(-1));assert.equal(JSON.stringify(input),before);
});

test('summary checkpoints and interrupted fragment progress survive restart, remain private and validate source identity',async t=>{
  const root=resolve('.test-artifacts');mkdirSync(root,{recursive:true});const dir=mkdtempSync(join(root,'context-memory-'));t.after(()=>{assert.equal(dirname(realpathSync(dir)),realpathSync(root));rmSync(dir,{recursive:true,force:true});});
  const f=fixture(),input={...history(0),messages:[createSystemMessage('protected'),...turn(50,100000),createUserMessage({source:{kind:'user'},content:[{type:'text',text:'最新补充'}]})]};let calls=0,admissions=0;
  const generate:NativeGenerate=async()=>{calls++;return reply();};
  await assert.rejects(new ContextCompactor(generate,dir).project(input,f.wake,()=>{if(++admissions>1)throw new ModelCallError('本轮整理暂停');}),/整理暂停/);
  assert.equal(calls,1);const restored=await new ContextCompactor(generate,dir).project(input,f.wake);assert.ok(calls<=3,'completed first chunk is not charged again');balanced(restored);
  const savedCalls=calls;await new ContextCompactor(generate,dir).project(input,f.wake);assert.equal(calls,savedCalls,'completed checkpoint survives restart');
  assert.doesNotMatch(readFileSync(join(dir,'context-memory.json'),'utf8'),/HIDDEN_REASONING_SECRET|OPAQUE_BLOB_SECRET|local-fixture-no-network/);
  await new ContextCompactor(generate,dir).project(input,fixture('another-member-session').wake);assert.ok(calls>savedCalls,'never reuse another member session memory');
});
