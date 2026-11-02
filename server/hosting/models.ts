import { connectionKey, type CompletionRequest, type ProviderConfig } from '../../shared/types.js';
import { buildDiscussionPrompt, complete } from '../providers.js';
import { generateNative, nativeRequest, type NativeGenerate } from '../runtime-adapters/native-model.js';
import { ModelCallError } from '../model-errors.js';
import { HostingBudget } from './budget.js';
import {projectHostedProvider,sharedModelIds,modelPrice} from '../../shared/hosted-models.js';

export interface HostedModelSource { providers:()=>ProviderConfig[]; getKey:(id:string)=>string|undefined; }
export function hostedProviders(source:HostedModelSource):ProviderConfig[] {
  return source.providers().filter(p=>p.enabled&&p.billingMode!=='subscription'&&['openai','claude','deepseek','qwen','doubao'].includes(p.id)).flatMap(p=>{
    const shared=projectHostedProvider({...p,hasKey:!!source.getKey(connectionKey(p))});
    return shared?[shared]:[];
  });
}
export function hostedGenerators(userId:string,source:HostedModelSource,budget:HostingBudget,active:()=>boolean,adapters={complete,native:generateNative}) {
  function permitted(candidate:ProviderConfig):ProviderConfig {
    if(!active())throw new ModelCallError('此网站邀请已撤销，无法继续调用模型。');
    const p=hostedProviders(source).find(p=>connectionKey(p)===connectionKey(candidate)&&p.id===candidate.id&&sharedModelIds(p).includes(candidate.model));
    if(!p)throw new ModelCallError('此模型未由站长开放，或连接已停用。');
    return {...p,model:candidate.model,...modelPrice(p,candidate.model)!};
  }
  return {
    generate:async(request:CompletionRequest)=>{
      const provider=permitted(request.provider);
      if(request.participant.channel==='browser'||request.participant.model!==provider.model)throw new ModelCallError('网站只提供站长开放的 API 模型。');
      const value={...request,provider,apiKey:source.getKey(connectionKey(provider))};
      if(provider.id==='demo')return adapters.complete(value);
      const prompt=buildDiscussionPrompt(value),input=Buffer.byteLength(prompt.system+prompt.input)+4096;
      return budget.run(userId,input,value.maxOutputTokens,provider,()=>adapters.complete(value));
    },
    nativeGenerate:(async(options,candidate)=>{
      const provider=permitted(candidate);
      if(options.model!==provider.model)throw new ModelCallError('请求模型与站长开放的模型不一致。');
      const key=source.getKey(connectionKey(provider));
      if(provider.id==='demo')throw new ModelCallError('演示模型不应发送网络请求。');
      // Count the serialized upstream body, including replay and tools, without logging credentials.
      const input=Buffer.byteLength(JSON.stringify(nativeRequest(options,provider,key).body))+4096;
      return budget.run(userId,input,options.maxTokens??1200,provider,()=>adapters.native(options,provider,key));
    }) as NativeGenerate,
  };
}
