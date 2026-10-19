import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { generateNative, nativeRequest, parseNativeReply } from '../server/runtime-adapters/native-model.js';
import type { ProviderConfig, ProviderId } from '../shared/types.js';
import { ModelResponseError, ProviderRequestError } from '../server/model-errors.js';

const provider=(id:ProviderId):ProviderConfig=>({id,name:id,enabled:true,hasKey:true,model:'tool-model',region:'cn',inputPrice:1,outputPrice:1});
const options=():GenerateOptions=>({provider:'openai',model:'tool-model',system:'讨论协议',maxTokens:800,messages:[createUserMessage({content:[{type:'text',text:'一条公开群消息'}],source:{kind:'user'}})],tools:[{name:'post_message',description:'发布观点',parameters:{type:'object',properties:{content:{type:'string'}},required:['content']}}]});

test('truncated reasoning responses retain validated usage and safe diagnostics without exposing partial output',()=>{
  for(const id of ['deepseek','doubao','qwen'] as const) {
    const data={choices:[{finish_reason:'length',message:{reasoning_content:'PRIVATE_THOUGHT',content:'PRIVATE_TEXT',tool_calls:[{id:'partial',function:{name:'post_message',arguments:'{"content":"PARTIAL_TOOL'}}]}}],usage:{prompt_tokens:201,completion_tokens:1200}};
    assert.throws(()=>parseNativeReply(data,provider(id),12000,1200),e=>{
      assert.ok(e instanceof ModelResponseError);assert.equal(e.kind,'output_limit');assert.deepEqual(e.usage,{inputTokens:201,outputTokens:1200});
      assert.match(e.message,/1200 Token/);assert.match(e.message,/思考也占用/);assert.doesNotMatch(e.message+JSON.stringify(e),/PRIVATE|PARTIAL_TOOL/);return true;
    });
  }
  assert.throws(()=>parseNativeReply({status:'incomplete',incomplete_details:{reason:'max_output_tokens'},usage:{input_tokens:40,output_tokens:800}},provider('openai'),900,800),e=>e instanceof ModelResponseError&&e.kind==='output_limit'&&e.usage?.inputTokens===40);
  assert.throws(()=>parseNativeReply({stop_reason:'max_tokens',usage:{input_tokens:10,cache_creation_input_tokens:20,cache_read_input_tokens:30,output_tokens:800}},provider('claude'),900,800),e=>e instanceof ModelResponseError&&e.kind==='output_limit'&&e.usage?.inputTokens===60);
});

test('journal only extracts explicitly returned text and requests summaries only on supported reasoning families',()=>{
  const reasoning={type:'reasoning',encrypted_content:'OPAQUE_SECRET',content:[{text:'NOT_A_PUBLIC_SUMMARY'}],summary:[{type:'summary_text',text:'可展示的摘要'},{type:'other',text:'IGNORE'}]};
  const out=parseNativeReply({status:'completed',output:[reasoning],usage:{input_tokens:1,output_tokens:2}},provider('openai'),10,20);
  assert.deepEqual(out.returnedReasoning,{text:'可展示的摘要',label:'供应商返回的推理摘要'});assert.doesNotMatch(JSON.stringify(out.returnedReasoning),/SECRET|NOT_A|IGNORE/);
  assert.equal(parseNativeReply({status:'completed',output:[{...reasoning,summary:[]}]},provider('openai'),10,20).returnedReasoning,undefined);
  assert.throws(()=>parseNativeReply({choices:[{finish_reason:'length',message:{reasoning_content:'已返回的推理片段'}}],usage:{prompt_tokens:10,completion_tokens:20}},provider('deepseek'),10,20),e=>e instanceof ModelResponseError&&e.returnedReasoning?.text==='已返回的推理片段'&&!JSON.stringify(e).includes('推理片段'));
  for(const model of ['gpt-5','gpt-5.2','o3','o4-mini'])assert.deepEqual((nativeRequest({...options(),model},provider('openai'),'fixture').body as any).reasoning,{summary:'auto'});
  for(const model of ['gpt-4.1','gpt-5-chat-latest','unknown-model'])assert.equal((nativeRequest({...options(),model},provider('openai'),'fixture').body as any).reasoning,undefined);
});

