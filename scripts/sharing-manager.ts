import {spawn} from 'node:child_process';
import {existsSync,lstatSync,readFileSync} from 'node:fs';
import {dirname,isAbsolute,join,parse,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {HostingAccounts,HostingAccountError,type HostedUser} from '../server/hosting/accounts.js';
import {HostingSettingsStore,HostingSettingsError} from '../server/hosting/settings.js';
import {hostingSettingsSchema,type HostingSettings,type HostingSettingsSnapshot,type HostingSettingField} from '../shared/hosting-settings.js';

/** Native, local-only JSON adapter. It deliberately creates no HTTP management endpoint. */
export const MANAGER_ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const ACTIONS=['status','start','stop','share-start','share-stop','invite','revoke','settings-save','account-code','account-code-import','account-code-reset'] as const;
type Action=typeof ACTIONS[number];
type State={state:string;message:string};
type Limits=Record<string,number>;
type Config={publicOrigin:string;dataDir:string;adminPort:number;gatewayPort:number;limits:Limits};
export interface CommandResult {code:number;stdout:string;stderr:string;}
export interface CommandOptions {cwd:string;env?:NodeJS.ProcessEnv;timeoutMs:number;}
export interface ManagerDeps {
  root:string;
  powershell:string;
  tailscale:string;
  run:(file:string,args:string[],options:CommandOptions)=>Promise<CommandResult>;
  hasTailscale:()=>boolean;
}
export interface ManagerResult {
  ok:boolean;action:string;message:string;
  configured?:boolean;app?:State;funnel?:State;publicOrigin?:string|null;adminUrl?:string|null;
  accounts?:ManagerAccount[];accountCounts?:{active:number;revoked:number};accountsError?:string|null;limits?:Limits|null;
  user?:HostedUser;code?:string;codeAvailable?:boolean;
  settings?:HostingSettingsSnapshot;settingsSchema?:HostingSettingField[];
  usage?:ManagerUsage;
}
export interface ManagerUsage {dailyCny:number;dailyCalls:number;monthlyCny:number;pending:number;uncertain:number;day:string;timeZone:'UTC';}
export interface ManagerAccount extends HostedUser {codeAvailable?:boolean;usage?:ManagerUsage;}
class ManagerError extends Error {}
const MAX_INPUT=4096,MAX_OUTPUT=1024*1024;
const limitNames=['dailyCny','userDailyCny','monthlyCny','exchangeRate','dailyCalls','userDailyCalls','concurrency','userConcurrency','maxOutputTokens'];
const integerLimits=new Set(['dailyCalls','userDailyCalls','concurrency','userConcurrency','maxOutputTokens']);
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const contains=(parent:string,child:string)=>{const part=relative(parent,child);return part===''||(!part.startsWith('..')&&!isAbsolute(part));};

/** Use exit, not close: a detached Windows service can retain inherited pipe handles. */
export async function runCommand(file:string,args:string[],options:CommandOptions):Promise<CommandResult>{
  return await new Promise((done,reject)=>{
    const child=spawn(file,args,{cwd:options.cwd,env:{...process.env,...options.env},windowsHide:true,stdio:['ignore','pipe','pipe'],shell:false});
    let stdout='',stderr='',finished=false;
    const close=()=>{child.stdout.destroy();child.stderr.destroy();};
    const finish=(error:Error|null,code=1)=>{if(finished)return;finished=true;clearTimeout(timer);close();if(error)reject(error);else done({code,stdout,stderr});};
    const timer=setTimeout(()=>{child.kill();finish(new ManagerError('操作超时。请刷新状态后再试，避免重复操作。'));},options.timeoutMs);
    for(const [stream,type] of [[child.stdout,'out'],[child.stderr,'err']] as const)stream.setEncoding('utf8').on('data',(text:string)=>{
      if(type==='out')stdout+=text;else stderr+=text;
      if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)>MAX_OUTPUT){child.kill();finish(new ManagerError('管理命令返回异常，已停止读取。'));}
    });
    child.once('error',()=>finish(new ManagerError('无法启动管理命令。请检查 Node.js、PowerShell 和 Tailscale 是否安装。')));
    child.once('exit',code=>setImmediate(()=>finish(null,code??1)));
  });
}
export function defaultDeps(root=MANAGER_ROOT):ManagerDeps{
  const tailscale=join(process.env.ProgramFiles||'C:\\Program Files','Tailscale','tailscale.exe');
  return {root,powershell:join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),tailscale,run:runCommand,hasTailscale:()=>existsSync(tailscale)};
}
function rejectLinks(path:string){
  for(let cursor=path;;cursor=dirname(cursor)){
    if(existsSync(cursor)&&lstatSync(cursor).isSymbolicLink())throw new ManagerError('分享配置或数据路径不能使用符号链接、目录联接。');
    if(cursor===dirname(cursor))break;
  }
}
function readJson(path:string,max=65536):unknown{
  rejectLinks(path);
  if(!existsSync(path)||!lstatSync(path).isFile()||lstatSync(path).size>max)throw new ManagerError('分享配置缺失或格式不正确，请查看部署说明。');
  try{return JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));}catch{throw new ManagerError('分享配置格式不正确，请查看部署说明。');}
}
export function loadManagerConfig(root:string):Config|undefined{
  const path=join(root,'data-hosted','hosting-launch.json');rejectLinks(path);
  if(!existsSync(path))return;
  const data=readJson(path);
  if(!plain(data)||typeof data.publicOrigin!=='string'||typeof data.dataDir!=='string'||!plain(data.limits))throw new ManagerError('分享配置格式不正确，请查看部署说明。');
  let url:URL;try{url=new URL(data.publicOrigin);}catch{throw new ManagerError('分享网址格式不正确。');}
  if(url.protocol!=='https:'||url.origin!==data.publicOrigin||url.username||url.password||url.port||!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ts\.net$/.test(url.hostname))throw new ManagerError('面板只管理已配置的 Tailscale HTTPS 网址，请检查部署配置。');
  if(data.adminPort!==4318||data.gatewayPort!==4319)throw new ManagerError('面板只管理本机 4318 后台和 4319 分享入口，不会修改其他端口。');
  const directory=data.dataDir,personal=resolve(process.env.CHAT_TEA_DATA_DIR||join(root,'data'));
  if(!isAbsolute(directory)||resolve(directory)!==directory||directory===parse(directory).root||contains(directory,root)||contains(directory,personal)||contains(personal,directory))throw new ManagerError('网站数据目录必须与私人聊天完全分离。');
  rejectLinks(directory);
  if(!existsSync(directory)||!lstatSync(directory).isDirectory()||existsSync(join(directory,'teahouse.sqlite')))throw new ManagerError('网站专用数据目录不可用。');
  const marker=join(directory,'hosting-mode.json');rejectLinks(marker);
  if(!existsSync(marker)||lstatSync(marker).size>100||readFileSync(marker,'utf8')!=='{"format":"chat-teahouse-hosting-v1"}\n')throw new ManagerError('缺少有效的网站专用数据标识，请先完成部署。');
  const limits:Limits={};
  for(const name of limitNames){const value=data.limits[name];if(typeof value!=='number'||!Number.isFinite(value)||value<=0||value>10000000||(integerLimits.has(name)&&!Number.isInteger(value)))throw new ManagerError('分享额度配置无效，请检查部署设置。');limits[name]=value;}
  return {publicOrigin:data.publicOrigin,dataDir:directory,adminPort:4318,gatewayPort:4319,limits};
}
function accountFile(config:Config):string{
  const file=join(config.dataDir,'accounts.db');
  for(const path of [file,file+'-wal',file+'-shm',file+'-journal'])rejectLinks(path);
  if(!existsSync(file)||!lstatSync(file).isFile())throw new ManagerError('邀请账号库尚未初始化，请先启动分享网站。');
  return file;
}
function listAccounts(config:Config){
  const file=accountFile(config),db=new DatabaseSync(file,{readOnly:true});
  try{
    const counts=db.prepare('SELECT sum(revoked_at IS NULL) AS active,sum(revoked_at IS NOT NULL) AS revoked FROM hosted_users').get()!;
    const codeField=db.prepare('PRAGMA table_info(hosted_users)').all().some(row=>row.name==='code_encrypted')?'code_encrypted IS NOT NULL':'0';
    const rows=db.prepare(`SELECT id,name,created_at,revoked_at,${codeField} AS recoverable FROM hosted_users WHERE revoked_at IS NULL ORDER BY created_at,id LIMIT 1000`).all();
    rows.push(...db.prepare(`SELECT id,name,created_at,revoked_at,${codeField} AS recoverable FROM hosted_users WHERE revoked_at IS NOT NULL ORDER BY revoked_at DESC,id LIMIT 20`).all());
    const accounts:ManagerAccount[]=rows.map(row=>{
      const id=String(row.id),path=join(config.dataDir,'invitation-codes',id,'secrets.enc.json');rejectLinks(path);
      return {id,name:String(row.name),createdAt:new Date(Number(row.created_at)).toISOString(),codeAvailable:row.revoked_at===null&&(!!row.recoverable||existsSync(path)),...(row.revoked_at===null?{}:{revokedAt:new Date(Number(row.revoked_at)).toISOString()})};
    });
    return {accounts,accountCounts:{active:Number(counts.active||0),revoked:Number(counts.revoked||0)}};
  }finally{db.close();}
}
/** Read-only: unlike HostingBudget construction, this never reconciles pending reservations. */
function readUsage(config:Config,accounts:ManagerAccount[]):ManagerUsage|undefined{
  const path=join(config.dataDir,'hosting-budget.sqlite');rejectLinks(path);
  const day=new Date().toISOString().slice(0,10),month=day.slice(0,7);
  const empty=():ManagerUsage=>({dailyCny:0,dailyCalls:0,monthlyCny:0,pending:0,uncertain:0,day,timeZone:'UTC'});
  if(!existsSync(path)){for(const account of accounts)account.usage=empty();return empty();}
  for(const suffix of ['-wal','-shm','-journal'])rejectLinks(path+suffix);
  const db=new DatabaseSync(path,{readOnly:true});
  try{
    const get=(id?:string):ManagerUsage=>{
      const filter=id?' AND user_id=?':'',params=id?[day,id]:[day];
      const today=db.prepare(`SELECT COALESCE(SUM(cost),0) AS cost,COUNT(*) AS calls,SUM(state='reserved') AS pending,SUM(state='uncertain') AS uncertain FROM host_calls WHERE day=?${filter}`).get(...params)!;
      const total=db.prepare(`SELECT COALESCE(SUM(cost),0) AS cost FROM host_calls WHERE month=?${filter}`).get(...(id?[month,id]:[month]))!;
      return {dailyCny:Number(today.cost)/1e6,dailyCalls:Number(today.calls),monthlyCny:Number(total.cost)/1e6,pending:Number(today.pending??0),uncertain:Number(today.uncertain??0),day,timeZone:'UTC'};
    };
    for(const account of accounts)account.usage=get(account.id);return get();
  }finally{db.close();}
}
// Variables are passed in the child environment, never interpolated into shell text.
const LAUNCH_COMMAND=`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); $OutputEncoding=[Console]::OutputEncoding; & $env:CHAT_TEA_MANAGER_SCRIPT -Action $env:CHAT_TEA_MANAGER_ACTION -SkipBuild; exit $LASTEXITCODE`;
async function launcher(deps:ManagerDeps,action:'Status'|'Start'|'Stop'){
  const script=join(deps.root,'scripts','start-hosted.ps1');rejectLinks(script);
  if(!existsSync(script))throw new ManagerError('缺少网站启动程序，请恢复项目文件。');
  return await deps.run(deps.powershell,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',LAUNCH_COMMAND],{cwd:deps.root,timeoutMs:action==='Start'?65000:45000,env:{CHAT_TEA_MANAGER_SCRIPT:script,CHAT_TEA_MANAGER_ACTION:action}});
}
async function appState(deps:ManagerDeps):Promise<State>{
  const result=await launcher(deps,'Status');
  if(result.code===0&&/^Running: /m.test(result.stdout))return {state:'running',message:'网站正在本机后台运行。'};
  if(result.code===1&&result.stdout.trim()==='Hosted service is stopped.')return {state:'stopped',message:'网站已停止，点击“启动网站”即可恢复。'};
  return {state:'error',message:'网站状态异常。请查看本机服务日志；面板不会停止不明进程。'};
}
function safeParse(text:string):Record<string,unknown>|undefined{try{const value=JSON.parse(text);return plain(value)?value:undefined;}catch{return;}}
export function classifyFunnel(value:unknown,origin:string):'enabled'|'disabled'|'conflict'{
  if(!plain(value))return 'conflict';
  const host=new URL(origin).hostname+':443';
  if(Object.keys(value).some(key=>!['TCP','Web','AllowFunnel'].includes(key)&&value[key]!==null&&(!plain(value[key])||Object.keys(value[key]).length)))return 'conflict';
  const tcp=value.TCP??{},web=value.Web??{},allow=value.AllowFunnel??{};
  if(!plain(tcp)||!plain(web)||!plain(allow))return 'conflict';
  if(!Object.keys(tcp).length&&!Object.keys(web).length&&!Object.keys(allow).length)return 'disabled';
  if(Object.keys(tcp).length!==1||!plain(tcp['443'])||Object.keys(tcp['443']).length!==1||tcp['443'].HTTPS!==true)return 'conflict';
  if(Object.keys(web).length!==1||!plain(web[host])||Object.keys(web[host]).length!==1||!plain(web[host].Handlers))return 'conflict';
  const handlers=web[host].Handlers;
  if(Object.keys(handlers).length!==1||!plain(handlers['/'])||Object.keys(handlers['/']).length!==1||handlers['/'].Proxy!=='http://127.0.0.1:4319')return 'conflict';
  if(Object.keys(allow).some(key=>key!==host)||Object.values(allow).some(item=>typeof item!=='boolean'))return 'conflict';
  return allow[host]===true?'enabled':'disabled';
}
async function funnelState(deps:ManagerDeps,config:Config):Promise<State>{
  if(!deps.hasTailscale())return {state:'unavailable',message:'尚未安装 Tailscale，请先完成部署。'};
  const status=await deps.run(deps.tailscale,['status','--json'],{cwd:deps.root,timeoutMs:15000});
  const parsed=status.code===0?safeParse(status.stdout):undefined;
  if(!parsed||parsed.BackendState!=='Running')return {state:'unavailable',message:'Tailscale 尚未连接，请先在 Tailscale 中登录。'};
  if(!plain(parsed.Self)||typeof parsed.Self.DNSName!=='string'||parsed.Self.DNSName.replace(/\.$/,'')!==new URL(config.publicOrigin).hostname)return {state:'conflict',message:'当前 Tailscale 设备网址与保存配置不同，已保留现有设置。'};
  const current=await deps.run(deps.tailscale,['funnel','status','--json'],{cwd:deps.root,timeoutMs:15000});
  if(current.code!==0)return {state:'unavailable',message:'无法读取 Tailscale 分享状态，请检查 Tailscale 是否正常运行。'};
  const state=classifyFunnel(safeParse(current.stdout),config.publicOrigin);
  return {state,message:state==='enabled'?'公网分享已开启；外网访问仍需访问码。':state==='disabled'?'公网分享已关闭。':'检测到其他 Tailscale 转发设置，为避免覆盖，面板不会修改它。'};
}
function validateInput(action:string,input:unknown):Record<string,unknown>{
  if(!ACTIONS.includes(action as Action))throw new ManagerError('不支持此管理操作。');
  if(!plain(input))throw new ManagerError('管理请求格式不正确。');
  const fields=action==='invite'?['name']:action==='settings-save'?['version','values']:action==='account-code-import'?['id','code']:['revoke','account-code','account-code-reset'].includes(action)?['id']:[];
  if(Object.keys(input).length!==fields.length||fields.some(field=>!Object.hasOwn(input,field)))throw new ManagerError('管理请求包含不支持的字段。');
  if(action==='invite'&&(typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>60||/[\u0000-\u001f\u007f]/.test(input.name)))throw new ManagerError('朋友名字须为 1–60 字符，不能包含换行或控制字符。');
  if(fields.includes('id')&&(typeof input.id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.id)))throw new ManagerError('邀请账号 ID 格式不正确。');
  if(action==='account-code-import'&&(typeof input.code!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(input.code)))throw new ManagerError('请输入此账号当前有效的邀请码。');
  if(action==='settings-save'&&(!Number.isSafeInteger(input.version)||Number(input.version)<0||!plain(input.values)||hostingSettingsSchema.some(field=>!Object.hasOwn(input.values as object,field.key))))throw new ManagerError('设置版本或字段不完整，请刷新后再试。');
  return input;
}
export async function executeManager(action:string,input:unknown={},deps:ManagerDeps=defaultDeps()):Promise<ManagerResult>{
  try{
    const data=validateInput(action,input),config=loadManagerConfig(deps.root);
    if(!config){
      if(action==='status')return {ok:true,action,message:'还没有配置分享网站，请先按部署说明完成一次配置。',configured:false,app:{state:'unconfigured',message:'分享网站尚未配置。'},funnel:{state:'unavailable',message:'分享网站尚未配置。'},publicOrigin:null,adminUrl:null,accounts:[],accountCounts:{active:0,revoked:0},accountsError:null,limits:null};
      throw new ManagerError('还没有配置分享网站，请先按部署说明完成一次配置。');
    }
    const settings=new HostingSettingsStore(config.dataDir,config.limits);
    if(action==='settings-save'){
      const updated=settings.update(data.values,data.version as number);
      return {ok:true,action,message:'设置已保存，后续操作即时采用新上限。已有记录、用量和正在执行的请求均保留。',settings:updated,settingsSchema:hostingSettingsSchema};
    }
    if(action==='status'){
      const [app,funnel]=await Promise.all([
        appState(deps).catch(()=>({state:'error',message:'网站状态暂时无法读取，请稍后刷新。'})),
        funnelState(deps,config).catch(()=>({state:'unavailable',message:'Tailscale 状态暂时无法读取，请稍后刷新。'})),
      ]);
      let listing:{accounts:ManagerAccount[];accountCounts:{active:number;revoked:number}}={accounts:[],accountCounts:{active:0,revoked:0}},accountsError:string|null=null;
      try{listing=listAccounts(config);}catch{accountsError='邀请列表暂时无法读取。请先启动网站，或检查本机数据目录。';}
      let usage:ManagerUsage|undefined;try{usage=readUsage(config,listing.accounts);}catch{/* Metadata controls remain available if the usage ledger needs repair. */}
      const snapshot=settings.snapshot(),limits:Limits={};for(const name of limitNames)limits[name]=snapshot.values[name as keyof HostingSettings];
      return {ok:true,action,message:accountsError?'状态已刷新，但'+accountsError:'状态已刷新。',configured:true,app,funnel,publicOrigin:config.publicOrigin,adminUrl:`http://127.0.0.1:${config.adminPort}`,...listing,accountsError,limits,settings:snapshot,settingsSchema:hostingSettingsSchema,...(usage?{usage}:{})};
    }
    if(action==='start'||action==='stop'){
      const result=await launcher(deps,action==='start'?'Start':'Stop');
      if(result.code!==0)throw new ManagerError(action==='start'?'网站启动失败。请检查生产构建、端口和本机服务日志。':'网站没有安全停止。请检查状态；面板不会停止无法确认身份的进程。');
      return {ok:true,action,message:action==='start'?'网站已启动。若公网分享已开启，朋友现在可以登录。':'网站已停止，聊天与笔记已保留。'};
    }
    if(action==='share-start'||action==='share-stop'){
      if(action==='share-start'&&(await appState(deps)).state!=='running')throw new ManagerError('请先启动网站，确认运行正常后再开启公网分享。');
      const current=await funnelState(deps,config);
      if(current.state==='conflict'||current.state==='unavailable')throw new ManagerError(current.message);
      const expected=action==='share-start'?'enabled':'disabled';
      if(current.state===expected)return {ok:true,action,message:current.message};
      const args=action==='share-start'?['funnel','--bg','http://127.0.0.1:4319']:['funnel','--https=443','off'];
      const result=await deps.run(deps.tailscale,args,{cwd:deps.root,timeoutMs:20000});
      if(result.code!==0)throw new ManagerError('公网分享操作未完成。请检查 Tailscale 连接及账户 Funnel 授权；面板不会自动登录或修改防火墙。');
      const verified=await funnelState(deps,config);
      if(verified.state!==expected)throw new ManagerError('公网分享状态尚未确认，请刷新查看后再试。');
      return {ok:true,action,message:verified.message};
    }
    accountFile(config);
    const accounts=new HostingAccounts(config.dataDir,Date.now,()=>settings.values());
    try{
      if(action==='invite'){const {user,code}=accounts.add(data.name as string);return {ok:true,action,message:'邀请已创建并加密保存，以后选择此朋友仍可查看或复制邀请码。请私下交给本人。',user,code,codeAvailable:true};}
      if(action==='account-code'){
        const user=accounts.get(data.id as string);if(!user)throw new HostingAccountError('邀请账号不存在或已撤销。');
        const code=accounts.recoverCode(user.id);
        return {ok:true,action,user,codeAvailable:!!code,...(code?{code}:{}),message:code?'邀请码已在本机解密显示，请私下交给本人。':'此旧邀请只保存过校验摘要，无法还原；可以导入你保存的原邀请码，或重置一个新码。'};
      }
      if(action==='account-code-import'){
        accounts.importCode(data.id as string,data.code as string);
        return {ok:true,action,message:'原邀请码已验证并加密保存，原有登录与聊天记录均保留。',user:accounts.get(data.id as string),code:data.code as string,codeAvailable:true};
      }
      if(action==='account-code-reset'){
        const result=accounts.resetCode(data.id as string);
        return {ok:true,action,message:'已生成并保存新邀请码，旧码和旧登录会话失效，聊天记录仍保留。请把新码交给本人。',...result,codeAvailable:true};
      }
      if(!accounts.revoke(data.id as string))throw new ManagerError('邀请账号不存在。');
      return {ok:true,action,message:'邀请已撤销，登录会话失效，已打开的实时连接最多 30 秒内断开。聊天和笔记仍保留。'};
    }finally{accounts.close();}
  }catch(error){return {ok:false,action,message:error instanceof ManagerError||error instanceof HostingAccountError||error instanceof HostingSettingsError?error.message:'操作未完成。请检查本机分享配置、数据目录权限和服务日志。'};}
}
async function main(){
  const action=process.argv[2]??'';
  try{
    if(process.argv.length!==3)throw new ManagerError('管理命令参数不正确。');
    let text='';process.stdin.setEncoding('utf8');
    for await(const chunk of process.stdin){text+=String(chunk);if(Buffer.byteLength(text)>MAX_INPUT)throw new ManagerError('管理请求过长。');}
    let input:unknown;try{input=text.trim()?JSON.parse(text):{};}catch{throw new ManagerError('管理请求不是有效的 JSON。');}
    const result=await executeManager(action,input);process.stdout.write(JSON.stringify(result)+'\n');if(!result.ok)process.exitCode=1;
  }catch(error){process.stdout.write(JSON.stringify({ok:false,action,message:error instanceof ManagerError?error.message:'操作未完成，请刷新后重试。'})+'\n');process.exitCode=1;}
}
const canonical=(path:string)=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
if(process.argv[1]&&canonical(process.argv[1])===canonical(fileURLToPath(import.meta.url)))void main();
