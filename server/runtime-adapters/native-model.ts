import { randomUUID } from 'node:crypto';
import { ToolCallId, type ContentBlock, type GenerateOptions, type ReplayEnvelope } from '@deepseek-ai/dsh-llm';
import type { ProviderConfig } from '../../shared/types.js';
import { ModelCallError, ModelResponseError, readProviderFailure, type ResponseFailureKind, type ReturnedReasoning } from '../model-errors.js';
import { estimateTokens } from '../token-estimate.js';
export { ModelCallError, ProviderRequestError } from '../model-errors.js';

export interface NativeReply { blocks: ContentBlock[]; inputTokens: number; outputTokens: number; replayState?: ReplayEnvelope; returnedReasoning?:ReturnedReasoning; }
export type NativeGenerate = (options: GenerateOptions, provider: ProviderConfig, apiKey: string | undefined) => Promise<NativeReply>;
const textOf = (content: readonly ContentBlock[]) => content.filter(b=>b.type==='text').map(b=>b.text).join('\n');
const object = (v: unknown): Record<string,any> => {
  if(!v||typeof v!=='object'||Array.isArray(v))throw new ModelCallError('模型返回的数据结构不正确。');return v as Record<string,any>;
};
const tokens = (v: unknown, fallback: number) => typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=1e9?v:fallback;
function incomplete(reason: unknown, input: unknown, output: unknown, limit: number,reasoning?:ReturnedReasoning): ModelResponseError {
  const inputTokens=tokens(input,NaN),outputTokens=tokens(output,NaN);
  const usage=Number.isFinite(inputTokens)&&Number.isFinite(outputTokens)?{inputTokens,outputTokens}:undefined;
  let kind:ResponseFailureKind='incomplete',detail='供应商未返回可识别的完成状态。请检查模型服务状态和工具调用支持。';
  if(['length','max_tokens','max_output_tokens'].includes(String(reason))) {
    kind='output_limit';detail=`达到输出或上下文长度限制（本次输出上限 ${limit} Token）。推理模型的思考也占用输出额度；请在讨论设置中提高单次输出上限后再继续。若仍达到上下文限制，可新开一场讨论。`;
  } else if(reason==='content_filter'||reason==='refusal') {
    kind='content_filter';detail='供应商的内容过滤中止了生成，请调整讨论内容。提高输出上限不能解决此问题。';
  } else if(reason==='insufficient_system_resource') {
    kind='unavailable';detail='供应商计算资源暂时不足，请稍后再继续。此错误不是本地 Token 余额不足。';
  } else if(reason==='aborted') {
    kind='aborted';detail='供应商中止了生成，请检查服务状态后再继续。';
  }
  return new ModelResponseError(`模型未完整完成本次请求：${detail}本次未发布群消息，也未自动重试。`,kind,usage,reasoning);
}
/** Only explicitly returned text; opaque replay state is never a human-readable thought log. */
function returnedReasoning(data:Record<string,any>,provider:ProviderConfig):ReturnedReasoning|undefined {
  let parts:unknown[]=[];
  if(provider.id==='openai')parts=(Array.isArray(data.output)?data.output:[]).filter((item:any)=>item?.type==='reasoning').flatMap((item:any)=>Array.isArray(item.summary)?item.summary.filter((s:any)=>s?.type==='summary_text').map((s:any)=>s.text):[]);
  else if(provider.id==='claude')parts=(Array.isArray(data.content)?data.content:[]).filter((item:any)=>item?.type==='thinking').map((item:any)=>item.thinking);
  else parts=[data.choices?.[0]?.message?.reasoning_content];
  const text=parts.filter((s):s is string=>typeof s==='string').join('\n').trim();
  if(text)return {text:text.length>16000?text.slice(0,16000)+'\n[日志内容已截短]':text,label:provider.id==='openai'?'供应商返回的推理摘要':'供应商返回的推理内容'};
}
function call(id: unknown, name: unknown, args: unknown): ContentBlock {
  if(typeof id!=='string'||!id||id.length>256||typeof name!=='string'||!name||name.length>100||typeof args!=='string'||args.length>64000)throw new ModelCallError('模型返回了无效工具调用。');
  return {type:'tool-call',id:ToolCallId(id),name,arguments:args};
}
function replay(message: GenerateOptions['messages'][number], kind: string): any[] | undefined {
  if(message.role!=='assistant')return;
  const envelope=message.source.replayState as ReplayEnvelope|undefined;
  const value=envelope?.response as {kind?:string;items?:any[]}|undefined;
  return value?.kind===kind&&Array.isArray(value.items)?value.items:undefined;
}

