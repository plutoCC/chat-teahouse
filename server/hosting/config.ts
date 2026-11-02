import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute, parse } from 'node:path';
import { defaultHostingLimits, type HostingLimits } from './budget.js';

/** Deliberately separate from CHAT_TEA_DATA_DIR: a personal database must never become the website. */
export function hostingDataDir(value=process.env.CHAT_TEA_HOST_DATA_DIR??'data-hosted'):string {
  const dir=resolve(value),personal=resolve(process.env.CHAT_TEA_DATA_DIR??'data');
  const contains=(parent:string,child:string)=>{const part=relative(parent,child);return part===''||(!part.startsWith('..')&&!isAbsolute(part));};
  if(dir===parse(dir).root||contains(dir,process.cwd())||contains(dir,personal)||contains(personal,dir))throw new Error('网站数据必须使用与本机 data 完全分离的专用目录。');
  for(let cursor=dir;cursor!==dirname(cursor);cursor=dirname(cursor))if(existsSync(cursor)&&lstatSync(cursor).isSymbolicLink())throw new Error('网站数据目录及父目录不能使用符号链接。');
  if(existsSync(resolve(dir,'teahouse.sqlite')))throw new Error('不能把已有个人工作区用作网站数据根目录。');
  mkdirSync(dir,{recursive:true,mode:0o700});
  const marker=resolve(dir,'hosting-mode.json');
  if(existsSync(marker)){if(readFileSync(marker,'utf8')!=='{"format":"chat-teahouse-hosting-v1"}\n')throw new Error('网站数据目录标识无效。');}
  else writeFileSync(marker,'{"format":"chat-teahouse-hosting-v1"}\n',{flag:'wx',mode:0o600});
  return realpathSync(dir);
}
export function hostingConfig(env:NodeJS.ProcessEnv=process.env) {
  const origin=env.CHAT_TEA_PUBLIC_ORIGIN??'';let url:URL;
  try{url=new URL(origin);}catch{throw new Error('请设置 CHAT_TEA_PUBLIC_ORIGIN 为专用网站的完整 HTTPS 来源，例如 https://tea.example.com。');}
  if(url.protocol!=='https:'||url.origin!==origin||url.username||url.password||['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('CHAT_TEA_PUBLIC_ORIGIN 必须是单个规范 HTTPS 来源，不带路径或尾部斜杠。');
  const port=Number(env.CHAT_TEA_HOST_PORT??4319),adminPort=Number(env.CHAT_TEA_ADMIN_PORT??4318);
  if(![port,adminPort].every(n=>Number.isInteger(n)&&n>=1024&&n<=65535)||port===adminPort)throw new Error('网站入口和本机管理端口必须不同，且在 1024–65535 之间。');
  const variables:Record<keyof HostingLimits,string>={dailyCny:'DAILY_CNY',userDailyCny:'USER_DAILY_CNY',monthlyCny:'MONTHLY_CNY',exchangeRate:'USD_CNY',dailyCalls:'DAILY_CALLS',userDailyCalls:'USER_DAILY_CALLS',concurrency:'CONCURRENCY',userConcurrency:'USER_CONCURRENCY',maxOutputTokens:'MAX_OUTPUT_TOKENS'};
  const limits={...defaultHostingLimits};
  for(const key of Object.keys(variables) as (keyof HostingLimits)[])if(env['CHAT_TEA_HOST_'+variables[key]]!==undefined)limits[key]=Number(env['CHAT_TEA_HOST_'+variables[key]]);
  return {origin,port,adminPort,limits};
}
