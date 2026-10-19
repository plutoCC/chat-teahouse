import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {mkdirSync,existsSync,readdirSync} from 'node:fs';
import {resolve,join,isAbsolute} from 'node:path';
import {ModelCallError} from '../model-errors.js';

export interface RpcTransport {request(method:string,params?:unknown):Promise<any>;onEvent(fn:(method:string,params:any)=>void):()=>void;close():Promise<void>;}
export function codexExecutable():string {
  const configured=process.env.CHAT_TEA_CODEX_PATH;if(configured){if(!isAbsolute(configured)||!existsSync(configured))throw new ModelCallError('CHAT_TEA_CODEX_PATH 必须是已安装 Codex 的绝对文件路径。');return configured;}
  if(process.platform==='win32'&&process.env.LOCALAPPDATA){const root=join(process.env.LOCALAPPDATA,'OpenAI','Codex','bin');if(existsSync(root)){const candidates=readdirSync(root).map(v=>join(root,v,'codex.exe')).filter(existsSync);if(candidates.length)return candidates.at(-1)!;}}
  return process.platform==='win32'?'codex.exe':'codex';
}
/** Dedicated credentials and stdio: never attach to the user's desktop session or accept model commands. */
export class CodexRpc implements RpcTransport {
  private child?:ChildProcessWithoutNullStreams;private ready?:Promise<void>;private sequence=0;private buffer='';
  private pending=new Map<number,{resolve:(value:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private listeners=new Set<(method:string,params:any)=>void>();private stopped=false;
  constructor(private home:string,private workspace:string){}
  private start(){return this.ready??=this.launch();}
  private async launch(){
    if(this.stopped)throw new ModelCallError('订阅连接已关闭，请重新打开。');
    mkdirSync(this.home,{recursive:true,mode:0o700});mkdirSync(this.workspace,{recursive:true,mode:0o700});
    const env={...process.env,CODEX_HOME:resolve(this.home)};
    for(const key of Object.keys(env))if(/^(?:OPENAI_API_KEY|OPENAI_BASE_URL|CODEX_API_KEY|CODEX_ACCESS_TOKEN|CODEX_MANAGED|CODEX_THREAD|CODEX_INTERNAL|CODEX_WIF)/.test(key))delete (env as Record<string,string|undefined>)[key];
    const config=['web_search="disabled"','approval_policy="never"','sandbox_mode="read-only"','cli_auth_credentials_store="keyring"','project_doc_max_bytes=0','apps._default.enabled=false','features.shell_tool=false','features.unified_exec=false','features.apply_patch_freeform=false','features.js_repl=false','features.multi_agent=false','features.apps=false','features.memories=false'];
    const child=this.child=spawn(codexExecutable(),['app-server','--listen','stdio://',...config.flatMap(c=>['-c',c])],{cwd:this.workspace,env,windowsHide:true,stdio:['pipe','pipe','pipe'],shell:false});
    child.stdin.on('error',()=>this.fail());child.stderr.on('data',()=>{}); // Never persist upstream stderr or credentials.
    child.stdout.setEncoding('utf8');child.stdout.on('data',(chunk:string)=>{
      this.buffer+=chunk;if(this.buffer.length>4*1024*1024){this.fail();child.kill();return;}
      for(let end;(end=this.buffer.indexOf('\n'))>=0;){const line=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+1);if(!line.trim())continue;
        let message:any;try{message=JSON.parse(line);}catch{this.fail();child.kill();return;}
        if(message.method&&message.id!==undefined){this.send({id:message.id,error:{code:-32601,message:'This chat client does not allow external tools or approvals.'}});continue;}
        if(message.method){for(const fn of this.listeners){try{fn(message.method,message.params);}catch{/* Consumer rejects its own turn. */}}}
        else {const item=this.pending.get(message.id);if(!item)continue;this.pending.delete(message.id);clearTimeout(item.timer);if(message.error)item.reject(new ModelCallError('Codex 官方接口未完成操作，请检查登录、模型权限或更新本机 Codex。'));else item.resolve(message.result);}
      }
    });
    child.once('error',()=>this.fail());child.once('exit',()=>{this.fail();this.ready=undefined;this.child=undefined;});
    await this.raw('initialize',{clientInfo:{name:'chat_teahouse',title:'Chat 茶馆',version:'0.3.0'},capabilities:{experimentalApi:true}});this.send({method:'initialized'});
  }
  private send(message:unknown){if(!this.child?.stdin.writable)throw new ModelCallError('Codex 进程不可用，请确认已安装官方 Codex CLI。');this.child.stdin.write(JSON.stringify(message)+'\n');}
  private raw(method:string,params:unknown={}){return new Promise<any>((resolve,reject)=>{const id=++this.sequence;const timer=setTimeout(()=>{this.pending.delete(id);reject(new ModelCallError('Codex 操作超时，请检查本机进程与登录状态。'));},20000);timer.unref();this.pending.set(id,{resolve,reject,timer});try{this.send({id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}});}
  private fail(){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new ModelCallError('无法连接官方 Codex，请检查安装路径或重新登录。'));}this.pending.clear();for(const fn of this.listeners){try{fn('teahouse/disconnected',{});}catch{}}}
  async request(method:string,params:unknown={}){await this.start();return this.raw(method,params);}
  onEvent(fn:(method:string,params:any)=>void){this.listeners.add(fn);return()=>{this.listeners.delete(fn);};}
  async close(){this.stopped=true;this.fail();this.listeners.clear();const child=this.child;if(!child)return;await new Promise<void>(resolve=>{const timer=setTimeout(resolve,2000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill();});}
}
