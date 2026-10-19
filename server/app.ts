import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { ZodError } from 'zod';
import { Store } from './store.js';
import {groupTemplateSchema} from './validation.js';
import { SecretVault } from './vault.js';
import { complete, PROVIDER_DEFAULTS, testProvider } from './providers.js';
import { DiscussionError, isActive, Scheduler } from './scheduler.js';
import { installSecurity } from './security.js';
import { createGroupSchema, patchGroupSchema, messageSchema, runSchema, providerUpdateSchema, browserRequestSchema, webProviderSchema, browserSelectorsSchema, emptyBodySchema, freeStartSchema, skillImportSchema } from './validation.js';
import { BrowserConnector, BrowserConnectorError, type BrowserDriver } from './browser-connector.js';
import { profileParticipant, profileFields, connectionKey, memberConnection, type CompletionRequest, type CompletionResult, type Message, type ProviderConfig } from '../shared/types.js';
import { RoomEngine } from './room-engine/engine.js';
import { HarnessRuntime } from './runtime-adapters/harness.js';
import type { NativeGenerate } from './runtime-adapters/native-model.js';
import type { ParticipantRuntime } from './runtime-adapters/types.js';
import { ModelCatalogService, fetchModelCatalog } from './model-catalog.js';
import { modelListSchema } from './validation.js';
import { createProfileSchema, updateProfileSchema, inviteProfileSchema, idSchema, avatarAssetIdSchema, avatarUploadSchema, profileRevisionSchema, connectionCreateSchema } from './validation.js';
import { MemberLibrary } from './member-library.js';
import { AvatarUploads } from './avatars.js';
import { migrateChatFeatures } from './migrations.js';
import { StickerLibrary, stickerUploadSchema, stickerMetadataSchema } from './stickers.js';
import { z } from 'zod';
import {containsMention,inferredMentions} from '../shared/mentions.js';
import {CodexSubscription,type SubscriptionService} from './subscription/codex.js';
import {generateNative} from './runtime-adapters/native-model.js';
import {ModelCallError} from './model-errors.js';
import {BillingService,billingCredentialsSchema,billingRefreshSchema} from './billing.js';
import { seedSkills, skillSummaries, importInstructionSkill } from './skills.js';
import {installNotebook} from './notebook.js';

