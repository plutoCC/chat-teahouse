import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, realpathSync, lstatSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { Store } from '../server/store.js';
import { RoomEngine } from '../server/room-engine/engine.js';
import { HarnessRuntime } from '../server/runtime-adapters/harness.js';
import { seedSkills, importInstructionSkill } from '../server/skills.js';
import type { ParticipantRuntime, RuntimeWake } from '../server/runtime-adapters/types.js';
import { nativeRequest, parseNativeReply, type NativeGenerate } from '../server/runtime-adapters/native-model.js';
import type { Message, ProviderConfig } from '../shared/types.js';
import { classifyProviderFailure } from '../server/model-errors.js';

const cloud:ProviderConfig={id:'openai',name:'测试模型',model:'test-a',enabled:true,hasKey:true,region:'cn',inputPrice:1,outputPrice:1};
const waitUntil=async(predicate:()=>boolean)=>{const deadline=Date.now()+10000;while(!predicate()){if(Date.now()>deadline)throw new Error('test condition timed out');await new Promise(r=>setTimeout(r,10));}};
function fixture(t:TestContext,run?:(wake:RuntimeWake)=>Promise<void>,native?:NativeGenerate,timing?:{now?:()=>number;random?:()=>number}) {
  const root=resolve('.test-artifacts');mkdirSync(root,{recursive:true});const dir=mkdtempSync(join(root,'free-chat-'));
  const store=new Store(dir);store.seed([cloud]);seedSkills(store);const group=store.groups()[0];
  group.participants=group.participants.slice(0,2).map((p,i)=>({...p,providerId:'openai' as const,model:`test-${i}`,name:`成员 ${i}`}));
  group.freeSettings={messageGapMin:0,messageGapMax:0,readingCharsPerSecond:0,typingGraceSeconds:0,quietSeconds:0,cooldownMin:0,cooldownMax:0,concurrency:2,maxMinutes:5,wakeProbability:1,respondToAI:true};
  group.settings={...group.settings,budgetUSD:0,maxCalls:30,maxTotalTokens:1000000};store.saveGroup(group);
  const runtime:ParticipantRuntime=run?{run,shutdown:async()=>{}}:new HarnessRuntime(dir,native);
  const engine=new RoomEngine(store,{runtime,providers:()=>[cloud],getKey:()=> 'fixture-key',notify:()=>{},random:()=>0.5,...timing});
  t.after(async()=>{await engine.shutdown();store.close();assert.equal(lstatSync(dir).isSymbolicLink(),false);const target=realpathSync(dir);assert.equal(dirname(target),realpathSync(root));assert.ok(basename(target).startsWith('free-chat-'));rmSync(target,{recursive:true,force:true});});
  const human=(content='补充条件')=>{const msg:Message={id:crypto.randomUUID(),groupId:group.id,author:'我',avatar:'我',color:'#000000',kind:'user',content,reasoning:'',reasoningLabel:'',round:0,status:'complete',createdAt:new Date().toISOString(),inputMessageIds:[],inputTokens:0,outputTokens:0};store.saveMessage(msg);engine.messageArrived(group.id);return msg;};
  return {engine,store,group,human,dir};
}
const tool=(name:string,args:object,id=crypto.randomUUID())=>({blocks:[{type:'tool-call' as const,id:ToolCallId(id),name,arguments:JSON.stringify(args)}],inputTokens:10,outputTokens:10});

test('draft waiting prevents new model admission until clearing plus three seconds, even beyond the old typing grace',async t=>{
  let now=Date.now(),calls=0;const f=fixture(t,async w=>{calls++;w.read();await w.post('输入完成之后再发言',undefined,'draft-admission');},undefined,{now:()=>now});
  f.group.participants=f.group.participants.slice(0,1);f.group.freeSettings={...f.group.freeSettings!,waitForUserDraft:true,messageStyle:'single'};f.store.saveGroup(f.group);
  const clientId=crypto.randomUUID();f.engine.draftPresence(f.group.id,{clientId,sequence:1,hasDraft:true,reason:'edit'});f.engine.start(f.group.id);
  for(let n=2;n<6;n++){now+=20000;f.engine.draftPresence(f.group.id,{clientId,sequence:n,hasDraft:true,reason:'edit'});f.engine.pump(f.group.id);await Promise.resolve();assert.equal(calls,0);}
  f.engine.draftPresence(f.group.id,{clientId,sequence:6,hasDraft:false,reason:'edit'});now+=2999;f.engine.pump(f.group.id);await Promise.resolve();assert.equal(calls,0);
  now++;f.engine.pump(f.group.id);await f.engine.settle(f.group.id);assert.equal(calls,1);assert.equal(f.store.messages(f.group.id).length,1);
});

test('draft waiting blocks an already thinking member and the zero-delay publication fast path',async t=>{
  let finish!:()=>void;const f=fixture(t,async w=>{w.read();await new Promise<void>(r=>{finish=r;});await w.post('准备好的回复',undefined,'draft-queued');});
  f.group.participants=f.group.participants.slice(0,1);f.group.freeSettings={...f.group.freeSettings!,waitForUserDraft:true,messageStyle:'single'};f.store.saveGroup(f.group);f.engine.start(f.group.id);await waitUntil(()=>!!finish);
  const clientId=crypto.randomUUID();f.engine.draftPresence(f.group.id,{clientId,sequence:1,hasDraft:true,reason:'edit'});finish();
  await waitUntil(()=>f.store.freeSession(f.group.id)!.members[0].activity==='等待用户完成输入');assert.equal(f.store.messages(f.group.id).length,0);
  f.engine.draftPresence(f.group.id,{clientId,sequence:2,hasDraft:false,reason:'sent'});await f.engine.settle(f.group.id);assert.equal(f.store.messages(f.group.id).length,1);
});

test('draft waiting pauses an in-flight segmented speech and resumes it after the user submits',async t=>{
  const f=fixture(t,async w=>{w.read();await w.post('第一段，等待参与。\n\n第二段，补充观点。',undefined,'draft-segments');});
  f.group.participants=f.group.participants.slice(0,1);f.group.freeSettings={...f.group.freeSettings!,waitForUserDraft:true,messageStyle:'segmented'};f.store.saveGroup(f.group);f.engine.start(f.group.id);await waitUntil(()=>f.store.messages(f.group.id).length===1);
  const clientId=crypto.randomUUID();f.engine.draftPresence(f.group.id,{clientId,sequence:1,hasDraft:true,reason:'edit'});
  await waitUntil(()=>f.store.freeSession(f.group.id)!.members[0].activity==='等待用户完成输入（连发已暂缓）');assert.equal(f.store.messages(f.group.id).length,1);
  f.engine.draftPresence(f.group.id,{clientId,sequence:2,hasDraft:false,reason:'sent'});await f.engine.settle(f.group.id);assert.equal(f.store.messages(f.group.id).length,2);assert.ok(f.store.messages(f.group.id).every(m=>m.speech?.state==='complete'));
});

