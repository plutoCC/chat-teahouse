import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {BillingService,aliyunRequest,volcRequest,money} from '../server/billing.js';
import type {ProviderConfig} from '../shared/types.js';
const provider=(id:ProviderConfig['id'],connectionId?:string):ProviderConfig=>({id,connectionId,name:id,model:'fixture',hasKey:false,enabled:false,region:'cn',inputPrice:0,outputPrice:0});
function fixture(fn:(url:string,init:RequestInit)=>Promise<Response>|Response){const secrets=new Map<string,string>();const vault={has:(id:string)=>secrets.has(id),get:(id:string)=>secrets.get(id),set:(id:string,v:string|null)=>{v===null?secrets.delete(id):secrets.set(id,v);}};const calls:{url:string;init:RequestInit}[]=[];const service=new BillingService(vault,async(url,init)=>{calls.push({url:String(url),init:init!});return fn(String(url),init!);});return {service,vault,calls};}
const response=(value:unknown)=>Response.json(value);

test('unconfigured providers do not request anything; local/subscription providers have no cash balance',async()=>{
  const f=fixture(()=>{throw Error('must not fetch');});for(const id of ['openai','claude','qwen','doubao','deepseek'] as const)assert.equal((await f.service.refresh(provider(id))).state,'unconfigured');
  assert.equal((await f.service.refresh(provider('ollama'))).state,'unsupported');assert.equal(f.service.status({...provider('openai'),billingMode:'subscription'}).state,'unsupported');assert.equal(f.calls.length,0);
});
test('DeepSeek keys, currencies and account scope stay separate; raw upstream fields never escape',async()=>{
  const f=fixture((_url,init)=>response({is_available:true,secret:'must-not-escape',balance_infos:[{currency:'CNY',total_balance:'3.012345',granted_balance:'1.00',topped_up_balance:'2.012345'}]}));
  f.vault.set('deepseek','fixture-first');f.vault.set('conn-second','fixture-second');const result=await f.service.refresh(provider('deepseek','conn-second'));
  assert.equal(result.state,'ready');assert.equal(result.metrics[0].amount,'3.012345');assert.ok(result.metrics.every(m=>m.scope==='account'));assert.equal(new Headers(f.calls[0].init.headers).get('Authorization'),'Bearer fixture-second');assert.equal(f.calls[0].url,'https://api.deepseek.com/user/balance');assert.equal(f.calls[0].init.redirect,'error');assert.ok(!JSON.stringify(result).includes('must-not-escape'));
  await assert.rejects(f.service.refresh(provider('deepseek','conn-second')),/15 秒/);
});
test('malformed/error balance is unknown, never fabricated zero or leaked provider errors',async()=>{
  const f=fixture(()=>new Response('leak-key-example',{status:403}));f.vault.set('deepseek','fixture');const result=await f.service.refresh(provider('deepseek'));assert.equal(result.state,'error');assert.deepEqual(result.metrics,[]);assert.match(result.error!,/403/);assert.ok(!JSON.stringify(result).includes('leak-key-example'));
  const bad=fixture(()=>response({balance_infos:[{currency:'CNY',total_balance:'garbage'}]}));bad.vault.set('deepseek','fixture');assert.equal((await bad.service.refresh(provider('deepseek'))).state,'error');
});
test('OpenAI costs follow pagination and sum exact decimal dollars while Claude converts cents',async()=>{
  const f=fixture((url)=>url.includes('api.openai')?response({data:[{results:[{amount:{value:url.includes('page=next')?0.2:0.1,currency:'usd'}}]}],has_more:!url.includes('page=next'),next_page:'next'}):response({data:[{results:[{amount:'123.45',currency:'USD'},{amount:'0.55',currency:'USD'}]}],has_more:false}));
  f.service.save(provider('openai'),{adminKey:'fixture-admin'});f.service.save(provider('claude'),{adminKey:'fixture-claude-admin'});
  assert.equal((await f.service.refresh(provider('openai'),'2026-01')).metrics[0].amount,'0.300000000000');const claude=await f.service.refresh(provider('claude'),'2026-01');assert.equal(claude.metrics[0].amount,'1.240000000000');assert.equal(claude.metrics[0].scope,'organization');assert.equal(f.calls.length,3);assert.equal(new Headers(f.calls[2].init.headers).get('x-api-key'),'fixture-claude-admin');assert.equal(money(1e-7),'0.0000001');
});
test('Qwen uses dedicated financial credentials and explicit site, not the inference API Key',async()=>{
  const f=fixture(()=>response({Success:true,Data:{AvailableAmount:'1,234.56',AvailableCashAmount:'2.56',Currency:'USD'}}));f.vault.set('qwen','never-send-inference-key');f.service.save(provider('qwen'),{accessKeyId:'fixture-ak',secretAccessKey:'fixture-sk',site:'intl'});
  const result=await f.service.refresh(provider('qwen'));assert.equal(result.metrics[0].amount,'1234.56');assert.equal(new URL(f.calls[0].url).hostname,'business.ap-southeast-1.aliyuncs.com');assert.ok(!f.calls[0].url.includes('fixture-sk'));assert.ok(!f.calls[0].url.includes('never-send-inference-key'));assert.ok(!JSON.stringify(result).includes('fixture-ak'));
});
test('Volcengine queries signed balance then only identifiable Ark monthly costs; empty is unknown',async()=>{
  const f=fixture(url=>url.includes('QueryBalanceAcct')?response({Result:{AvailableBalance:'12.30',CashBalance:'14',ArrearsBalance:'0',FreezeAmount:'1.70'}}):response({Result:{List:[{ProductZh:'火山方舟',PayableAmount:'0.01',Currency:'CNY'},{Product:'ark',PayableAmount:'0.02',Currency:'CNY'},{ProductZh:'云服务器',PayableAmount:'99',Currency:'CNY'}],Total:3}}));
  f.service.save(provider('doubao'),{accessKeyId:'fixture-ak',secretAccessKey:'fixture-sk'});const result=await f.service.refresh(provider('doubao'),'2026-01');assert.equal(result.metrics.at(-1)!.amount,'0.030000000000');assert.equal(result.metrics.at(-1)!.scope,'ark');assert.ok(f.calls.every(c=>new URL(c.url).hostname==='billing.volcengineapi.com'));assert.ok(!JSON.stringify(f.calls).includes('fixture-sk'));
});
test('financial credentials cannot be supplied as another provider type and removal does not remove inference keys',()=>{
  const f=fixture(()=>response({}));f.vault.set('qwen','inference');assert.throws(()=>f.service.save(provider('openai'),{accessKeyId:'a',secretAccessKey:'b'}));f.service.save(provider('qwen'),{accessKeyId:'a',secretAccessKey:'b'});assert.equal(f.service.status(provider('qwen')).state,'unverified');f.service.remove(provider('qwen'));assert.equal(f.vault.get('qwen'),'inference');assert.equal(f.service.status(provider('qwen')).state,'unconfigured');
});
test('official signature requests contain scoped authentication without secret material',()=>{
  const [url,init]=volcRequest('QueryBalanceAcct',{accessKeyId:'test-ak',secretAccessKey:'test-sk'},undefined,new Date('2025-03-29T18:09:37Z'));assert.match(url,/^https:\/\/billing\.volcengineapi\.com/);assert.match(new Headers(init.headers).get('Authorization')!,/20250329\/cn-beijing\/billing\/request/);assert.equal(new Headers(init.headers).get('X-Date'),'20250329T180937Z');
  const [ali]=aliyunRequest({accessKeyId:'test-ak',secretAccessKey:'test-sk'},new Date('2025-03-29T18:09:37Z'),'fixture');const u=new URL(ali);const signature=u.searchParams.get('Signature');u.searchParams.delete('Signature');const enc=(v:string)=>encodeURIComponent(v).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());const canonical=[...u.searchParams].sort(([a],[b])=>a<b?-1:1).map(([k,v])=>enc(k)+'='+enc(v)).join('&');assert.equal(signature,createHmac('sha1','test-sk&').update('GET&%2F&'+enc(canonical)).digest('base64'));
});