export interface AppOptions { dataDir:string; port:number; production:boolean; serveUI?:boolean; generate?:(r:CompletionRequest)=>Promise<CompletionResult>; browserDriver?:BrowserDriver; nativeGenerate?:NativeGenerate; participantRuntime?:ParticipantRuntime; modelCatalogFetcher?:typeof fetchModelCatalog; subscription?:SubscriptionService; billingFetcher?:typeof fetch; }
export async function buildApp(options:AppOptions) {
  const app=Fastify({logger:false,bodyLimit:131072,requestTimeout:30000,connectionTimeout:10000,trustProxy:false});
  const store=new Store(options.dataDir);
  const vault=new SecretVault(options.dataDir);
  const billing=new BillingService(vault,options.billingFetcher);
  const catalogs=new ModelCatalogService(options.modelCatalogFetcher);
  store.seed(PROVIDER_DEFAULTS);store.adoptMemberProfiles();store.interruptOutstanding();store.recoverFreeSessions();seedSkills(store);
  migrateChatFeatures(store);
  const members=new MemberLibrary(store);
  const avatars=new AvatarUploads(store);
  const stickerLibrary=new StickerLibrary(store);
  const {csrfToken}=installSecurity(app,{port:options.port,production:options.production});
  installNotebook(app,store);
  const clients=new Set<ServerResponse>();
  const notify=(groupId?:string)=>{const data=`event: change\ndata: ${JSON.stringify({groupId})}\n\n`;for(const client of clients){if(client.destroyed||client.writableEnded){clients.delete(client);continue;}if(client.writableLength>262144){client.destroy();clients.delete(client);continue;}client.write(data);}};
  const providers=()=>store.providers().map(p=>({...p,hasKey:vault.has(connectionKey(p))}));
  const browser=new BrowserConnector({dataDir:options.dataDir,load:id=>store.browserConfig(id),save:(id,value)=>store.saveBrowserConfig(id,value),notify});
  const scheduler=new Scheduler(store,{providers,getKey:id=>vault.get(id),generate:options.generate??complete,notify,browser:options.browserDriver??browser});
  const subscription=options.subscription??new CodexSubscription(options.dataDir,()=>notify());
  const roomEngine=new RoomEngine(store,{providers,getKey:id=>vault.get(id),notify,runtime:options.participantRuntime??new HarnessRuntime(options.dataDir,(opts,p,key)=>p.billingMode==='subscription'?subscription.generate(opts,p):(options.nativeGenerate??generateNative)(opts,p,key))});
  const getGroup=(id:string)=>{const group=store.group(id);if(!group)throw new DiscussionError('茶桌不存在。',404);return group;};
  const getProvider=(id:string)=>{const provider=providers().find(p=>connectionKey(p)===id);if(!provider)throw new DiscussionError('不支持的模型服务。',404);return provider;};
  app.setErrorHandler((error,request,reply)=>{
    if(error instanceof ZodError){const detail=error.issues.slice(0,3).map(i=>`${i.path.join('.')||'设置'}：${i.message}`).join('；');return reply.code(400).send({error:detail});}
    const code=typeof error==='object'&&error!==null&&'statusCode'in error?Number(error.statusCode):500;
    const message=error instanceof DiscussionError||error instanceof BrowserConnectorError?error.message:code===413?'消息过长，请缩短后重试。':code===429?'操作过于频繁，请稍后再试。':code>=400&&code<500?'请求格式不正确。':'操作未完成，请检查本地服务。';
    return reply.code(Number.isFinite(code)&&code>=400&&code<600?code:500).send({error:message});
  });
  app.get('/api/bootstrap',async()=>({csrfToken,groups:store.groups(),profiles:store.profiles(),deletedProfiles:store.profiles(true).filter(p=>p.deletedAt),stickers:store.stickers(true),providers:providers(),skills:skillSummaries(store),security:{localOnly:true,vault:vault.description,version:'0.2.0'}}));
  app.post('/api/stickers',{bodyLimit:5600000},async(request,reply)=>{const s=await stickerLibrary.upload(stickerUploadSchema.parse(request.body));notify();return reply.code(201).send(s);});
  app.put<{Params:{id:string}}>('/api/stickers/:id',async request=>{const s=store.sticker(idSchema.parse(request.params.id));if(!s||s.deletedAt)throw new DiscussionError('表情包不存在。',404);const updated={...s,...stickerMetadataSchema.parse(request.body)};store.saveSticker(updated);notify();return updated;});
  app.delete<{Params:{id:string}}>('/api/stickers/:id',async request=>{emptyBodySchema.parse(request.body??{});const s=store.sticker(idSchema.parse(request.params.id));if(!s)throw new DiscussionError('表情包不存在。',404);store.saveSticker({...s,deletedAt:new Date().toISOString()});notify();return {ok:true};});
  app.post<{Params:{id:string}}>('/api/stickers/:id/restore',async request=>{emptyBodySchema.parse(request.body??{});const s=store.sticker(idSchema.parse(request.params.id));if(!s)throw new DiscussionError('表情包不存在。',404);delete s.deletedAt;store.saveSticker(s);notify();return s;});
  app.get<{Params:{id:string}}>('/api/sticker-assets/:id',async(request,reply)=>{const bytes=store.stickerAsset(avatarAssetIdSchema.parse(request.params.id));if(!bytes)throw new DiscussionError('表情图片不存在。',404);return reply.type('image/webp').send(bytes);});
  app.post<{Params:{id:string}}>('/api/groups/:id/typing',async request=>{emptyBodySchema.parse(request.body??{});getGroup(request.params.id);roomEngine.typing(request.params.id);return {ok:true};});
  app.post<{Params:{id:string}}>('/api/groups/:id/draft-presence',async request=>{
    const data=z.object({clientId:z.string().uuid(),sequence:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),hasDraft:z.boolean(),reason:z.enum(['edit','sent','leave'])}).strict().parse(request.body);
    getGroup(request.params.id);roomEngine.draftPresence(request.params.id,data);return {ok:true};
  });
  app.post<{Params:{id:string}}>('/api/groups/:id/stickers',async(request,reply)=>{
    const g=getGroup(request.params.id);if(g.archived)throw new DiscussionError('请先恢复群聊。');
    const data=z.object({stickerId:idSchema,caption:z.string().trim().max(1000).optional()}).strict().parse(request.body);
    const s=store.sticker(data.stickerId);if(!s||s.deletedAt)throw new DiscussionError('表情包不存在。',404);
    if(store.messages(g.id).length>=5000)throw new DiscussionError('群聊记录已达上限。');
    const message:Message={id:randomUUID(),groupId:g.id,author:'我',avatar:'我',color:'#526559',kind:'user',content:data.caption??'',sticker:{id:s.id,name:s.name,tags:s.tags,assetId:s.assetId},reasoning:'',reasoningLabel:'',round:0,status:'complete',createdAt:new Date().toISOString(),inputMessageIds:[],inputTokens:0,outputTokens:0};
    store.saveMessage(message);g.updatedAt=message.createdAt;store.saveGroup(g);roomEngine.typing(g.id);roomEngine.messageArrived(g.id);notify(g.id);return reply.code(201).send(message);
  });
  app.post('/api/avatars',{bodyLimit:2800000},async(request,reply)=>reply.code(201).send(await avatars.upload(avatarUploadSchema.parse(request.body).data)));
  app.get<{Params:{id:string}}>('/api/avatars/:id',async(request,reply)=>{
    const bytes=store.avatarAsset(avatarAssetIdSchema.parse(request.params.id));
    if(!bytes)throw new DiscussionError('头像图片不存在。',404);
    return reply.type('image/png').send(bytes);
  });
  app.get('/api/members',async()=>store.profiles());
  app.post('/api/members',async(request,reply)=>{
    const data=createProfileSchema.parse(request.body);
    const profile=store.atomic(()=>{const p=members.create(data.profile);if(data.groupId)members.invite(getGroup(data.groupId),p.id);return p;});
    notify();return reply.code(201).send(profile);
  });
  app.put<{Params:{id:string}}>('/api/members/:id',async request=>{
    const data=updateProfileSchema.parse(request.body);const profile=members.update(idSchema.parse(request.params.id),data.profile,data.expectedRevision);notify();return profile;
  });
  app.delete<{Params:{id:string}}>('/api/members/:id',async request=>{
    const {expectedRevision}=profileRevisionSchema.parse(request.body);const profile=members.delete(idSchema.parse(request.params.id),expectedRevision);notify();return profile;
  });
  app.post<{Params:{id:string}}>('/api/members/:id/restore',async request=>{
    const {expectedRevision}=profileRevisionSchema.parse(request.body);const profile=members.restore(idSchema.parse(request.params.id),expectedRevision);notify();return profile;
  });
  app.post<{Params:{id:string}}>('/api/groups/:id/members',async request=>{
    const data=inviteProfileSchema.parse(request.body);const group=members.invite(getGroup(request.params.id),data.profileId);notify(group.id);return group;
  });
  app.delete<{Params:{id:string;memberId:string}}>('/api/groups/:id/members/:memberId',async request=>{
    const group=getGroup(request.params.id);members.requireEditable(group);const memberId=idSchema.parse(request.params.memberId);
    group.participants=group.participants.filter(p=>p.id!==memberId);if(group.settings.summaryParticipantId===memberId)group.settings.summaryParticipantId='';
    group.updatedAt=new Date().toISOString();store.saveGroup(group);notify(group.id);return group;
  });
  app.get('/api/providers',async()=>providers());
  app.get<{Params:{id:string}}>('/api/providers/:id/billing',async request=>billing.status(getProvider(request.params.id)));
  app.put<{Params:{id:string}}>('/api/providers/:id/billing/credentials',async request=>billing.save(getProvider(request.params.id),billingCredentialsSchema.parse(request.body)));
  app.delete<{Params:{id:string}}>('/api/providers/:id/billing/credentials',async request=>{emptyBodySchema.parse(request.body??{});return billing.remove(getProvider(request.params.id));});
  app.post<{Params:{id:string}}>('/api/providers/:id/billing/refresh',async request=>{request.raw.socket.setTimeout?.(35000);const data=billingRefreshSchema.parse(request.body??{});return billing.refresh(getProvider(request.params.id),data.month);});
  app.get<{Params:{id:string}}>('/api/groups/:id',async request=>{const detail=store.detail(request.params.id);if(!detail)throw new DiscussionError('茶桌不存在。',404);return detail;});
  app.get('/api/group-defaults',async()=>store.groupDefaults());
  app.post<{Params:{id:string}}>('/api/groups/:id/default-template',async request=>{
    const group=getGroup(request.params.id),template=groupTemplateSchema.parse(request.body);
    if(roomEngine.active(group.id)||store.runs(group.id).some(isActive))throw new DiscussionError('请暂停或停止讨论后保存默认模板。',409);
    const saved=store.atomic(()=>{store.saveGroup({...group,...template,updatedAt:new Date().toISOString()});return store.saveGroupDefaults(template);});
    notify(group.id);return saved;
  });
  app.post('/api/groups',async(request,reply)=>{
    const data=createGroupSchema.parse(request.body);if(store.groups().length>=200)throw new DiscussionError('最多保留 200 张茶桌。');
    const group=store.atomic(()=>{
      const g=store.createGroup(data.name,data.goal??'');
      g.participants=data.profileIds?data.profileIds.map(id=>profileParticipant(members.requireProfile(id),randomUUID())):members.prepare(data.participants??g.participants);
      if(data.settings)g.settings=data.settings;if(data.conversationMode)g.conversationMode=data.conversationMode;if(data.freeSettings)g.freeSettings=data.freeSettings;
      store.saveGroup(g);return g;
    });notify();return reply.code(201).send(group);
  });
  app.patch<{Params:{id:string}}>('/api/groups/:id',async request=>{
    const group=getGroup(request.params.id);const patch=patchGroupSchema.parse(request.body);
    if(roomEngine.active(group.id))throw new DiscussionError('请暂停自由讨论后修改群聊、成员或权限。',409);
    if(patch.participants)members.requireEditable(group);
    if(patch.archived&&store.runs(group.id).some(isActive))throw new DiscussionError('请先停止讨论再归档。',409);
    const updated=store.atomic(()=>{const g={...group,...patch,updatedAt:new Date().toISOString()};if(patch.participants)g.participants=members.prepare(patch.participants);store.saveGroup(g);return g;});notify(group.id);return updated;
  });
  app.post<{Params:{id:string}}>('/api/groups/:id/messages',async(request,reply)=>{
    const group=getGroup(request.params.id);if(group.archived)throw new DiscussionError('请先恢复茶桌。');const data=messageSchema.parse(request.body);
    const mentions=[...new Set(data.mentions??inferredMentions(data.content,group.participants))];
    if(mentions.some(id=>!group.participants.some(p=>p.id===id&&p.enabled&&containsMention(data.content,p.name))))throw new DiscussionError('@成员已离群、停用，或消息中缺少对应昵称。请重新选择。');
    if(store.messages(group.id).length>=5000)throw new DiscussionError('本茶桌记录已较长，请导出后新建茶桌继续。');
    const message:Message={id:randomUUID(),groupId:group.id,author:'我',avatar:'我',color:'#526559',kind:'user',content:data.content,reasoning:'',reasoningLabel:'',round:0,status:'complete',createdAt:new Date().toISOString(),inputMessageIds:[],inputTokens:0,outputTokens:0};
    message.mentions=mentions;store.saveMessage(message);group.updatedAt=new Date().toISOString();store.saveGroup(group);roomEngine.typing(group.id);roomEngine.messageArrived(group.id);notify(group.id);return reply.code(201).send(message);
  });
  app.get<{Params:{id:string}}>('/api/groups/:id/logs',async request=>{getGroup(request.params.id);return {entries:store.logs(request.params.id),retention:500};});
  app.get<{Params:{id:string}}>('/api/groups/:id/usage',async request=>{getGroup(request.params.id);return store.memberUsage(request.params.id);});
  app.post<{Params:{id:string}}>('/api/groups/:id/runs',async(request,reply)=>{const settings=runSchema.parse(request.body??{});if(roomEngine.active(request.params.id))throw new DiscussionError('请先暂停自由讨论。',409);const run=scheduler.start(request.params.id,settings);return reply.code(201).send(run);});
  app.post<{Params:{id:string}}>('/api/groups/:id/free/start',async(request,reply)=>{const data=freeStartSchema.parse(request.body??{});return reply.code(201).send(roomEngine.start(request.params.id,data.reset));});
  app.post<{Params:{id:string}}>('/api/groups/:id/free/pause',async request=>{emptyBodySchema.parse(request.body??{});return roomEngine.pause(request.params.id);});
  app.get('/api/skills',async()=>skillSummaries(store));
  app.post('/api/skills',async(request,reply)=>{
    if(store.freeSessions().some(s=>s.status==='active'))throw new DiscussionError('请暂停自由讨论后安装技能。',409);
    const skill=importInstructionSkill(store,skillImportSchema.parse(request.body).markdown);notify();const {instructions,...summary}=skill;return reply.code(201).send(summary);
  });
  app.delete<{Params:{id:string}}>('/api/skills/:id',async request=>{
    if(store.freeSessions().some(s=>s.status==='active'))throw new DiscussionError('请暂停自由讨论后移除技能。',409);
    const skill=store.skill(request.params.id);if(!skill)throw new DiscussionError('技能不存在。',404);if(skill.builtin)throw new DiscussionError('内置技能可以停用，无需删除。');
    store.atomic(()=>{
      for(const profile of store.profiles())if(profile.skills?.includes(skill.id))members.update(profile.id,{...profileFields(profile),skills:profile.skills.filter(id=>id!==skill.id)},profile.revision);
      for(const group of store.groups()){group.participants=group.participants.map(p=>({...p,skills:p.skills?.filter(id=>id!==skill.id)}));store.saveGroup(group);}store.deleteSkill(skill.id);
    });notify();return {ok:true};
  });
  app.post<{Params:{id:string}}>('/api/runs/:id/cancel',async request=>scheduler.cancel(request.params.id));
  app.post<{Params:{id:string}}>('/api/runs/:id/retry',async request=>{const run=store.run(request.params.id);if(run&&roomEngine.active(run.groupId))throw new DiscussionError('请先暂停自由讨论。',409);return scheduler.retry(request.params.id);});
  app.post<{Params:{id:string}}>('/api/runs/:id/browser-start',async request=>scheduler.startBrowser(request.params.id,browserRequestSchema.parse(request.body).requestId));
  app.post<{Params:{id:string}}>('/api/runs/:id/browser-pause',async request=>scheduler.pauseBrowser(request.params.id,browserRequestSchema.parse(request.body).requestId));
  app.get('/api/browser',async()=>browser.profiles());
  app.post<{Params:{id:string}}>('/api/browser/:id/open',async request=>{emptyBodySchema.parse(request.body??{});return browser.open(webProviderSchema.parse(request.params.id));});
  app.post<{Params:{id:string}}>('/api/browser/:id/check',async request=>{emptyBodySchema.parse(request.body??{});return browser.probe(webProviderSchema.parse(request.params.id));});
  app.post<{Params:{id:string}}>('/api/browser/:id/close',async request=>{emptyBodySchema.parse(request.body??{});await browser.close(webProviderSchema.parse(request.params.id));return {ok:true};});
  app.put<{Params:{id:string}}>('/api/browser/:id/selectors',async request=>{browser.configure(webProviderSchema.parse(request.params.id),browserSelectorsSchema.parse(request.body));return {ok:true};});
  app.post('/api/providers',async(request,reply)=>{
    const data=connectionCreateSchema.parse(request.body);
    if(store.providers().length>=24)throw new DiscussionError('最多保存 24 个模型连接。');
    const base=getProvider(data.providerId),p={...base,connectionId:'conn-'+randomUUID(),label:data.label,hasKey:false,enabled:false,billingMode:'api' as const,modelPrices:{[base.model]:{inputPrice:base.inputPrice,outputPrice:base.outputPrice}}};
    store.saveProvider(p);notify();return reply.code(201).send(p);
  });
  app.delete<{Params:{id:string}}>('/api/providers/:id',async request=>{
    emptyBodySchema.parse(request.body??{});const p=getProvider(request.params.id),id=connectionKey(p);
    if(!p.connectionId)throw new DiscussionError('默认连接请停用或移除密钥。');
    if(store.profiles(true).some(m=>memberConnection(m as any)===id)||store.groups().some(g=>g.participants.some(m=>memberConnection(m)===id))||store.allRuns().some(r=>isActive(r)&&r.participants.some(m=>memberConnection(m)===id)))throw new DiscussionError('仍有成员使用此连接（含回收站），请先更换成员连接。',409);
    billing.remove(p);if(p.billingMode==='subscription')await subscription.logout(id);vault.set(id,null);store.deleteProvider(id);catalogs.invalidate(id);notify();return {ok:true};
  });
  app.put<{Params:{id:string}}>('/api/providers/:id',async request=>{
    const current=getProvider(request.params.id);const data=providerUpdateSchema.parse(request.body);
    if(store.allRuns().some(isActive)||store.freeSessions().some(s=>s.status==='active'))throw new DiscussionError('请停止正在运行的讨论后再修改服务凭据与单价。',409);
    billing.assertIdle(connectionKey(current));
    const {apiKey,...patch}=data;
    if(current.id==='demo'&&apiKey)throw new DiscussionError('演示模式不需要密钥。');
    if(current.id==='ollama'&&apiKey)throw new DiscussionError('本地 Ollama 不需要云端密钥。');
    if(patch.billingMode==='subscription'&&current.id!=='openai')throw new DiscussionError('订阅授权仅支持 OpenAI。');
    const modelPrices={...(current.modelPrices??{[current.model]:{inputPrice:current.inputPrice,outputPrice:current.outputPrice}}),...patch.modelPrices};
    const selected=patch.model??current.model,price=modelPrices[selected]??{inputPrice:0,outputPrice:0};
    if(patch.inputPrice!==undefined||patch.outputPrice!==undefined)modelPrices[selected]={inputPrice:patch.inputPrice??price.inputPrice,outputPrice:patch.outputPrice??price.outputPrice};
    if(Object.keys(modelPrices).length>100)throw new DiscussionError('每个连接最多配置 100 个模型价格。');
    if(apiKey!==undefined){vault.set(connectionKey(current),apiKey);catalogs.invalidate(connectionKey(current));}
    if(apiKey!==undefined||patch.billingMode!==undefined)billing.invalidate(connectionKey(current));
    const updated:ProviderConfig={...current,...patch,...(modelPrices[selected]??{inputPrice:0,outputPrice:0}),modelPrices,hasKey:vault.has(connectionKey(current))};store.saveProvider(updated);notify();return updated;
  });
  const lastTests=new Map<string,number>();
  const subscriptionProvider=(id:string)=>{const p=getProvider(id);if(p.id!=='openai'||p.billingMode!=='subscription')throw new DiscussionError('请先将此 OpenAI 连接保存为 ChatGPT 订阅方式。');return p;};
  const subscriptionAction=async<T,>(action:()=>Promise<T>)=>{try{return await action();}catch(e){throw new DiscussionError(e instanceof ModelCallError?e.message:'订阅连接操作未完成，请检查官方 Codex 登录。');}};
  const idleForAuth=()=>{if(store.allRuns().some(isActive)||store.freeSessions().some(s=>s.status==='active'))throw new DiscussionError('请先暂停讨论，再变更订阅授权。',409);};
  app.get<{Params:{id:string}}>('/api/providers/:id/subscription',async request=>{request.raw.socket.setTimeout?.(50000);subscriptionProvider(request.params.id);return subscription.status(request.params.id);});
  app.post<{Params:{id:string;action:string}}>('/api/providers/:id/subscription/:action',async request=>{request.raw.socket.setTimeout?.(50000);emptyBodySchema.parse(request.body??{});subscriptionProvider(request.params.id);const id=request.params.id;
    if(request.params.action==='refresh')return subscription.status(id,true);
    idleForAuth();
    if(request.params.action==='login')return subscriptionAction(()=>subscription.login(id));
    if(request.params.action==='cancel'){await subscriptionAction(()=>subscription.cancel(id));return {ok:true};}
    if(request.params.action==='logout'){await subscriptionAction(()=>subscription.logout(id));notify();return {ok:true};}
    throw new DiscussionError('订阅操作不存在。',404);
  });
  app.post<{Params:{id:string}}>('/api/providers/:id/models',async request=>{
    request.raw.socket.setTimeout?.(20_000);
    const input=modelListSchema.parse(request.body??{}),provider=getProvider(request.params.id);
    if(provider.billingMode==='subscription'){request.raw.socket.setTimeout?.(150000);return subscriptionAction(()=>subscription.models(provider));}
    return catalogs.load({...provider,region:input.region??provider.region},vault.get(connectionKey(provider)),input.refresh);
  });
  app.post<{Params:{id:string}}>('/api/providers/:id/test',async request=>{
    // The upstream probe has a 12 s deadline; the normal 10 s idle socket
    // timeout must not close the browser response before diagnostics arrive.
    request.raw.socket.setTimeout(20_000);
    const provider=getProvider(request.params.id);const last=lastTests.get(connectionKey(provider))??0;
    if(Date.now()-last<5000)throw new DiscussionError('连接测试间隔至少 5 秒。',429);lastTests.set(connectionKey(provider),Date.now());
    if(provider.billingMode==='subscription'){request.raw.socket.setTimeout?.(50000);const status=await subscription.status(connectionKey(provider),true);if(!status.connected)throw new DiscussionError(status.error??'请先使用 Continue with ChatGPT 登录。');return {ok:true,message:'官方订阅登录有效；未进行模型推理。实际权限以首次完成请求为准。'};}
    return testProvider(provider,vault.get(connectionKey(provider)));
  });
  app.get('/api/events',(request,reply)=>{
    if(clients.size>=12)return reply.code(429).send({error:'打开的茶馆页面过多，请关闭部分页面。'});
    // A quiet event stream stays alive between heartbeats; normal HTTP sockets keep their timeout.
    request.raw.socket.setTimeout(0);
    reply.hijack();const response=reply.raw;
    response.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'});
    response.write('retry: 2000\n\nevent: change\ndata: {}\n\n');clients.add(response);
    const heartbeat=setInterval(()=>{if(!response.destroyed)response.write(': heartbeat\n\n');},15000);heartbeat.unref();
    const cleanup=()=>{clients.delete(response);clearInterval(heartbeat);};response.on('close',cleanup);response.on('error',cleanup);
  });
  app.get('/api/health',async()=>({ok:true,application:'chat-teahouse',version:'0.2.0',runtime:'deepseek-harness',harnessVersion:'0.2.1-rc.2'}));
  app.post('/api/service/stop',async(request,reply)=>{
    emptyBodySchema.parse(request.body??{});
    reply.raw.once('finish',()=>{void app.close().catch(()=>app.log.error('Local service shutdown failed.'));});
    return {ok:true};
  });
  let closeVite:(()=>Promise<void>)|undefined;
  if(options.serveUI!==false){
    if(options.production){
      const root=resolve('dist');if(!existsSync(resolve(root,'index.html')))throw new Error('请先运行 npm run build。');
      await app.register(fastifyStatic,{root,wildcard:true,dotfiles:'deny'});
      app.setNotFoundHandler((req,reply)=>req.url.startsWith('/api/')?reply.code(404).send({error:'接口不存在。'}):reply.sendFile('index.html'));
    }else{
      const {createServer}=await import('vite');
      const vite=await createServer({server:{middlewareMode:true,hmr:{server:app.server,host:'127.0.0.1',port:options.port}},appType:'spa'});
      closeVite=()=>vite.close();
      app.setNotFoundHandler((req,reply)=>{
        if(req.url.startsWith('/api/'))return reply.code(404).send({error:'接口不存在。'});
        reply.hijack();vite.middlewares(req.raw,reply.raw,()=>{reply.raw.statusCode=404;reply.raw.end('Not found');});
      });
    }
  }
  app.addHook('preClose',async()=>{for(const client of clients)client.end();clients.clear();await roomEngine.shutdown();await subscription.close();await scheduler.shutdown();await browser.shutdown();if(closeVite)await closeVite();});
  app.addHook('onClose',async()=>{store.close();});
  return {app,store,vault,scheduler,browser,roomEngine,csrfToken};
}