test('a completed prose reply is privately corrected into a publish action instead of a fabricated wait',async t=>{
  let calls=0;const draft='我有不同的判断，需要把依据展开。\n\n这里是补充依据。';
  const f=fixture(t,undefined,async options=>{
    if(++calls===1)return parseNativeReply({choices:[{finish_reason:'stop',message:{content:draft,reasoning_content:'PRIVATE_REASONING'}}],usage:{prompt_tokens:31,completion_tokens:47}},{...cloud,id:'doubao'},100,1200);
    assert.equal(f.store.messages(f.group.id).length,0,'draft is not automatically public');
    assert.ok(options.messages.some(m=>m.role==='assistant'&&m.content.some(b=>b.type==='text'&&b.text===draft)),'retain draft for the model to submit');
    assert.ok(options.messages.some(m=>m.role==='user'&&m.content.some(b=>b.type==='text'&&b.text.includes('room-action-required'))));
    return tool('post_message',{content:draft});
  });
  f.group.participants=f.group.participants.slice(0,1);f.store.saveGroup(f.group);f.engine.start(f.group.id);
  await waitUntil(()=>calls>0);await f.engine.settle(f.group.id);
  assert.equal(calls,2);assert.equal(f.store.messages(f.group.id).map(m=>m.content).join('\n\n'),draft);
  const logs=f.store.logs(f.group.id);assert.equal(logs.filter(l=>l.kind==='waiting').length,0);assert.ok(logs.some(l=>l.kind==='protocol'));assert.ok(logs.some(l=>l.kind==='model'&&l.summary.includes('尚未发布')));
  const s=f.store.freeSession(f.group.id)!;assert.equal(s.callCount,2);assert.equal(s.inputTokens,41);assert.equal(s.outputTokens,57);assert.equal(s.reservedTokens,0);
});

test('a second reply without a group action stops visibly, keeps reasoning private, and does not loop',async t=>{
  let calls=0;
  const f=fixture(t,undefined,async()=>{calls++;return {blocks:[{type:'reasoning',text:'PRIVATE_ONLY'}],inputTokens:12,outputTokens:14};});
  f.group.participants=f.group.participants.slice(0,1);f.store.saveGroup(f.group);f.engine.start(f.group.id);
  await waitUntil(()=>calls>0);await f.engine.settle(f.group.id);
  assert.equal(calls,2);assert.match(f.store.freeSession(f.group.id)!.members[0].error!,/未提交.*群聊动作/);
  assert.equal(f.store.messages(f.group.id).length,0);assert.equal(f.store.logs(f.group.id).filter(l=>l.kind==='waiting').length,0);
  f.engine.pump(f.group.id);await f.engine.settle(f.group.id);assert.equal(calls,2);
});

test('an explicit model wait stays a single decision without protocol correction',async t=>{
  let calls=0;
  const f=fixture(t,undefined,async()=>{calls++;return tool('wait_for_messages',{seconds:0,reason:'没有新的依据，先听群友补充。'});});
  f.group.participants=f.group.participants.slice(0,1);f.store.saveGroup(f.group);f.engine.start(f.group.id);
  await waitUntil(()=>calls>0);await f.engine.settle(f.group.id);
  assert.equal(calls,1);assert.equal(f.store.messages(f.group.id).length,0);
  const logs=f.store.logs(f.group.id);assert.equal(logs.filter(l=>l.kind==='protocol').length,0);assert.equal(logs.filter(l=>l.kind==='waiting').length,1);assert.match(logs.find(l=>l.kind==='waiting')!.summary,/没有新的依据/);
});

test('protocol correction cannot exceed the group call budget',async t=>{
  let calls=0;
  const f=fixture(t,undefined,async()=>{calls++;return {blocks:[{type:'text',text:'未提交的草稿'}],inputTokens:10,outputTokens:10};});
  f.group.participants=f.group.participants.slice(0,1);f.group.settings.maxCalls=1;f.store.saveGroup(f.group);f.engine.start(f.group.id);
  await waitUntil(()=>calls>0);await f.engine.settle(f.group.id);
  assert.equal(calls,1);assert.equal(f.store.freeSession(f.group.id)!.callCount,1);assert.equal(f.store.freeSession(f.group.id)!.reservedTokens,0);
  assert.equal(f.store.messages(f.group.id).length,0);assert.equal(f.store.logs(f.group.id).filter(l=>l.kind==='waiting').length,0);
});

test('pause during the correction cancels a late publish without marking it as voluntary waiting',async t=>{
  let calls=0,release!:()=>void;const held=new Promise<void>(r=>release=r);
  const f=fixture(t,undefined,async()=>{
    if(++calls===1)return {blocks:[{type:'text',text:'还没提交的正文'}],inputTokens:10,outputTokens:10};
    await held;return tool('post_message',{content:'暂停后不能发布'});
  });
  f.group.participants=f.group.participants.slice(0,1);f.store.saveGroup(f.group);f.engine.start(f.group.id);
  await waitUntil(()=>calls===2);f.engine.pause(f.group.id);release();await f.engine.settle(f.group.id);
  assert.equal(calls,2);assert.equal(f.store.freeSession(f.group.id)!.status,'paused');assert.equal(f.store.messages(f.group.id).length,0);
  assert.equal(f.store.logs(f.group.id).filter(l=>l.kind==='waiting').length,0);assert.equal(f.store.freeSession(f.group.id)!.reservedTokens,0);
});

test('segmented speech publishes separate bubbles one second apart and peers wait for all parts plus human input',async t=>{
  let peerCalls=0;
  const f=fixture(t,async w=>{
    const delivery=w.read();
    if(w.participant.id==='aaa'){await w.post('第一段：我保留资源稀缺这个判断。\n\n第二段：抽牌需要留出缓冲时间。\n\n第三段：不能把随机抽牌直接变成生死判定。',undefined,'segmented-once');return;}
    peerCalls++;assert.equal(delivery.messages.filter(m=>m.speech).length,3);assert.ok(delivery.messages.some(m=>m.content==='人类中途插话'));assert.ok(delivery.messages.filter(m=>m.speech).every(m=>m.speech!.state==='complete'));
    await w.post('我对第三段有不同意见：代价也可以是损失进度。',undefined,'peer-reply');
  });
  f.group.participants[0].id='aaa';f.group.participants[1].id='bbb';f.group.freeSettings={...f.group.freeSettings!,messageStyle:'segmented',concurrency:1};f.group.settings.maxCalls=1;f.store.saveGroup(f.group);f.engine.start(f.group.id);
  await waitUntil(()=>f.store.messages(f.group.id).length===1);assert.equal(f.store.freeSession(f.group.id)!.sending?.sent,1);f.human('人类中途插话');f.engine.pump(f.group.id);assert.equal(peerCalls,0);
  await waitUntil(()=>peerCalls===1);await f.engine.settle(f.group.id);
  const messages=f.store.messages(f.group.id),parts=messages.filter(m=>m.participantId==='aaa');assert.equal(parts.length,3);assert.deepEqual(parts.map(m=>m.speech!.index),[1,2,3]);
  assert.equal(new Set(parts.map(m=>m.speech!.id)).size,1);for(let i=1;i<parts.length;i++)assert.ok(Date.parse(parts[i].createdAt)-Date.parse(parts[i-1].createdAt)>=950);
  assert.equal(messages.at(-1)!.participantId,'bbb');assert.equal(f.store.freeSession(f.group.id)!.publishedCount,4);assert.equal(f.store.freeSession(f.group.id)!.sending,undefined);
  f.engine.pause(f.group.id);
});

test('segmented reading pace follows the preceding bubble and leaves time for the final bubble only',async t=>{
  const first='甲'.repeat(90),last='乙'.repeat(120);
  const f=fixture(t,async w=>{w.read();if(w.participant.id==='aaa')await w.post(first+'\n\n'+last,undefined,'reader');else await w.post('我读完了再接话',undefined,'peer');});
  f.group.participants[0].id='aaa';f.group.participants[1].id='bbb';
  f.group.freeSettings={...f.group.freeSettings!,messageStyle:'segmented',readingCharsPerSecond:60,concurrency:1};f.store.saveGroup(f.group);
  f.engine.start(f.group.id);await waitUntil(()=>f.store.messages(f.group.id).length===2);
  const [a,b]=f.store.messages(f.group.id);assert.ok(Date.parse(b.createdAt)-Date.parse(a.createdAt)>=1450);
  const next=f.store.freeSession(f.group.id)!.nextPublishAt!;assert.ok(next-Date.parse(b.createdAt)>=1950);assert.ok(next-Date.parse(b.createdAt)<2300,'only the final bubble is charged after sending');
  await waitUntil(()=>f.store.messages(f.group.id).length===3);assert.ok(Date.parse(f.store.messages(f.group.id)[2].createdAt)-Date.parse(b.createdAt)>=1950);
  f.engine.pause(f.group.id);await f.engine.settle(f.group.id);
});