test('incomplete response reasons are distinct and incomplete or invalid usage remains uncertain',()=>{
  for(const [reason,kind] of [['content_filter','content_filter'],['insufficient_system_resource','unavailable'],['aborted','aborted'],['raw-secret-upstream-error','incomplete']]) {
    assert.throws(()=>parseNativeReply({choices:[{finish_reason:reason}],usage:{prompt_tokens:10,completion_tokens:20}},provider('deepseek'),100,1200),e=>{
      assert.ok(e instanceof ModelResponseError);assert.equal(e.kind,kind);assert.deepEqual(e.usage,{inputTokens:10,outputTokens:20});assert.doesNotMatch(e.message,/raw-secret/);return true;
    });
  }
  for(const usage of [undefined,{prompt_tokens:10},{prompt_tokens:-1,completion_tokens:20},{prompt_tokens:10,completion_tokens:NaN},{prompt_tokens:'10',completion_tokens:20},{prompt_tokens:10,completion_tokens:1e12}]) {
    assert.throws(()=>parseNativeReply({choices:[{finish_reason:'length'}],usage},provider('deepseek'),100,1200),e=>e instanceof ModelResponseError&&e.usage===undefined);
  }
});

test('native HTTP quota and rate responses retain safe classification for the engine without transport retry',async()=>{
  const original=globalThis.fetch;let calls=0;
  try {
    for(const code of ['credit_balance_exhausted','rate_limit_exceeded']) {
      globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({error:{code,message:'secret-key-account'}}),{status:429,headers:{'retry-after':'12'}});};
      await assert.rejects(generateNative(options(),provider('openai'),'fixture'),e=>e instanceof ProviderRequestError&&e.kind===(code==='credit_balance_exhausted'?'quota':'rate_limit')&&!e.message.includes('secret-key-account'));
    }
    assert.equal(calls,2);
  }finally{globalThis.fetch=original;}
});

test('Doubao keeps signed encrypted assistant state for tool continuations without exposing it in content', () => {
  const message = { role: 'assistant', content: null, reasoning_content: '可见摘要', encrypted_content: 'opaque-ark-state', tool_calls: [{ id: 'ark-tool-1', type: 'function', function: { name: 'load_skill', arguments: '{"id":"argument-check"}' } }] };
  const p = provider('doubao');
  const reply = parseNativeReply({ choices: [{ finish_reason: 'tool_calls', message }], usage: { prompt_tokens: 21, completion_tokens: 34 } }, p, 100, 800);
  const input = options(); input.messages.push(createAssistantMessage({ content: reply.blocks, source: { provider: p.id, model: p.model, replayState: reply.replayState } }), createToolResultMessage({ callId: ToolCallId('ark-tool-1'), content: [{ type: 'text', text: '技能正文' }], isError: false }));
  const request = nativeRequest(input, p, 'fixture-ark-key'), body = request.body as any;
  assert.equal(request.url, 'https://ark.cn-beijing.volces.com/api/v3/chat/completions');
  assert.equal(request.headers.Authorization, 'Bearer fixture-ark-key'); assert.equal(body.max_tokens, 800);
  assert.deepEqual(body.messages[2], message); assert.equal(body.messages[3].tool_call_id, 'ark-tool-1');
  assert.equal(body.messages.filter((m: any) => m.tool_calls).length, 1);
  assert.doesNotMatch(JSON.stringify(reply.blocks), /opaque-ark-state/);
  assert.equal(reply.inputTokens, 21); assert.equal(reply.outputTokens, 34);
  assert.throws(() => parseNativeReply({ choices: [{ finish_reason: 'length', message }] }, p, 100, 800), /未完整/);
});

test('Responses preserves encrypted reasoning and tool identities across tool continuations',()=>{
  const items=[{id:'rs_1',type:'reasoning',encrypted_content:'opaque-private-state',summary:[]},{id:'fc_1',type:'function_call',call_id:'call_1',name:'post_message',arguments:'{"content":"公开观点"}'}];
  const p=provider('openai'),reply=parseNativeReply({status:'completed',output:items,usage:{input_tokens:41,output_tokens:22}},p,100,800);
  assert.equal(reply.inputTokens,41);assert.equal(reply.blocks.length,1);
  const input=options();input.messages.push(createAssistantMessage({content:reply.blocks,source:{provider:p.id,model:p.model,replayState:reply.replayState}}),createToolResultMessage({callId:ToolCallId('call_1'),content:[{type:'text',text:'{"messageId":"m1"}'}],isError:false}));
  const request=nativeRequest(input,p,'fixture-secret');const body=request.body as any;
  assert.equal(request.url,'https://api.openai.com/v1/responses');assert.equal(body.store,false);assert.equal(body.parallel_tool_calls,false);
  assert.deepEqual(body.include,['reasoning.encrypted_content']);assert.deepEqual(body.input.slice(1,3),items);
  assert.equal(body.input.at(-1).call_id,'call_1');assert.equal(body.input.filter((i:any)=>i.type==='function_call').length,1);
  assert.equal(body.tools[0].strict,false);assert.doesNotMatch(JSON.stringify(reply.blocks),/opaque-private-state/);
});

