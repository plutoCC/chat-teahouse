import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';
import { Scheduler } from '../server/scheduler.js';
import { BrowserConnectorError } from '../server/browser-connector.js';
import type { CompletionRequest, Message, ProviderConfig } from '../shared/types.js';
import { classifyProviderFailure } from '../server/model-errors.js';

const provider:ProviderConfig={id:'demo',name:'Demo',model:'demo',enabled:true,hasKey:false,region:'cn',inputPrice:0,outputPrice:0};
function fixture(t:TestContext, overrides:Record<string,unknown>={}){
  const dir=mkdtempSync(join(tmpdir(),'teahouse-scheduler-'));const store=new Store(dir);store.seed([provider]);
  t.after(()=>{store.close();assert.equal(dirname(resolve(dir)),resolve(tmpdir()));assert.ok(dir.startsWith(join(tmpdir(),'teahouse-scheduler-')));rmSync(dir,{recursive:true,force:true});});
  const group=store.groups()[0];group.participants=group.participants.slice(0,2);group.settings={...group.settings,delaySeconds:0,autoSummary:false,maxTotalTokens:1000000,...overrides};store.saveGroup(group);
  return {store,group};
}
const response=async(r:CompletionRequest)=>{r.onDelta({content:`${r.participant.name} 的第 ${r.round} 轮观点`,reasoning:'可展示依据'});return {inputTokens:20,outputTokens:10};};
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('round quota rejection is zero generation usage while partial output remains conservatively charged',async t=>{
  for(const partial of [false,true]) {
    const {store,group}=fixture(t,{budgetUSD:0});const cloud={...provider,id:'openai' as const,hasKey:true,inputPrice:1,outputPrice:1};
    group.participants=group.participants.slice(0,1).map(p=>({...p,providerId:'openai'}));store.saveGroup(group);
    const scheduler=new Scheduler(store,{providers:()=>[cloud],getKey:()=> 'fixture',notify:()=>{},generate:async r=>{if(partial)r.onDelta({content:'already-generated'});throw classifyProviderFailure(429,{error:{code:'credit_balance_exhausted'}},'openai');}});
    const run=scheduler.start(group.id);await scheduler.settle(run.id);const result=store.run(run.id)!;
    assert.equal(result.turnCount,1);assert.equal(result.status,'failed');assert.match(result.error!,/预付余额已耗尽/);
    if(partial){assert.ok(result.inputTokens>0&&result.estimatedUSD>0);}else{assert.equal(result.inputTokens+result.outputTokens,0);assert.equal(result.estimatedUSD,0);}
  }
});
test('independent first round and frozen peer context in subsequent rounds',async t=>{
  const {store,group}=fixture(t);const seen:{round:number;ids:string[]}[]=[];
  const scheduler=new Scheduler(store,{providers:()=>[provider],getKey:()=>undefined,notify:()=>{},generate:async r=>{seen.push({round:r.round,ids:r.history.map(m=>m.id)});return response(r);}});
  const run=scheduler.start(group.id);await scheduler.settle(run.id);
  assert.equal(store.run(run.id)?.status,'completed');assert.equal(seen.length,4);
  assert.deepEqual(seen[0].ids,seen[1].ids);assert.equal(seen[0].ids.length,0);
  assert.equal(seen[2].ids.length,2);assert.deepEqual(seen[2].ids,seen[3].ids);
  assert.deepEqual(store.messages(group.id)[2].inputMessageIds,seen[2].ids);
});
test('sequential mode sees completed replies within later rounds',async t=>{
  const {store,group}=fixture(t,{contextMode:'sequential'});const seen:number[]=[];
  const scheduler=new Scheduler(store,{providers:()=>[provider],getKey:()=>undefined,notify:()=>{},generate:async r=>{seen.push(r.history.length);return response(r);}});
  const run=scheduler.start(group.id);await scheduler.settle(run.id);assert.deepEqual(seen,[0,0,2,3]);
});
test('random rounds and subsecond delay stay in configured bounds; shuffle has each member once',async t=>{
  const {store,group}=fixture(t,{roundsMode:'random',roundsMin:2,roundsMax:3,order:'random',delayMode:'random',delayMin:0.1,delayMax:0.3});const delays:number[]=[];
  const scheduler=new Scheduler(store,{providers:()=>[provider],getKey:()=>undefined,notify:()=>{},generate:response,random:(min,max)=>max,wait:async ms=>{delays.push(ms);}});
  const run=scheduler.start(group.id);await scheduler.settle(run.id);assert.equal(run.chosenRounds,3);assert.equal(store.messages(group.id).length,6);assert.equal(delays.length,5);assert.ok(delays.every(d=>d>=100&&d<=300));
  for(const round of [1,2,3])assert.equal(new Set(store.messages(group.id).filter(m=>m.round===round).map(m=>m.participantId)).size,2);
});
test('cancelling a live stream prevents subsequent calls and preserves stopped partial text',async t=>{
  const {store,group}=fixture(t);let calls=0;
  const scheduler=new Scheduler(store,{providers:()=>[provider],getKey:()=>undefined,notify:()=>{},generate:async r=>{calls++;r.onDelta({content:'部分回答'});await new Promise<void>((_,reject)=>r.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));return {inputTokens:1,outputTokens:1};}});
  const run=scheduler.start(group.id);scheduler.cancel(run.id);await scheduler.settle(run.id);
  assert.equal(calls,1);assert.equal(store.run(run.id)?.status,'cancelled');assert.equal(store.messages(group.id)[0].status,'stopped');assert.equal(store.messages(group.id)[0].content,'部分回答');
});
test('failed retry retains logical message identity and counts both attempts',async t=>{
  const {store,group}=fixture(t,{rounds:1});let calls=0;
  const scheduler=new Scheduler(store,{providers:()=>[provider],getKey:()=>undefined,notify:()=>{},generate:async r=>{calls++;if(calls===1){r.onDelta({content:'partial'});throw new Error('test failure');}return response(r);}});
  const run=scheduler.start(group.id);await scheduler.settle(run.id);const id=store.messages(group.id)[0].id;assert.equal(store.run(run.id)?.status,'failed');
  scheduler.retry(run.id);await scheduler.settle(run.id);assert.equal(store.messages(group.id).length,2);assert.equal(store.messages(group.id)[0].id,id);assert.equal(store.run(run.id)?.turnCount,3);assert.equal(store.run(run.id)?.status,'completed');
});
test('hard call cap stops the run; no hidden requests after budget failure',async t=>{
  const {store,group}=fixture(t,{maxCalls:1});let calls=0;
  const scheduler=new Scheduler(store,{providers:()=>[provider],getKey:()=>undefined,notify:()=>{},generate:async r=>{calls++;return response(r);}});
  const run=scheduler.start(group.id);await scheduler.settle(run.id);assert.equal(calls,1);assert.equal(store.run(run.id)?.status,'failed');assert.match(store.run(run.id)?.error??'',/上限/);
});
test('cloud monetary cap requires configured prices and rejects before calling',async t=>{
  const {store,group}=fixture(t);group.participants[0].providerId='openai';group.participants=group.participants.slice(0,1);store.saveGroup(group);let calls=0;
  const cloud:ProviderConfig={...provider,id:'openai',name:'OpenAI',hasKey:true};
  const scheduler=new Scheduler(store,{providers:()=>[cloud],getKey:()=> 'test-key',notify:()=>{},generate:async r=>{calls++;return response(r);}});
  const run=scheduler.start(group.id);await scheduler.settle(run.id);assert.equal(calls,0);assert.match(store.run(run.id)?.error??'',/单价/);
});
test('service restart marks running requests interrupted without generating again',async t=>{
  const {store,group}=fixture(t);const scheduler=new Scheduler(store,{providers:()=>[provider],getKey:()=>undefined,notify:()=>{},generate:response});
  const run=scheduler.start(group.id);await scheduler.settle(run.id);const saved=store.run(run.id)!;saved.status='running';store.saveRun(saved);store.interruptOutstanding();assert.equal(store.run(run.id)?.status,'interrupted');
});

