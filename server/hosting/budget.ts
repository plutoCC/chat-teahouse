import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ModelCallError, ModelResponseError, ProviderRequestError } from '../model-errors.js';
import {defaultHostingSettings,type HostingSettings} from '../../shared/hosting-settings.js';

export interface HostingLimits {
  dailyCny: number; userDailyCny: number; monthlyCny: number; exchangeRate: number;
  dailyCalls: number; userDailyCalls: number; concurrency: number; userConcurrency: number;
  maxOutputTokens: number;
}
export const defaultHostingLimits: HostingLimits = {
  dailyCny: 20, userDailyCny: 5, monthlyCny: 300, exchangeRate: 7,
  dailyCalls: 200, userDailyCalls: 50, concurrency: 4, userConcurrency: 2, maxOutputTokens: 16384,
};
interface Usage { inputTokens: number; outputTokens: number; usageEstimated?: boolean; }
interface Reservation { id:string; user_id:string; day:string; month:string; cost:number; input_price:number; output_price:number; state:string;exchange_rate:number|null; }
// Integer millionths of CNY; round upwards when reserving rather than losing fractions.
const money = (input:number,output:number,inputPrice:number,outputPrice:number,rate:number) => Math.ceil((input*inputPrice+output*outputPrice)*rate);
const validUsage = (u:Usage) => [u.inputTokens,u.outputTokens].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=1e9);

