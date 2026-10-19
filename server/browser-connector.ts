import { chromium, type BrowserContext, type Locator, type Page } from 'playwright-core';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { WEB_CHAT_URLS, type BrowserProfile, type BrowserProgress, type BrowserSelectors, type WebProviderId } from '../shared/types.js';
import { browserSelectorsSchema, webProviderSchema } from './validation.js';

export const WEB_PROVIDERS: WebProviderId[] = ['openai','claude','deepseek','qwen'];
// Versioned, conservative CSS presets. An unknown layout pauses instead of guessing a button or answer.
export const BROWSER_PRESETS: Record<WebProviderId,BrowserSelectors> = {
  openai: {composer:'#prompt-textarea',send:'button[data-testid="send-button"]',response:'[data-message-author-role="assistant"] .markdown',busy:'button[data-testid="stop-button"]',done:'button[data-testid="copy-turn-action-button"]',reasoning:''},
  claude: {composer:'div[contenteditable="true"][role="textbox"], div[contenteditable="true"].ProseMirror',send:'button[aria-label="Send message"], button[aria-label="发送消息"]',response:'.font-claude-response',busy:'button[aria-label="Stop response"], button[aria-label="停止回复"]',done:'button[data-testid="action-bar-copy"], button[aria-label="Copy"], button[aria-label="复制"]',reasoning:''},
  deepseek: {composer:'textarea#chat-input',send:'[role="button"][aria-label="发送"], button[aria-label="Send message"], button[type="submit"]',response:'.ds-message .ds-markdown',busy:'[role="button"][aria-label="停止生成"], button[aria-label="Stop generating"]',done:'[role="button"][aria-label="复制"], button[aria-label="Copy"]',reasoning:''},
  qwen: {composer:'textarea#chat-input, textarea[placeholder*="Qwen"], textarea[placeholder*="千问"]',send:'button[aria-label="Send"], button[aria-label="发送"], button#send-message-button',response:'.chat-assistant .markdown, [data-message-author-role="assistant"] .markdown',busy:'button[aria-label="Stop"], button[aria-label="停止"], button#stop-response-button',done:'.chat-assistant button[aria-label="Copy"], button[aria-label="复制回复"]',reasoning:''},
};
export class BrowserConnectorError extends Error {
  constructor(message:string, public statusCode=409){super(message);}
}
export interface BrowserTurnRequest {
  providerId: WebProviderId; signal: AbortSignal;
  prepare: () => string; // Read the latest discussion immediately before entering the composer.
  progress: (progress: BrowserProgress) => void;
}
export interface BrowserTurnResult { content:string; reasoning:string; }
export interface BrowserDriver {
  generate(request:BrowserTurnRequest):Promise<BrowserTurnResult>;
}
interface Options {
  dataDir:string; load:(id:WebProviderId)=>unknown; save:(id:WebProviderId,value:BrowserSelectors)=>void;
  notify:()=>void;
  // Dependency injection is available to local tests only; no HTTP API accepts URLs, paths or browser code.
  launch?:(profile:string)=>Promise<BrowserContext>;
  timeoutMs?:number; pollMs?:number; stableMs?:number;
}
interface Session { context:BrowserContext; busy:boolean; lastPage?:Page; }

export function safeBrowserRequest(raw:string):boolean {
  try {
    const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password)return false;
    const h=u.hostname.toLowerCase().replace(/^\[|\]$/g,'');
    if(h==='localhost'||h.endsWith('.localhost')||h.endsWith('.local')||h.endsWith('.internal')||!h.includes('.'))return false;
    if(h.includes(':')||/^\d+(\.\d+){3}$/.test(h))return false;
    return !['metadata.google.internal','metadata.azure.internal'].includes(h);
  }catch{return false;}
}
export function providerOrigin(provider:WebProviderId,raw:string):boolean {
  try {const u=new URL(raw);return !u.username&&!u.password&&u.origin===new URL(WEB_CHAT_URLS[provider]!).origin;}catch{return false;}
}

