import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {Store} from '../server/store.js';
import {Scheduler} from '../server/scheduler.js';
import {RoomEngine} from '../server/room-engine/engine.js';
import {defaultFreeSettings} from '../shared/free-chat.js';
import {defaultWorkspaceLimits,type Group,type ProviderConfig} from '../shared/types.js';

const provider:ProviderConfig={id:'demo',name:'Fixture',model:'demo',enabled:true,hasKey:false,region:'cn',inputPrice:0,outputPrice:0};
const until=async(predicate:()=>boolean)=>{const deadline=Date.now()+5000;while(!predicate()){if(Date.now()>deadline)throw Error('Timed out waiting for fixture');await new Promise(r=>setTimeout(r,10));}};
function fixture(t:TestContext){
  const root=resolve('.test-artifacts');mkdirSync(root,{recursive:true});const dir=mkdtempSync(join(root,'discussion-limits-'));
  const store=new Store(dir);store.seed([provider]);const limits={...defaultWorkspaceLimits},cleanup:Array<()=>Promise<void>>=[];
  t.after(async()=>{for(const close of cleanup)await close();store.close();assert.equal(dirname(realpathSync(dir)),realpathSync(root));rmSync(dir,{recursive:true,force:true});});
  const create=(count=1)=>{const template=store.groups()[0];const group:Group={...structuredClone(template),id:crypto.randomUUID(),name:'Fixture group',goal:'Fixture goal',participants:Array.from({length:count},(_,index)=>({...template.participants[0],id:crypto.randomUUID(),name:`Member ${index}`,providerId:'demo',model:'demo',skills:[],enabled:true})),settings:{...template.settings,rounds:1,autoSummary:false,delaySeconds:0,budgetUSD:0},freeSettings:{...defaultFreeSettings,messageGapMin:0,messageGapMax:0,quietSeconds:0,cooldownMin:1,cooldownMax:1,concurrency:count}};store.saveGroup(group);return group;};
  return {store,limits,create,cleanup};
}

test('round and autonomous chats share the live per-user active discussion limit',async t=>{
  const {store,limits,create,cleanup}=fixture(t);limits.maxActiveGroupsPerUser=1;
  const engine=new RoomEngine(store,{providers:()=>[provider],getKey:()=>undefined,notify:()=>{},resourceLimits:()=>limits,runtime:{run:async wake=>{wake.read(20);wake.wait(0);},shutdown:async()=>{}}});
  const scheduler=new Scheduler(store,{providers:()=>[provider],getKey:()=>undefined,notify:()=>{},resourceLimits:()=>limits,generate:async request=>{await new Promise<void>(yes=>request.signal.addEventListener('abort',()=>yes(),{once:true}));return {inputTokens:0,outputTokens:0};}});
  cleanup.push(async()=>{await engine.shutdown();await scheduler.shutdown();});
  const free=create();engine.start(free.id);const round=create();
  assert.throws(()=>scheduler.start(round.id),/最多同时运行 1/);
  limits.maxActiveGroupsPerUser=4;
  const runs=[round,create(),create()].map(group=>scheduler.start(group.id));
  assert.equal(runs.length,3);assert.throws(()=>engine.start(create().id),/最多同时运行 4/);
  for(const run of runs)scheduler.cancel(run.id);
});

test('autonomous jobs honor a changed per-user member limit instead of the old fixed six',async t=>{
  const {store,limits,create,cleanup}=fixture(t);limits.maxActiveMembersPerUser=2;
  let started=0;
  const engine=new RoomEngine(store,{providers:()=>[provider],getKey:()=>undefined,notify:()=>{},resourceLimits:()=>limits,runtime:{run:async wake=>{started++;await new Promise<void>(yes=>wake.signal.addEventListener('abort',()=>yes(),{once:true}));},shutdown:async()=>{}}});
  cleanup.push(()=>engine.shutdown());const group=create(7);engine.start(group.id);await until(()=>started===2);
  await new Promise(r=>setTimeout(r,30));assert.equal(started,2);
  limits.maxActiveMembersPerUser=7;engine.pump(group.id);await until(()=>started===7);
  limits.maxActiveMembersPerUser=1;assert.equal(store.freeSession(group.id)?.status,'active');
});

test('round message storage limits stop new generation and can be raised without losing history',async t=>{
  const {store,limits,create,cleanup}=fixture(t);limits.maxMessagesPerGroup=1;const group=create(2);let calls=0;
  const scheduler=new Scheduler(store,{providers:()=>[provider],getKey:()=>undefined,notify:()=>{},resourceLimits:()=>limits,generate:async request=>{calls++;request.onDelta({content:'Fixture response'});return {inputTokens:1,outputTokens:1};}});
  cleanup.push(()=>scheduler.shutdown());const run=scheduler.start(group.id);await scheduler.settle(run.id);
  assert.equal(calls,1);assert.equal(store.messages(group.id).length,1);assert.match(store.run(run.id)?.error??'',/1 条记录上限/);
  limits.maxMessagesPerGroup=3;scheduler.retry(run.id);await scheduler.settle(run.id);
  assert.equal(calls,2);assert.equal(store.messages(group.id).length,2);assert.equal(store.run(run.id)?.status,'completed');
});