test('pause immediately cancels the longer per-bubble reading delay',async t=>{
  const f=fixture(t,async w=>{w.read();await w.post('甲'.repeat(100)+'\n\n剩余部分不应发出',undefined,'slow-reader');});
  f.group.participants=f.group.participants.slice(0,1);f.group.freeSettings={...f.group.freeSettings!,messageStyle:'segmented',readingCharsPerSecond:1};f.store.saveGroup(f.group);
  f.engine.start(f.group.id);await waitUntil(()=>f.store.messages(f.group.id).length===1);
  const pausedAt=Date.now();f.engine.pause(f.group.id);await f.engine.settle(f.group.id);
  assert.ok(Date.now()-pausedAt<1000);assert.equal(f.store.messages(f.group.id).length,1);assert.equal(f.store.messages(f.group.id)[0].speech!.state,'interrupted');
});

test('a ready reply waits for a whole peer speech without being discarded and unread peers remain pending',async t=>{
  let peer!:RuntimeWake,release!:()=>void,published=false,resuming=false,deliveredOnResume:string[]=[];
  const held=new Promise<void>(r=>release=r);
  const f=fixture(t,async w=>{
    const delivery=w.read();
    if(resuming){if(w.participant.id==='bbb')deliveredOnResume=delivery.messages.map(m=>m.content);w.wait(0);return;}
    if(w.participant.id==='aaa'){await w.post('先提出判断。\n\n再给出依据。\n\n最后说明边界。',undefined,'speech');return;}
    peer=w;await held;
    const half=w.read();assert.equal(half.messages.length,0);assert.equal(half.pendingSpeech?.memberId,'aaa');
    await w.post('我基于之前读到的消息，有一个独立的观点。',undefined,'ready-reply');published=true;
  });
  f.group.participants[0].id='aaa';f.group.participants[1].id='bbb';f.group.freeSettings={...f.group.freeSettings!,messageStyle:'segmented',cooldownMin:300,cooldownMax:300};f.store.saveGroup(f.group);f.engine.start(f.group.id);
  await waitUntil(()=>!!peer&&f.store.messages(f.group.id).length===1);release();
  await waitUntil(()=>f.store.freeSession(f.group.id)!.members.find(m=>m.id==='bbb')!.status==='queued');assert.equal(published,false);
  await waitUntil(()=>published);await f.engine.settle(f.group.id);
  assert.deepEqual(f.store.messages(f.group.id).map(m=>m.participantId),['aaa','aaa','aaa','bbb']);
  const state=f.store.freeSession(f.group.id)!.members.find(m=>m.id==='bbb')!;assert.equal(state.acknowledgedSeq,0,'do not acknowledge unseen messages just because the reply published');
  f.engine.pause(f.group.id);resuming=true;f.store.mutateFree(f.group.id,s=>{for(const m of s.members)m.cooldownUntil=0;});f.engine.start(f.group.id);await waitUntil(()=>deliveredOnResume.length>0);await f.engine.settle(f.group.id);f.engine.pause(f.group.id);
  assert.deepEqual(deliveredOnResume.slice(0,3),['先提出判断。','再给出依据。','最后说明边界。']);
});

test('a slow Harness model publishes its first prepared reply even when a faster peer finished during generation',async t=>{
  let slowStarted=false,releaseFast!:()=>void,releaseSlow!:()=>void;
  const fast=new Promise<void>(r=>releaseFast=r),slow=new Promise<void>(r=>releaseSlow=r),calls=new Map<string,number>();
  const f=fixture(t,undefined,async options=>{
    calls.set(options.model,(calls.get(options.model)??0)+1);
    const aborted=new Promise<void>(done=>options.signal?.addEventListener('abort',()=>done(),{once:true}));
    if(options.model==='test-0'){await Promise.race([fast,aborted]);return tool('post_message',{content:'我先提出一个判断。\n\n再提供完整的依据。'});}
    slowStarted=true;await Promise.race([slow,aborted]);return tool('post_message',{content:'我有另一条独立的论证路径。'});
  });
  t.after(()=>{releaseFast();releaseSlow();});
  f.group.participants[0].id='aaa';f.group.participants[1].id='bbb';f.group.freeSettings={...f.group.freeSettings!,messageStyle:'segmented',cooldownMin:300,cooldownMax:300};f.store.saveGroup(f.group);
  f.engine.start(f.group.id);await waitUntil(()=>slowStarted);releaseFast();await waitUntil(()=>f.store.messages(f.group.id).length===2&&!f.store.freeSession(f.group.id)!.sending);
  releaseSlow();await waitUntil(()=>f.store.messages(f.group.id).length===3);await f.engine.settle(f.group.id);
  assert.deepEqual([...calls.values()],[1,1],'no extra read/rewrite model calls just because a peer was faster');
  assert.equal(f.store.messages(f.group.id).at(-1)!.participantId,'bbb');assert.equal(f.store.freeSession(f.group.id)!.members.find(m=>m.id==='bbb')!.acknowledgedSeq,0);f.engine.pause(f.group.id);
});

test('partially paginated peer speeches still require reading the rest before publishing',async t=>{
  let checked=false;
  const f=fixture(t,async w=>{
    const first=w.read(2);assert.equal(first.more,true);assert.equal(first.messages.length,2);assert.equal(first.messages.at(-1)!.senderKind,'human');
    assert.throws(()=>w.post('只读了第一段的过早回复',undefined,'partial'),/尚未读完整/);
    assert.equal(f.store.freeSession(f.group.id)!.members[0].status,'thinking');
    assert.equal(w.read().messages.length,2);await w.post('读完三段后的完整回复',undefined,'complete');checked=true;
  });
  f.group.participants=f.group.participants.slice(0,1);f.store.saveGroup(f.group);
  for(let i=1;i<=3;i++){
    f.store.saveMessage({id:crypto.randomUUID(),groupId:f.group.id,participantId:'other',author:'其他成员',avatar:'他',color:'#000000',kind:'assistant',content:`第 ${i} 段`,reasoning:'',reasoningLabel:'',round:0,status:'complete',createdAt:new Date().toISOString(),inputMessageIds:[],inputTokens:0,outputTokens:0,speech:{id:'whole-speech',index:i,total:3,state:'complete'}});
    if(i===1)f.human('分段期间的人类插话');
  }
  f.engine.start(f.group.id);await waitUntil(()=>checked);await f.engine.settle(f.group.id);
  assert.equal(f.store.messages(f.group.id).length,5);assert.ok(f.store.logs(f.group.id).some(l=>l.kind==='protocol'&&l.summary.includes('尚未读完整')));
});

