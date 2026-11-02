import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { HostingBudget,defaultHostingLimits } from '../server/hosting/budget.js';
import { hostedGenerators,hostedProviders } from '../server/hosting/models.js';
import { hostingConfig,hostingDataDir } from '../server/hosting/config.js';
import { PROVIDER_DEFAULTS } from '../server/providers.js';
import { ProviderRequestError } from '../server/model-errors.js';
import type { CompletionRequest,ProviderConfig } from '../shared/types.js';

function directory(){const root=resolve('.test-artifacts');mkdirSync(root,{recursive:true});return mkdtempSync(join(root,'hosting-budget-'));}
test('host quota reserves concurrent costs atomically, settles actual model-specific rates and survives restarts',t=>{
  const dir=directory();let time=Date.parse('2026-01-01T23:59:50Z');
  const limits={...defaultHostingLimits,userDailyCny:1,dailyCny:2,monthlyCny:3,userConcurrency:1};
  let budget=new HostingBudget(dir,limits,()=>time);t.after(()=>budget.close());
  const a=budget.reserve('a',10000,1000,1,2);
  assert.throws(()=>budget.reserve('a',10,10,1,2),/并发/);
  const b=budget.reserve('b',10000,1000,2,3);
  budget.settle(a,{inputTokens:100,outputTokens:50});
  assert.equal(budget.usage('a').estimatedCny,0.0014);
  budget.settle(b);assert.equal(budget.usage('b').uncertain,1);
  const pending=budget.reserve('a',1000,100,1,2);assert.ok(pending);
  const before=budget.usage('a').estimatedCny;budget.close();budget=new HostingBudget(dir,limits,()=>time);
  assert.equal(budget.usage('a').estimatedCny,before);assert.equal(budget.usage('a').pending,0);assert.equal(budget.usage('a').uncertain,1);
  time+=20000;assert.equal(budget.usage('a').calls,0);
});
test('quotas cannot be reset by new groups/users and unknown failures keep conservative reservations',async t=>{
  const budget=new HostingBudget(directory(),{...defaultHostingLimits,dailyCny:0.02,userDailyCny:0.02,monthlyCny:0.03});t.after(()=>budget.close());
  const id=budget.reserve('a',1000,100,1,2);budget.settle(id);
  assert.throws(()=>budget.reserve('b',10000,1000,1,2),/额度/);
  const before=budget.usage('a').estimatedCny;
  await assert.rejects(budget.run('a',100,100,{inputPrice:1,outputPrice:2},async()=>{throw new ProviderRequestError('quota','quota',429,true);}),/quota/);
  assert.equal(budget.usage('a').estimatedCny,before);assert.equal(budget.usage('a').calls,2);
  assert.throws(()=>budget.reserve('a',10,10,0,0),/价格/);
  assert.throws(()=>budget.reserve('a',10,100000,1,2),/输出/);
});
test('monthly and global calls continue enforcing limits across date rollover and accounts',t=>{
  let time=Date.parse('2026-02-01');const budget=new HostingBudget(directory(),{...defaultHostingLimits,monthlyCny:0.01,dailyCalls:1},()=>time);t.after(()=>budget.close());
  const id=budget.reserve('a',1000,100,1,2);budget.settle(id);
  assert.throws(()=>budget.reserve('b',1,1,1,2),/次数/);
  time+=86400000;assert.throws(()=>budget.reserve('a',1000,100,1,2),/额度/);
});
test('estimated upstream usage does not release the host conservative reservation',async t=>{
  const budget=new HostingBudget(directory());t.after(()=>budget.close());
  await budget.run('a',1000,1000,{inputPrice:1,outputPrice:2},async()=>({inputTokens:1,outputTokens:1,usageEstimated:true}));
  assert.equal(budget.usage('a').estimatedCny,0.021);assert.equal(budget.usage('a').uncertain,1);
});
test('host selects only enabled cloud API connections and rechecks price, model, key and revocation at dispatch',async t=>{
  const provider={...PROVIDER_DEFAULTS.find(p=>p.id==='deepseek')!,enabled:true,hasKey:true,inputPrice:1,outputPrice:2};
  const source={providers:()=>[provider,{...PROVIDER_DEFAULTS.find(p=>p.id==='ollama')!,enabled:true},{...PROVIDER_DEFAULTS.find(p=>p.id==='openai')!,billingMode:'subscription' as const,enabled:true}],getKey:()=> 'fixture-private-key'};
  assert.deepEqual(hostedProviders(source).map(p=>p.id),['deepseek']);
  let active=true,calls=0;
  const budget=new HostingBudget(directory());t.after(()=>budget.close());
  const {generate}=hostedGenerators('a',source,budget,()=>active,{complete:async r=>{calls++;assert.equal(r.apiKey,'fixture-private-key');return {inputTokens:10,outputTokens:20};},native:async()=>{throw new Error('unused');}});
  const req:CompletionRequest={provider,participant:{id:'p',name:'fixture',providerId:'deepseek',model:provider.model,role:'',avatar:'茶',color:'#000000',enabled:true},goal:'fixture',roster:'fixture',history:[],round:1,summary:false,maxOutputTokens:100,signal:new AbortController().signal,onDelta:()=>{}};
  await generate(req);assert.equal(calls,1);assert.equal(budget.usage('a').estimatedCny,0.00035);
  await assert.rejects(generate({...req,provider:{...provider,model:'not-published'}}),/未由站长/);
  provider.enabled=false;await assert.rejects(generate(req),/未由站长/);provider.enabled=true;
  active=false;await assert.rejects(generate(req),/撤销/);assert.equal(calls,1);
});
test('hosting configuration rejects unsafe origins, port collisions and personal data paths',()=>{
  assert.throws(()=>hostingConfig({}),/PUBLIC_ORIGIN/);
  for(const origin of ['http://tea.example.com','https://tea.example.com/','https://user:pass@tea.example.com','https://localhost'])assert.throws(()=>hostingConfig({CHAT_TEA_PUBLIC_ORIGIN:origin}));
  assert.throws(()=>hostingConfig({CHAT_TEA_PUBLIC_ORIGIN:'https://tea.example.com',CHAT_TEA_HOST_PORT:'4318'}),/端口/);
  assert.equal(hostingConfig({CHAT_TEA_PUBLIC_ORIGIN:'https://tea.example.com'}).limits.userDailyCny,5);
  assert.throws(()=>hostingDataDir('data'),/分离/);assert.throws(()=>hostingDataDir(process.cwd()),/分离/);
});