/** Fixed first-party endpoints. No ambient credential discovery, redirects, or model-selected URLs. */
export function nativeRequest(options: GenerateOptions, provider: ProviderConfig, apiKey?: string) {
  if(provider.id!=='ollama'&&(!apiKey||/[\r\n]/.test(apiKey)))throw new ModelCallError('请在模型连接中配置有效 API Key。');
  const tools=options.tools??[];
  const system=[options.system,...options.messages.filter(m=>m.role==='system').map(m=>textOf(m.content))].filter(Boolean).join('\n\n');
  const headers:Record<string,string>={'Content-Type':'application/json'};
  const maxTokens=options.maxTokens??1200;
  if(provider.id==='openai') {
    headers.Authorization=`Bearer ${apiKey}`;
    const input:any[]=[];
    for(const m of options.messages) {
      if(m.role==='system')continue;
      if(m.role==='tool'){input.push({type:'function_call_output',call_id:m.toolCallId,output:textOf(m.content)});continue;}
      const saved=replay(m,'teahouse-openai-v1');
      if(saved){input.push(...saved);continue;}
      const content=textOf(m.content);
      if(content)input.push({role:m.role==='assistant'?'assistant':'user',content});
      for(const b of m.content)if(b.type==='tool-call')input.push({type:'function_call',call_id:b.id,name:b.name,arguments:b.arguments});
    }
    const summarySupported=/^(?:gpt-5(?:[.-]|$)|o[34](?:-|$))/.test(options.model)&&!options.model.includes('chat');
    return {url:'https://api.openai.com/v1/responses',headers,body:{model:options.model,instructions:system,input,store:false,include:['reasoning.encrypted_content'],...(summarySupported?{reasoning:{summary:'auto'}}:{}),max_output_tokens:maxTokens,tools:tools.map(t=>({type:'function',name:t.name,description:t.description,parameters:t.parameters,strict:false})),parallel_tool_calls:false}};
  }
  if(provider.id==='claude') {
    headers['x-api-key']=apiKey!;headers['anthropic-version']='2023-06-01';
    const messages:{role:string;content:any[]}[]=[];
    for(const m of options.messages) {
      if(m.role==='system')continue;
      const role=m.role==='assistant'?'assistant':'user';
      const content=m.role==='tool'?[{type:'tool_result',tool_use_id:m.toolCallId,content:textOf(m.content),is_error:!!m.isError}]:replay(m,'teahouse-claude-v1')??m.content.flatMap<any>(b=>b.type==='text'?[{type:'text',text:b.text}]:b.type==='tool-call'?[{type:'tool_use',id:b.id,name:b.name,input:JSON.parse(b.arguments)}]:[]);
      if(!content.length)continue;
      if(messages.at(-1)?.role===role)messages.at(-1)!.content.push(...content);else messages.push({role,content});
    }
    return {url:'https://api.anthropic.com/v1/messages',headers,body:{model:options.model,system,messages,max_tokens:maxTokens,tools:tools.map(t=>({name:t.name,description:t.description,input_schema:t.parameters}))}};
  }
  const messages:any[]=[];
  if(system)messages.push({role:'system',content:system});
  for(const m of options.messages) {
    if(m.role==='system')continue;
    if(m.role==='tool'){messages.push({role:'tool',tool_call_id:m.toolCallId,content:textOf(m.content)});continue;}
    // Ark signs encrypted_content. Replay the original assistant message, including tool IDs,
    // without projecting opaque provider state into public content or reconstructing it.
    const saved=provider.id==='doubao'?replay(m,'teahouse-doubao-v1'):undefined;
    if(saved){messages.push(...saved);continue;}
    const calls=m.content.filter(b=>b.type==='tool-call').map(b=>({id:b.id,type:'function',function:{name:b.name,arguments:b.arguments}}));
    const thinking=m.content.filter(b=>b.type==='reasoning').map(b=>b.text).join('');
    messages.push({role:m.role==='assistant'?'assistant':'user',content:textOf(m.content),...(calls.length?{tool_calls:calls}:{}),...(provider.id==='deepseek'&&m.role==='assistant'?{reasoning_content:thinking}:{})});
  }
  const url=provider.id==='deepseek'?'https://api.deepseek.com/chat/completions':provider.id==='doubao'?'https://ark.cn-beijing.volces.com/api/v3/chat/completions':provider.id==='qwen'?(provider.region==='cn'?'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions':'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions'):provider.id==='ollama'?'http://127.0.0.1:11434/v1/chat/completions':'';
  if(!url)throw new ModelCallError('自由群聊不支持这个供应商。');
  if(provider.id!=='ollama')headers.Authorization=`Bearer ${apiKey}`;
  return {url,headers,body:{model:options.model,messages,max_tokens:maxTokens,stream:false,tools:tools.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.parameters}}))}};
}