test('pause cancels unsent bubbles immediately, retains sent text and does not replay a duplicate tool call',async t=>{
  const f=fixture(t,async w=>{w.read();await w.post('已经发送的第一段。\n\n尚未发送的第二段。\n\n尚未发送的第三段。',undefined,'same-burst-id');});
  f.group.participants=f.group.participants.slice(0,1);f.group.freeSettings!.messageStyle='segmented';f.store.saveGroup(f.group);f.engine.start(f.group.id);
  await waitUntil(()=>f.store.messages(f.group.id).length===1);f.engine.pause(f.group.id);await f.engine.settle(f.group.id);
  assert.equal(f.store.messages(f.group.id).length,1);assert.equal(f.store.messages(f.group.id)[0].speech!.state,'interrupted');assert.equal(f.store.freeSession(f.group.id)!.sending,undefined);
  f.engine.start(f.group.id);await f.engine.settle(f.group.id);await new Promise(r=>setTimeout(r,1100));f.engine.pause(f.group.id);await f.engine.settle(f.group.id);assert.equal(f.store.messages(f.group.id).length,1);
});

test('real Harness corrects empty praise once without forcing agreement or changing a substantiated opinion',async t=>{
  let calls=0;
  const f=fixture(t,undefined,async options=>{
    calls++;assert.match((options.system??'')+JSON.stringify(options.messages.filter(m=>m.role==='system')),/共同讨论者角色/);
    if(calls===1)return tool('post_message',{content:'你这个观点太精辟了！我赞同保留缓冲，因为抽牌随机性需要可控的代价。'});
    assert.ok(options.messages.some(m=>m.role==='tool'&&m.content.some(b=>b.type==='text'&&b.text.includes('原有实质观点应保留'))));
    return tool('post_message',{content:'我赞同保留缓冲，因为抽牌随机性需要可控的代价。'});
  });
  f.group.participants=f.group.participants.slice(0,1);f.store.saveGroup(f.group);f.engine.start(f.group.id);await waitUntil(()=>f.store.messages(f.group.id).length===1);await f.engine.settle(f.group.id);
  assert.equal(calls,2);assert.match(f.store.messages(f.group.id)[0].content,/我赞同保留缓冲/);assert.doesNotMatch(f.store.messages(f.group.id)[0].content,/精辟/);
});

test('same-key same-model personas have separate system prompts and durable private sessions',async t=>{
  const seen:{session:string;system:string;history:string}[]=[];
  const f=fixture(t,undefined,async options=>{const body=nativeRequest(options,cloud,'fixture-key').body as any;seen.push({session:String(options.sessionId),system:body.instructions,history:JSON.stringify(body.input)});return tool('wait_for_messages',{seconds:0});});
  f.group.participants=f.group.participants.map((p,i)=>({...p,model:'test-shared',identityMode:'role',role:i?'PRIVATE_BETA_PERSONA':'PRIVATE_ALPHA_PERSONA'}));f.store.saveGroup(f.group);
  f.human('共同可见的公开消息');f.engine.start(f.group.id);await waitUntil(()=>seen.length===2);await f.engine.settle(f.group.id);
  assert.notEqual(seen[0].session,seen[1].session);for(const row of seen){assert.equal(Number(row.system.includes('PRIVATE_ALPHA_PERSONA'))+Number(row.system.includes('PRIVATE_BETA_PERSONA')),1);assert.ok(!row.history.includes('PRIVATE_ALPHA_PERSONA'));assert.ok(!row.history.includes('PRIVATE_BETA_PERSONA'));assert.match(row.history,/共同可见的公开消息/);}
  f.engine.pause(f.group.id);await f.engine.settle(f.group.id);f.engine.start(f.group.id);await waitUntil(()=>seen.length===4);await f.engine.settle(f.group.id);assert.equal(new Set(seen.map(r=>r.session)).size,2);
});

test('temporary token reservations wait for actual settlement and clipped output fits the remaining budget',async t=>{
  let release:()=>void=()=>{},first=true,successful=0;
  const held=new Promise<void>(r=>{release=r;});
  const f=fixture(t,async w=>{w.read();const ticket=w.reserve(600,600);assert.equal(w.outputLimit!(ticket),first?400:200);const hold=first;first=false;if(hold)await held;w.settle(ticket,{inputTokens:100,outputTokens:100});successful++;w.wait(0);});
  f.group.settings.maxTotalTokens=1000;f.store.saveGroup(f.group);f.engine.start(f.group.id);
  await waitUntil(()=>f.store.freeSession(f.group.id)!.members.some(m=>m.status==='budget_wait'));assert.equal(f.store.freeSession(f.group.id)!.admissionClosed,undefined);release();
  await waitUntil(()=>successful===2);await f.engine.settle(f.group.id);const s=f.store.freeSession(f.group.id)!;assert.equal(s.inputTokens+s.outputTokens,400);assert.equal(s.reservedTokens,0);assert.equal(s.status,'active');assert.equal(s.callCount,2);
});

test('room publication waits during typing, rechecks human input, and aborts queued messages on pause',async t=>{
  let now=Date.now(),rejectedLate=false;const f=fixture(t,async w=>{w.read();try{await w.post('排队中的回答',undefined,w.sessionId);}catch(e){if(!w.signal.aborted){assert.match((e as Error).message,/尚未读取/);rejectedLate=true;w.read();w.wait(0);}}},undefined,{now:()=>now});
  f.group.participants=f.group.participants.slice(0,1);f.group.freeSettings={...f.group.freeSettings!,messageGapMin:2,messageGapMax:2,typingGraceSeconds:3};f.store.saveGroup(f.group);f.engine.start(f.group.id);f.engine.typing(f.group.id);
  await waitUntil(()=>f.store.freeSession(f.group.id)!.members[0].status==='queued');assert.equal(f.store.messages(f.group.id).length,0);
  f.human('刚刚追加的新条件');now+=4000;await waitUntil(()=>rejectedLate);assert.equal(f.store.messages(f.group.id).filter(m=>m.kind==='assistant').length,0);
  f.human('第二次唤醒');f.engine.typing(f.group.id);await waitUntil(()=>f.store.freeSession(f.group.id)!.members[0].status==='queued');f.engine.pause(f.group.id);await f.engine.settle(f.group.id);assert.equal(f.store.messages(f.group.id).filter(m=>m.kind==='assistant').length,0);
});

test('Harness resets queued status after new human input rejects a post and records the actual reason',async t=>{
  let now=Date.now(),calls=0;
  const f=fixture(t,undefined,async options=>{
    calls++;
    const m=f.store.freeSession(f.group.id)!.members[0];assert.equal(m.status,'thinking');assert.equal(m.queuedUntil,undefined);assert.equal(m.activity,'正在独立思考与生成');
    if(calls===1)return tool('post_message',{content:'尚未考虑新补充的草稿'});
    if(calls===2){assert.ok(options.messages.some(m=>m.role==='tool'&&m.content.some(b=>b.type==='text'&&b.text.includes('尚未读取'))));return tool('read_messages',{});}
    assert.equal(calls,3);assert.ok(JSON.stringify(options.messages).includes('新的讨论条件'));return tool('post_message',{content:'我结合新条件修正了判断。'});
  },{now:()=>now});
  f.group.participants=f.group.participants.slice(0,1);f.group.freeSettings!.typingGraceSeconds=3;f.store.saveGroup(f.group);
  f.engine.start(f.group.id);f.engine.typing(f.group.id);
  await waitUntil(()=>!!f.store.freeSession(f.group.id)!.members[0].queuedUntil);
  const queued=f.store.freeSession(f.group.id)!.members[0];assert.equal(queued.status,'queued');assert.equal(queued.activity,'等待用户输入保护');assert.equal(queued.queuedUntil,now+3000);
  f.human('新的讨论条件');now+=4000;
  await waitUntil(()=>f.store.messages(f.group.id).some(m=>m.kind==='assistant'));await f.engine.settle(f.group.id);
  assert.equal(calls,3);assert.deepEqual(f.store.messages(f.group.id).filter(m=>m.kind==='assistant').map(m=>m.content),['我结合新条件修正了判断。']);
  const s=f.store.freeSession(f.group.id)!;assert.equal(s.members[0].status,'waiting');assert.equal(s.members[0].queuedUntil,undefined);assert.equal(s.reservedTokens,0);
  assert.ok(f.store.logs(f.group.id).some(l=>l.kind==='protocol'&&l.summary.includes('有新的人类或导入消息尚未读取')));
  assert.equal(f.store.logs(f.group.id).filter(l=>l.kind==='waiting').length,0,'rejected delivery is not a model choice to wait');
});

