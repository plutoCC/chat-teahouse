import type {FastifyInstance} from 'fastify';
import {connectionKey,type ProfileFields,type ProviderConfig} from '../../shared/types.js';
import {projectHostedProvider,sharedModelIds,hasHostedPrice} from '../../shared/hosted-models.js';
import {DiscussionError} from '../scheduler.js';

export interface HostedTenantOptions {
  providers:()=>ProviderConfig[];
  getKey:(id:string)=>string|undefined;
  userName:string;
}

/** A tenant receives only explicitly shared cloud models. No owner credentials, local
 * services, subscriptions or unused model-price metadata cross this boundary. */
export function hostedProviders(configured:ProviderConfig[]):ProviderConfig[]{
  return configured.flatMap(p=>{const shared=projectHostedProvider(p);return shared?[shared]:[];});
}

export function assertHostedParticipant(member:ProfileFields,providers:ProviderConfig[]){
  const provider=providers.find(p=>connectionKey(p)===(member.connectionId??member.providerId)&&p.id===member.providerId);
  if(member.channel==='browser'||!provider||!projectHostedProvider(provider)||!sharedModelIds(provider).includes(member.model)||!hasHostedPrice(provider,member.model)){
    throw new DiscussionError('此网站仅可使用站主开放的 API 连接和模型，请重新选择成员模型。',403);
  }
}

// Deliberately enumerate method + canonical Fastify route. New administrative
// endpoints remain denied until explicitly reviewed for tenant use.
const routes=new Map<string,readonly string[]>([
  ['/api/bootstrap',['GET','HEAD']],['/api/health',['GET','HEAD']],['/api/events',['GET','HEAD']],
  ['/api/providers',['GET','HEAD']],['/api/providers/:id/models',['POST']],['/api/skills',['GET','HEAD']],
  ['/api/members',['GET','HEAD','POST']],['/api/members/:id',['PUT','DELETE']],['/api/members/:id/restore',['POST']],
  ['/api/avatars',['POST']],['/api/avatars/:id',['GET','HEAD']],
  ['/api/stickers',['POST']],['/api/stickers/:id',['PUT','DELETE']],['/api/stickers/:id/restore',['POST']],['/api/sticker-assets/:id',['GET','HEAD']],
  ['/api/group-defaults',['GET','HEAD']],['/api/groups',['POST']],['/api/groups/:id',['GET','HEAD','PATCH']],
  ['/api/groups/:id/default-template',['POST']],['/api/groups/:id/members',['POST']],['/api/groups/:id/members/:memberId',['DELETE']],
  ['/api/groups/:id/typing',['POST']],['/api/groups/:id/draft-presence',['POST']],['/api/groups/:id/playback-presence',['POST']],['/api/groups/:id/stickers',['POST']],['/api/groups/:id/messages',['POST']],
  ['/api/groups/:id/logs',['GET','HEAD']],['/api/groups/:id/usage',['GET','HEAD']],['/api/groups/:id/runs',['POST']],
  ['/api/groups/:id/free/start',['POST']],['/api/groups/:id/free/pause',['POST']],
  ['/api/runs/:id/cancel',['POST']],['/api/runs/:id/retry',['POST']],
  ['/api/notebook',['GET','HEAD','POST']],['/api/notebook/:id',['PUT','DELETE']],
]);
export function installTenantPolicy(app:FastifyInstance){
  app.addHook('onRequest',async(request,reply)=>{
    const route=request.routeOptions.url??'';
    let rawPath='';try{rawPath=decodeURIComponent((request.raw.url??'').split('?')[0]);}catch{return reply.code(400).send({error:'无效的访问路径。'});}
    const api=route==='/api'||route.startsWith('/api/')||rawPath==='/api'||rawPath.startsWith('/api/');
    if(api&&!routes.get(route)?.includes(request.method)||!api&&!['GET','HEAD'].includes(request.method))return reply.code(403).send({error:'访客账号不能使用此管理功能。'});
  });
}