test('one connection shares multiple models with canonical per-model pricing and rejects unpublished or unpriced models',async t=>{
  const provider:ProviderConfig={...PROVIDER_DEFAULTS.find(p=>p.id==='deepseek')!,enabled:true,hasKey:true,model:'model-a',inputPrice:1,outputPrice:2,
    sharedModels:['model-a','model-b','unpriced'],modelPrices:{'model-a':{inputPrice:1,outputPrice:2},'model-b':{inputPrice:3,outputPrice:4},'private-model':{inputPrice:5,outputPrice:6}}};
  let key='fixture-key';const source={providers:()=>[provider],getKey:()=>key};
  const projected=hostedProviders(source)[0];assert.deepEqual(projected.sharedModels,['model-a','model-b']);assert.equal(projected.modelPrices?.['private-model'],undefined);
  const budget=new HostingBudget(directory());t.after(()=>budget.close());let calls=0;
  const {generate}=hostedGenerators('multi',source,budget,()=>true,{complete:async req=>{calls++;assert.equal(req.provider.model,'model-b');assert.equal(req.provider.inputPrice,3);assert.equal(req.provider.outputPrice,4);return {inputTokens:100,outputTokens:50};},native:async()=>{throw Error('unused');}});
  const req:CompletionRequest={provider:{...provider,model:'model-b',inputPrice:0,outputPrice:0},participant:{id:'m',name:'测试',providerId:'deepseek',model:'model-b',role:'',avatar:'茶',color:'#000000',enabled:true},goal:'test',roster:'test',history:[],round:1,summary:false,maxOutputTokens:100,signal:new AbortController().signal,onDelta:()=>{}};
  await generate(req);assert.equal(budget.usage('multi').estimatedCny,0.0035);
  for(const model of ['unpriced','private-model','demo'])await assert.rejects(generate({...req,provider:{...provider,model}}),/未由站长/);
  provider.sharedModels=['model-a'];await assert.rejects(generate(req),/未由站长/);
  provider.sharedModels=['model-b'];assert.equal(hostedProviders(source)[0].model,'model-b','published fallback must have its own price');assert.equal(hostedProviders(source)[0].inputPrice,3);
  key='';await assert.rejects(generate(req),/未由站长/);key='fixture-key';provider.sharedModels=[];assert.deepEqual(hostedProviders(source),[]);assert.equal(calls,1);
});
