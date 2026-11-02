import Fastify,{type FastifyReply,type FastifyRequest} from 'fastify';
import {request as httpRequest,type ClientRequest,type IncomingMessage} from 'node:http';
import {HostingAccounts,HostingAccountError,type HostedUser} from './accounts.js';
import {HostingSettingsStore} from './settings.js';
import type {HostingSettings} from '../../shared/hosting-settings.js';
export type {HostingUser} from './accounts.js';

export interface HostingGatewayOptions {
  origin:string;dataDir:string;
  getTenant:(user:HostedUser)=>Promise<{port:number}>;
  usage?:(user:HostedUser)=>unknown|Promise<unknown>;
  now?:()=>number;
  settings?:()=>HostingSettings;
  /** Tests can shorten revocation checks; never permit a delay above 30 seconds. */
  sessionCheckMs?:number;
}
const COOKIE='__Host-teahouse_session';
const LOGIN_WINDOW_MS=60000,LOGIN_LIMIT=30;
const securityHeaders={
  'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer',
  'Cross-Origin-Resource-Policy':'same-origin','Permissions-Policy':'camera=(), microphone=(), geolocation=(), payment=()',
  'Strict-Transport-Security':'max-age=31536000','Cache-Control':'no-store',
};
const loginHtml=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · 茶馆</title><style>body{font:16px system-ui;background:#f4f2ec;color:#26372d;margin:0;display:grid;min-height:100vh;place-items:center}main{margin:24px;width:min(360px,85vw);padding:32px;background:#fff;border-radius:20px}input,button{box-sizing:border-box;width:100%;padding:12px;border:1px solid #ccd3cb;border-radius:8px;font:inherit;margin-top:12px}button{background:#365d47;color:white;cursor:pointer}p{line-height:1.7;color:#56635a}#status{min-height:2em}</style><script src="/_host/login.js" defer></script></head><body><main><h1>茶馆</h1><p>这是邀请制茶馆。请输入管理员单独提供的访问码，请勿分享访问码。</p><form id="login"><label for="code">访问码</label><input id="code" type="password" autocomplete="current-password" maxlength="100" required><button>进入茶馆</button><p id="status" role="status"></p></form></main></body></html>`;
const loginJs=`const form=document.querySelector('#login'),field=document.querySelector('#code'),status=document.querySelector('#status'),button=form.querySelector('button');form.addEventListener('submit',async e=>{e.preventDefault();button.disabled=true;status.textContent='正在登录…';try{const response=await fetch('/_host/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:field.value.trim()}),credentials:'same-origin'});field.value='';if(response.ok){location.replace('/');return;}const result=await response.json();status.textContent=result.error||'登录失败，请稍后再试。';}catch{status.textContent='连接失败，请稍后再试。';}finally{button.disabled=false;}});`;

function cookie(request:FastifyRequest):string{
  const cookies=(request.headers.cookie??'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(COOKIE+'='));
  return cookies.length===1?cookies[0].slice(COOKIE.length+1):'';
}
function body(request:FastifyRequest):Record<string,unknown>{
  if(!Buffer.isBuffer(request.body)||request.body.length>4096)throw new Error('Invalid body');
  const value:unknown=JSON.parse(request.body.toString('utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid body');
  return value as Record<string,unknown>;
}
function safePath(raw:string):string|undefined{
  // Application routes and build asset names are ASCII. Reject ambiguous paths
  // rather than allowing a proxy/router to interpret a second decoded form.
  if(raw.length>4096||/[\u0000-\u0020\u007f\\#]/.test(raw))return;
  const path=raw.split('?')[0];
  if(!/^\/[a-zA-Z0-9/_.,-]*$/.test(path)||path.includes('//')||path.split('/').some(part=>part==='.'||part==='..'))return;
  return path;
}

export function buildHostingGateway(options:HostingGatewayOptions){
  const publicUrl=new URL(options.origin);
  if(publicUrl.protocol!=='https:'||publicUrl.origin!==options.origin||publicUrl.username||publicUrl.password)throw new Error('分享地址必须是完整 HTTPS Origin，不含路径、参数或凭据。');
  const checkMs=options.sessionCheckMs??10000;
  if(!Number.isInteger(checkMs)||checkMs<10||checkMs>30000)throw new Error('Invalid session check interval');
  const settings=options.settings??(()=>new HostingSettingsStore(options.dataDir).values());
  const accounts=new HostingAccounts(options.dataDir,options.now,settings),now=options.now??Date.now;
  const app=Fastify({logger:false,bodyLimit:5_600_000,requestTimeout:30000,connectionTimeout:10000,trustProxy:false});
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*',{parseAs:'buffer'},(_request,value,done)=>done(null,value));
  const upstreams=new Set<ClientRequest>(),streams=new Map<string,number>();
  const inflight=new Map<string,number>();let activeRequests=0;
  const windows=new Map<string,{at:number;reads:number;writes:number}>();
  // Only verified account IDs enter this map; its cap matches the active-account cap.
  const loginWindows=new Map<string,{at:number;count:number}>();
  let failedLoginWindow={at:now(),count:0},closed=false;
  const users=new WeakMap<FastifyRequest,HostedUser>();
  const error=(text:string)=>({error:text});
  const loginThrottled=(reply:FastifyReply,at:number)=>reply.header('Retry-After',String(Math.max(1,Math.ceil((at+LOGIN_WINDOW_MS-now())/1000)))).code(429).send(error('登录尝试过多，请一分钟后重试。'));
  const failedLogin=(reply:FastifyReply,status:400|401,message:string)=>{
    const time=now();if(time-failedLoginWindow.at>=LOGIN_WINDOW_MS)failedLoginWindow={at:time,count:0};
    // This bounds the failure-response budget, not verification work or network traffic.
    // Valid codes must still be checked during a flood, so this is not DDoS protection.
    if(failedLoginWindow.count>=LOGIN_LIMIT)return loginThrottled(reply,failedLoginWindow.at);
    failedLoginWindow.count++;return reply.code(status).send(error(message));
  };
  app.setErrorHandler((err,_request,reply)=>{const status=typeof err==='object'&&err!==null&&'statusCode'in err?Number(err.statusCode):500;return reply.code(status===413?413:status===400?400:500).send(error(status===413?'请求内容过大。':'请求未完成，请稍后重试。'));});
  app.addHook('onRequest',async(request,reply)=>{
    for(const [name,value] of Object.entries(securityHeaders)){reply.header(name,value);reply.raw.setHeader(name,value);}
    if(request.headers.host!==publicUrl.host)return reply.code(403).send(error('访问地址不正确。'));
    const path=safePath(request.raw.url??'');
    if(!path)return reply.code(400).send(error('请求路径无效。'));
    const mutation=!['GET','HEAD'].includes(request.method),origin=request.headers.origin;
    if((origin!==undefined&&origin!==options.origin)||(mutation&&origin!==options.origin)||request.headers['sec-fetch-site']==='cross-site'&&(mutation||path.startsWith('/api/')||path.startsWith('/_host/')))return reply.code(403).send(error('拒绝跨来源请求。'));
    if(path==='/_host/login'&&request.method==='POST')return;
    if(path==='/_host/login.js'&&request.method==='GET')return;
    const user=accounts.session(cookie(request));
    if(!user){
      if(['GET','HEAD'].includes(request.method)&&!path.startsWith('/api/')&&path!=='/api'&&!path.startsWith('/_host/'))return reply.type('text/html; charset=utf-8').send(loginHtml);
      return reply.code(401).send(error('请使用邀请访问码登录。'));
    }
    users.set(request,user);
    let window=windows.get(user.id);
    if(!window||now()-window.at>=60000){window={at:now(),reads:0,writes:0};windows.set(user.id,window);}
    if(windows.size>20)for(const [id,value] of windows)if(now()-value.at>=60000)windows.delete(id);
    if((mutation?++window.writes>120:++window.reads>360))return reply.header('Retry-After','60').code(429).send(error('操作过于频繁，请稍后再试。'));
    // Admit before parsing upload bodies or awaiting a tenant's cold start.
    // SSE has a separate small allowance, so login/logout remain available.
    if(path!=='/api/events'&&!path.startsWith('/_host/')){
      if((inflight.get(user.id)??0)>=8||activeRequests>=40)return reply.header('Retry-After','5').code(429).send(error('正在处理的请求过多，请稍后再试。'));
      inflight.set(user.id,(inflight.get(user.id)??0)+1);activeRequests++;
      let released=false;const release=()=>{if(released)return;released=true;activeRequests--;const count=(inflight.get(user.id)??1)-1;if(count)inflight.set(user.id,count);else inflight.delete(user.id);};
      reply.raw.once('finish',release);reply.raw.once('close',release);request.raw.once('aborted',release);
    }
  });
  app.get('/_host/login.js',async(_request,reply)=>reply.type('text/javascript; charset=utf-8').send(loginJs));
  app.post('/_host/login',{bodyLimit:4096},async(request,reply)=>{
    let code:string;
    try{const input=body(request);if(Object.keys(input).length!==1||typeof input.code!=='string')throw new Error();code=input.code;}catch{return failedLogin(reply,400,'请输入有效访问码。');}
    const user=accounts.authenticateCode(code);
    if(!user)return failedLogin(reply,401,'访问码无效或已被撤销。');
    const time=now();
    for(const [id,window] of loginWindows)if(time-window.at>=LOGIN_WINDOW_MS)loginWindows.delete(id);
    let window=loginWindows.get(user.id);
    if(!window){
      // Repeated invite/revoke cycles cannot grow state or evict another active account.
      const maximum=Math.max(settings().maxAccounts,accounts.list().filter(account=>!account.revokedAt).length);
      if(loginWindows.size>=maximum)for(const id of loginWindows.keys())if(!accounts.get(id))loginWindows.delete(id);
      if(loginWindows.size>=maximum)return loginThrottled(reply,time);
      window={at:time,count:0};loginWindows.set(user.id,window);
    }
    if(window.count>=LOGIN_LIMIT)return loginThrottled(reply,window.at);
    // Count verified-code admissions before session mutations, including session-cap failures.
    window.count++;
    try{
      // Replace this browser's previous session rather than leaking session slots.
      accounts.deleteSession(cookie(request));
      const session=accounts.createSession(user.id);
      reply.header('Set-Cookie',`${COOKIE}=${session.token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`);
      return {ok:true};
    }catch(e){return reply.code(e instanceof HostingAccountError?429:500).send(error(e instanceof HostingAccountError?'登录会话已达上限，请退出其他设备或联系管理员。':'暂时无法登录。'));}
  });
  app.get('/_host/session',async request=>{const user=users.get(request)!;return {user:{id:user.id,name:user.name},...(options.usage?{usage:await options.usage(user)}:{})};});
  app.post('/_host/logout',{bodyLimit:4096},async(request,reply)=>{
    accounts.deleteSession(cookie(request));reply.header('Set-Cookie',`${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);return {ok:true};
  });
  app.route({method:['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'],url:'/*',handler:async(request,reply)=>{
    const path=safePath(request.raw.url??'')!;
    if(path.startsWith('/_host/'))return reply.code(404).send(error('接口不存在。'));
    const user=users.get(request)!;
    const isStream=path==='/api/events';
    const maxStreams=settings().maxSsePerUser;
    if(isStream&&(streams.get(user.id)??0)>=maxStreams)return reply.header('Retry-After','30').code(429).send(error(`此账号最多同时打开 ${maxStreams} 个实时页面。`));
    // Reserve before awaiting tenant startup: concurrent requests cannot race the cap.
    if(isStream)streams.set(user.id,(streams.get(user.id)??0)+1);
    let counted=isStream;
    const uncount=()=>{if(counted){counted=false;const count=(streams.get(user.id)??1)-1;if(count)streams.set(user.id,count);else streams.delete(user.id);}};
    let tenant:{port:number};
    try{tenant=await options.getTenant(user);}catch{uncount();return reply.code(503).send(error('个人茶馆暂时无法启动，请联系管理员。'));}
    if(closed||!Number.isInteger(tenant.port)||tenant.port<1024||tenant.port>65535){uncount();return reply.code(503).send(error('个人茶馆暂不可用。'));}
    // Revocation can happen while getTenant awaits a cold start.
    if(!accounts.session(cookie(request))){uncount();return reply.code(401).send(error('登录已失效。'));}
    const headers:Record<string,string>={host:`127.0.0.1:${tenant.port}`,origin:`http://127.0.0.1:${tenant.port}`,'accept-encoding':'identity'};
    for(const name of ['content-type','accept','x-csrf-token']){const value=request.headers[name];if(typeof value==='string')headers[name]=value;}
    if(Buffer.isBuffer(request.body))headers['content-length']=String(request.body.length);
    if(isStream)request.raw.socket.setTimeout(0);
    await new Promise<void>(resolve=>{
      let response:IncomingMessage|undefined,finished=false;
      const upstream=httpRequest({hostname:'127.0.0.1',port:tenant.port,path:request.raw.url,method:request.method,headers,agent:false});
      upstreams.add(upstream);
      const finish=()=>{if(finished)return;finished=true;clearInterval(timer);upstreams.delete(upstream);uncount();response?.destroy();upstream.destroy();resolve();};
      const fail=()=>{if(finished)return;if(reply.raw.headersSent)reply.raw.destroy();else if(!reply.sent)reply.code(502).send(error('个人茶馆连接暂时中断。'));finish();};
      const timer=setInterval(()=>{if(closed||!accounts.session(cookie(request))){reply.raw.destroy();finish();}},checkMs);timer.unref();
      reply.raw.once('close',finish);reply.raw.once('error',finish);
      upstream.setTimeout(isStream?30000:180000,fail);
      upstream.once('error',fail);
      upstream.once('response',incoming=>{
        response=incoming;
        const status=incoming.statusCode??502;
        if(status>=300&&status<400){fail();return;}
        const type=incoming.headers['content-type'];
        if(typeof type==='string')reply.raw.setHeader('Content-Type',type);
        if(isStream)reply.raw.setHeader('X-Accel-Buffering','no');
        const retry=incoming.headers['retry-after'];if(typeof retry==='string'&&/^\d{1,5}$/.test(retry))reply.raw.setHeader('Retry-After',retry);
        reply.hijack();reply.raw.statusCode=status;
        incoming.once('error',fail);incoming.once('aborted',fail);
        reply.raw.once('finish',finish);incoming.pipe(reply.raw);
      });
      if(Buffer.isBuffer(request.body))upstream.write(request.body);
      upstream.end();
    });
  }});
  app.addHook('preClose',async()=>{closed=true;for(const request of upstreams)request.destroy();upstreams.clear();});
  app.addHook('onClose',async()=>accounts.close());
  return {app,accounts};
}