test('real Harness selects a local sticker by catalog and publishes it as an idempotent message',async t=>{
  let calls=0;const f=fixture(t,undefined,async options=>{calls++;if(calls===1)return tool('list_stickers',{});const history=JSON.stringify(options.messages);assert.match(history,/思考表情/);assert.doesNotMatch(history,/assetId/);return tool('send_sticker',{stickerId:'fixture-sticker',caption:'这个假设需要再验证。'});});
  f.group.participants=f.group.participants.slice(0,1);f.store.saveGroup(f.group);f.store.saveSticker({id:'fixture-sticker',name:'思考表情',tags:['思考'],assetId:'a'.repeat(64),createdAt:new Date().toISOString()});f.engine.start(f.group.id);
  await waitUntil(()=>f.store.messages(f.group.id).some(m=>m.sticker));await f.engine.settle(f.group.id);assert.equal(calls,2);assert.equal(f.store.messages(f.group.id)[0].sticker!.name,'思考表情');assert.equal(f.store.freeSession(f.group.id)!.publishedCount,1);
});

test('sticker permissions and shared cooldown are enforced before publishing and peers receive labels',async t=>{
  let checked=false;const f=fixture(t,async w=>{const delivery=w.read();if(w.participant.id===f.group.participants[0].id){await w.post('',undefined,'unique-sticker','fixture-sticker');await w.post('',undefined,'unique-sticker','fixture-sticker');return;}assert.equal(delivery.messages[0].sticker!.name,'点头');assert.equal('assetId' in delivery.messages[0].sticker!,false);assert.throws(()=>w.post('',undefined,'another','fixture-sticker'),/冷却/);checked=true;w.wait(0);});
  f.group.freeSettings={...f.group.freeSettings!,concurrency:1};f.store.saveGroup(f.group);f.store.saveSticker({id:'fixture-sticker',name:'点头',tags:['赞同'],assetId:'b'.repeat(64),createdAt:new Date().toISOString()});
  // Deterministic launch order, independent of generated member UUIDs.
  f.group.participants[0].id='aaa';f.group.participants[1].id='bbb';f.store.saveGroup(f.group);f.engine.start(f.group.id);await waitUntil(()=>checked);assert.equal(f.store.messages(f.group.id).length,1);
  f.engine.pause(f.group.id);await f.engine.settle(f.group.id);f.group.freeSettings.allowStickers=false;f.store.saveGroup(f.group);
  const disabled=fixture(t,async w=>{w.read();assert.deepEqual(w.listStickers!(),[]);assert.throws(()=>w.post('',undefined,'disabled','fixture-sticker'),/不可用/);w.wait(0);});disabled.group.participants=disabled.group.participants.slice(0,1);disabled.group.freeSettings!.allowStickers=false;disabled.store.saveGroup(disabled.group);disabled.engine.start(disabled.group.id);await waitUntil(()=>disabled.store.freeSession(disabled.group.id)!.members[0].status==='waiting');assert.equal(disabled.store.messages(disabled.group.id).length,0);
});

test('truncation pauses without publishing partial tools or retrying and settles actual provider usage',async t=>{
  let calls=0;
  const f=fixture(t,undefined,async()=>{calls++;return parseNativeReply({choices:[{finish_reason:'length',message:{reasoning_content:'PRIVATE_THINKING',tool_calls:[{id:'partial',function:{name:'post_message',arguments:'{"content":"UNFINISHED'}}]}}],usage:{prompt_tokens:321,completion_tokens:1200}},{...cloud,id:'deepseek'},12000,1200);});
  f.group.participants=f.group.participants.slice(0,1);f.group.settings.maxOutputTokens=1200;f.store.saveGroup(f.group);f.engine.start(f.group.id);
  await waitUntil(()=>f.store.freeSession(f.group.id)!.status==='paused');await f.engine.settle(f.group.id);
  const s=f.store.freeSession(f.group.id)!;assert.equal(calls,1);assert.equal(s.uncertainCalls,0);assert.equal(s.reservedTokens,0);assert.equal(s.inputTokens,321);assert.equal(s.outputTokens,1200);assert.equal(s.estimatedUSD,1521/1e6);
  assert.match(s.members[0].error!,/输出或上下文长度限制/);assert.equal(f.store.messages(f.group.id).length,0);
  f.human('不自动重试');f.engine.pump(f.group.id);await f.engine.settle(f.group.id);assert.equal(calls,1);
});

test('resuming the same private session applies increased and decreased output limits to requests and reservations',async t=>{
  const seen:number[]=[],sessions:string[]=[];
  const f=fixture(t,undefined,async options=>{seen.push(options.maxTokens!);sessions.push(String(options.sessionId));assert.ok(f.store.freeSession(f.group.id)!.reservedTokens>=options.maxTokens!);return tool('wait_for_messages',{seconds:0});});
  f.group.participants=f.group.participants.slice(0,1);
  for(const limit of [1200,4096,512]) {
    f.group.settings.maxOutputTokens=limit;f.store.saveGroup(f.group);f.engine.start(f.group.id);
    await waitUntil(()=>seen.length===[1200,4096,512].indexOf(limit)+1);await f.engine.settle(f.group.id);f.engine.pause(f.group.id);await f.engine.settle(f.group.id);
  }
  assert.deepEqual(seen,[1200,4096,512]);assert.equal(new Set(sessions).size,1);assert.equal(f.store.freeSession(f.group.id)!.reservedTokens,0);
});

test('quota rejection consumes one attempt, releases reservations and does not retry or charge unknown usage',async t=>{
  let calls=0;
  const f=fixture(t,undefined,async()=>{calls++;throw classifyProviderFailure(429,{error:{code:'credit_balance_exhausted'}},'openai');});
  f.group.participants=f.group.participants.slice(0,1);f.store.saveGroup(f.group);f.engine.start(f.group.id);
  await waitUntil(()=>f.store.freeSession(f.group.id)!.status==='paused');
  const s=f.store.freeSession(f.group.id)!;
  assert.equal(calls,1);assert.equal(s.callCount,1);assert.equal(s.uncertainCalls,0);assert.equal(s.reservedTokens,0);assert.equal(s.reservedUSD,0);assert.equal(s.estimatedUSD,0);assert.equal(s.inputTokens+s.outputTokens,0);
  assert.match(s.members[0].error!,/预付余额已耗尽/);
  f.human('新消息不得重试欠费成员');f.engine.pump(f.group.id);await f.engine.settle(f.group.id);assert.equal(calls,1);
});

test('rate limit honors server delay and retries twice at most, with counted attempts and no charge',async t=>{
  let now=Date.now(),calls=0;
  const f=fixture(t,undefined,async()=>{calls++;throw classifyProviderFailure(429,{error:{code:'rate_limit_exceeded'}},'openai','8');},{now:()=>now});
  f.group.participants=f.group.participants.slice(0,1);f.store.saveGroup(f.group);f.engine.start(f.group.id);
  await waitUntil(()=>f.store.freeSession(f.group.id)!.members[0].status==='retrying');
  f.human('@成员 0 立即发言');now+=7999;f.engine.pump(f.group.id);await f.engine.settle(f.group.id);assert.equal(calls,1);
  now++;f.engine.pump(f.group.id);await waitUntil(()=>calls===2);await f.engine.settle(f.group.id);
  now+=8000;f.engine.pump(f.group.id);await waitUntil(()=>f.store.freeSession(f.group.id)!.status==='paused');
  const s=f.store.freeSession(f.group.id)!;assert.equal(calls,3);assert.equal(s.callCount,3);assert.equal(s.uncertainCalls,0);assert.equal(s.estimatedUSD,0);assert.match(s.members[0].error!,/自动重试已停止/);
});