export function parseNativeReply(value: unknown, provider: ProviderConfig, inputEstimate: number, outputReserve: number): NativeReply {
  const data=object(value),blocks:ContentBlock[]=[];
  const reasoning=returnedReasoning(data,provider);
  let input:unknown,output:unknown,replayState:ReplayEnvelope|undefined;
  if(provider.id==='openai') {
    input=data.usage?.input_tokens;output=data.usage?.output_tokens;
    if(data.status!=='completed'||!Array.isArray(data.output))throw incomplete(data.incomplete_details?.reason,input,output,outputReserve,reasoning);
    for(const item of data.output) {
      if(item.type==='function_call')blocks.push(call(item.call_id,item.name,item.arguments));
      else if(item.type==='message')for(const c of item.content??[]) {
        if(c.type==='output_text'&&typeof c.text==='string')blocks.push({type:'text',text:c.text});
        else if(c.type==='refusal')throw new ModelCallError('模型拒绝了本次请求，未发布群消息。');
      }
    }
    replayState={response:{kind:'teahouse-openai-v1',items:data.output.filter((x:any)=>['reasoning','message','function_call'].includes(x.type))}};
  } else if(provider.id==='claude') {
    const usage=data.usage;
    if(typeof usage?.input_tokens==='number')input=tokens(usage.input_tokens,NaN)+tokens(usage.cache_creation_input_tokens??0,NaN)+tokens(usage.cache_read_input_tokens??0,NaN);
    output=usage?.output_tokens;
    if(!['end_turn','tool_use','stop_sequence'].includes(data.stop_reason)||!Array.isArray(data.content))throw incomplete(data.stop_reason,input,output,outputReserve,reasoning);
    for(const b of data.content) {
      if(b.type==='text'&&typeof b.text==='string')blocks.push({type:'text',text:b.text});
      if(b.type==='tool_use')blocks.push(call(b.id,b.name,JSON.stringify(b.input)));
    }
    replayState={response:{kind:'teahouse-claude-v1',items:data.content}};
  } else {
    const choice=data.choices?.[0];
    input=data.usage?.prompt_tokens;output=data.usage?.completion_tokens;
    if(!choice||!['stop','tool_calls'].includes(choice.finish_reason))throw incomplete(choice?.finish_reason,input,output,outputReserve,reasoning);
    const m=object(choice.message);
    if(typeof m.reasoning_content==='string')blocks.push({type:'reasoning',text:m.reasoning_content});
    if(typeof m.content==='string'&&m.content)blocks.push({type:'text',text:m.content});
    if(m.tool_calls!==undefined&&!Array.isArray(m.tool_calls))throw new ModelCallError('模型返回了无效工具列表。');
    for(const t of m.tool_calls??[])blocks.push(call(t.id,t.function?.name,t.function?.arguments));
    if(provider.id==='doubao')replayState={response:{kind:'teahouse-doubao-v1',items:[{...m,role:'assistant'}]}};
  }
  if(blocks.length>32)throw new ModelCallError('模型单次返回的工具调用或内容块过多。');
  return {blocks,inputTokens:tokens(input,inputEstimate),outputTokens:tokens(output,outputReserve),...(replayState?{replayState}:{}),...(reasoning?{returnedReasoning:reasoning}:{})};
}

export const generateNative: NativeGenerate = async(options,provider,apiKey) => {
  const request=nativeRequest(options,provider,apiKey);
  const signal=AbortSignal.any([...(options.signal?[options.signal]:[]),AbortSignal.timeout(120000)]);
  try {
    const response=await fetch(request.url,{method:'POST',headers:request.headers,body:JSON.stringify(request.body),signal,redirect:'error'});
    if(!response.ok)throw await readProviderFailure(response,provider.id);
    if(!response.body)throw new ModelCallError('供应商返回空响应。');
    const reader=response.body.getReader();const chunks:Uint8Array[]=[];let length=0;
    try { while(true){const item=await reader.read();if(item.done)break;length+=item.value.byteLength;if(length>4*1024*1024)throw new ModelCallError('供应商响应超过大小限制。');chunks.push(item.value);} }
    finally { await reader.cancel().catch(()=>{});reader.releaseLock(); }
    signal.throwIfAborted();
    const inputEstimate=estimateTokens(JSON.stringify(options.messages)+JSON.stringify(options.tools)+(options.system??''));
    return parseNativeReply(JSON.parse(Buffer.concat(chunks).toString('utf8')),provider,inputEstimate,options.maxTokens??1200);
  } catch(error) {
    if(options.signal?.aborted)throw new ModelCallError('本次生成已停止。');
    if(signal.aborted)throw new ModelCallError('供应商响应超过 120 秒，已暂停该成员。');
    if(error instanceof ModelCallError)throw error;
    throw new ModelCallError('无法完成模型请求。请检查网络和模型配置；原始响应未写入群聊。');
  }
};

/** Deterministic local fixture, explicitly labelled; still exercises the actual Harness tool loop. */
export function demoReply(options: GenerateOptions): NativeReply {
  const last=[...options.messages].reverse().find(m=>m.role==='user');
  let wake:any={};try{wake=JSON.parse(last?textOf(last.content):'{}');}catch{}
  const messages=Array.isArray(wake.messages)?wake.messages:[];
  const human=messages.some((m:any)=>m.kind==='user'||m.kind==='import');
  const shouldPost=human||wake.firstWake===true;
  const name=shouldPost?'post_message':'wait_for_messages';
  const args=shouldPost?{content:`【本地演示 · 非真实模型】已收到 ${messages.length} 条新消息。这条回复通过 DeepSeek Harness 的群聊工具发布；没有调用真实 AI。${human?'我会把你的补充作为待讨论观点。':'你可以继续发言测试唤醒。'}`,replyTo:messages.at(-1)?.id??null}:{seconds:0};
  return {blocks:[call(`demo-${randomUUID()}`,name,JSON.stringify(args))],inputTokens:0,outputTokens:0};
}
