import { randomInt, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { identityModeOf, WEB_CHAT_URLS, connectionKey, resolveConnection, type CompletionRequest, type CompletionResult, type Group, type Message, type Participant, type PendingWebTurn, type ProviderConfig, type Run, type WebProviderId } from '../shared/types.js';
import { BrowserConnectorError, type BrowserDriver } from './browser-connector.js';
import { Store } from './store.js';
import { buildDiscussionPrompt, estimateInputTokens } from './providers.js';
import { ProviderRequestError } from './model-errors.js';

type Generate = (request: CompletionRequest) => Promise<CompletionResult>;
export interface SchedulerDeps {
  providers: () => ProviderConfig[]; getKey: (id: string) => string | undefined;
  generate: Generate; notify: (groupId: string) => void;
  browser?: BrowserDriver;
  wait?: (ms:number, signal:AbortSignal) => Promise<void>; random?: (min:number,max:number) => number;
}
export class DiscussionError extends Error { constructor(message:string,public statusCode=400){super(message);} }
export const isActive = (r: Run) => r.status==='running'||r.status==='waiting'||r.status==='awaiting_web';

export class Scheduler {
  private controllers = new Map<string, AbortController>();
  private jobs = new Map<string, Promise<void>>();
  private browserTurns = new Map<string,{run:Run;participant:Participant;summary:boolean;resolve:(reply:{content:string;reasoning:string;context:PendingWebTurn;source?:'browser'})=>void;reject:(e:Error)=>void}>();
  private browserJobs = new Map<string,{controller:AbortController;job:Promise<void>}>();
  private random: (min:number,max:number)=>number;
  constructor(private store:Store,private deps:SchedulerDeps) {this.random=deps.random??((min,max)=>randomInt(min,max+1));}
  start(groupId:string,options:{targetId?:string;summaryOnly?:boolean}={}):Run {
    if(options.targetId&&options.summaryOnly)throw new DiscussionError('点名发言和单独总结不能同时选择。');
    const group=this.requireGroup(groupId);
    if(group.archived)throw new DiscussionError('请先恢复这个茶桌。');
    if(this.store.runs(groupId).some(isActive))throw new DiscussionError('这张茶桌已有讨论正在进行。',409);
    if(this.controllers.size>=3)throw new DiscussionError('最多同时运行 3 场讨论，请等待或停止其他茶桌。',429);
    const all=group.participants.filter(p=>p.enabled);
    const participants=all;
    if(!participants.length||options.targetId&&!all.some(p=>p.id===options.targetId))throw new DiscussionError('至少启用一位有效成员后才能开始。');
    if(!group.goal.trim()&&!this.store.messages(groupId).some(m=>m.kind==='user'))throw new DiscussionError('请先设置讨论目标或发送一条消息。');
    this.validateProviders(options.targetId?participants.filter(p=>p.id===options.targetId):options.summaryOnly?[participants.find(p=>p.id===group.settings.summaryParticipantId)??participants[0]]:participants);
    const settings=structuredClone(group.settings);
    if(options.targetId){settings.autoSummary=false;settings.roundsMode='fixed';settings.rounds=1;}
    const chosenRounds=options.summaryOnly?0:settings.roundsMode==='random'?this.random(settings.roundsMin,settings.roundsMax):settings.rounds;
    if(options.summaryOnly)settings.autoSummary=true;
    const history=this.store.messages(groupId).filter(m=>m.status==='complete');
    const run:Run={id:randomUUID(),groupId,goal:group.goal,status:'running',createdAt:new Date().toISOString(),chosenRounds,currentRound:1,
      turnCount:0,inputTokens:0,outputTokens:0,estimatedUSD:0,settings,participants:structuredClone(participants),
      baseMessageIds:history.map(m=>m.id),roundStartMessageIds:history.map(m=>m.id),roundOrder:options.targetId?[options.targetId]:this.order(participants,settings.order),nextIndex:0,summaryDone:false,...options};
    this.store.saveRun(run);this.touch(groupId);this.launch(run);return run;
  }
  cancel(id:string):Run {
    const run=this.requireRun(id);
    if(!isActive(run))throw new DiscussionError('这场讨论已经停止。',409);
    run.status='cancelled';run.finishedAt=new Date().toISOString();delete run.nextAt;delete run.nextSpeakerId;delete run.pendingWeb;
    this.store.saveRun(run);this.controllers.get(id)?.abort();this.deps.notify(run.groupId);return run;
  }
  retry(id:string):Run {
    const run=this.requireRun(id);
    if(run.status!=='failed')throw new DiscussionError('只有失败的发言可以重试；中断或已停止的讨论请重新开始。',409);
    const group=this.requireGroup(run.groupId);
    if(group.archived||run.participants.some(p=>!group.participants.some(current=>current.id===p.id&&current.enabled&&current.profileId===p.profileId&&current.profileRevision===p.profileRevision)))throw new DiscussionError('群聊或成员档案已变化，请开始新的讨论；旧发言不能继续重试。',409);
    if(this.store.runs(run.groupId)[0]?.id!==id)throw new DiscussionError('已有更新的讨论，请在新讨论中继续，避免混入旧上下文。',409);
    if(this.controllers.has(id)||this.store.runs(run.groupId).some(isActive))throw new DiscussionError('上一次调用仍在结束，请稍后重试。',409);
    if(this.controllers.size>=3)throw new DiscussionError('同时运行的讨论已达到上限。',429);
    this.validateProviders(run.targetId?run.participants.filter(p=>p.id===run.targetId):run.summaryOnly?[run.participants.find(p=>p.id===run.settings.summaryParticipantId)??run.participants[0]]:run.participants);
    run.status='running';delete run.error;delete run.finishedAt;
    this.store.saveRun(run);this.launch(run);return run;
  }
  async settle(id:string) {await this.jobs.get(id);}
  startBrowser(id:string,requestId:string):Run {
    const entry=this.requireWebTurn(id,requestId);
    if(entry.participant.channel!=='browser')throw new DiscussionError('此成员未选择浏览器连接。',400);
    if(this.browserJobs.has(id))throw new DiscussionError('浏览器已在处理本轮，请勿重复发送。',409);
    if(entry.run.turnCount>=entry.run.settings.maxCalls)throw new DiscussionError('达到本场调用次数上限，请结束本场讨论。',409);
    entry.run.turnCount++;this.launchBrowser(id);return entry.run;
  }
  async pauseBrowser(id:string,requestId:string):Promise<Run> {
    const entry=this.requireWebTurn(id,requestId);const work=this.browserJobs.get(id);
    work?.controller.abort();if(work)await work.job;
    this.requireWebTurn(id,requestId);
    entry.run.pendingWeb!.browser={phase:'paused',sent:entry.run.pendingWeb!.browser?.sent??false,message:'已暂停自动操作，可检查网页后重新发送。网页已发送的请求可能仍在生成。'};
    this.store.saveRun(entry.run);this.deps.notify(entry.run.groupId);return entry.run;
  }
  private launchBrowser(id:string) {
    const entry=this.browserTurns.get(id)!;const run=entry.run;const controller=new AbortController();
    run.pendingWeb!.browser={phase:'opening',message:'正在准备浏览器连接…',sent:false};
    this.store.saveRun(run);this.deps.notify(run.groupId);
    const current=()=>this.browserTurns.get(id)===entry&&this.store.run(id)?.status==='awaiting_web'&&!controller.signal.aborted;
    // Defer until the job has been registered, so duplicate actions cannot race the first await.
    const job=Promise.resolve().then(async()=>{
      if(!this.deps.browser)throw new BrowserConnectorError('浏览器连接器不可用，请检查浏览器连接设置。');
      let context=run.pendingWeb!;
      const result=await this.deps.browser.generate({providerId:entry.participant.providerId as WebProviderId,signal:controller.signal,
        prepare:()=>{
          if(!current())throw new BrowserConnectorError('本轮已停止。');
          const refreshed=this.browserContext(run,entry.participant,entry.summary);
          context={...refreshed,requestId:run.pendingWeb!.requestId,browser:run.pendingWeb!.browser};run.pendingWeb=context;
          this.store.saveRun(run);this.deps.notify(run.groupId);return context.prompt;
        },
        progress:progress=>{if(current()){run.pendingWeb!.browser=progress;this.store.saveRun(run);this.deps.notify(run.groupId);}},
      });
      if(!current())return;
      if(!result.content.trim()||result.content.length>16000||result.reasoning.length>16000)throw new BrowserConnectorError('网页返回内容为空或超过消息长度限制，请检查网页后重试。');
      // Like API responses, new human messages AFTER dispatch belong to the next turn.
      this.browserTurns.delete(id);run.status='running';delete run.pendingWeb;this.store.saveRun(run);
      entry.resolve({...result,context,source:'browser'});this.deps.notify(run.groupId);
    }).catch(error=>{
      if(this.browserTurns.get(id)!==entry||this.store.run(id)?.status!=='awaiting_web')return;
      run.pendingWeb!.browser={phase:'paused',sent:run.pendingWeb!.browser?.sent??false,message:controller.signal.aborted?'浏览器操作已暂停。':error instanceof BrowserConnectorError?error.message:'网页操作未完成，已暂停；不会自动重发。'};
      this.store.saveRun(run);this.deps.notify(run.groupId);
    }).finally(()=>{if(this.browserJobs.get(id)?.controller===controller)this.browserJobs.delete(id);});
    this.browserJobs.set(id,{controller,job});
  }
  private requireWebTurn(id:string,requestId:string) {
    const entry=this.browserTurns.get(id);
    if(!entry||this.store.run(id)?.status!=='awaiting_web'||entry.run.pendingWeb?.requestId!==requestId)throw new DiscussionError('这次浏览器连接已失效，请刷新当前讨论。',409);
    if(Date.now()-Date.parse(entry.run.createdAt)>60*60*1000)throw new DiscussionError('本场讨论已达到 60 分钟上限。',409);
    return entry;
  }
  async shutdown(){for(const [id,controller]of this.controllers){const run=this.store.run(id);if(run&&isActive(run)){run.status='interrupted';run.error='服务已停止，未自动重新请求模型。';run.finishedAt=new Date().toISOString();delete run.pendingWeb;this.store.saveRun(run);}controller.abort();}await Promise.allSettled([...this.jobs.values(),...[...this.browserJobs.values()].map(w=>w.job)]);}
  private launch(run:Run) {
    const controller=new AbortController();this.controllers.set(run.id,controller);
    const job=this.execute(run,controller.signal).finally(()=>{this.controllers.delete(run.id);this.jobs.delete(run.id);this.deps.notify(run.groupId);});
    this.jobs.set(run.id,job);this.deps.notify(run.groupId);
  }
  private async execute(run:Run,signal:AbortSignal) {
    try {
      while(run.currentRound<=run.chosenRounds){
        while(run.nextIndex<run.roundOrder.length){
          signal.throwIfAborted();const participant=run.participants.find(p=>p.id===run.roundOrder[run.nextIndex])!;
          await this.turn(run,participant,false,signal);run.nextIndex++;this.store.saveRun(run);
        }
        run.currentRound++;run.nextIndex=0;run.roundOrder=this.order(run.participants,run.settings.order);
        // AI replies are frozen per round; new human contributions are selected at each dispatch.
        run.roundStartMessageIds=this.store.messages(run.groupId).filter(m=>m.status==='complete').map(m=>m.id);
        this.store.saveRun(run);
      }
      if(run.settings.autoSummary&&!run.summaryDone){
        const participant=run.participants.find(p=>p.id===run.settings.summaryParticipantId)??run.participants[0];
        await this.turn(run,participant,true,signal);run.summaryDone=true;
      }
      signal.throwIfAborted();run.status='completed';run.finishedAt=new Date().toISOString();delete run.nextAt;delete run.nextSpeakerId;this.store.saveRun(run);
    }catch(error){
      if(signal.aborted){const saved=this.store.run(run.id);if(saved&&isActive(saved)){saved.status='cancelled';saved.finishedAt=new Date().toISOString();this.store.saveRun(saved);}}
      else {run.status='failed';run.error=error instanceof DiscussionError?error.message:error instanceof Error?error.message:'模型调用未完成。';run.finishedAt=new Date().toISOString();delete run.nextAt;delete run.pendingWeb;this.store.saveRun(run);}
    }finally{this.touch(run.groupId);this.deps.notify(run.groupId);}
  }
  private async turn(run:Run,participant:Participant,summary:boolean,signal:AbortSignal) {
    signal.throwIfAborted();
    if(run.turnCount>=run.settings.maxCalls)throw new DiscussionError('达到本场调用次数上限，已停止后续请求。');
    if(Date.now()-Date.parse(run.createdAt)>60*60*1000)throw new DiscussionError('本场讨论已达到 60 分钟上限。');
    const seconds=run.turnCount===0?0:run.settings.delayMode==='random'?this.random(Math.round(run.settings.delayMin*1000),Math.round(run.settings.delayMax*1000))/1000:run.settings.delaySeconds;
    run.nextSpeakerId=participant.id;
    if(seconds>0){run.status='waiting';run.nextAt=new Date(Date.now()+seconds*1000).toISOString();this.store.saveRun(run);this.deps.notify(run.groupId);await (this.deps.wait??((ms,s)=>sleep(ms,undefined,{signal:s})))(seconds*1000,signal);}
    if(Date.now()-Date.parse(run.createdAt)>60*60*1000)throw new DiscussionError('本场讨论已达到 60 分钟上限，等待后没有再启动请求。');
    signal.throwIfAborted();delete run.nextAt;
    if(participant.channel==='browser'){await this.browserTurn(run,participant,summary,signal);return;}
    const provider=resolveConnection(this.deps.providers(),participant);
    if(provider?.billingMode==='subscription')throw new DiscussionError('ChatGPT 订阅连接用于自主群聊，请将讨论模式切换为自主群聊。');
    if(!provider?.enabled)throw new DiscussionError(`${participant.name} 的服务未启用。`);
    const key=this.deps.getKey(connectionKey(provider));
    if(!['demo','ollama'].includes(provider.id)&&!key)throw new DiscussionError(`${provider.name} 尚未配置 API Key。`);
    if(!participant.model.trim()&&!provider.model.trim())throw new DiscussionError(`请为 ${participant.name} 配置模型 ID。`);
    const history=this.historyFor(run,summary);
    const roster=this.roster(run);
    const effectiveParticipant={...participant,model:participant.model||provider.model};
    const estimatedInput=estimateInputTokens({goal:run.goal,roster,history,participant:effectiveParticipant,round:run.currentRound,summary});
    const reserveTokens=estimatedInput+run.settings.maxOutputTokens;
    if(run.inputTokens+run.outputTokens+reserveTokens>run.settings.maxTotalTokens)throw new DiscussionError('剩余 token 预算不足以安全启动下一次调用，已暂停。请新建一次预算更充足的讨论。');
    const real=provider.id!=='demo'&&provider.id!=='ollama';
    if(real&&run.settings.budgetUSD>0&&(provider.inputPrice<=0||provider.outputPrice<=0))throw new DiscussionError(`请先在 ${provider.name} 设置中填写当前输入和输出单价，才能启用金额预算。也可将金额预算设为 0，仅使用次数与 token 限制。`);
    const reserveCost=real?(estimatedInput*provider.inputPrice+run.settings.maxOutputTokens*provider.outputPrice)/1e6:0;
    if(run.settings.budgetUSD>0&&run.estimatedUSD+reserveCost>run.settings.budgetUSD)throw new DiscussionError('预计下一次调用会超过金额预算，已停止后续请求。');
    signal.throwIfAborted();run.status='running';delete run.nextAt;run.turnCount++;this.store.saveRun(run);
    // Stable message identity on retries; failed attempts stay accounted for in run counters.
    const messageId=`${run.id}:${summary?'summary':`${run.currentRound}:${participant.id}`}`;
    const msg:Message={id:messageId,groupId:run.groupId,runId:run.id,participantId:participant.id,author:participant.name,avatar:participant.avatar,avatarAssetId:participant.avatarAssetId,color:participant.color,
      providerId:participant.providerId,model:participant.model||provider.model,source:'api',kind:summary?'summary':'assistant',content:'',reasoning:'',reasoningLabel:'',
      round:summary?run.chosenRounds+1:run.currentRound,status:'streaming',createdAt:new Date().toISOString(),inputMessageIds:history.map(m=>m.id),inputTokens:0,outputTokens:0};
    this.store.saveMessage(msg);this.deps.notify(run.groupId);
    let lastFlush=0;
    const flush=()=>{this.store.saveMessage(msg);this.deps.notify(run.groupId);lastFlush=Date.now();};
    try {
      const result=await this.deps.generate({provider,apiKey:key,participant:effectiveParticipant,goal:run.goal,roster,
        history,round:run.currentRound,summary,maxOutputTokens:run.settings.maxOutputTokens,signal,
        onDelta:delta=>{if(signal.aborted)return;if(delta.content)msg.content+=delta.content;if(delta.reasoning)msg.reasoning+=delta.reasoning;if(delta.reasoningLabel)msg.reasoningLabel=delta.reasoningLabel;if(Date.now()-lastFlush>100)flush();}});
      signal.throwIfAborted();
      msg.inputTokens=Math.max(0,result.inputTokens);msg.outputTokens=Math.max(0,result.outputTokens);msg.status='complete';
      run.inputTokens+=msg.inputTokens;run.outputTokens+=msg.outputTokens;
      run.estimatedUSD+=real?(msg.inputTokens*provider.inputPrice+msg.outputTokens*provider.outputPrice)/1e6:0;
      flush();this.store.saveRun(run);
    }catch(error){
      msg.status=signal.aborted?'stopped':'failed';
      // Known pre-generation rejections consume attempts, but not estimated generation spend.
      const rejected=error instanceof ProviderRequestError&&error.notGenerated&&!msg.content&&!msg.reasoning;
      msg.inputTokens=rejected?0:estimatedInput;msg.outputTokens=rejected?0:run.settings.maxOutputTokens;
      const failedCost=rejected?0:reserveCost;
      const saved=this.store.run(run.id);
      if(signal.aborted&&saved){saved.inputTokens+=msg.inputTokens;saved.outputTokens+=msg.outputTokens;saved.estimatedUSD+=failedCost;this.store.saveRun(saved);}
      else{run.inputTokens+=msg.inputTokens;run.outputTokens+=msg.outputTokens;run.estimatedUSD+=failedCost;this.store.saveRun(run);}
      flush();throw error;
    }
  }
  private roster(run:Run):string {
    return JSON.stringify([{name:'我',type:'human',role:'平等讨论成员；观点可以被质疑'},...run.participants.map(p=>({name:p.name,type:'ai',provider:p.providerId,model:p.model,identityMode:identityModeOf(p)}))]);
  }
  private historyFor(run:Run,summary:boolean):Message[] {
    const messages=this.store.messages(run.groupId).filter(m=>m.status==='complete');
    if(summary||run.currentRound>1&&run.settings.contextMode==='sequential')return this.limitHistory(messages);
    const snapshot=new Set(run.currentRound===1?run.baseMessageIds:run.roundStartMessageIds);
    return this.limitHistory(messages.filter(m=>m.kind==='user'||m.kind==='import'||snapshot.has(m.id)));
  }
  private browserContext(run:Run,participant:Participant,summary:boolean):PendingWebTurn {
    const history=this.historyFor(run,summary);
    const {system,input}=buildDiscussionPrompt({goal:run.goal,roster:this.roster(run),history,participant,round:run.currentRound,summary});
    const url=WEB_CHAT_URLS[participant.providerId];if(!url)throw new DiscussionError('该成员没有支持的官方网页入口。');
    return {requestId:randomUUID(),participantId:participant.id,prompt:`${system}\n\n以下是本次讨论的议题与公开消息：\n${input}`,url,createdAt:new Date().toISOString(),inputMessageIds:history.map(m=>m.id),liveMessageIds:this.store.messages(run.groupId).filter(m=>m.kind==='user'||m.kind==='import').map(m=>m.id),round:run.currentRound,summary};
  }
  private async browserTurn(run:Run,participant:Participant,summary:boolean,signal:AbortSignal) {
    run.status='awaiting_web';run.turnCount++;run.pendingWeb=this.browserContext(run,participant,summary);
    const reply=await new Promise<{content:string;reasoning:string;context:PendingWebTurn;source?:'browser'}>((resolve,reject)=>{
      const finish=()=>{clearTimeout(timeout);signal.removeEventListener('abort',abort);this.browserTurns.delete(run.id);this.browserJobs.get(run.id)?.controller.abort();};
      const abort=()=>{finish();reject(new Error('浏览器连接已停止。'));};
      const timeout=setTimeout(()=>{finish();reject(new DiscussionError('等待网页回复超过本场 60 分钟上限。'));},Math.max(1,60*60*1000-(Date.now()-Date.parse(run.createdAt))));timeout.unref();
      this.browserTurns.set(run.id,{run,participant,summary,resolve:result=>{finish();resolve(result);},reject:error=>{finish();reject(error);}});
      signal.addEventListener('abort',abort,{once:true});
      this.store.saveRun(run);this.deps.notify(run.groupId);
      if(signal.aborted)abort();else if(participant.channel==='browser')this.launchBrowser(run.id);
    });
    signal.throwIfAborted();
    const msg:Message={id:`${run.id}:${summary?'summary':`${run.currentRound}:${participant.id}`}`,groupId:run.groupId,runId:run.id,participantId:participant.id,author:participant.name,avatar:participant.avatar,avatarAssetId:participant.avatarAssetId,color:participant.color,providerId:participant.providerId,model:participant.model,source:'browser',kind:summary?'summary':'assistant',content:reply.content,reasoning:reply.reasoning,reasoningLabel:reply.reasoning?'网页可见思考（浏览器读取）':'',round:summary?run.chosenRounds+1:run.currentRound,status:'complete',createdAt:new Date().toISOString(),inputMessageIds:reply.context.inputMessageIds,inputTokens:0,outputTokens:0};
    delete run.pendingWeb;run.status='running';this.store.saveMessage(msg);this.store.saveRun(run);this.deps.notify(run.groupId);
  }
  private limitHistory(history:Message[]):Message[] {
    let used=0;const selected:Message[]=[];
    for(let i=history.length-1;i>=0&&selected.length<80;i--){const m=history[i];const size=Buffer.byteLength(m.content,'utf8');if(used+size>48000)continue;selected.unshift(m);used+=size;}
    return selected;
  }
  private order(participants:Participant[],mode:'fixed'|'random') {const ids=participants.map(p=>p.id);if(mode==='random')for(let i=ids.length-1;i>0;i--){const j=this.random(0,i);[ids[i],ids[j]]=[ids[j],ids[i]];}return ids;}
  private validateProviders(participants:Participant[]) {const configs=this.deps.providers();for(const p of participants){if(p.channel==='browser'){if(!WEB_CHAT_URLS[p.providerId])throw new DiscussionError('该成员不支持网页连接。');continue;}const c=resolveConnection(configs,p);if(!c?.enabled)throw new DiscussionError(`${p.name} 使用的服务未启用。`);if(c.billingMode==='subscription')throw new DiscussionError('ChatGPT 订阅连接用于自主群聊，请先切换讨论模式。');if(!['demo','ollama'].includes(p.providerId)&&!this.deps.getKey(p.connectionId??p.providerId))throw new DiscussionError(`请先配置 ${c.name} 的 API Key。`);}}
  private requireGroup(id:string):Group {const group=this.store.group(id);if(!group)throw new DiscussionError('茶桌不存在。',404);return group;}
  private requireRun(id:string):Run {const run=this.store.run(id);if(!run)throw new DiscussionError('讨论不存在。',404);return run;}
  private touch(groupId:string) {const group=this.store.group(groupId);if(group){group.updatedAt=new Date().toISOString();this.store.saveGroup(group);}}
}
