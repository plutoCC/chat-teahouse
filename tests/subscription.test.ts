import test from 'node:test';
import assert from 'node:assert/strict';
import type {GenerateOptions} from '@deepseek-ai/dsh-llm';
import {CodexSubscription,quotasOf} from '../server/subscription/codex.js';
import type {RpcTransport} from '../server/subscription/codex-rpc.js';
import {ProviderRequestError} from '../server/model-errors.js';
import type {ProviderConfig} from '../shared/types.js';

const provider:ProviderConfig={id:'openai',name:'fixture',model:'gpt-fixture',enabled:true,hasKey:false,region:'cn',inputPrice:10,outputPrice:20,billingMode:'subscription'};
const options={model:'gpt-fixture',system:'独立成员甲',messages:[],tools:[{name:'wait_for_messages',description:'等待',parameters:{type:'object',properties:{seconds:{type:'number'}},required:['seconds']}}],maxTokens:1000} as unknown as GenerateOptions;
class FakeRpc implements RpcTransport {
  calls:{method:string;params:any}[]=[];listeners=new Set<(method:string,p:any)=>void>();counter=0;logged=true;limit=10;autoComplete=true;
  emit(m:string,p:any){for(const fn of this.listeners)fn(m,p);}
  async request(method:string,params?:any){this.calls.push({method,params});switch(method){
    case 'account/read':return {account:this.logged?{type:'chatgpt',email:'fixture@example.invalid',planType:'plus'}:null};
    case 'account/rateLimits/read':return {rateLimitsByLimitId:{codex:{limitName:'Codex',primary:{usedPercent:this.limit,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+3600}}}};
    case 'account/login/start':return {authUrl:'https://auth.openai.com/fixture',loginId:'fixture-login'};
    case 'account/logout':this.logged=false;return {};
    case 'model/list':return {data:[{model:'gpt-fixture',displayName:'测试模型'},{model:'gpt-hidden',hidden:true}],nextCursor:null};
    case 'thread/start':return {thread:{id:'thread-'+(++this.counter)}};
    case 'turn/start':{const threadId=params.threadId;const turn={id:'turn-'+threadId,status:'completed'};if(this.autoComplete)queueMicrotask(()=>{
      this.emit('thread/tokenUsage/updated',{threadId,tokenUsage:{total:{inputTokens:111,outputTokens:22}}});
      this.emit('item/completed',{threadId,item:{type:'reasoning',summary:['官方摘要'],content:['RAW-REASONING-NOT-PUBLIC']}});
      this.emit('item/completed',{threadId,item:{type:'agentMessage',phase:'final_answer',text:JSON.stringify({name:'wait_for_messages',arguments:'{"seconds":0}'})}});
      this.emit('turn/completed',{threadId,turn});
    });return {turn};}
    default:return {};
  }}
  onEvent(fn:(m:string,p:any)=>void){this.listeners.add(fn);return()=>{this.listeners.delete(fn);};}async close(){}
}
test('subscription quota uses used percent and missing stays unknown, including sparse updates',async()=>{
  assert.deepEqual(quotasOf({}),[]);const rpc=new FakeRpc(),service=new CodexSubscription('unused',()=>{},()=>rpc);const status=await service.status('openai');assert.equal(status.quotas[0].primary!.usedPercent,10);rpc.limit=25;rpc.emit('account/rateLimits/updated',{rateLimits:{primary:null}});assert.equal((await service.status('openai')).quotas[0].primary!.usedPercent,25);await service.close();
});
test('subscription model calls create isolated ephemeral threads, disable environments and expose summaries only',async()=>{
  const rpc=new FakeRpc(),service=new CodexSubscription('unused',()=>{},()=>rpc);const a=await service.generate(options,provider),b=await service.generate({...options,system:'独立成员乙'},provider);
  assert.equal(a.inputTokens,111);assert.equal(b.outputTokens,22);assert.equal(a.returnedReasoning!.text,'官方摘要');assert.ok(!JSON.stringify(a).includes('RAW-REASONING'));
  const starts=rpc.calls.filter(c=>c.method==='thread/start');assert.equal(starts.length,2);assert.equal(starts[0].params.baseInstructions,'独立成员甲');assert.equal(starts[1].params.baseInstructions,'独立成员乙');assert.ok(starts.every(c=>c.params.ephemeral&&c.params.allowProviderModelFallback===false&&c.params.approvalPolicy==='never'&&c.params.sandbox==='read-only'));assert.deepEqual(starts[0].params.environments,[]);assert.deepEqual(starts[0].params.selectedCapabilityRoots,[]);assert.equal(starts[0].params.dynamicTools,undefined);assert.equal(rpc.calls.filter(c=>c.method==='thread/unsubscribe').length,2);assert.equal(rpc.calls.filter(c=>c.method==='turn/interrupt').length,0);await service.close();
});
test('missing login and exhausted quota fail before inference without paid API fallback',async()=>{
  const rpc=new FakeRpc(),service=new CodexSubscription('unused',()=>{},()=>rpc);rpc.logged=false;await assert.rejects(service.generate(options,provider),(e:unknown)=>e instanceof ProviderRequestError&&e.notGenerated);rpc.logged=true;rpc.limit=100;await service.status('openai',true);await assert.rejects(service.generate(options,provider),/额度已用尽/);assert.ok(!rpc.calls.some(c=>c.method==='thread/start'));await service.close();
});
test('cancelled subscription turn interrupts the official process and never returns a chat decision',async()=>{
  const rpc=new FakeRpc();rpc.autoComplete=false;const service=new CodexSubscription('unused',()=>{},()=>rpc),controller=new AbortController();const request=service.generate({...options,signal:controller.signal},provider);const rejected=assert.rejects(request,/取消/);await new Promise(r=>setTimeout(r,20));controller.abort();await rejected;assert.ok(rpc.calls.some(c=>c.method==='turn/interrupt'));assert.ok(rpc.calls.some(c=>c.method==='thread/unsubscribe'));await service.close();
});
test('login allows only official auth URL and model list filters hidden entries',async()=>{
  const rpc=new FakeRpc(),service=new CodexSubscription('unused',()=>{},()=>rpc);assert.equal((await service.login('openai')).url,'https://auth.openai.com/fixture');assert.equal((await service.models(provider)).models.length,1);await service.cancel('openai');assert.ok(rpc.calls.some(c=>c.method==='account/login/cancel'));await service.close();
});