test('targeted retry keeps the full roster but validates only the named speaker',async t=>{
  const {store,group}=fixture(t);group.participants[1].providerId='openai';store.saveGroup(group);
  let calls=0;const rosters:string[]=[];
  const scheduler=new Scheduler(store,{providers:()=>[provider],getKey:()=>undefined,notify:()=>{},generate:async r=>{rosters.push(r.roster);if(++calls===1)throw new Error('temporary');return response(r);}});
  const run=scheduler.start(group.id,{targetId:group.participants[0].id});await scheduler.settle(run.id);
  scheduler.retry(run.id);await scheduler.settle(run.id);
  assert.equal(store.run(run.id)?.status,'completed');assert.equal(calls,2);assert.equal(store.messages(group.id).length,1);
  assert.ok(rosters.every(r=>r.includes(group.participants[1].name)));
});

test('token guard includes the complete roster and role instructions before making a call',async t=>{
  const {store,group}=fixture(t,{maxTotalTokens:2000,maxOutputTokens:128});group.participants[0].identityMode='role';group.participants[0].role='角度'.repeat(1000);store.saveGroup(group);let calls=0;
  const scheduler=new Scheduler(store,{providers:()=>[provider],getKey:()=>undefined,notify:()=>{},generate:async r=>{calls++;return response(r);}});
  const run=scheduler.start(group.id);await scheduler.settle(run.id);assert.equal(calls,0);assert.match(store.run(run.id)?.error??'',/token/);
});

