import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ToolCallId,type GenerateOptions} from '@deepseek-ai/dsh-llm';
import {connectionKey,type ProviderConfig} from '../../shared/types.js';
import type {ModelCatalog} from '../../shared/model-catalog.js';
import type {SubscriptionStatus,QuotaWindow,SubscriptionQuota} from '../../shared/subscription.js';
import type {NativeReply} from '../runtime-adapters/native-model.js';
import {ModelCallError,ModelResponseError,ProviderRequestError} from '../model-errors.js';
import {CodexRpc,type RpcTransport} from './codex-rpc.js';

const unavailable=()=>new ProviderRequestError('ChatGPT 订阅未登录或授权已过期。请在该模型连接中使用 Continue with ChatGPT 登录；不会改用 API Key。','auth',401,true);
function windowOf(v:any):QuotaWindow|null {if(!v||typeof v.usedPercent!=='number'||!Number.isFinite(v.usedPercent))return null;return {usedPercent:Math.max(0,Math.min(100,v.usedPercent)),windowDurationMins:typeof v.windowDurationMins==='number'?v.windowDurationMins:null,resetsAt:typeof v.resetsAt==='number'?v.resetsAt:null};}
export function quotasOf(value:any):SubscriptionQuota[]{
  const entries=value?.rateLimitsByLimitId&&typeof value.rateLimitsByLimitId==='object'?Object.entries(value.rateLimitsByLimitId):value?.rateLimits?[[value.rateLimits.limitId??'codex',value.rateLimits]]:[];
  return entries.slice(0,30).map(([id,raw])=>{const q=raw as any;return {id:String(id),name:typeof q?.limitName==='string'?q.limitName:String(id),...(typeof q?.normalModelSlug==='string'?{model:q.normalModelSlug}:{}),primary:windowOf(q?.primary),secondary:windowOf(q?.secondary)};});
}
export interface SubscriptionService {
  status(id:string,refresh?:boolean):Promise<SubscriptionStatus>;
  login(id:string):Promise<{url:string}>;cancel(id:string):Promise<void>;logout(id:string):Promise<void>;
  models(provider:ProviderConfig):Promise<ModelCatalog>;
  generate(options:GenerateOptions,provider:ProviderConfig):Promise<NativeReply>;
  close():Promise<void>;
}
/** Uses the official installed app-server and its managed OAuth. No token copying or private endpoint calls. */
export class CodexSubscription implements SubscriptionService {
  private clients=new Map<string,RpcTransport>();private cache=new Map<string,SubscriptionStatus>();private logins=new Map<string,string>();private refreshing=new Map<string,Promise<SubscriptionStatus>>();
  constructor(private dataDir:string,private notify:()=>void,private factory?:(home:string,workspace:string)=>RpcTransport){}
  private rpc(id:string){
    if(!/^[a-zA-Z0-9_-]{1,128}$/.test(id))throw new ModelCallError('订阅连接标识无效。');
    let rpc=this.clients.get(id);if(!rpc){const root=resolve(this.dataDir,'codex-subscription',id),workspace=join(root,'empty-workspace');rpc=this.factory?.(root,workspace)??new CodexRpc(root,workspace);this.clients.set(id,rpc);
      rpc.onEvent((method,p)=>{if(method==='account/login/completed'){this.logins.delete(id);this.cache.delete(id);void this.status(id,true).catch(()=>{});this.notify();}if(method==='account/updated'){this.cache.delete(id);this.notify();}if(method==='account/rateLimits/updated'){this.cache.delete(id);this.notify();}});
    }return rpc;
  }
  status(id:string,refresh=false):Promise<SubscriptionStatus>{
    const old=this.cache.get(id);if(!refresh&&old&&Date.now()-Date.parse(old.checkedAt??'')<30000)return Promise.resolve({...old,pending:this.logins.has(id)});
    const running=this.refreshing.get(id);if(running)return running;
    const operation=(async()=>{let next:SubscriptionStatus={connected:false,pending:this.logins.has(id),quotas:[],checkedAt:new Date().toISOString()};try{
      const rpc=this.rpc(id),result=await rpc.request('account/read',{refreshToken:false});const account=result?.account;
      if(account?.type==='chatgpt'){
        next={...next,connected:true,plan:typeof account.planType==='string'?account.planType:undefined,email:typeof account.email==='string'?account.email:undefined};
        try{next.quotas=quotasOf(await rpc.request('account/rateLimits/read'));}catch{next.error='当前无法读取官方剩余额度；未知不代表额度充足。';}
      }
    }catch{next.error='无法连接本机 Codex，请确认已安装官方 Codex CLI，必要时设置 CHAT_TEA_CODEX_PATH。';}this.cache.set(id,next);return next;})().finally(()=>{this.refreshing.delete(id);});this.refreshing.set(id,operation);return operation;
  }
  async login(id:string){await this.cancel(id);const result=await this.rpc(id).request('account/login/start',{type:'chatgpt'});let url:URL;try{url=new URL(result.authUrl);}catch{throw unavailable();}
    if(url.protocol!=='https:'||url.hostname!=='auth.openai.com'||url.username||url.password||typeof result.loginId!=='string')throw new ModelCallError('官方登录地址格式不正确，已拒绝打开。');
    this.logins.set(id,result.loginId);this.cache.delete(id);return {url:url.href};
  }
  async cancel(id:string){const loginId=this.logins.get(id);if(loginId){await this.rpc(id).request('account/login/cancel',{loginId});this.logins.delete(id);}}
  async logout(id:string){await this.cancel(id);await this.rpc(id).request('account/logout');this.cache.delete(id);this.notify();}
  async models(provider:ProviderConfig):Promise<ModelCatalog>{
    const id=connectionKey(provider);if(!(await this.status(id)).connected)throw unavailable();
    const models:{id:string;label:string}[]=[];let cursor:string|undefined;
    for(let i=0;i<5;i++){const data=await this.rpc(id).request('model/list',{limit:100,includeHidden:false,...(cursor?{cursor}:{})});for(const m of data?.data??[])if(typeof m.model==='string'&&/^[a-zA-Z0-9._-]{1,128}$/.test(m.model)&&!m.hidden)models.push({id:m.model,label:typeof m.displayName==='string'?m.displayName:m.model});cursor=typeof data.nextCursor==='string'?data.nextCursor:undefined;if(!cursor)break;}
    return {providerId:'openai',region:provider.region,source:'account',models,fetchedAt:new Date().toISOString(),message:'官方 Codex 返回的订阅模型目录，可能含本机缓存；实际使用权限以该账号成功完成请求为准。'};
  }
  async generate(options:GenerateOptions,provider:ProviderConfig):Promise<NativeReply>{
    const id=connectionKey(provider),status=await this.status(id);if(!status.connected)throw unavailable();
    if(status.quotas.some(q=>(!q.model||q.model===options.model)&&[q.primary,q.secondary].some(w=>w&&w.usedPercent>=100&&(!w.resetsAt||w.resetsAt*1000>Date.now()))))throw new ProviderRequestError('ChatGPT 订阅额度已用尽，请等待重置或在官方页面检查额度；未切换至 API 付费。','quota',429,true);
    options.signal?.throwIfAborted();
    const rpc=this.rpc(id),system=[options.system,...options.messages.filter(m=>m.role==='system').flatMap(m=>m.content.filter(b=>b.type==='text').map(b=>b.text))].filter(Boolean).join('\n');
    const tools=options.tools??[];if(!tools.length)throw new ModelCallError('订阅成员需要群聊决策工具。');
    const schema={type:'object',additionalProperties:false,properties:{name:{type:'string',enum:tools.map(t=>t.name)},arguments:{type:'string'}},required:['name','arguments']};
    const created=await rpc.request('thread/start',{model:options.model,allowProviderModelFallback:false,cwd:resolve(this.dataDir,'codex-subscription',id,'empty-workspace'),environments:[],selectedCapabilityRoots:[],approvalPolicy:'never',sandbox:'read-only',ephemeral:true,baseInstructions:system,developerInstructions:'只作为群聊决策模型。禁止访问环境、文件、网络、插件和其他代理。按给定 JSON Schema 输出一个决定：name 是工具名称，arguments 是符合该工具参数定义的 JSON 字符串。不要真正执行环境工具。',config:{web_search:'disabled','apps._default.enabled':false}});
    const threadId=created?.thread?.id;if(typeof threadId!=='string')throw new ModelCallError('官方 Codex 未创建独立模型会话。');
    const history=options.messages.filter(m=>m.role!=='system').map(m=>({role:m.role,...(m.role==='tool'?{toolCallId:m.toolCallId}:{}),content:m.content.filter(b=>b.type==='text'||b.type==='tool-call')}));
    let turnId:string|undefined,usage:{inputTokens:number;outputTokens:number}|undefined,finalText='',summary='';
    let cancelled=false;let completed=false;let cleanup=()=>{};
    const completion=new Promise<NativeReply>((resolve,reject)=>{
      const abort=()=>{cancelled=true;if(turnId)void rpc.request('turn/interrupt',{threadId,turnId}).catch(()=>{});reject(new ModelCallError('订阅判断已取消，未发布消息。'));};
      const off=rpc.onEvent((method,p)=>{
        if(method==='teahouse/disconnected'){reject(new ModelCallError('官方 Codex 连接中断，本次未发布消息。'));return;}
        if(p?.threadId!==threadId)return;
        if(method==='turn/started'&&typeof p?.turn?.id==='string'){turnId=p.turn.id;if(cancelled||options.signal?.aborted)abort();}
        if(method==='thread/tokenUsage/updated'){const u=p?.tokenUsage?.total;if(u&&Number.isSafeInteger(u.inputTokens)&&u.inputTokens>=0&&Number.isSafeInteger(u.outputTokens)&&u.outputTokens>=0)usage={inputTokens:u.inputTokens,outputTokens:u.outputTokens};}
        if(method==='item/completed'){
          if(p.item?.type==='agentMessage'&&p.item.phase!=='commentary')finalText=String(p.item.text??'').slice(0,128000);
          if(p.item?.type==='reasoning')summary=(summary+'\n'+(Array.isArray(p.item.summary)?p.item.summary.filter((s:unknown)=>typeof s==='string').join('\n'):'')).slice(0,16000);
          if(['commandExecution','fileChange','mcpToolCall','webSearch','collabAgentToolCall'].includes(p.item?.type)){abort();return;}
        }
        if(method==='turn/completed'){
          const returnedReasoning=summary.trim()?{text:summary.trim(),label:'Codex 返回的推理摘要'}:undefined;
          if(p.turn?.status!=='completed'){reject(new ModelResponseError('订阅模型未完成本次判断，请查看官方订阅额度、模型权限或稍后继续。','incomplete',usage,returnedReasoning));return;}
          try{const value=JSON.parse(finalText);if(!tools.some(t=>t.name===value.name)||typeof value.arguments!=='string'||value.arguments.length>64000)throw new Error();JSON.parse(value.arguments);
            if(!usage){reject(new ModelResponseError('订阅模型未返回可确认的 Token 用量，已停止该成员以免预算失真。','incomplete',undefined,returnedReasoning));return;}
            completed=true;resolve({blocks:[{type:'tool-call',id:ToolCallId(randomUUID()),name:value.name,arguments:value.arguments}],...usage,...(returnedReasoning?{returnedReasoning}:{})});
          }catch{reject(new ModelResponseError('订阅模型没有返回有效的群聊决定，本次未发布消息。','incomplete',usage,returnedReasoning));}
        }
      });
      const timer=setTimeout(()=>{abort();},180000);timer.unref();options.signal?.addEventListener('abort',abort,{once:true});cleanup=()=>{off();clearTimeout(timer);options.signal?.removeEventListener('abort',abort);};
    });
    // Attach a handler before turn/start, so cancellation during startup is never unhandled.
    void completion.catch(()=>{});
    try{const started=await rpc.request('turn/start',{threadId,environments:[],input:[{type:'text',text:JSON.stringify({history,availableDecisions:tools.map(t=>({name:t.name,description:t.description,parameters:t.parameters})),outputTokenTarget:options.maxTokens}),text_elements:[]}],outputSchema:schema,summary:'auto'});turnId=started?.turn?.id;options.signal?.throwIfAborted();return await completion;}
    finally{cleanup();if((cancelled||options.signal?.aborted||!completed)&&turnId)await rpc.request('turn/interrupt',{threadId,turnId}).catch(()=>{});await rpc.request('thread/unsubscribe',{threadId}).catch(()=>{});void this.status(id,true).then(()=>this.notify()).catch(()=>{});}
  }
  async close(){await Promise.allSettled([...this.clients.values()].map(c=>c.close()));this.clients.clear();}
}