test('provider cooldown gates other members; successful retry clears state; idle members do not poll',async t=>{
  let now=Date.now(),calls=0;
  const f=fixture(t,undefined,async()=>{calls++;if(calls===1)throw classifyProviderFailure(429,{error:{code:'slow_down'}},'openai','10');return tool('wait_for_messages',{seconds:0});},{now:()=>now});
  f.group.freeSettings!.concurrency=1;f.store.saveGroup(f.group);f.engine.start(f.group.id);
  await waitUntil(()=>f.store.freeSession(f.group.id)!.members.some(m=>m.status==='retrying'));
  f.engine.pump(f.group.id);await f.engine.settle(f.group.id);assert.equal(calls,1);
  now+=10000;f.engine.pump(f.group.id);await waitUntil(()=>f.store.freeSession(f.group.id)!.members.every(m=>m.status==='waiting'));
  assert.equal(calls,3);assert.ok(f.store.freeSession(f.group.id)!.members.every(m=>!m.error&&!m.retryAt&&!m.rateLimitRetries));
  now+=60000;f.engine.pump(f.group.id);await f.engine.settle(f.group.id);assert.equal(calls,3);
});

test('long Retry-After is not shortened and manual resume still respects it',async t=>{
  let now=Date.now(),calls=0;
  const f=fixture(t,undefined,async()=>{calls++;if(calls===1)throw classifyProviderFailure(429,{error:{code:'rate_limit_exceeded'}},'openai','90');return tool('wait_for_messages',{seconds:0});},{now:()=>now});
  f.group.participants=f.group.participants.slice(0,1);f.store.saveGroup(f.group);f.engine.start(f.group.id);
  await waitUntil(()=>f.store.freeSession(f.group.id)!.status==='paused');assert.equal(calls,1);
  f.engine.start(f.group.id);now+=60000;f.engine.pump(f.group.id);await f.engine.settle(f.group.id);assert.equal(calls,1);
  now+=30000;f.engine.pump(f.group.id);await waitUntil(()=>calls===2);
});

test('pause during rate backoff cancels automatic retries',async t=>{
  let now=Date.now(),calls=0;
  const f=fixture(t,undefined,async()=>{calls++;throw classifyProviderFailure(429,{error:{code:'rate_limit_exceeded'}},'openai');},{now:()=>now});
  f.group.participants=f.group.participants.slice(0,1);f.store.saveGroup(f.group);f.engine.start(f.group.id);
  await waitUntil(()=>f.store.freeSession(f.group.id)!.members[0].status==='retrying');f.engine.pause(f.group.id);
  now+=10000;f.engine.pump(f.group.id);await f.engine.settle(f.group.id);assert.equal(calls,1);
});

test('real Harness makes a group broadcast, privately corrects service endings, and delivers peer replies without human steering',async t=>{
  let rejected=false,peerRead=false,humanSeen=false;
  const f=fixture(t,undefined,async options=>{
    const upstream=nativeRequest(options,cloud,'fixture-key').body as {instructions:string};
    assert.match(upstream.instructions,/API 中的 user 消息只是承载群消息/);assert.match(upstream.instructions,/不强加角色/);
    const last=options.messages.findLast(m=>m.role==='user')!;
    const wake=JSON.parse(last.content.filter(b=>b.type==='text').map(b=>b.text).join(''));
    assert.equal(wake.audience,'whole-group');assert.equal(wake.roster.length,3);assert.ok(wake.roster.some((p:any)=>p.kind==='human'&&p.role==='equal-peer'));
    humanSeen ||= wake.messages.some((m:any)=>m.kind==='user'&&m.senderKind==='human');
    const peers=wake.messages.filter((m:any)=>m.participantId&&m.participantId!==wake.selfId);
    if(options.model==='test-1'&&peers.length){peerRead=true;return tool('post_message',{content:'【本地模拟】我不同意把海仅看作屏障，航路也创造连接。',replyTo:peers[0].id});}
    if(options.model==='test-0'&&!options.messages.some(m=>m.role==='assistant'))return tool('post_message',{content:'【本地模拟】海是屏障。\n你想往哪个方向走——地理/政治，还是个人感受？'});
    if(options.model==='test-0'&&!f.store.messages(f.group.id).some(m=>m.participantId===f.group.participants[0].id)) {
      rejected=options.messages.some(m=>m.role==='tool'&&m.content.some(b=>b.type==='text'&&b.text.includes('消息尚未发布')));
      assert.equal(rejected,true);return tool('post_message',{content:'【本地模拟】我认为海首先是一道屏障，因为跨越它需要航海技术。'});
    }
    return tool('wait_for_messages',{seconds:0});
  });
  f.human('谈一谈海吧');f.engine.start(f.group.id);
  await waitUntil(()=>f.store.messages(f.group.id).filter(m=>m.kind==='assistant').length===2);
  await f.engine.settle(f.group.id);
  assert.ok(rejected&&peerRead&&humanSeen);
  const messages=f.store.messages(f.group.id).filter(m=>m.kind==='assistant');assert.equal(messages[1].replyTo,messages[0].id);
  assert.ok(messages.every(m=>!m.content.includes('你想往哪个方向')));assert.equal(f.store.freeSession(f.group.id)!.uncertainCalls,0);
});

test('repeated service-style output stops after one corrective attempt without publishing',async t=>{
  let calls=0;
  const f=fixture(t,undefined,async()=>{calls++;return tool('post_message',{content:'你想聊哪方面？'});});
  f.group.participants=f.group.participants.slice(0,1);f.store.saveGroup(f.group);f.engine.start(f.group.id);
  await waitUntil(()=>f.store.freeSession(f.group.id)!.status==='paused');assert.equal(calls,2);assert.equal(f.store.messages(f.group.id).length,0);assert.match(f.store.freeSession(f.group.id)!.members[0].error!,/平等讨论规范/);
});

test('real Harness creates independent members; a silent member does not block another member',async t=>{
  const seen=new Map<string,string[]>();
  const f=fixture(t,undefined,async options=>{
    const prompts=options.messages.filter(m=>m.role==='user').map(m=>m.content.filter(b=>b.type==='text').map(b=>b.text).join(''));
    seen.set(options.model,prompts);
    if(options.model==='test-0'&&!options.messages.some(m=>m.role==='assistant'))return tool('post_message',{content:'【测试夹具】独立成员发言'});
    return tool('wait_for_messages',{seconds:0});
  });
  f.engine.start(f.group.id);
  await waitUntil(()=>f.store.messages(f.group.id).length===1&&f.store.freeSession(f.group.id)!.members.every(m=>m.status==='waiting'));
  assert.equal(seen.size,2);assert.equal(f.store.messages(f.group.id)[0].participantId,f.group.participants[0].id);
  const s=f.store.freeSession(f.group.id)!;assert.equal(new Set(s.members.map(m=>m.sessionId)).size,2);
  assert.equal(s.publishedCount,1);assert.ok(s.callCount>=2&&s.callCount<=3);
  assert.equal(s.reservedTokens,0);assert.equal(s.uncertainCalls,0);
});