test('Claude preserves signed thinking with tool results and counts cached input',()=>{
  const content=[{type:'thinking',thinking:'private',signature:'provider-signature'},{type:'tool_use',id:'tool_1',name:'read_messages',input:{}}];
  const p=provider('claude'),reply=parseNativeReply({stop_reason:'tool_use',content,usage:{input_tokens:10,cache_creation_input_tokens:20,cache_read_input_tokens:30,output_tokens:40}},p,100,800);
  const input=options();input.messages.push(createAssistantMessage({content:reply.blocks,source:{provider:p.id,model:p.model,replayState:reply.replayState}}),createToolResultMessage({callId:ToolCallId('tool_1'),content:[{type:'text',text:'{"messages":[]}'}],isError:false}));
  const request=nativeRequest(input,p,'fixture-secret'),body=request.body as any;
  assert.equal(reply.inputTokens,60);assert.equal(request.headers['x-api-key'],'fixture-secret');assert.equal(request.headers.Authorization,undefined);
  assert.deepEqual(body.messages[1].content,content);assert.equal(body.messages[2].content[0].tool_use_id,'tool_1');
  assert.doesNotMatch(JSON.stringify(reply.blocks),/provider-signature/);
});

test('DeepSeek replays reasoning_content required by thinking tool calls; Qwen and Ollama use fixed endpoints',()=>{
  const p=provider('deepseek'),reply=parseNativeReply({choices:[{finish_reason:'tool_calls',message:{content:null,reasoning_content:'private-provider-reasoning',tool_calls:[{id:'call_d',type:'function',function:{name:'read_messages',arguments:'{}'}}]}}],usage:{prompt_tokens:32,completion_tokens:14}},p,100,800);
  const input=options();input.messages.push(createAssistantMessage({content:reply.blocks,source:{provider:p.id,model:p.model}}),createToolResultMessage({callId:ToolCallId('call_d'),content:[{type:'text',text:'{}'}],isError:false}));
  const body=nativeRequest(input,p,'fixture').body as any;
  assert.equal(body.messages[2].reasoning_content,'private-provider-reasoning');assert.equal(body.messages[3].tool_call_id,'call_d');
  assert.equal(nativeRequest(input,{...provider('qwen'),region:'intl'},'fixture').url,'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions');
  const local=nativeRequest(input,provider('ollama'));assert.equal(local.url,'http://127.0.0.1:11434/v1/chat/completions');assert.equal(local.headers.Authorization,undefined);
});

test('incomplete, malformed, excessive and refused native responses never execute tools',()=>{
  assert.throws(()=>parseNativeReply({status:'incomplete',output:[]},provider('openai'),10,800),/未完整/);
  assert.throws(()=>parseNativeReply({status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'no'}]}]},provider('openai'),10,800),/拒绝/);
  assert.throws(()=>parseNativeReply({stop_reason:'max_tokens',content:[]},provider('claude'),10,800),/未完整/);
  assert.throws(()=>parseNativeReply({choices:[{finish_reason:'length',message:{}}]},provider('qwen'),10,800),/未完整/);
  assert.throws(()=>parseNativeReply({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:1,function:{name:'x',arguments:'{}'}}]}}]},provider('deepseek'),10,800),/无效/);
  assert.throws(()=>parseNativeReply({status:'completed',output:Array.from({length:33},(_,i)=>({type:'function_call',call_id:String(i),name:'x',arguments:'{}'}))},provider('openai'),10,800),/过多/);
  const missing=parseNativeReply({status:'completed',output:[]},provider('openai'),300,800);assert.equal(missing.inputTokens,300);assert.equal(missing.outputTokens,800);
});

test('native transport rejects redirects, redacts upstream error text, and honors aborts',async()=>{
  const original=globalThis.fetch;
  try {
    globalThis.fetch=async(_url,init)=>{assert.equal(init?.redirect,'error');return new Response('secret-account-information',{status:401});};
    await assert.rejects(generateNative(options(),provider('openai'),'fixture'),e=>e instanceof Error&&/401/.test(e.message)&&!/secret-account/.test(e.message));
    const c=new AbortController();c.abort();globalThis.fetch=async()=>{throw new Error('fixture-key');};
    await assert.rejects(generateNative({...options(),signal:c.signal},provider('openai'),'fixture'),/停止/);
    globalThis.fetch=async()=>new Response('raw-secret-not-json');
    await assert.rejects(generateNative(options(),provider('openai'),'fixture'),e=>e instanceof Error&&!/raw-secret/.test(e.message));
  } finally {globalThis.fetch=original;}
});
