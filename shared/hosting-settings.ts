/** Public product limits. Security boundaries (origins, credential routes and payload parsing) remain fixed. */
export interface HostingSettings {
  dailyCny:number;userDailyCny:number;monthlyCny:number;exchangeRate:number;
  dailyCalls:number;userDailyCalls:number;concurrency:number;userConcurrency:number;maxOutputTokens:number;
  maxAccounts:number;maxSessionsPerUser:number;maxSsePerUser:number;maxGroupsPerUser:number;
  maxMembersPerGroup:number;maxProfilesPerUser:number;maxMessagesPerGroup:number;maxInputTokens:number;
  maxDiscussionRounds:number;maxDiscussionCalls:number;maxDiscussionBudgetUSD:number;maxConcurrentMembers:number;maxCallsPerWake:number;
  maxActiveGroupsPerUser:number;maxActiveMembersPerUser:number;
}
export interface HostingSettingField {key:keyof HostingSettings;label:string;group:string;min:number;max:number;step:number;help:string;}
export const defaultHostingSettings:HostingSettings={dailyCny:20,userDailyCny:5,monthlyCny:300,exchangeRate:7,dailyCalls:200,userDailyCalls:50,concurrency:4,userConcurrency:2,maxOutputTokens:16384,maxAccounts:10,maxSessionsPerUser:8,maxSsePerUser:4,maxGroupsPerUser:200,maxMembersPerGroup:8,maxProfilesPerUser:2000,maxMessagesPerGroup:5000,maxInputTokens:500000,maxDiscussionRounds:12,maxDiscussionCalls:128,maxDiscussionBudgetUSD:1000,maxConcurrentMembers:4,maxCallsPerWake:32,maxActiveGroupsPerUser:3,maxActiveMembersPerUser:6};
const field=(key:keyof HostingSettings,label:string,group:string,min:number,max:number,step:number,help:string):HostingSettingField=>({key,label,group,min,max,step,help});
export const hostingSettingsSchema:HostingSettingField[]=[
  field('dailyCny','全站每日金额（元）','金额与用量',0.01,10000000,0.01,'按站长填写的模型单价预估；含正在请求的预留金额。每日 UTC 00:00 重置。'),
  field('userDailyCny','每人每日金额（元）','金额与用量',0.01,10000000,0.01,'所有群聊合计，不会因新建群聊而重置。'),
  field('monthlyCny','全站每月金额（元）','金额与用量',0.01,10000000,0.01,'每个 UTC 自然月累计；修改上限不会清空已有用量。'),
  field('exchangeRate','美元换算人民币汇率','金额与用量',0.01,100,0.01,'新请求使用此汇率，已发起请求仍按发起时的汇率结算。'),
  field('dailyCalls','全站每日模型调用次数','金额与用量',1,10000000,1,'包括摘要和工具往返；新建群聊不会重置。'),
  field('userDailyCalls','每人每日模型调用次数','金额与用量',1,10000000,1,'按账号累计，当天已有调用不会因修改设置而清零。'),
  field('concurrency','全站同时模型请求数','模型请求',1,128,1,'越高越容易触发供应商限流；已有请求不会被强行取消。'),
  field('userConcurrency','每人同时模型请求数','模型请求',1,128,1,'每位会员的全部群聊合计，同时受全站上限约束。'),
  field('maxInputTokens','单次输入 Token 上限','模型请求',1,2000000,1,'包含上下文和工具内容；仍须符合所选模型的实际上下文限制。'),
  field('maxOutputTokens','单次输出 Token 上限','模型请求',1,1000000,1,'包含推理模型的思考用量；仍须符合供应商限制。'),
  field('maxAccounts','有效邀请账号数','邀请与登录',1,1000,1,'降低后不会撤销已有账号，只限制新增邀请。'),
  field('maxSessionsPerUser','每人同时登录会话数','邀请与登录',1,100,1,'不同浏览器和设备分别计数；降低后不退出现有会话。'),
  field('maxSsePerUser','每人同时实时页面数','邀请与登录',1,100,1,'每个打开的聊天页面使用一个实时连接；降低后只限制新连接。'),
  field('maxGroupsPerUser','每人群聊数量','群聊与成员',1,10000,1,'仅限制新建，不删除已有群聊。'),
  field('maxMembersPerGroup','每个群聊 AI 成员数','群聊与成员',1,100,1,'包括主动讨论和仅被 @ 唤醒的成员；已有成员不会被移出。'),
  field('maxProfilesPerUser','每人创建的公共 AI 形象数','群聊与成员',1,10000,1,'只限制该会员新建形象；可以邀请其他人的公共形象。'),
  field('maxMessagesPerGroup','每个群聊消息数量','群聊与成员',1,1000000,1,'达到后停止新增消息，已有历史始终保留。'),
  field('maxDiscussionRounds','单场讨论轮次可设上限','讨论设置',1,10000,1,'限制会员在讨论设置中可选择的轮次数。'),
  field('maxDiscussionCalls','单场讨论调用次数可设上限','讨论设置',1,1000000,1,'仍受每人和全站每日调用额度约束。'),
  field('maxDiscussionBudgetUSD','单场讨论预算可设上限（美元）','讨论设置',0.01,10000000,0.01,'这是群聊设置的模型预算，不会替代全站人民币费用保护。'),
  field('maxConcurrentMembers','单群同时思考成员可设上限','讨论设置',1,100,1,'仍受每人和全站的模型并发上限约束。'),
  field('maxCallsPerWake','单次唤醒模型调用可设上限','讨论设置',2,256,1,'包括模型读取上下文和调用工具的往返次数；较高设置会增加费用。'),
  field('maxActiveGroupsPerUser','每人同时讨论的群聊数','讨论设置',1,100,1,'只限制新启动讨论；降低不会中断已在运行的群聊。'),
  field('maxActiveMembersPerUser','每人同时思考或排队的成员数','讨论设置',1,256,1,'跨全部群聊计数；降低不会中断在途任务。'),
];
export function normalizeHostingSettings(input:unknown,base:HostingSettings=defaultHostingSettings):HostingSettings{
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('分享设置格式不正确。');
  const data=input as Record<string,unknown>,keys=new Set(hostingSettingsSchema.map(item=>item.key));
  if(Object.keys(data).some(key=>!keys.has(key as keyof HostingSettings)))throw new Error('分享设置包含未知字段。');
  const result={...base};
  for(const item of hostingSettingsSchema){
    const value=Object.hasOwn(data,item.key)?data[item.key]:base[item.key];
    if(typeof value!=='number'||!Number.isFinite(value)||value<item.min||value>item.max||(item.step===1&&!Number.isInteger(value)))throw new Error(`${item.label}须为 ${item.min}–${item.max} 之间的${item.step===1?'整数':'数值'}。`);
    result[item.key]=value;
  }
  return result;
}
export interface HostingSettingsSnapshot {version:number;values:HostingSettings;}