test('new human input during generation must be read before publishing; post is idempotent',async t=>{
  let wake!:RuntimeWake,release!:()=>void;
  const f=fixture(t,async w=>{if(w.participant.id!==f.group.participants[0].id){w.read();w.wait(0);return;}wake=w;w.read();await new Promise<void>(r=>{release=r;});});
  f.engine.start(f.group.id);await waitUntil(()=>!!wake);
  const message=f.human('新的重要条件');
  assert.throws(()=>wake.post('旧条件回答',undefined,'same-call'),/新的人类/);
  assert.ok(wake.read().messages.some(m=>m.id===message.id));
  const a=wake.post('考虑补充后的回答',message.id,'same-call') as {messageId:string};
  const b=wake.post('重复网络交付',message.id,'same-call') as {messageId:string};
  assert.equal(a.messageId,b.messageId);assert.equal(f.store.messages(f.group.id).filter(m=>m.kind==='assistant').length,1);
  f.engine.pause(f.group.id);release();await f.engine.settle(f.group.id);
});

test('pause invalidates late tools and preserves a safe cursor for resume',async t=>{
  let wake!:RuntimeWake,release!:()=>void;
  const f=fixture(t,async w=>{w.read();if(w.participant.id===f.group.participants[0].id){wake=w;await new Promise<void>(r=>{release=r;});}else w.wait(0);});
  f.human('不可丢失');f.engine.start(f.group.id);await waitUntil(()=>!!wake);
  f.engine.pause(f.group.id);
  assert.throws(()=>wake.post('迟到回复',undefined,'late'));
  release();await f.engine.settle(f.group.id);
  assert.equal(f.store.messages(f.group.id).length,1);
  const member=f.store.freeSession(f.group.id)!.members[0];assert.equal(member.acknowledgedSeq,0);assert.ok(member.deliveredSeq>0);
});

test('member cannot impersonate another room or use an unassigned skill',async t=>{
  let checked=0;
  const f=fixture(t,async w=>{
    w.read();assert.throws(()=>w.loadSkill('argument-check'),/没有启用/);
    assert.throws(()=>w.post('引用其他群','unknown-message','bad'),/本群已交付/);
    const fresh=f.store.group(f.group.id)!;fresh.participants=fresh.participants.filter(p=>p.id!==w.participant.id);f.store.saveGroup(fresh);
    assert.throws(()=>w.post('冒用旧权限',undefined,'old'),/权限已变化/);checked++;
  });
  f.engine.start(f.group.id);await waitUntil(()=>checked===2);assert.equal(f.store.messages(f.group.id).length,0);
});

test('concurrent reservation prevents overspend and lets admitted calls finish',async t=>{
  let finish!:()=>void;let admitted=0;
  const f=fixture(t,async w=>{w.read();const ticket=w.reserve(600,100);admitted++;await new Promise<void>(r=>{finish=r;});w.settle(ticket,{inputTokens:500,outputTokens:90});w.post('已获预算的请求仍然可以完成',undefined,'paid');});
  f.group.settings.maxTotalTokens=1000;f.store.saveGroup(f.group);f.engine.start(f.group.id);
  await waitUntil(()=>f.store.freeSession(f.group.id)!.members.some(m=>m.status==='budget_wait'));
  assert.equal(admitted,1);assert.equal(f.store.freeSession(f.group.id)!.reservedTokens,700);
  finish();await waitUntil(()=>f.store.freeSession(f.group.id)!.reservedTokens===0&&f.store.freeSession(f.group.id)!.members.some(m=>m.status==='error'));
  assert.equal(f.store.messages(f.group.id).length,1);assert.equal(f.store.freeSession(f.group.id)!.inputTokens,500);assert.equal(f.store.freeSession(f.group.id)!.reservedTokens,0);
});

test('restart charges uncertain calls conservatively and recovers without publishing or calling models',async t=>{
  let wake!:RuntimeWake,release!:()=>void;
  const f=fixture(t,async w=>{w.read();if(w.participant.id===f.group.participants[0].id){wake=w;w.reserve(300,100);await new Promise<void>(r=>{release=r;});}else w.wait(0);});
  f.human();f.engine.start(f.group.id);await waitUntil(()=>!!wake);
  f.store.recoverFreeSessions();assert.throws(()=>wake.post('不能重发',undefined,'stale'));
  const state=f.store.freeSession(f.group.id)!;assert.equal(state.status,'interrupted');assert.equal(state.uncertainCalls,1);assert.equal(state.reservedTokens,0);assert.equal(state.inputTokens+state.outputTokens,400);
  release();await f.engine.settle(f.group.id);assert.equal(f.store.messages(f.group.id).length,1);
});

test('self messages do not create wake loops; human messages wake listeners without a new round',async t=>{
  const calls=new Map<string,number>();
  const f=fixture(t,async w=>{calls.set(w.participant.id,(calls.get(w.participant.id)??0)+1);const d=w.read();if(w.participant.id===f.group.participants[0].id&&d.messages.some(m=>m.kind==='user'))w.post('收到新的用户观点',undefined,crypto.randomUUID());else w.wait(0);});
  f.engine.start(f.group.id);await waitUntil(()=>calls.size===2);await f.engine.settle(f.group.id);
  const before=[...calls.values()].reduce((a,b)=>a+b,0);f.engine.pump(f.group.id);await f.engine.settle(f.group.id);assert.equal([...calls.values()].reduce((a,b)=>a+b,0),before);
  f.human('请重新考虑');await waitUntil(()=>f.store.messages(f.group.id).some(m=>m.kind==='assistant'));await f.engine.settle(f.group.id);
  assert.equal(calls.get(f.group.participants[0].id),2);assert.ok((calls.get(f.group.participants[1].id)??0)>=2);
});

test('instruction skills import as text and never install executable capabilities',t=>{
  const f=fixture(t,async w=>{w.read();w.wait(0);});
  const skill=importInstructionSkill(f.store,'---\nname: check-evidence\ndescription: 检查依据\n---\n读取讨论中的论据。\n```python\nprint("not executed")\n```');
  assert.equal(skill.builtin,false);assert.match(skill.instructions,/not executed/);
  assert.throws(()=>importInstructionSkill(f.store,'---\nname: ../../bad\ndescription: x\n---\nx'));
  assert.throws(()=>importInstructionSkill(f.store,'---\nname: check-evidence\ndescription: x\n---\nx'),/同名/);
});

test('real Harness loads only assigned instruction skill before posting',async t=>{
  let calls=0;
  const f=fixture(t,undefined,async options=>{
    calls++;
    if(!options.messages.some(m=>m.role==='tool'))return tool('load_skill',{id:'argument-check'});
    return tool('post_message',{content:'【测试夹具】技能读取之后发布'});
  });
  f.group.participants=f.group.participants.slice(0,1).map(p=>({...p,skills:['argument-check']}));f.store.saveGroup(f.group);
  f.engine.start(f.group.id);await waitUntil(()=>f.store.messages(f.group.id).length===1);
  assert.equal(calls,2);assert.match(f.store.messages(f.group.id)[0].reasoning,/读取技能：论证检查/);
});