/** Shared by every hosted workspace. No guest route can reset or modify this ledger. */
export class HostingBudget {
  private db: DatabaseSync;
  get limits():HostingLimits{return this.liveSettings?.()??this.initialLimits;}
  constructor(dataDir:string,private readonly initialLimits:HostingLimits=defaultHostingLimits,private now=()=>Date.now(),private readonly liveSettings?:()=>HostingSettings) {
    const limits=this.limits;
    for(const [key,value] of Object.entries(limits))if(!Number.isFinite(value)||value<=0||value>1e7)throw new Error(`Invalid hosting limit: ${key}`);
    for(const key of ['dailyCalls','userDailyCalls','concurrency','userConcurrency','maxOutputTokens'] as const)if(!Number.isInteger(limits[key]))throw new Error(`Invalid hosting limit: ${key}`);
    mkdirSync(dataDir,{recursive:true,mode:0o700});this.db=new DatabaseSync(join(dataDir,'hosting-budget.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS host_calls(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,day TEXT NOT NULL,month TEXT NOT NULL,cost INTEGER NOT NULL,input_price REAL NOT NULL,output_price REAL NOT NULL,state TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS host_calls_day ON host_calls(day,user_id);
      CREATE INDEX IF NOT EXISTS host_calls_month ON host_calls(month);`);
    if(!this.db.prepare('PRAGMA table_info(host_calls)').all().some(row=>row.name==='exchange_rate'))this.db.exec('ALTER TABLE host_calls ADD COLUMN exchange_rate REAL');
    // Only the single hosting process owns this ledger. Interrupted calls may still have cost money.
    this.db.exec("UPDATE host_calls SET state='uncertain' WHERE state='reserved'");
  }
  private period() {const day=new Date(this.now()).toISOString().slice(0,10);return {day,month:day.slice(0,7)};}
  reserve(userId:string,input:number,output:number,inputPrice:number,outputPrice:number):string {
    const limits=this.limits,maxInput=this.liveSettings?.().maxInputTokens??defaultHostingSettings.maxInputTokens;
    if(!userId||![input,output].every(n=>Number.isSafeInteger(n)&&n>=0)||input>maxInput||output>limits.maxOutputTokens)throw new ModelCallError(`网站单次输入或输出超过站长设定的上限（输入 ${maxInput}，输出 ${limits.maxOutputTokens} Token）。请缩短上下文或降低输出设置。`);
    if(![inputPrice,outputPrice].every(n=>Number.isFinite(n)&&n>0&&n<=100000))throw new ModelCallError('站长尚未为此模型配置有效的输入与输出价格，网站已暂停付费调用。');
    const {day,month}=this.period(),cost=money(input,output,inputPrice,outputPrice,limits.exchangeRate);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const daily=this.db.prepare('SELECT COALESCE(SUM(cost),0) AS cost,COUNT(*) AS calls FROM host_calls WHERE day=?').get(day)!;
      const user=this.db.prepare('SELECT COALESCE(SUM(cost),0) AS cost,COUNT(*) AS calls FROM host_calls WHERE day=? AND user_id=?').get(day,userId)!;
      const monthly=this.db.prepare('SELECT COALESCE(SUM(cost),0) AS cost FROM host_calls WHERE month=?').get(month)!;
      const busy=Number(this.db.prepare("SELECT COUNT(*) AS n FROM host_calls WHERE state='reserved'").get()!.n);
      const userBusy=Number(this.db.prepare("SELECT COUNT(*) AS n FROM host_calls WHERE state='reserved' AND user_id=?").get(userId)!.n);
      if(busy>=limits.concurrency||userBusy>=limits.userConcurrency)throw new ModelCallError('网站模型并发额度已满，请稍后继续讨论。');
      if(Number(daily.calls)>=limits.dailyCalls||Number(user.calls)>=limits.userDailyCalls)throw new ModelCallError('已达到网站或当前访客的每日调用次数限制；重开群聊不会重置额度。');
      if(Number(daily.cost)+cost>Math.floor(limits.dailyCny*1e6)||Number(user.cost)+cost>Math.floor(limits.userDailyCny*1e6)||Number(monthly.cost)+cost>Math.floor(limits.monthlyCny*1e6))throw new ModelCallError('网站或当前访客的额度不足以预留本次调用。请降低单次输出，或联系站长；重开群聊不会重置额度。');
      const id=randomUUID();this.db.prepare('INSERT INTO host_calls(id,user_id,day,month,cost,input_price,output_price,state,exchange_rate) VALUES(?,?,?,?,?,?,?,?,?)').run(id,userId,day,month,cost,inputPrice,outputPrice,'reserved',limits.exchangeRate);this.db.exec('COMMIT');return id;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  settle(id:string,usage?:Usage,knownNotGenerated=false) {
    const entry=this.db.prepare('SELECT * FROM host_calls WHERE id=?').get(id) as unknown as Reservation|undefined;
    if(!entry||entry.state!=='reserved')return;
    const valid=usage&&!usage.usageEstimated&&validUsage(usage),cost=knownNotGenerated?0:valid?money(usage.inputTokens,usage.outputTokens,entry.input_price,entry.output_price,entry.exchange_rate??this.initialLimits.exchangeRate):entry.cost;
    this.db.prepare('UPDATE host_calls SET cost=?,state=? WHERE id=?').run(cost,knownNotGenerated||valid?'settled':'uncertain',id);
  }
  async run<T extends Usage>(userId:string,input:number,output:number,prices:{inputPrice:number;outputPrice:number},action:()=>Promise<T>):Promise<T> {
    const id=this.reserve(userId,input,output,prices.inputPrice,prices.outputPrice);
    try{const result=await action();this.settle(id,result);return result;}
    catch(error){this.settle(id,error instanceof ModelResponseError?error.usage:undefined,error instanceof ProviderRequestError&&error.notGenerated);throw error;}
  }
  usage(userId:string) {
    const {day}=this.period();const row=this.db.prepare("SELECT COALESCE(SUM(cost),0) AS cost,COUNT(*) AS calls,SUM(CASE WHEN state='reserved' THEN 1 ELSE 0 END) AS pending,SUM(CASE WHEN state='uncertain' THEN 1 ELSE 0 END) AS uncertain FROM host_calls WHERE day=? AND user_id=?").get(day,userId)!;
    return {day,timeZone:'UTC',estimatedCny:Number(row.cost)/1e6,dailyLimitCny:this.limits.userDailyCny,calls:Number(row.calls),dailyCallLimit:this.limits.userDailyCalls,pending:Number(row.pending??0),uncertain:Number(row.uncertain??0),maxOutputTokens:this.limits.maxOutputTokens,notice:'含在途预留和无法确认用量的请求，按站长模型单价估算，非供应商账单；每日 UTC 00:00 重置。'};
  }
  close(){this.db.close();}
}