function human(store:Store,groupId:string,id:string,content='我不同意这个前提，请重新检查。') {
  const message:Message={id,groupId,author:'我',avatar:'我',color:'#34705a',kind:'user',content,reasoning:'',reasoningLabel:'',round:0,status:'complete',createdAt:new Date().toISOString(),inputMessageIds:[],inputTokens:0,outputTokens:0};store.saveMessage(message);return message;
}

test('human joins during a delay and reaches the next dispatch without exposing same-round AI replies',async t=>{
  const {store,group}=fixture(t,{rounds:1,delaySeconds:2});const seen:CompletionRequest[]=[];
  const scheduler=new Scheduler(store,{providers:()=>[provider],getKey:()=>undefined,notify:()=>{},wait:async()=>{human(store,group.id,'human-during-delay');},generate:async r=>{seen.push(r);return response(r);}});
  const run=scheduler.start(group.id);await scheduler.settle(run.id);
  assert.deepEqual(seen[0].history,[]);assert.deepEqual(seen[1].history.map(m=>m.id),['human-during-delay']);
  assert.ok(seen[1].roster.includes('human'));assert.ok(!seen[1].history.some(m=>m.kind==='assistant'));
});

test('human joins mid-round while round-shared AI history remains frozen',async t=>{
  const {store,group}=fixture(t);const seen:CompletionRequest[]=[];
  const scheduler=new Scheduler(store,{providers:()=>[provider],getKey:()=>undefined,notify:()=>{},generate:async r=>{seen.push(r);if(seen.length===3)human(store,group.id,'human-round-two');return response(r);}});
  const run=scheduler.start(group.id);await scheduler.settle(run.id);
  assert.equal(seen[2].history.length,2);assert.equal(seen[3].history.length,3);
  assert.ok(seen[3].history.some(m=>m.id==='human-round-two'));assert.equal(seen[3].history.filter(m=>m.kind==='assistant').length,2);
});

test('native member role drafts never appear in another members roster',async t=>{
  const {store,group}=fixture(t,{rounds:1});group.participants[0].identityMode='native';group.participants[0].role='SHOULD_NOT_BE_SENT';store.saveGroup(group);const seen:string[]=[];
  const scheduler=new Scheduler(store,{providers:()=>[provider],getKey:()=>undefined,notify:()=>{},generate:async r=>{seen.push(r.roster);return response(r);}});
  const run=scheduler.start(group.id);await scheduler.settle(run.id);assert.ok(seen.every(r=>!r.includes('SHOULD_NOT_BE_SENT')));
});

test('shutdown clears pending web request and does not silently resume after restart',async t=>{
  const {store,group}=fixture(t);group.participants=[{...group.participants[0],providerId:'openai',channel:'browser'}];store.saveGroup(group);
  const scheduler=new Scheduler(store,{providers:()=>[provider],getKey:()=>undefined,notify:()=>{},generate:response});
  const run=scheduler.start(group.id);assert.ok(store.run(run.id)?.pendingWeb);await scheduler.shutdown();
  assert.equal(store.run(run.id)?.status,'interrupted');assert.equal(store.run(run.id)?.pendingWeb,undefined);assert.equal(store.messages(group.id).length,0);
});

test('browser dispatch refreshes human context, records provenance and lets later humans reach the next member',async t=>{
  const {store,group}=fixture(t,{rounds:1});group.participants[0]={...group.participants[0],providerId:'qwen',channel:'browser',identityMode:'native',role:'HIDDEN_PERSONA'};store.saveGroup(group);
  let prompt='';const seen:CompletionRequest[]=[];
  const scheduler=new Scheduler(store,{providers:()=>[provider],getKey:()=>undefined,notify:()=>{},generate:async r=>{seen.push(r);return response(r);},browser:{generate:async request=>{
    human(store,group.id,'before-send');prompt=request.prepare();request.progress({phase:'reading',sent:true,message:'reading'});
    human(store,group.id,'after-send');return {content:'浏览器完整回答',reasoning:'实际可见摘要'};
  }}});
  const run=scheduler.start(group.id);await scheduler.settle(run.id);
  assert.equal(store.run(run.id)?.status,'completed');assert.ok(!prompt.includes('HIDDEN_PERSONA'));assert.ok(prompt.includes('before-send'));assert.ok(!prompt.includes('after-send'));
  const message=store.messages(group.id).find(m=>m.source==='browser')!;assert.deepEqual(message.inputMessageIds,['before-send']);assert.match(message.reasoningLabel,/浏览器读取/);
  assert.deepEqual(seen[0].history.map(m=>m.id),['before-send','after-send']);assert.equal(store.run(run.id)?.turnCount,2);
});