test('Harness runtime resumes durable private history without auto-calling or repeating published messages',async t=>{
  let runtime!:HarnessRuntime;let calls=0;let restored=false;
  const generate:NativeGenerate=async options=>{
    calls++;const assistants=options.messages.filter(m=>m.role==='assistant');
    if(assistants.length){assert.ok(assistants.some(m=>m.content.some(b=>b.type==='tool-call'&&b.arguments.includes('durable-first-post'))));restored=true;return tool('wait_for_messages',{seconds:0});}
    return tool('post_message',{content:'durable-first-post'});
  };
  const f=fixture(t,w=>runtime.run(w));f.group.participants=f.group.participants.slice(0,1);f.store.saveGroup(f.group);
  runtime=new HarnessRuntime(f.dir,generate);
  try {
    f.engine.start(f.group.id);await waitUntil(()=>f.store.messages(f.group.id).length===1);f.engine.pause(f.group.id);await f.engine.settle(f.group.id);await runtime.shutdown();
    const id=f.store.freeSession(f.group.id)!.members[0].sessionId;
    runtime=new HarnessRuntime(f.dir,generate);assert.equal(calls,1);f.human('继续之前的讨论');
    f.engine.start(f.group.id);await waitUntil(()=>restored);await f.engine.settle(f.group.id);
    assert.equal(calls,2);assert.equal(f.store.freeSession(f.group.id)!.members[0].sessionId,id);assert.equal(f.store.messages(f.group.id).filter(m=>m.kind==='assistant').length,1);
  } finally {f.engine.pause(f.group.id);await f.engine.settle(f.group.id);await runtime.shutdown();}
});

test('cooldown, mention attention and probability gate admission without acknowledging unseen messages',async t=>{
  let now=Date.now(),calls=0;
  const f=fixture(t,async w=>{calls++;w.read();w.attention('mentions');w.wait(0);},undefined,{now:()=>now,random:()=>0.5});
  f.group.participants=f.group.participants.slice(0,1);f.group.freeSettings={...f.group.freeSettings!,cooldownMin:10,cooldownMax:10,wakeProbability:0};f.store.saveGroup(f.group);
  f.engine.start(f.group.id);await waitUntil(()=>calls===1);await f.engine.settle(f.group.id);
  const ordinary=f.human('普通消息');now+=11000;f.engine.pump(f.group.id);await f.engine.settle(f.group.id);assert.equal(calls,1);
  const s=f.store.freeSession(f.group.id)!.members[0];assert.equal(s.acknowledgedSeq,0);assert.ok(s.consideredSeq>0);
  f.human(`@${f.group.participants[0].name} 请讨论`);f.engine.pump(f.group.id);await waitUntil(()=>calls===2);await f.engine.settle(f.group.id);
  assert.ok(f.store.freeSession(f.group.id)!.members[0].acknowledgedSeq>=f.store.events(f.group.id).find(e=>e.messageId===ordinary.id)!.seq);
  f.human(`@${f.group.participants[0].name} 再补充`);f.engine.pump(f.group.id);await waitUntil(()=>calls===3);await f.engine.settle(f.group.id);
  now+=11000;f.engine.pump(f.group.id);await f.engine.settle(f.group.id);assert.equal(calls,3);
});

test('mention while already thinking does not duplicate a job and current job can read the mention',async t=>{
  let calls=0,release!:()=>void,seen=false;
  const f=fixture(t,async w=>{calls++;w.read();await new Promise<void>(r=>{release=r;});seen=w.read().messages.some(m=>m.content.includes('@'));w.wait(0,'已处理点名，暂无新增依据。');});
  f.group.participants=f.group.participants.slice(0,1);f.store.saveGroup(f.group);f.engine.start(f.group.id);await waitUntil(()=>!!release);
  f.human(`@${f.group.participants[0].name} 加入新条件`);f.engine.pump(f.group.id);assert.equal(calls,1);release();await f.engine.settle(f.group.id);f.engine.pump(f.group.id);await f.engine.settle(f.group.id);
  assert.equal(calls,1);assert.ok(seen);assert.match(f.store.logs(f.group.id)[0].summary,/已处理点名/);
});

test('waiting reasoning and per-member cost are durable local logs and never peer messages',async t=>{
  const f=fixture(t,undefined,async options=>{
    assert.ok(!JSON.stringify(options.messages).includes('PRIVATE_RETURNED_REASONING'));
    return {...tool('wait_for_messages',{seconds:0,reason:'当前没有可补充的新论据。'}),returnedReasoning:{text:'PRIVATE_RETURNED_REASONING',label:'供应商返回的推理摘要'}};
  });
  f.engine.start(f.group.id);await waitUntil(()=>f.store.logs(f.group.id).filter(e=>e.kind==='waiting').length===2);await f.engine.settle(f.group.id);f.engine.pause(f.group.id);
  assert.equal(f.store.messages(f.group.id).length,0);assert.equal(f.store.events(f.group.id).length,0);
  const logs=f.store.logs(f.group.id);assert.equal(logs.filter(e=>e.reasoning==='PRIVATE_RETURNED_REASONING').length,2);assert.ok(logs.filter(e=>e.kind==='waiting').every(e=>e.summary.includes('没有可补充')));
  const usage=f.store.memberUsage(f.group.id);assert.equal(usage.members.length,2);assert.ok(usage.members.every(m=>m.inputTokens===10&&m.outputTokens===10&&m.calls===1&&m.estimatedUSD===0.00002));
  const other=f.store.createGroup('隔离日志','');assert.equal(f.store.logs(other.id).length,0);assert.equal(f.store.memberUsage(other.id).members.length,0);
  const reopened=new Store(f.dir);try{assert.deepEqual(reopened.memberUsage(f.group.id),usage);assert.deepEqual(reopened.logs(f.group.id),logs);}finally{reopened.close();}
});

test('cost snapshots separate same-key same-model members and preserve prior rates and unknown estimates',t=>{
  const f=fixture(t,async w=>{w.wait(0);});
  const add=(memberId:string,inputPrice:number,outputPrice:number,actual?:{inputTokens:number;outputTokens:number})=>{
    const id=crypto.randomUUID();f.store.reserveCall({id,groupId:f.group.id,sessionId:'past-session',input:1000,output:1000,usd:(inputPrice+outputPrice)/1000,inputPrice,outputPrice,memberId,author:memberId,model:'same-model',providerId:'openai',connectionId:'shared-key'});f.store.settleCall(id,actual);f.store.settleCall(id,actual);
  };
  add('a',2,8,{inputTokens:1000,outputTokens:500});add('a',10,20,{inputTokens:2000,outputTokens:1000});add('b',2,8,{inputTokens:100,outputTokens:200});add('b',2,8);
  const rows=f.store.memberUsage(f.group.id).members;
  assert.equal(rows.length,2);assert.equal(rows[0].inputTokens,3000);assert.equal(rows[0].outputTokens,1500);assert.equal(rows[0].calls,2);assert.ok(Math.abs(rows[0].estimatedUSD-0.046)<1e-10);
  assert.equal(rows[1].uncertainCalls,1);assert.equal(rows[1].inputTokens,1100);assert.ok(Math.abs(rows[1].estimatedUSD-0.0118)<1e-10);
  f.store.reserveCall({id:'legacy',groupId:f.group.id,sessionId:'old',input:10,output:10,usd:0,inputPrice:0,outputPrice:0});assert.equal(f.store.memberUsage(f.group.id).unattributedCalls,1);
});

test('scheduled wait wakes once no earlier than its floor and does not poll while idle',async t=>{
  let now=Date.now(),calls=0;
  const f=fixture(t,async w=>{calls++;w.read();w.wait(calls===1?1:0);},undefined,{now:()=>now});
  f.group.participants=f.group.participants.slice(0,1);f.store.saveGroup(f.group);f.engine.start(f.group.id);
  await waitUntil(()=>calls===1);await f.engine.settle(f.group.id);
  now+=14000;f.engine.pump(f.group.id);await f.engine.settle(f.group.id);assert.equal(calls,1);
  now+=1000;f.engine.pump(f.group.id);await waitUntil(()=>calls===2);await f.engine.settle(f.group.id);
  now+=60000;f.engine.pump(f.group.id);await f.engine.settle(f.group.id);assert.equal(calls,2);
});