export class BrowserConnector implements BrowserDriver {
  private sessions=new Map<WebProviderId,Session>();
  private opening=new Map<WebProviderId,Promise<Session>>();
  private closing=false;
  constructor(private options:Options){}
  profiles():BrowserProfile[] {return WEB_PROVIDERS.map(providerId=>({providerId,state:this.opening.has(providerId)?'opening':this.sessions.get(providerId)?.busy?'busy':this.sessions.has(providerId)?'open':'closed',selectors:this.selectors(providerId)}));}
  selectors(id:WebProviderId):BrowserSelectors {const saved=browserSelectorsSchema.safeParse(this.options.load(id));return saved.success?saved.data:{...BROWSER_PRESETS[id]};}
  configure(id:WebProviderId,selectors:BrowserSelectors) {
    if(this.sessions.get(id)?.busy)throw new BrowserConnectorError('请先暂停该网页成员，再修改页面适配。');
    this.options.save(id,browserSelectorsSchema.parse(selectors));this.options.notify();
  }
  private profilePath(id:WebProviderId):string {
    webProviderSchema.parse(id);
    const root=resolve(this.options.dataDir);
    for(const path of [root,join(root,'browser-profiles'),join(root,'browser-profiles',id)]) {
      if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw new BrowserConnectorError('浏览器配置目录不能是符号链接。',400);
      mkdirSync(path,{recursive:true,mode:0o700});
    }
    const target=realpathSync(join(root,'browser-profiles',id));
    const rel=relative(realpathSync(root),target);
    if(rel.startsWith('..')||resolve(root,rel)!==target)throw new BrowserConnectorError('浏览器配置目录超出本机数据目录。',400);
    return target;
  }
  private async session(id:WebProviderId):Promise<Session> {
    if(this.closing)throw new BrowserConnectorError('浏览器连接器正在关闭。');
    const existing=this.sessions.get(id);if(existing)return existing;
    const pending=this.opening.get(id);if(pending)return pending;
    const opening=(async()=>{
      let context:BrowserContext;
      try {
        const profile=this.profilePath(id);
        const channel=process.env.CHAT_TEA_BROWSER_CHANNEL??(process.platform==='win32'?'msedge':'chrome');
        if(!['msedge','chrome','chromium'].includes(channel))throw new Error('invalid channel');
        context=await (this.options.launch?.(profile)??chromium.launchPersistentContext(profile,{
          channel,headless:false,chromiumSandbox:true,viewport:null,acceptDownloads:false,
          serviceWorkers:'block',permissions:[],timeout:20000,
        }));
      }catch {throw new BrowserConnectorError('专用浏览器未能启动。请安装 Microsoft Edge，或按说明配置 Chrome / Chromium；确认没有另一份茶馆占用此配置目录。',503);}
      if(this.closing){await context.close();throw new BrowserConnectorError('浏览器连接器已关闭。');}
      context.setDefaultTimeout(5000);context.setDefaultNavigationTimeout(20000);
      try {
        await context.route('**/*',route=>safeBrowserRequest(route.request().url())?route.continue():route.abort('blockedbyclient'));
        await context.routeWebSocket('**/*',ws=>{const u=ws.url().replace(/^wss:/,'https:');if(safeBrowserRequest(u))ws.connectToServer();else ws.close();});
      }catch {await context.close();throw new BrowserConnectorError('无法建立浏览器网络保护，已停止连接。',503);}
      const protect=(page:Page)=>{
        page.on('dialog',dialog=>{void dialog.dismiss().catch(()=>{});});
        page.on('download',download=>{void download.cancel().catch(()=>{});});
      };
      context.pages().forEach(protect);context.on('page',protect);
      const session:Session={context,busy:false};this.sessions.set(id,session);
      context.on('close',()=>{if(this.sessions.get(id)===session)this.sessions.delete(id);this.options.notify();});
      this.options.notify();return session;
    })();
    this.opening.set(id,opening);this.options.notify();
    try{return await opening;}finally{this.opening.delete(id);this.options.notify();}
  }
  async open(id:WebProviderId):Promise<{message:string}> {
    const session=await this.session(id);
    if(session.lastPage&&!session.lastPage.isClosed()){await session.lastPage.bringToFront();return {message:'已显示专用浏览器。请自行登录或处理页面提示。'};}
    const page=session.context.pages().find(p=>providerOrigin(id,p.url()))??await session.context.newPage();
    session.lastPage=page;
    try {if(!providerOrigin(id,page.url()))await page.goto(WEB_CHAT_URLS[id]!,{waitUntil:'domcontentloaded'});await page.bringToFront();}
    catch {throw new BrowserConnectorError('官网暂时未能打开，请检查专用浏览器中的网络状态。');}
    return {message:'已打开专用浏览器，请自行登录。此操作不会发送讨论内容。'};
  }
  async probe(id:WebProviderId):Promise<{message:string;ready:boolean}> {
    const page=this.sessions.get(id)?.lastPage;
    if(!page||page.isClosed())return {ready:false,message:'请先打开专用浏览器并登录。'};
    if(!providerOrigin(id,page.url()))return {ready:false,message:'当前位于登录或其他页面，请完成登录并回到对应聊天首页。'};
    try {
      const selectors=this.selectors(id);await validateSelectors(page,selectors);
      const input=await uniqueVisible(page,selectors.composer);
      return {ready:!!input,message:input?'已找到唯一输入框。仅验证页面结构，不代表额度可用或真实回答已通过测试。':'未找到唯一输入框。请处理登录/验证，或在高级页面适配中更新选择器。'};
    }catch{return {ready:false,message:'页面选择器无效或页面已变化，请检查高级页面适配。'};}
  }
  async close(id:WebProviderId) {
    const session=this.sessions.get(id);
    if(this.opening.has(id)||session?.busy)throw new BrowserConnectorError('请先暂停正在进行的浏览器操作，再关闭窗口。');
    if(session){this.sessions.delete(id);await session.context.close().catch(()=>{});this.options.notify();}
  }
  async shutdown() {this.closing=true;await Promise.allSettled(this.opening.values());await Promise.allSettled([...this.sessions.values()].map(s=>s.context.close()));this.sessions.clear();}