test('browser failures pause without automatic resends and can be stopped',async t=>{
  const {store,group}=fixture(t,{rounds:1});group.participants=[{...group.participants[0],providerId:'deepseek',channel:'browser'}];store.saveGroup(group);let sends=0;
  const scheduler=new Scheduler(store,{providers:()=>[provider],getKey:()=>{throw Error('no API secrets');},notify:()=>{},generate:response,browser:{generate:async r=>{sends++;r.prepare();r.progress({phase:'reading',message:'sent',sent:true});throw new BrowserConnectorError('需要处理验证');}}});
  const run=scheduler.start(group.id);await tick();await tick();
  assert.equal(sends,1);let pending=store.run(run.id)!.pendingWeb!;assert.equal(pending.browser?.phase,'paused');assert.equal(pending.browser?.sent,true);assert.equal(store.messages(group.id).length,0);
  scheduler.cancel(run.id);await scheduler.settle(run.id);assert.equal(store.messages(group.id).length,0);assert.equal(sends,1);
});

test('browser pending work blocks duplicate send and manual races, then explicit resend counts against cap',async t=>{
  const {store,group}=fixture(t,{rounds:1,maxCalls:2});group.participants=[{...group.participants[0],providerId:'openai',channel:'browser'}];store.saveGroup(group);let calls=0;
  const scheduler=new Scheduler(store,{providers:()=>[provider],getKey:()=>undefined,notify:()=>{},generate:response,browser:{generate:async r=>{calls++;r.prepare();await new Promise<void>((_,reject)=>r.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));return {content:'must not save',reasoning:''};}}});
  const run=scheduler.start(group.id);await tick();const pending=store.run(run.id)!.pendingWeb!;
  assert.throws(()=>scheduler.startBrowser(run.id,pending.requestId),/重复/);
  await scheduler.pauseBrowser(run.id,pending.requestId);assert.equal(store.run(run.id)?.pendingWeb?.browser?.phase,'paused');
  scheduler.startBrowser(run.id,pending.requestId);await tick();await scheduler.pauseBrowser(run.id,pending.requestId);
  assert.equal(calls,2);assert.equal(store.run(run.id)?.turnCount,2);assert.throws(()=>scheduler.startBrowser(run.id,pending.requestId),/上限/);
  scheduler.cancel(run.id);await scheduler.settle(run.id);assert.equal(store.messages(group.id).length,0);
});

test('cancelled browser responses cannot be written even if a driver returns late',async t=>{
  const {store,group}=fixture(t,{rounds:1});group.participants=[{...group.participants[0],providerId:'claude',channel:'browser'}];store.saveGroup(group);
  let finish!:()=>void;let aborted=false;
  const scheduler=new Scheduler(store,{providers:()=>[provider],getKey:()=>undefined,notify:()=>{},generate:response,browser:{generate:async r=>{r.prepare();r.signal.addEventListener('abort',()=>{aborted=true;});await new Promise<void>(resolve=>{finish=resolve;});return {content:'late',reasoning:''};}}});
  const run=scheduler.start(group.id);await tick();scheduler.cancel(run.id);finish();await scheduler.settle(run.id);await scheduler.shutdown();
  assert.equal(aborted,true);assert.equal(store.run(run.id)?.status,'cancelled');assert.equal(store.messages(group.id).length,0);
});

test('browser attempts respect the original whole-run timeout and do not restart after shutdown',async t=>{
  const {store,group}=fixture(t,{rounds:1});group.participants=[{...group.participants[0],providerId:'qwen',channel:'browser'}];store.saveGroup(group);let aborted=false;
  t.mock.timers.enable({apis:['Date','setTimeout']});
  const scheduler=new Scheduler(store,{providers:()=>[provider],getKey:()=>undefined,notify:()=>{},generate:response,browser:{generate:async r=>{r.prepare();return await new Promise((_,reject)=>r.signal.addEventListener('abort',()=>{aborted=true;reject(new Error('cancelled'));},{once:true}));}}});
  const run=scheduler.start(group.id);await tick();t.mock.timers.tick(60*60*1000+1);await scheduler.settle(run.id);await scheduler.shutdown();
  assert.equal(aborted,true);assert.equal(store.run(run.id)?.status,'failed');assert.equal(store.run(run.id)?.pendingWeb,undefined);assert.equal(store.messages(group.id).length,0);
});
