import { createHash, randomUUID } from 'node:crypto';
import { defaultFreeSettings, isLegacyTimeLimit, type FreeSession, type FreeMemberState } from '../../shared/free-chat.js';
import { identityModeOf, connectionKey, memberConnection, resolveConnection, type Group, type Message, type Participant, type ProviderConfig, type WorkspaceLimits } from '../../shared/types.js';
import { Store } from '../store.js';
import { DiscussionError, isActive, activeDiscussionGroups } from '../scheduler.js';
import { ModelCallError, ProviderRequestError } from '../runtime-adapters/native-model.js';
import type { Delivery, ParticipantRuntime, RuntimeWake } from '../runtime-adapters/types.js';
import { PublicationGate, readingSeconds, segmentDelayMs } from './pacing.js';
import { splitChatMessage } from './segments.js';
import { setTimeout as sleep } from 'node:timers/promises';
import {inferredMentions} from '../../shared/mentions.js';
import type {LogInput} from '../../shared/room-journal.js';
import {DraftPresence} from './draft-presence.js';
import type {DraftPresenceUpdate} from '../../shared/typing.js';
class BudgetWaitError extends ModelCallError {}

interface EngineDeps {
  runtime: ParticipantRuntime;
  providers(): ProviderConfig[];
  getKey(id: string): string | undefined;
  notify(groupId: string): void;
  now?: () => number;
  random?: () => number;
  resourceLimits?:()=>Partial<WorkspaceLimits>;
}
const fingerprint=(p:Participant)=>createHash('sha256').update(JSON.stringify({provider:p.providerId,...(p.connectionId&&p.connectionId!==p.providerId?{connection:p.connectionId}:{}),model:p.model,mode:identityModeOf(p),role:identityModeOf(p)==='role'?p.role:'',skills:p.skills??[],name:p.name,channel:p.channel??'api',profile:p.profileId,revision:p.profileRevision})).digest('hex');
export class RoomEngine {
  private timers=new Map<string,ReturnType<typeof setTimeout>>();
  private jobs=new Map<string,{controller:AbortController;promise:Promise<void>;groupId:string}>();
  private providerRetryAt=new Map<string,number>();
  private closed=false;
  private publicationGate:PublicationGate;
  private typingUntil=new Map<string,number>();
  private drafts:DraftPresence;
  private playback:DraftPresence;
  private mentions=new Map<string,Set<string>>();
  private speeches=new Map<string,{memberId:string;speechId:string;beforeSeq:number}>();
  private now:()=>number;
  private random:()=>number;
  constructor(private store:Store,private deps:EngineDeps) {this.now=deps.now??Date.now;this.random=deps.random??Math.random;this.publicationGate=new PublicationGate(this.now);this.drafts=new DraftPresence(this.now);this.playback=new DraftPresence(this.now);}
  playbackPresence(groupId:string,update:{clientId:string;sequence:number;active:boolean}){
    this.requireGroup(groupId);
    this.playback.update(groupId,{clientId:update.clientId,sequence:update.sequence,hasDraft:update.active,reason:update.active?'edit':'sent'});
    if(this.active(groupId))this.schedule(groupId,0);
  }
  draftPresence(groupId:string,update:DraftPresenceUpdate){this.requireGroup(groupId);this.drafts.update(groupId,update);if(this.active(groupId))this.schedule(groupId,0);}
  private inputHold(groupId:string){const settings=this.requireGroup(groupId).freeSettings;return settings?.waitForUserDraft?this.drafts.status(groupId):{until:this.typingUntil.get(groupId)??0,hasDraft:false};}
  typing(groupId:string){
    if(!this.active(groupId))return;
    const g=this.requireGroup(groupId),seconds=g.freeSettings?.typingGraceSeconds??defaultFreeSettings.typingGraceSeconds!;
    this.typingUntil.set(groupId,this.now()+seconds*1000);
  }
  private requireGroup(id:string) {const group=this.store.group(id);if(!group)throw new DiscussionError('茶桌不存在。',404);return group;}
  active(groupId:string) {return this.store.freeSession(groupId)?.status==='active';}
  busy(groupId:string) {return this.active(groupId)||!!this.mentions.get(groupId)?.size||[...this.jobs.values()].some(j=>j.groupId===groupId);}
  private memberState(p:Participant):FreeMemberState{return {id:p.id,sessionId:`tea-${randomUUID()}`,fingerprint:fingerprint(p),acknowledgedSeq:0,deliveredSeq:0,consideredSeq:0,status:'waiting',attention:'all',cooldownUntil:0,lastStartedAt:0};}
  private requestMentions(groupId:string,message:Message){
    const group=this.requireGroup(groupId);
    if(group.conversationMode!=='free'||group.archived||message.groupId!==groupId||message.kind!=='user'||message.participantId||this.store.runs(groupId).some(isActive))return;
    const targets=group.participants.filter(p=>(message.mentions??[]).includes(p.id)&&(!p.enabled||!this.active(groupId)));
    if(!targets.length)return;
    let session=this.store.freeSession(groupId);
    if(!session){session={id:randomUUID(),groupId,status:'paused',epoch:0,createdAt:new Date(this.now()).toISOString(),updatedAt:new Date(this.now()).toISOString(),callCount:0,publishedCount:0,inputTokens:0,outputTokens:0,reservedTokens:0,estimatedUSD:0,reservedUSD:0,uncertainCalls:0,members:[]};this.store.saveFreeSession(session);}
    const pending=this.mentions.get(groupId)??new Set<string>();
    for(const p of targets){
      if(this.jobs.has(`${groupId}:${p.id}`)||pending.has(p.id))continue;
      this.store.mutateFree(groupId,s=>{let m=s.members.find(m=>m.id===p.id);if(!m||m.fingerprint!==fingerprint(p)){s.members=s.members.filter(m=>m.id!==p.id);m=this.memberState(p);s.members.push(m);}m.manualWake=true;m.status='queued';m.activity='收到人类 @，等待单次回应';delete m.error;delete m.wakeAt;});
      pending.add(p.id);
    }
    this.mentions.set(groupId,pending);this.deps.notify(groupId);
  }
  private visibleEvents(groupId:string,after=0){
    const speech=this.speeches.get(groupId);
    return this.store.events(groupId,after).filter(e=>!speech||e.seq<=speech.beforeSeq);
  }
  start(groupId:string,reset=false,renew=false):FreeSession {
    if(this.closed)throw new DiscussionError('后台正在关闭。',409);
    if(reset&&renew)throw new DiscussionError('重置上下文与保留上下文续开不能同时选择。');
    const group=this.requireGroup(groupId),now=this.now(),previous=this.store.freeSession(groupId);
    if(group.archived)throw new DiscussionError('请先恢复群聊。');
    if(this.active(groupId)||this.store.runs(groupId).some(isActive))throw new DiscussionError('该群已有讨论正在运行。',409);
    if(this.mentions.get(groupId)?.size||[...this.jobs.values()].some(j=>j.groupId===groupId))throw new DiscussionError('上次推理仍在停止，请稍后继续。',409);
    const maxActiveGroups=this.deps.resourceLimits?.().maxActiveGroupsPerUser??3;
    if(activeDiscussionGroups(this.store)>=maxActiveGroups)throw new DiscussionError(`最多同时运行 ${maxActiveGroups} 场讨论，请暂停其他群聊后再开始。`,429);
    if(!group.goal.trim()&&!this.store.messages(groupId).length)throw new DiscussionError('请先填写讨论目标或发送消息。');
    const participants=group.participants.filter(p=>p.enabled);
    if(!participants.length)throw new DiscussionError('请至少启用一位成员。');
    for(const p of participants) {
      if(p.channel&&p.channel!=='api')throw new DiscussionError(`${p.name} 使用网页渠道，暂不能参与自由工具群聊。请改为 API，或使用圆桌模式。`);
      const provider=resolveConnection(this.deps.providers(),p);
      if(!provider?.enabled)throw new DiscussionError(`${p.name} 的模型连接未启用。`);
      if(provider.billingMode!=='subscription'&&!['demo','ollama'].includes(p.providerId)&&!this.deps.getKey(memberConnection(p)))throw new DiscussionError(`请先在模型连接中配置 ${provider.name} 的密钥。`);
      if(provider.billingMode!=='subscription'&&group.settings.budgetUSD>0&&!['demo','ollama'].includes(p.providerId)&&(!provider.inputPrice||!provider.outputPrice))throw new DiscussionError(`${p.name} 使用的 ${p.model} 未填写单独费率。请在此连接中选择该模型并保存输入、输出单价后再启用金额保护。`);
      for(const skill of p.skills??[])if(!this.store.skill(skill))throw new DiscussionError(`${p.name} 启用的技能 ${skill} 不存在。`);
    }
    if(previous&&!reset&&!renew&&(previous.status==='limit'&&!isLegacyTimeLimit(previous)))throw new DiscussionError('本场讨论已达到边界。可「续开讨论（保留上下文）」开启新的本场预算，或重新开始并重置上下文。',409);
    const session:FreeSession=previous&&!reset&&!renew?previous:{id:randomUUID(),groupId,status:'active',epoch:0,createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),callCount:0,publishedCount:0,inputTokens:0,outputTokens:0,reservedTokens:0,estimatedUSD:0,reservedUSD:0,uncertainCalls:0,members:renew&&previous?structuredClone(previous.members):[]};
    if(session.admissionClosed&&!reset)throw new DiscussionError('本场计算预算已用完，可续开讨论并保留上下文。',409);
    session.epoch++;session.status='active';delete session.error;delete session.sending;delete session.deadline;delete session.pauseRequested;
    session.members=group.participants.map(p=>{
      const old=session.members.find(m=>m.id===p.id&&m.fingerprint===fingerprint(p));
      const m:FreeMemberState=old??this.memberState(p);
      delete m.manualWake;m.status=p.enabled?'listening':'waiting';delete m.error;delete m.rateLimitRetries;delete m.queuedUntil;
      if(p.enabled)m.wakeAt=Math.max(now,m.retryAt??0);else delete m.wakeAt;m.activity=p.enabled?'等待新消息':'待命，仅回应人类 @';return m;
    });
    this.store.saveFreeSession(session);this.deps.notify(groupId);this.schedule(groupId,0);return session;
  }
  pause(groupId:string,reason?:string,immediate=false):FreeSession {
    const current=this.store.freeSession(groupId);if(!current)throw new DiscussionError('自由讨论尚未开始。',404);
    this.clearTimer(groupId);
    this.mentions.delete(groupId);
    if(current.pauseRequested&&!immediate&&!reason)return current;
    const speech=this.speeches.get(groupId);
    if(!immediate&&!reason&&speech){
      // Finish only the already-started speech. Cancel peers and block all further
      // admission; keep its epoch/signal valid until its terminal tool is persisted.
      const session=this.store.mutateFree(groupId,s=>{
        s.pauseRequested={memberId:speech.memberId};
        for(const member of s.members)if(member.id!==speech.memberId){member.status='paused';member.activity='已暂停';delete member.queuedUntil;delete member.manualWake;}
        return s;
      });
      for(const [key,job] of this.jobs)if(job.groupId===groupId&&key!==`${groupId}:${speech.memberId}`)job.controller.abort();
      this.deps.notify(groupId);return session;
    }
    const session=this.store.mutateFree(groupId,s=>{
      s.status='paused';s.epoch++;s.error=reason;delete s.pauseRequested;
      for(const member of s.members){member.status='paused';member.activity='已暂停';delete member.queuedUntil;delete member.manualWake;}
      return s;
    });
    for(const job of this.jobs.values())if(job.groupId===groupId)job.controller.abort();
    this.deps.notify(groupId);return session;
  }
  private limit(groupId:string,reason:string) {
    if(!this.active(groupId))return;
    this.pause(groupId,reason);
    this.store.mutateFree(groupId,s=>{s.status='limit';});this.deps.notify(groupId);
  }
  messageArrived(groupId:string,message?:Message) {if(message)this.requestMentions(groupId,message);if(this.active(groupId)||this.mentions.get(groupId)?.size)this.schedule(groupId,0);}
  private clearTimer(groupId:string) {clearTimeout(this.timers.get(groupId));this.timers.delete(groupId);}
  private schedule(groupId:string,delay:number) {
    if(this.closed)return;this.clearTimer(groupId);
    const timer=setTimeout(()=>{
      this.timers.delete(groupId);
      try{this.pump(groupId);}catch{if(this.active(groupId))this.pause(groupId,'调度遇到问题，已安全暂停。');}
    },Math.max(0,Math.min(delay,2147483647)));timer.unref();this.timers.set(groupId,timer);
  }
  /** Event-driven admission; no fixed speaker order and no LLM polling while idle. */
  pump(groupId:string) {
    const session=this.store.freeSession(groupId);if(!session||this.closed||session.status!=='active'&&!this.mentions.get(groupId)?.size)return;
    const group=this.requireGroup(groupId),settings={...defaultFreeSettings,...group.freeSettings},now=this.now();
    if(session.pauseRequested)return;
    const playback=this.playback.status(groupId);
    if(playback.until>now){
      if(session.members.some(m=>!this.jobs.has(`${groupId}:${m.id}`)&&m.status!=='error'&&m.activity!=='等待浏览器朗读完成')){
        this.store.mutateFree(groupId,s=>{for(const m of s.members)if(!this.jobs.has(`${groupId}:${m.id}`)&&m.status!=='error')m.activity='等待浏览器朗读完成';});this.deps.notify(groupId);
      }
      this.schedule(groupId,Math.min(1000,playback.until-now));return;
    }
    const input=settings.waitForUserDraft?this.drafts.status(groupId):{until:0,hasDraft:false};
    if(input.until>now){
      const activity=input.hasDraft?'等待用户完成输入':'输入框已清空，等待 3 秒';
      if(session.members.some(m=>!this.jobs.has(`${groupId}:${m.id}`)&&m.status!=='error'&&m.activity!==activity)){
        this.store.mutateFree(groupId,s=>{for(const m of s.members)if(!this.jobs.has(`${groupId}:${m.id}`)&&m.status!=='error'){m.activity=activity;}});this.deps.notify(groupId);
      }
      this.schedule(groupId,Math.min(1000,input.until-now));return;
    }
    // Human messages remain visible in the UI; model admission waits for the whole speech.
    if(this.speeches.has(groupId))return;
    const events=this.store.events(groupId);let nextAt=Infinity;
    let running=[...this.jobs.values()].filter(j=>j.groupId===groupId).length;
    for(const id of this.mentions.get(groupId)??[]){
      if(running>=settings.concurrency||this.jobs.size>=(this.deps.resourceLimits?.().maxActiveMembersPerUser??6)){nextAt=now+500;break;}
      const p=group.participants.find(p=>p.id===id),m=session.members.find(m=>m.id===id);
      if(!p||!m){this.mentions.get(groupId)?.delete(id);continue;}
      const retryAt=Math.max(m.retryAt??0,this.providerRetryAt.get(memberConnection(p))??0);
      if(retryAt>now){nextAt=Math.min(nextAt,retryAt);continue;}
      this.mentions.get(groupId)?.delete(id);this.launch(group,session,m,p,true);running++;
    }
    if(session.status!=='active'){if(Number.isFinite(nextAt))this.schedule(groupId,Math.max(10,nextAt-now));return;}
    if(session.admissionClosed||session.callCount>=group.settings.maxCalls) {
      if(!running)this.limit(groupId,session.error??'达到本场模型调用次数上限。');
      return;
    }
    const automaticMembers=session.members.filter(m=>group.participants.some(p=>p.id===m.id&&p.enabled));
    if(!running&&automaticMembers.length&&automaticMembers.every(m=>m.status==='error')) {
      this.store.mutateFree(groupId,s=>{s.status='paused';s.epoch++;s.error='所有成员都需要处理问题，讨论已暂停。请查看各成员的原因后继续。';});
      this.clearTimer(groupId);this.deps.notify(groupId);return;
    }
    const candidates=session.members.filter(m=>!this.jobs.has(`${groupId}:${m.id}`)&&m.status!=='error'&&m.status!=='budget_wait').sort((a,b)=>a.lastStartedAt-b.lastStartedAt||a.id.localeCompare(b.id));
    for(const member of candidates) {
      const participant=group.participants.find(p=>p.id===member.id&&p.enabled);
      if(!participant)continue;
      const unseen=events.filter(e=>e.seq>(member.consideredSeq??0)&&e.participantId!==member.id&&(settings.respondToAI||!e.participantId));
      const mentioned=unseen.some(e=>{const message=this.store.message(e.messageId);return message&&(message.mentions??inferredMentions(message.content,group.participants)).includes(participant.id);});
      const timerDue=member.wakeAt!==undefined&&member.wakeAt<=now;
      if(!unseen.length&&!timerDue){if(member.wakeAt)nextAt=Math.min(nextAt,member.wakeAt);continue;}
      const latest=unseen.at(-1),first=unseen[0];
      const quietAt=latest?Math.min(latest.createdAt+settings.quietSeconds*1000,first.createdAt+Math.max(settings.quietSeconds,10)*1000):now;
      const due=Math.max(mentioned?now:quietAt,mentioned?now:member.cooldownUntil,member.retryAt??0,this.providerRetryAt.get(memberConnection(participant))??0);
      if(due>now){nextAt=Math.min(nextAt,due);continue;}
      const triggered=timerDue||mentioned||(member.attention==='all'&&this.random()<settings.wakeProbability);
      if(!triggered){this.store.mutateFree(groupId,s=>{s.members.find(m=>m.id===member.id)!.consideredSeq=events.at(-1)?.seq??member.consideredSeq;});continue;}
      if(running>=settings.concurrency||this.jobs.size>=(this.deps.resourceLimits?.().maxActiveMembersPerUser??6)){nextAt=Math.min(nextAt,now+500);continue;}
      this.launch(group,session,member,participant);running++;
    }
    if(this.active(groupId)&&Number.isFinite(nextAt))this.schedule(groupId,Math.max(10,nextAt-now));
  }
  private launch(group:Group,session:FreeSession,member:FreeMemberState,participant:Participant,oneShot=false) {
    const groupId=group.id,key=`${groupId}:${member.id}`,epoch=session.epoch,controller=new AbortController();
    const firstWake=member.lastStartedAt===0;
    this.store.mutateFree(groupId,s=>{const m=s.members.find(x=>x.id===member.id)!;m.manualWake=oneShot;m.status='thinking';m.lastStartedAt=this.now();delete m.wakeAt;m.activity='正在独立判断是否回应';});
    // Defer execution so cancellation and concurrency accounting see the job before any work.
    const promise=Promise.resolve().then(async()=>{
      const provider=resolveConnection(this.deps.providers(),participant);
      if(!provider?.enabled||participant.channel&&participant.channel!=='api')throw new ModelCallError('此成员的 API 连接未启用或不支持自主群聊。');
      if(provider.billingMode!=='subscription'&&!['demo','ollama'].includes(provider.id)&&!this.deps.getKey(memberConnection(participant)))throw new ModelCallError('此成员的模型连接未配置密钥。');
      if(provider.billingMode!=='subscription'&&!['demo','ollama'].includes(provider.id)&&group.settings.budgetUSD>0&&(!provider.inputPrice||!provider.outputPrice))throw new ModelCallError('此成员的模型尚未配置单独费率，请先保存价格或调整群预算。');
      const wake=this.makeWake(group,session,member,participant,controller.signal,firstWake,oneShot);
      wake.log?.({kind:'wake',summary:oneShot?'人类 @ 单次唤醒：本次任务完成后返回待命，不恢复全群自动讨论。':'已唤醒，独立判断新消息；公开回复和等待都允许。'});
      await this.deps.runtime.run(wake);
      if(!controller.signal.aborted&&this.store.freeSession(groupId)?.epoch===epoch)this.store.mutateFree(groupId,s=>{const m=s.members.find(x=>x.id===member.id)!;delete m.rateLimitRetries;delete m.retryAt;delete m.error;});
    }).catch(error=>{
      const current=this.store.freeSession(groupId);
      if(controller.signal.aborted||current?.epoch!==epoch||current.status!=='active'&&!oneShot)return;
      if(error instanceof BudgetWaitError&&!oneShot){this.store.mutateFree(groupId,s=>{const m=s.members.find(m=>m.id===member.id)!;m.status='budget_wait';m.activity='等待在途请求结算';m.error=undefined;});return;}
      if(error instanceof ProviderRequestError&&error.kind==='rate_limit') {
        const retries=current.members.find(m=>m.id===member.id)?.rateLimitRetries??0;
        const delay=Math.max(error.retryAfterMs??0,2000*2**Math.min(retries,2)+Math.floor(this.random()*1000));
        const retryAt=Math.min(Number.MAX_SAFE_INTEGER,this.now()+delay);
        this.providerRetryAt.set(memberConnection(participant),Math.max(retryAt,this.providerRetryAt.get(memberConnection(participant))??0));
        const canRetry=!oneShot&&retries<2&&delay<=60000;
        this.store.mutateFree(groupId,s=>{const m=s.members.find(x=>x.id===member.id)!;m.retryAt=retryAt;m.rateLimitRetries=retries+1;m.status=canRetry?'retrying':'error';m.error=canRetry?`暂时限流，等待后自动重试（${retries+1}/2）；仍受本场预算限制。`:`${error.message} 自动重试已停止，请稍后手动继续。`;m.activity=canRetry?'等待限流退避':'需要检查速率限制';if(canRetry)m.wakeAt=retryAt;});
        return;
      }
      this.store.mutateFree(groupId,s=>{const m=s.members.find(x=>x.id===member.id)!;m.status='error';m.error=error instanceof ModelCallError?error.message:'成员运行时未完成请求，已暂停该成员。';m.activity='需要检查连接';});
      this.store.saveLog({id:randomUUID(),groupId,sessionId:session.id,memberId:member.id,author:participant.name,model:participant.model,createdAt:new Date(this.now()).toISOString(),kind:'error',summary:error instanceof ModelCallError?error.message:'成员运行未完成，已暂停。'});
    }).finally(()=>{
      this.jobs.delete(key);
      const current=this.store.freeSession(groupId);
      if(current?.epoch===epoch&&oneShot)this.store.mutateFree(groupId,s=>{const m=s.members.find(m=>m.id===member.id);if(m){delete m.manualWake;delete m.wakeAt;if(m.status!=='error'){m.status='waiting';m.activity='单次任务已结束，返回待命';}}});
      if(current?.epoch===epoch&&current.pauseRequested?.memberId===member.id&&!this.speeches.has(groupId)){
        // Human requests received after pause was requested run only after its speech drains.
        const pending=this.mentions.get(groupId);
        this.pause(groupId,undefined,true);
        if(pending?.size){this.mentions.set(groupId,pending);this.store.mutateFree(groupId,s=>{for(const m of s.members)if(pending.has(m.id)){m.manualWake=true;m.status='queued';m.activity='全群已暂停，等待单次回应';}});this.schedule(groupId,0);}
      }
      else if(current?.epoch===epoch&&current.status==='active') {
        this.store.mutateFree(groupId,s=>{const m=s.members.find(x=>x.id===member.id)!;if(m.status==='thinking')m.status='listening';if(m.status==='budget_wait'&&!s.reservedTokens){m.status='listening';m.wakeAt=this.now();}});
        this.schedule(groupId,0);
      }
      if(current?.epoch===epoch&&this.mentions.get(groupId)?.size)this.schedule(groupId,0);
      this.deps.notify(groupId);
    });
    this.jobs.set(key,{controller,promise,groupId});this.deps.notify(groupId);
  }
  private makeWake(group:Group,session:FreeSession,member:FreeMemberState,participant:Participant,signal:AbortSignal,firstWake:boolean,oneShot=false):RuntimeWake {
    const epoch=session.epoch,groupId=group.id,settings={...defaultFreeSettings,...group.freeSettings};
    const provider=resolveConnection(this.deps.providers(),participant)!;
    let delivered=member.acknowledgedSeq,terminal=false;
    const deliveredIds=new Set<string>(),deliveredSpeeches=new Set<string>(),activities:string[]=[];
    const log=(entry:LogInput)=>{this.store.saveLog({...entry,id:randomUUID(),groupId,sessionId:session.id,memberId:member.id,author:participant.name,model:participant.model,createdAt:new Date(this.now()).toISOString()});this.deps.notify(groupId);};
    const assertActive=()=>{
      signal.throwIfAborted();
      const current=this.store.freeSession(groupId),fresh=this.store.group(groupId),person=fresh?.participants.find(p=>p.id===member.id&&(p.enabled||oneShot));
      if(current?.id!==session.id||current.epoch!==epoch||current.status!=='active'&&!oneShot||fresh?.archived||!person||fingerprint(person)!==member.fingerprint)throw new ModelCallError('成员或讨论权限已变化，操作已取消。');
      if(current.pauseRequested&&this.speeches.get(groupId)?.memberId!==member.id)throw new ModelCallError('正在暂停，不再开始新的操作。');
    };
    const update=(fn:(m:FreeMemberState)=>void)=>this.store.mutateFree(groupId,s=>{assertActive();fn(s.members.find(m=>m.id===member.id)!);});
    const finish=(seconds:number)=>{
      terminal=true;
      update(m=>{
        m.acknowledgedSeq=Math.max(m.acknowledgedSeq,delivered);m.consideredSeq=Math.max(m.consideredSeq,delivered);m.deliveredSeq=delivered;
        m.status='waiting';delete m.queuedUntil;m.cooldownUntil=this.now()+(settings.cooldownMin+this.random()*(settings.cooldownMax-settings.cooldownMin))*1000;
        if(seconds>0&&!oneShot)m.wakeAt=this.now()+Math.max(seconds,15)*1000;else delete m.wakeAt;
        m.activity=oneShot?'单次任务已结束，返回待命':seconds>0?'等待补充或下次主动检查':'聆听新消息';
      });
    };
    const read=(limit=12):Delivery=>{
      assertActive();if(terminal)throw new ModelCallError('本次唤醒已经结束。');
      const pending=this.visibleEvents(groupId,delivered),messages:Delivery['messages']=[];let bytes=0;
      for(const e of pending) {
        const message=this.store.message(e.messageId);if(!message)throw new ModelCallError('群消息记录不完整。');
        const item:Delivery['messages'][number]={seq:e.seq,id:message.id,author:message.author,...(message.participantId?{participantId:message.participantId}:{}),kind:message.kind,content:message.content,senderKind:message.participantId?'ai':message.kind==='user'?'human':message.kind==='import'?'import':'system',...(message.replyTo?{replyTo:message.replyTo}:{}),...(message.sticker?{sticker:{id:message.sticker.id,name:message.sticker.name,tags:message.sticker.tags}}:{})};
        const size=Buffer.byteLength(JSON.stringify(item));
        if(message.speech)item.speech={...message.speech};
        if(messages.length>=limit||(messages.length>0&&bytes+size>60000))break;
        if(message.speech)deliveredSpeeches.add(message.speech.id);
        messages.push(item);bytes+=size;delivered=e.seq;deliveredIds.add(message.id);
      }
      update(m=>{m.deliveredSeq=Math.max(m.deliveredSeq,delivered);});
      activities.push(`读取 ${messages.length} 条新消息`);
      const speaking=this.speeches.get(groupId);
      return {messages,readThroughSeq:delivered,more:pending.some(e=>e.seq>delivered),...(speaking?{pendingSpeech:{memberId:speaking.memberId}}:{})};
    };
    const reserve=(input:number,output:number,chargeProvider=provider,chargeParticipant=participant,chargeMemberId=member.id)=>{
        assertActive();if(this.store.freeSession(groupId)?.pauseRequested)throw new ModelCallError('正在暂停，不再调用模型。');let failure='',pending=false;const id=randomUUID();
        this.store.mutateFree(groupId,s=>{
          const available=group.settings.maxTotalTokens-s.inputTokens-s.outputTokens-s.reservedTokens;
          let allowed=Math.min(output,Math.max(0,Math.floor(available-input)));
          if(group.settings.budgetUSD>0&&chargeProvider.outputPrice>0)allowed=Math.min(allowed,Math.max(0,Math.floor(((group.settings.budgetUSD-s.estimatedUSD-s.reservedUSD)*1e6-input*chargeProvider.inputPrice)/chargeProvider.outputPrice)));
          const usd=(input*chargeProvider.inputPrice+allowed*chargeProvider.outputPrice)/1e6;
          if(s.callCount>=group.settings.maxCalls)failure='达到本场模型调用次数上限。';
          else if(input>available||output>0&&allowed<Math.min(128,output))failure=`本群本场预算暂不够下一次请求：已用 ${s.inputTokens+s.outputTokens} / ${group.settings.maxTotalTokens} Token，在途预留 ${s.reservedTokens}；下一次输入估算 ${input} + 至少 ${Math.min(128,output)} 输出。也请检查金额上限。这不是供应商账户余额提示。`;
          else if(group.settings.budgetUSD>0&&s.estimatedUSD+s.reservedUSD+usd>group.settings.budgetUSD)failure='本群本场金额预算不足以预留下一次调用；不是供应商账户欠费。';
          if(failure){pending=s.reservedTokens>0&&s.callCount<group.settings.maxCalls;s.budgetNotice=failure;return;}
          if(allowed<output)s.budgetNotice=`根据本群剩余预算，本次输出上限由 ${output} 调整为 ${allowed} Token。输入为估算值，完成后按供应商实际用量结算。`;else delete s.budgetNotice;
          s.callCount++;s.reservedTokens+=input+allowed;s.reservedUSD+=usd;
          this.store.reserveCall({id,groupId,sessionId:session.id,input,output:allowed,usd,inputPrice:chargeProvider.inputPrice,outputPrice:chargeProvider.outputPrice,memberId:chargeMemberId,author:chargeParticipant.name,model:chargeParticipant.model,providerId:chargeProvider.id,connectionId:memberConnection(chargeParticipant),billingMode:chargeProvider.billingMode??'api'});
        });
        if(failure)throw pending?new BudgetWaitError(failure):new ModelCallError(failure);
        this.deps.notify(groupId);return id;
      };
    const wake:RuntimeWake={
      singleResponse:oneShot,
      sessionId:member.sessionId,group,participant,provider,apiKey:this.deps.getKey(memberConnection(participant)),signal,firstWake,
      summaryCycle:`${session.id}:${epoch}`,
      publicHistory:()=>{
        assertActive();const messages:Delivery['messages']=this.visibleEvents(groupId).map(e=>{
          const m=this.store.message(e.messageId);if(!m)throw new ModelCallError('公开历史记录不完整。');
          return {seq:e.seq,id:m.id,author:m.author,participantId:m.participantId,kind:m.kind,content:m.content,senderKind:m.participantId?'ai':m.kind==='user'?'human':'import',replyTo:m.replyTo,speech:m.speech,...(m.sticker?{sticker:{id:m.sticker.id,name:m.sticker.name,tags:m.sticker.tags}}:{})};
        });return {messages,readThroughSeq:messages.at(-1)?.seq??0,more:false};
      },
      summaryWake:()=>{
        assertActive();const config=group.freeSettings?.publicSummary;
        if(!config)throw new ModelCallError('本群需要压缩上下文，请先在群聊设置中选择「公共摘要连接」和「公共摘要模型」。原始历史保留。');
        const connection=this.deps.providers().find(p=>connectionKey(p)===config.connectionId);
        if(!connection?.enabled||connection.id==='demo')throw new ModelCallError('公共摘要连接未启用或不支持真实摘要，请在群设置重新选择。');
        const person:Participant={id:'public-summary',name:'公共摘要',providerId:connection.id,connectionId:config.connectionId,model:config.model,role:'',identityMode:'native',avatar:'摘',color:'#666666',enabled:true};
        const selected=resolveConnection(this.deps.providers(),person)!;
        if(selected.billingMode!=='subscription'&&selected.id!=='ollama'&&!this.deps.getKey(config.connectionId))throw new ModelCallError('公共摘要连接缺少密钥。');
        if(selected.billingMode!=='subscription'&&selected.id!=='ollama'&&group.settings.budgetUSD>0&&(!selected.inputPrice||!selected.outputPrice))throw new ModelCallError('公共摘要模型未配置单独费率，无法使用金额保护。请先配置该模型单价。');
        const summaryLog=(entry:LogInput)=>{this.store.saveLog({...entry,id:randomUUID(),groupId,sessionId:session.id,memberId:'public-summary',author:'公共摘要',model:selected.model,createdAt:new Date(this.now()).toISOString()});this.deps.notify(groupId);};
        return {...wake,participant:person,provider:selected,apiKey:this.deps.getKey(config.connectionId),skills:[],publicHistory:undefined,summaryWake:undefined,
          reserve:(input,output)=>reserve(input,output,selected,person,'public-summary'),log:summaryLog,
          post:()=>{throw new ModelCallError('公共摘要工具不能发言。');},loadSkill:()=>{throw new ModelCallError('公共摘要工具不能读取成员技能。');}};
      },
      memberStates:this.store.freeSession(groupId)?.members.map(m=>({id:m.id,status:m.status})),
      skills:(participant.skills??[]).map(id=>this.store.skill(id)).filter(s=>!!s).map(({instructions,...summary})=>summary),assertActive,read,log,
      listStickers:()=>{assertActive();return settings.allowStickers?this.store.stickers().map(({id,name,tags})=>({id,name,tags})):[];},
      post:(content,replyTo,callId,stickerId)=>{
        const postKey=`${member.sessionId}:${callId}`;
        const parts=!stickerId&&settings.messageStyle==='segmented'?splitChatMessage(content):[content];
        if(parts.length>60)throw new ModelCallError('这次发言分段过多。请合并零碎句子，只保留一个核心判断及依据，再提交完整发言。');
        const existing=this.store.existingPost(postKey);
        assertActive();if(existing)return {messageId:existing.id,duplicate:true};
        const sticker=stickerId?this.store.sticker(stickerId):undefined;
        if(stickerId&&(!settings.allowStickers||!sticker||sticker.deletedAt))throw new ModelCallError('该表情包不可用或本群未允许 AI 使用表情包。');
        const prepare=()=>{
        assertActive();const saved=this.store.existingPost(postKey);if(saved)return {messageId:saved.id,duplicate:true};
        if(terminal)throw new ModelCallError('本次唤醒已经结束。');
        const lastSticker=this.store.freeSession(groupId)?.lastStickerAt;
        if(sticker&&lastSticker!==undefined&&this.now()-lastSticker<(settings.stickerCooldownSeconds??60)*1000)throw new ModelCallError('本群表情包正在冷却，请改用文字或等待新消息。');
        if(this.store.messages(groupId).length+parts.length>(this.deps.resourceLimits?.().maxMessagesPerGroup??5000))throw new ModelCallError('本群剩余记录空间不足以发送整段发言，可请站主提高消息数量上限。');
        const unseen=this.store.events(groupId,delivered);
        const late=unseen.some(e=>!e.participantId);
        if(late)throw new ModelCallError('有新的人类或导入消息尚未读取，请先调用 read_messages 后重新判断。');
        // New peer speeches do not invalidate a reply to an earlier complete snapshot.
        // Otherwise a slow model can regenerate forever while faster peers keep posting.
        // Still reject replying from a paginated, partially delivered speech.
        if(unseen.some(e=>{const speech=this.store.message(e.messageId)?.speech;return speech&&deliveredSpeeches.has(speech.id);}))throw new ModelCallError('上一组分段发言尚未读完整，请调用 read_messages 继续读取（more=true 时继续读），再提交发言。');
        if(replyTo){const target=this.store.message(replyTo);const event=this.store.events(groupId).find(e=>e.messageId===replyTo);if(target?.groupId!==groupId||!event||event.seq>delivered)throw new ModelCallError('只能引用本群已交付的消息。');}
        };
        const commit=(index:number,speechId?:string)=>this.store.atomic(()=>{
        assertActive();if(this.store.messages(groupId).length>=(this.deps.resourceLimits?.().maxMessagesPerGroup??5000))throw new ModelCallError('本群已达到配置的记录上限，剩余分段已停止；可请站主调整。');
        const message:Message={id:randomUUID(),groupId,runId:session.id,participantId:member.id,author:participant.name,avatar:participant.avatar,avatarAssetId:participant.avatarAssetId,color:participant.color,providerId:participant.providerId,model:participant.model,kind:'assistant',content:parts[index],reasoning:index===0?activities.join('\n'):'',reasoningLabel:'本次活动记录',round:0,status:'complete',createdAt:new Date(this.now()).toISOString(),inputMessageIds:index===0?[...deliveredIds]:[],inputTokens:0,outputTokens:0,source:'api',discussionMode:'free',runtime:'deepseek-harness',...(replyTo&&index===0?{replyTo}:{}),...(speechId?{speech:{id:speechId,index:index+1,total:parts.length,state:'sending' as const}}:{})};
        if(sticker)message.sticker={id:sticker.id,name:sticker.name,tags:sticker.tags,assetId:sticker.assetId};
        if(index===0)this.store.publish(postKey,message);else this.store.saveMessage(message);
        this.store.mutateFree(groupId,s=>{s.publishedCount++;if(sticker)s.lastStickerAt=this.now();if(speechId)s.sending={memberId:member.id,speechId,sent:index+1,total:parts.length};});
        const fresh=this.store.group(groupId)!;fresh.updatedAt=message.createdAt;this.store.saveGroup(fresh);
        return message;
        });
        const complete=()=>this.store.atomic(()=>{
          const gap=(settings.messageGapMin??1)+this.random()*((settings.messageGapMax??3)-(settings.messageGapMin??1));
          const reading=readingSeconds(parts.at(-1)??content,settings.readingCharsPerSecond);
          this.store.mutateFree(groupId,s=>{s.nextPublishAt=this.now()+Math.max(gap,reading)*1000;});finish(0);
          log({kind:'published',summary:`已发送 ${parts.length} 条消息${sticker?'（含本地表情）':''}。`});
        });
        const publishOne=()=>this.store.atomic(()=>{const duplicate=prepare();if(duplicate)return duplicate;const message=commit(0);complete();this.deps.notify(groupId);this.messageArrived(groupId);return {messageId:message.id};});
        const publishSpeech=async()=>{
          const duplicate=prepare();if(duplicate)return duplicate;
          const speechId=randomUUID(),sent:Message[]=[];let completed=false;
          this.speeches.set(groupId,{memberId:member.id,speechId,beforeSeq:this.store.events(groupId).at(-1)?.seq??0});
          try {
            for(let index=0;index<parts.length;index++) {
              if(index)await sleep(segmentDelayMs(parts[index-1],settings.readingCharsPerSecond),undefined,{signal});
              while(this.playback.status(groupId).until>this.now()&&!this.store.freeSession(groupId)?.pauseRequested){
                assertActive();const activity='等待浏览器朗读完成（连发已暂缓）';
                if(this.store.freeSession(groupId)?.members.find(m=>m.id===member.id)?.activity!==activity){update(m=>{m.activity=activity;});this.deps.notify(groupId);}
                await sleep(500,undefined,{signal});
              }
              if(settings.waitForUserDraft){
                while(this.drafts.status(groupId).until>this.now()){
                  assertActive();const state=this.drafts.status(groupId),activity=state.hasDraft?'等待用户完成输入（连发已暂缓）':'输入框已清空，等待 3 秒';
                  if(this.store.freeSession(groupId)?.members.find(m=>m.id===member.id)?.activity!==activity){update(m=>{m.activity=activity;});this.deps.notify(groupId);}
                  await sleep(Math.min(500,Math.max(1,state.until-this.now())),undefined,{signal});
                }
              }
              assertActive();sent.push(commit(index,speechId));update(m=>{m.status='sending';m.activity=`正在发送 ${index+1}/${parts.length}`;});this.deps.notify(groupId);
            }
            complete();completed=true;
            return {messageId:sent[0].id,messageIds:sent.map(m=>m.id)};
          } finally {
            // Graceful pause drains this speech; forced stop persists only emitted bubbles.
            this.store.atomic(()=>{
              for(const message of sent){message.speech!.state=completed?'complete':'interrupted';this.store.saveMessage(message);}
              const current=this.store.freeSession(groupId);
              if(current?.sending?.speechId===speechId)this.store.mutateFree(groupId,s=>{delete s.sending;});
            });
            if(this.speeches.get(groupId)?.speechId===speechId)this.speeches.delete(groupId);
            this.deps.notify(groupId);this.messageArrived(groupId);
          }
        };
        const rejected=(error:unknown):never=>{
          const current=this.store.freeSession(groupId);
          if(!terminal&&!signal.aborted&&current?.epoch===epoch&&current.status==='active'){
            update(m=>{m.status='thinking';m.activity='发言未发送，正在重新判断';delete m.queuedUntil;});
            log({kind:'protocol',summary:`发言尚未发送：${error instanceof ModelCallError?error.message:'发送未完成，正在处理。'}`});
          }
          throw error;
        };
        const publish=parts.length>1?publishSpeech:publishOne;
        if(parts.length===1&&!this.publicationGate.busy(groupId)&&settings.messageGapMin===0&&settings.messageGapMax===0&&!settings.readingCharsPerSecond&&!settings.typingGraceSeconds&&this.inputHold(groupId).until<=this.now()&&this.playback.status(groupId).until<=this.now()){try{return publishOne();}catch(error){return rejected(error);}}
        update(m=>{m.status='queued';m.activity=this.speeches.has(groupId)?'等待群友发完整组消息':'已准备发言，排队发送';delete m.queuedUntil;});this.deps.notify(groupId);
        const due=()=>{
          const input=this.inputHold(groupId),current=this.store.freeSession(groupId),gap=current?.nextPublishAt??0,typing=input.until,playback=this.playback.status(groupId),at=Math.max(gap,typing,playback.until),now=this.now();
          const activity=at<=now?'即将发送':playback.until>now?'等待浏览器朗读完成':input.hasDraft?'等待用户完成输入':typing>=gap?(settings.waitForUserDraft?'输入框已清空，等待 3 秒':'等待用户输入保护'):'等待阅读 / 发送间隔',until=at>now&&!input.hasDraft&&!playback.hasDraft?at:undefined;
          const state=current?.members.find(m=>m.id===member.id);
          if(state?.activity!==activity||state?.queuedUntil!==until){update(m=>{m.activity=activity;m.queuedUntil=until;});this.deps.notify(groupId);}
          return at;
        };
        return this.publicationGate.run(groupId,signal,due,publish).catch(rejected);
      },
      wait:(seconds,reason)=>{assertActive();if(terminal)throw new ModelCallError('本次唤醒已经结束。');finish(seconds);log({kind:'waiting',summary:reason?.trim()?`等待原因（模型说明）：${reason.trim().slice(0,500)}`:'模型选择继续等待，未提供原因。'});return {waiting:true,readThroughSeq:delivered};},
      attention:mode=>{assertActive();update(m=>{m.attention=mode;});return {mode};},
      loadSkill:id=>{
        assertActive();if(!(participant.skills??[]).includes(id))throw new ModelCallError('当前成员没有启用此技能。');
        const skill=this.store.skill(id);if(!skill)throw new ModelCallError('技能已被移除。');activities.push(`读取技能：${skill.name}`);
        return {name:skill.name,description:skill.description,instructions:skill.instructions,capabilities:'仅方法说明；不增加文件、网络或代码执行权限'};
      },
      activity:text=>{if(!terminal)update(m=>{m.status='thinking';m.activity=text;delete m.queuedUntil;});this.deps.notify(groupId);},
      reserve:(input,output)=>reserve(input,output),
      outputLimit:ticket=>this.store.callOutput(ticket),
      settle:(ticket,usage)=>{
        this.store.settleCall(ticket,usage);
        this.store.mutateFree(groupId,s=>{if(s.id!==session.id||s.epoch!==epoch||s.status!=='active')return;for(const m of s.members)if(m.status==='budget_wait'){m.status='listening';m.wakeAt=this.now();}});
        this.deps.notify(groupId);
      },
    };
    return wake;
  }
  async settle(groupId:string) {await Promise.allSettled([...this.jobs.values()].filter(j=>j.groupId===groupId).map(j=>j.promise));}
  async shutdown() {
    this.closed=true;for(const timer of this.timers.values())clearTimeout(timer);this.timers.clear();
    for(const session of this.store.freeSessions())if(session.status==='active')this.pause(session.groupId,'本地服务已停止；重新打开后可以继续。');
    for(const job of this.jobs.values())job.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map(j=>j.promise));await this.deps.runtime.shutdown();
  }
}
