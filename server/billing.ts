import {createHash,createHmac,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {BILLING_CAPABILITIES,type BillingCredentials,type BillingMoney,type BillingStatus} from '../shared/billing.js';
import {connectionKey,type ProviderConfig} from '../shared/types.js';
import type {SecretVault} from './vault.js';
import {DiscussionError} from './scheduler.js';

const secret=z.string().trim().min(1).max(2048).regex(/^[\x21-\x7e]+$/);
export const billingCredentialsSchema=z.union([z.object({accessKeyId:secret.max(256),secretAccessKey:secret,site:z.enum(['cn','intl']).default('cn')}).strict(),z.object({adminKey:secret}).strict()]);
export const billingRefreshSchema=z.object({month:z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/).optional()}).strict();
class BillingError extends Error {}
const formatError='官方接口返回的数据格式无法确认，未按零余额处理。';
const fail=()=>{throw new BillingError(formatError);};
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const hmac=(key:string|Buffer,v:string)=>createHmac('sha256',key).update(v).digest();
const percent=(v:string)=>encodeURIComponent(v).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
const canonical=(p:Record<string,string>)=>Object.keys(p).sort().map(k=>`${percent(k)}=${percent(p[k])}`).join('&');
/** Decimal strings stay decimal through summation; no cent rounding or binary-float accumulation. */
export function money(value:unknown):string {
  let v=typeof value==='number'&&Number.isFinite(value)?String(value):typeof value==='string'?value.trim():'';
  if(typeof value==='number'&&/[eE]/.test(v)){const parts=v.match(/^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i);if(!parts)return fail();const digits=parts[2]+(parts[3]??''),point=parts[2].length+Number(parts[4]);v=parts[1]+(point<=0?'0.'+'0'.repeat(-point)+digits:point>=digits.length?digits+'0'.repeat(point-digits.length):digits.slice(0,point)+'.'+digits.slice(point));}
  if(!/^-?\d{1,18}(?:\.\d{1,12})?$/.test(v))return fail();return v;
}
function decimal(v:string){const [a,b='']=money(v).split('.');return BigInt(a+b.padEnd(12,'0'));}
function textDecimal(v:bigint){const s=(v<0n?-v:v).toString().padStart(13,'0');return (v<0n?'-':'')+s.slice(0,-12)+'.'+s.slice(-12);}
function sum(values:string[],cents=false){const total=values.reduce((n,v)=>n+decimal(v),0n);return textDecimal(cents?total/100n:total);}
function currency(v:unknown){if(typeof v!=='string'||! /^[A-Za-z]{3}$/.test(v))return fail();return v.toUpperCase();}
export function volcRequest(action:'QueryBalanceAcct'|'ListBill',credentials:{accessKeyId:string;secretAccessKey:string},body?:object,now=new Date()):[string,RequestInit]{
  const host='billing.volcengineapi.com',query=canonical({Action:action,Version:'2022-01-01'}),payload=body?JSON.stringify(body):'',method=body?'POST':'GET';
  const date=now.toISOString().replace(/[:-]|\.\d{3}/g,''),day=date.slice(0,8),scope=`${day}/cn-beijing/billing/request`;
  const request=`${method}\n/\n${query}\nhost:${host}\nx-date:${date}\n\nhost;x-date\n${sha(payload)}`;
  const signing=hmac(hmac(hmac(hmac(credentials.secretAccessKey,day),'cn-beijing'),'billing'),'request');
  const signature=hmac(signing,`HMAC-SHA256\n${date}\n${scope}\n${sha(request)}`).toString('hex');
  return [`https://${host}/?${query}`,{method,headers:{'X-Date':date,Authorization:`HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=host;x-date, Signature=${signature}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:payload}:{})}];
}
export function aliyunRequest(credentials:{accessKeyId:string;secretAccessKey:string;site?:'cn'|'intl'},now=new Date(),nonce:string=randomUUID()):[string,RequestInit]{
  const params={Action:'QueryAccountBalance',Version:'2017-12-14',Format:'JSON',AccessKeyId:credentials.accessKeyId,SignatureMethod:'HMAC-SHA1',SignatureVersion:'1.0',SignatureNonce:nonce,Timestamp:now.toISOString().replace(/\.\d{3}Z$/,'Z')};
  const signature=createHmac('sha1',credentials.secretAccessKey+'&').update('GET&%2F&'+percent(canonical(params))).digest('base64');
  return [`https://${credentials.site==='intl'?'business.ap-southeast-1.aliyuncs.com':'business.aliyuncs.com'}/?${canonical({...params,Signature:signature})}`,{method:'GET'}];
}

/** Only these official, read-only endpoints are callable. Raw responses/credentials never enter chat context. */
export class BillingService {
  private cache=new Map<string,BillingStatus>();private pending=new Map<string,Promise<BillingStatus>>();private last=new Map<string,number>();
  constructor(private vault:Pick<SecretVault,'get'|'set'|'has'>,private fetcher:typeof fetch=fetch){}
  private key(p:ProviderConfig){return 'billing:'+connectionKey(p);}
  assertIdle(id:string){if(this.pending.has(id))throw new DiscussionError('请等待当前余额查询完成，再修改或移除模型连接。',409);}
  invalidate(id:string){this.cache.delete(id);this.last.delete(id);}
  status(p:ProviderConfig):BillingStatus {
    const mode=BILLING_CAPABILITIES[p.id].credential,configured=mode==='model-key'?this.vault.has(connectionKey(p)):mode!=='none'&&this.vault.has(this.key(p));
    if(mode==='none'||p.billingMode==='subscription')return {configured:false,state:'unsupported',metrics:[],warnings:[]};
    return this.cache.get(connectionKey(p))??{configured,state:configured?'unverified':'unconfigured',metrics:[],warnings:[]};
  }
  save(p:ProviderConfig,input:unknown){
    const id=connectionKey(p);if(this.pending.has(id))throw new DiscussionError('请等待当前余额查询结束后再修改凭据。',409);
    const mode=BILLING_CAPABILITIES[p.id].credential;if(mode!=='access-key'&&mode!=='admin-key')throw new DiscussionError('此连接不需要额外账单凭据。');
    const data=billingCredentialsSchema.parse(input);if((mode==='admin-key')!==('adminKey'in data))throw new DiscussionError('账单凭据类型不正确。');
    const encoded=JSON.stringify(data);if(encoded.length>4096)throw new DiscussionError('账单凭据过长。');this.vault.set(this.key(p),encoded);this.invalidate(id);return this.status(p);
  }
  remove(p:ProviderConfig){const id=connectionKey(p);if(this.pending.has(id))throw new DiscussionError('请等待余额查询结束后再移除凭据。',409);this.vault.set(this.key(p),null);this.invalidate(id);return this.status(p);}
  async refresh(p:ProviderConfig,month=new Date().toISOString().slice(0,7)):Promise<BillingStatus>{
    const id=connectionKey(p),before=this.status(p);if(!before.configured||before.state==='unsupported')return before;
    const running=this.pending.get(id);if(running)return running;
    if(Date.now()-(this.last.get(id)??0)<15000)throw new DiscussionError('官方余额 / 账单查询间隔至少 15 秒。',429);
    const currentMonth=new Date(Date.now()+8*3600000).toISOString().slice(0,7);if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)||month>currentMonth)throw new DiscussionError('请选择有效的当前或历史账单月份。');
    this.last.set(id,Date.now());
    const work=(async()=>{
      const at=new Date().toISOString(),metrics:BillingMoney[]=[],warnings:string[]=[];const deadline=AbortSignal.timeout(25000);
      try{
        let credentials:BillingCredentials|undefined;if(BILLING_CAPABILITIES[p.id].credential!=='model-key'){try{credentials=billingCredentialsSchema.parse(JSON.parse(this.vault.get(this.key(p))??''));}catch{throw new BillingError('账单凭据不可读取，请重新保存。');}}
        if(p.id==='deepseek'){
          const d=await this.json('https://api.deepseek.com/user/balance',{headers:{Authorization:`Bearer ${this.vault.get(id)}`}},deadline);
          if(!Array.isArray(d.balance_infos)||!d.balance_infos.length||d.balance_infos.length>10)fail();
          for(const b of d.balance_infos){const c=currency(b.currency);for(const [label,key] of [['账户总余额','total_balance'],['赠送余额','granted_balance'],['充值余额','topped_up_balance']])metrics.push({label,amount:money(b[key]),currency:c,kind:'balance',scope:'account'});}
          if(d.is_available===false)warnings.push('官方标记该账户目前不可用，请到控制台确认。');
        }else if(p.id==='qwen'&&credentials&&'accessKeyId'in credentials){
          const d=await this.json(...aliyunRequest(credentials),deadline);if(d.Success!==true)throw new BillingError('阿里云拒绝余额查询，请核对费用查询权限和国内 / 国际站选择。');const c=currency(d.Data?.Currency);
          for(const [label,key] of [['可用余额','AvailableAmount'],['可用现金余额','AvailableCashAmount'],['信控额度','CreditAmount']]){const value=d.Data?.[key];if(value!==undefined)metrics.push({label,amount:money(typeof value==='string'?value.replace(/,/g,''):value),currency:c,kind:'balance',scope:'account'});}if(!metrics.length)fail();
        }else if(p.id==='doubao'&&credentials&&'accessKeyId'in credentials){
          const d=await this.json(...volcRequest('QueryBalanceAcct',credentials),deadline);if(d.ResponseMetadata?.Error)throw new BillingError('火山引擎拒绝余额查询，请核对 AccessKey 和费用中心查询权限。');
          for(const [label,key] of [['可用余额','AvailableBalance'],['现金余额','CashBalance'],['欠费金额','ArrearsBalance'],['冻结金额','FreezeAmount']])metrics.push({label,amount:money(d.Result?.[key]),currency:'CNY',kind:'balance',scope:'account'});
          try{const costs=await this.volcCosts(credentials,month,deadline);metrics.push(...costs.metrics);warnings.push(...costs.warnings);}catch(e){warnings.push(e instanceof BillingError?`账单未取全：${e.message}`:'余额已读取，但本月方舟账单查询未完成。');}
        }else if((p.id==='openai'||p.id==='claude')&&credentials&&'adminKey'in credentials){metrics.push(...await this.costs(p.id,credentials.adminKey,month,deadline));}
        else fail();
        if(metrics.some(m=>m.partial))warnings.push('费用报告只读取了部分分页，金额不是完整总额。');
        const result:BillingStatus={configured:true,state:warnings.length?'partial':'ready',metrics,warnings,checkedAt:at,retrievedAt:at,month};this.cache.set(id,result);return result;
      }catch(e){const result:BillingStatus={...before,configured:true,state:'error',checkedAt:at,error:e instanceof BillingError?e.message:'官方查询未完成（网络中断或超时）。保留的旧数据不代表当前余额。',warnings:before.metrics.length?['以下为上次成功查询的数据，尚未更新。']:[]};this.cache.set(id,result);return result;}
    })().finally(()=>this.pending.delete(id));this.pending.set(id,work);return work;
  }
  private async json(url:string,init:RequestInit,signal:AbortSignal):Promise<any>{
    const response=await this.fetcher(url,{...init,signal,redirect:'error'});if(!response.ok){void response.body?.cancel().catch(()=>{});throw new BillingError(`官方查询失败（HTTP ${response.status}）。${response.status===401||response.status===403?'请检查账单凭据及只读财务权限。':response.status===429?'查询受限，请稍后重试。':'请稍后到官方控制台核对。'}`);}
    const reader=response.body?.getReader();if(!reader)fail();let size=0;const chunks:Uint8Array[]=[];
    try{while(true){const {done,value}=await reader!.read();if(done)break;size+=value.byteLength;if(size>2*1024*1024)throw new BillingError('官方账单响应过大，未作为完整结果显示。');chunks.push(value);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return fail();}}
    finally{void reader!.cancel().catch(()=>{});reader!.releaseLock();}
  }
  private async costs(id:'openai'|'claude',key:string,month:string,signal:AbortSignal):Promise<BillingMoney[]>{
    const start=new Date(month+'-01T00:00:00Z'),end=new Date(start);end.setUTCMonth(end.getUTCMonth()+1);const ending=new Date(Math.min(end.getTime(),Date.now()));
    const amounts=new Map<string,string[]>();let page:string|undefined;const seen=new Set<string>();let complete=false;
    for(let i=0;i<10;i++){
      const url=new URL(id==='openai'?'https://api.openai.com/v1/organization/costs':'https://api.anthropic.com/v1/organizations/cost_report');
      const q=id==='openai'?{start_time:String(start.getTime()/1000),end_time:String(Math.floor(ending.getTime()/1000)),bucket_width:'1d',limit:'31'}:{starting_at:start.toISOString(),ending_at:ending.toISOString(),bucket_width:'1d',limit:'31'};
      for(const [k,v] of Object.entries(q))if(v!==undefined)url.searchParams.set(k,v);if(page)url.searchParams.set('page',page);
      const d=await this.json(url.href,{headers:id==='openai'?{Authorization:`Bearer ${key}`}:{'x-api-key':key,'anthropic-version':'2023-06-01'}},signal);
      if(!Array.isArray(d.data)||typeof d.has_more!=='boolean')fail();for(const bucket of d.data){if(!Array.isArray(bucket.results))fail();for(const r of bucket.results){const c=currency(id==='openai'?r.amount?.currency:r.currency??'USD'),a=money(id==='openai'?r.amount?.value:r.amount);amounts.set(c,[...(amounts.get(c)??[]),a]);}}
      if(!d.has_more){complete=true;break;}if(typeof d.next_page!=='string'||!d.next_page||seen.has(d.next_page))fail();page=String(d.next_page);seen.add(page);
    }
    if(!amounts.size)amounts.set('USD',[]);
    return [...amounts].map(([c,a])=>({label:'官方报告费用',kind:'cost',scope:'organization',amount:sum(a,id==='claude'),currency:c,period:month,...(!complete?{partial:true}:{})}));
  }
  private async volcCosts(credentials:{accessKeyId:string;secretAccessKey:string},month:string,signal:AbortSignal){
    const sums=new Map<string,string[]>(),warnings:string[]=[];let offset=0,complete=false,matched=0;
    for(let i=0;i<10;i++){
      await new Promise<void>(r=>setTimeout(r,220));signal.throwIfAborted();
      const d=await this.json(...volcRequest('ListBill',credentials,{BillPeriod:month,Limit:300,Offset:offset,NeedRecordNum:1,IgnoreZero:0}),signal);
      if(d.ResponseMetadata?.Error)throw new BillingError('请检查 ListBill 账单查询权限。');const result=d.Result;if(!Array.isArray(result?.List)||!Number.isSafeInteger(result.Total)||result.Total<0)fail();
      for(const row of result.List){if(!/^(ark|volcark)$/i.test(String(row.Product??''))&&!/火山方舟|豆包/.test(String(row.ProductZh??'')))continue;matched++;const c=currency(row.Currency??'CNY');sums.set(c,[...(sums.get(c)??[]),money(row.PayableAmount)]);}
      offset+=result.List.length;if(offset>=result.Total){complete=true;break;}if(!result.List.length)fail();
    }
    if(!matched)warnings.push('尚未找到可识别的火山方舟账单记录；可能尚未出账或产品标识发生变化，不能认定消费为零。');
    if(!complete)warnings.push('账单超过单次查询上限，仅显示已读取部分，请到官方账单核对。');
    return {metrics:[...sums].map(([c,a]):BillingMoney=>({label:'方舟账单应付金额',kind:'cost',scope:'ark',amount:sum(a),currency:c,period:month,...(!complete?{partial:true}:{})})),warnings};
  }
}