  async generate(request:BrowserTurnRequest):Promise<BrowserTurnResult> {
    const {providerId,signal,progress}=request;
    signal.throwIfAborted();progress({phase:'opening',message:'正在准备独立网页会话…',sent:false});
    const session=await this.session(providerId);signal.throwIfAborted();
    if(session.busy)throw new BrowserConnectorError('这个网站已有成员正在发言。当前轮次已暂停，可在另一场完成后继续。');
    if(session.context.pages().length>=8)throw new BrowserConnectorError('专用浏览器保留的页面较多，请关闭已处理页面后继续。');
    session.busy=true;this.options.notify();let page:Page|undefined;let success=false;
    const abort=()=>{if(page)void page.close().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
    try {
      page=await session.context.newPage();session.lastPage=page;signal.throwIfAborted();
      await page.goto(WEB_CHAT_URLS[providerId]!,{waitUntil:'domcontentloaded'});
      const selectors=this.selectors(providerId);
      const result=await runBrowserTurn(page,selectors,request,{timeoutMs:this.options.timeoutMs??180000,pollMs:this.options.pollMs??500,stableMs:this.options.stableMs??2500});
      success=true;return result;
    }catch(error){
      if(signal.aborted)throw new BrowserConnectorError('浏览器操作已暂停。网页端已经发送的请求可能仍在生成。');
      if(error instanceof BrowserConnectorError)throw error;
      throw new BrowserConnectorError('网页操作未完成，已暂停且没有自动重发。请在专用窗口处理登录、验证或页面变化后重试。');
    }finally{
      signal.removeEventListener('abort',abort);session.busy=false;
      if((success||signal.aborted)&&page)await page.close().catch(()=>{});
      this.options.notify();
    }
  }
}

async function validateSelectors(page:Page,selectors:BrowserSelectors) {
  await page.evaluate(values=>{for(const value of Object.values(values))if(value)document.querySelectorAll(value);},selectors);
}
async function uniqueVisible(page:Page,selector:string):Promise<Locator|undefined> {
  const all=page.locator(selector);const count=await all.count();if(count>50)return;
  const visible:Locator[]=[];for(let i=0;i<count;i++)if(await all.nth(i).isVisible())visible.push(all.nth(i));
  return visible.length===1?visible[0]:undefined;
}
export interface TurnTiming {timeoutMs:number;pollMs:number;stableMs:number;}

/** Only fixed DOM actions are executed. Returned text is never interpreted as browser instructions. */
export async function runBrowserTurn(page:Page,selectors:BrowserSelectors,request:BrowserTurnRequest,timing:TurnTiming):Promise<BrowserTurnResult> {
  const {providerId,signal,progress}=request;
  const guard=()=>{signal.throwIfAborted();if(!providerOrigin(providerId,page.url()))throw new BrowserConnectorError('当前不是对应官网的聊天页面，请完成登录或返回聊天首页。');};
  guard();await validateSelectors(page,selectors);
  // Give a client-rendered page a bounded opportunity to mount; never click login or consent controls.
  const readyDeadline=Date.now()+Math.min(12000,timing.timeoutMs);
  let composer:Locator|undefined;
  while(!composer&&Date.now()<readyDeadline){guard();composer=await uniqueVisible(page,selectors.composer);if(!composer)await sleep(timing.pollMs,undefined,{signal});}
  if(!composer||!await composer.isEditable())throw new BrowserConnectorError('未找到唯一可编辑输入框。请在专用窗口登录、处理验证或更新页面适配。');
  if(await page.locator(selectors.response).count())throw new BrowserConnectorError('新会话出现了已有回答，已暂停以避免混入其他聊天记录。请检查首页和回复选择器。');
  const doneBefore=await page.locator(selectors.done).count();
  guard();const prompt=request.prepare();
  progress({phase:'sending',message:'正在输入本轮公开讨论上下文…',sent:false});
  await composer.fill(prompt);guard();
  const send=await uniqueVisible(page,selectors.send);
  if(!send||!await send.isEnabled())throw new BrowserConnectorError('未找到唯一可用的发送按钮。内容可能已填入，但没有自动发送；请检查网页和页面适配。');
  // This is set BEFORE clicking: a click that times out may already have reached the website.
  progress({phase:'reading',message:'已尝试发送，正在等待网页完成回复…',sent:true});
  await send.click({timeout:5000,noWaitAfter:true});
  const deadline=Date.now()+timing.timeoutMs;let last='';let stableSince=0;
  while(Date.now()<deadline){
    guard();
    const snapshot=await page.evaluate(s=>{
      // Keep callbacks inline: tsx/esbuild names local functions with a helper unavailable in page scope.
      const responses=[...document.querySelectorAll(s.response)].filter(el=>!!(el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'));
      const busy=[...document.querySelectorAll(s.busy)].some(el=>!!(el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'));
      const done=[...document.querySelectorAll(s.done)].filter(el=>!!(el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden')).length;
      const latest=responses.at(-1) as HTMLElement|undefined;
      const reasoning=s.reasoning?([...document.querySelectorAll(s.reasoning)].filter(el=>!!(el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden')).at(-1) as HTMLElement|undefined)?.innerText??'':'';
      const content=latest?.innerText??'';
      const body=[...document.querySelectorAll('[role="alert"], [role="dialog"], #challenge-running')].map(el=>(el as HTMLElement).innerText).join('\n');
      const blocked=/(unusual activity|verify you are human|rate limit|too many requests|usage limit|limit reached|达到.{0,8}(上限|限制)|操作频繁|验证您是人类|请完成验证)/i.test(body);
      return {count:responses.length,content:content.slice(0,16001),reasoning:reasoning.slice(0,16001),busy,done,blocked};
    },selectors);
    if(snapshot.blocked)throw new BrowserConnectorError('网页显示验证或使用限制，已暂停且不会自动重发。请查看专用窗口。');
    if(snapshot.content.length>16000||snapshot.reasoning.length>16000)throw new BrowserConnectorError('网页回复超过当前单条消息长度限制，请检查页面适配后重试。');
    // Multiple matches could be separate paragraphs or thinking and answer; do not silently truncate.
    if(snapshot.count>1)throw new BrowserConnectorError('回复选择器匹配了多块内容，无法确定完整回答。请修正为完整回答容器后重试。');
    const text=snapshot.content.trim();const fingerprint=JSON.stringify([text,snapshot.reasoning]);
    if(fingerprint!==last||snapshot.busy){last=fingerprint;stableSince=Date.now();}
    const completionEvidence=snapshot.done>doneBefore;
    if(text&&!snapshot.busy&&completionEvidence&&Date.now()-stableSince>=timing.stableMs)return {content:text,reasoning:snapshot.reasoning.trim()};
    await sleep(timing.pollMs,undefined,{signal});
  }
  throw new BrowserConnectorError('等待回复超时，或未能确认回答已结束。已保留网页且不会自动重发，请检查网页状态后停止或重新发送。');
}
