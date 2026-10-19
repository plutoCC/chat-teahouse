import {useEffect,useState} from 'react';
import type {SubscriptionStatus} from '../shared/subscription';
export type LocalApi=<T>(path:string,method?:string,body?:unknown)=>Promise<T>;
export function SubscriptionPanel({id,api,readOnly=false}:{id:string;api:LocalApi;readOnly?:boolean}) {
  const [status,setStatus]=useState<SubscriptionStatus>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[url,setUrl]=useState('');
  const refresh=async()=>{const result=await api<SubscriptionStatus>(`/api/providers/${id}/subscription`);setStatus(result);return result;};
  useEffect(()=>{let stopped=false;const load=()=>{void api<SubscriptionStatus>(`/api/providers/${id}/subscription`).then(s=>{if(!stopped)setStatus(s);}).catch(e=>{if(!stopped)setError(e.message);});};load();const timer=setInterval(()=>{if(!stopped)load();},10000);return()=>{stopped=true;clearInterval(timer);};},[id,api]);
  const action=async(name:string)=>{setBusy(true);setError('');try{const result=await api<{url?:string}>(`/api/providers/${id}/subscription/${name}`,'POST',{});if(result.url)setUrl(result.url);if(name!=='login')setUrl('');await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  return <section className="subscription-panel" aria-label="ChatGPT 订阅额度"><h3>ChatGPT 订阅 · 官方 Codex 授权</h3><p className="journal-note">{status?.connected?`正在使用 ChatGPT 套餐${status.plan?'（'+status.plan+'）':''}${status.email?' · '+status.email:''}`:'在官方页面登录后使用订阅额度。茶馆不读取你在 Codex 桌面中的登录凭据。'}</p>
    <div className="quota-windows">{status?.quotas.map(q=><div key={q.id}><strong>{q.name}{q.model?' · '+q.model:''}</strong>{[q.primary,q.secondary].filter(w=>w!==null).map((w,i)=><div className="quota-window" key={i}><span>{w!.windowDurationMins?`${w!.windowDurationMins!>=1440?w!.windowDurationMins!/1440+' 天':w!.windowDurationMins!>=60?w!.windowDurationMins!/60+' 小时':w!.windowDurationMins+' 分钟'}窗口`:'用量窗口'}</span><b>已用 {w!.usedPercent}% · 剩余 {Math.max(0,100-w!.usedPercent)}%</b><progress max={100} value={w!.usedPercent}/><small>{w!.resetsAt?'重置：'+new Date(w!.resetsAt!*1000).toLocaleString('zh-CN'):'重置时间未提供'}</small></div>)}</div>)}</div>
    {status?.connected&&!status.quotas.length&&<p className="journal-note">官方未返回可显示的剩余额度。</p>}
    {status?.checkedAt&&<small>查询时间：{new Date(status.checkedAt).toLocaleString('zh-CN')}</small>}
    <p className="journal-note">额度在账号的各个应用与成员之间共享，不能按成员精确拆分百分比；本群仍单独记录每位成员的 Token。订阅不显示人民币估价，也不会失败后自动改用付费 API。仅用于自主群聊。</p>
    {!readOnly&&<p className="journal-note">订阅接口不提供茶馆的单次输出硬上限：此设置作为长度目标，实际 Token 返回后累计并限制后续请求。</p>}
    <div className="provider-actions">{!readOnly&&!status?.connected&&<button type="button" className="primary-button" disabled={busy} onClick={()=>void action('login')}>Continue with ChatGPT</button>}<button type="button" className="secondary-button" disabled={busy} onClick={()=>void action('refresh')}>刷新订阅额度</button>{!readOnly&&status?.connected&&<button type="button" className="text-button" disabled={busy} onClick={()=>void action('logout')}>退出此订阅授权</button>}{!readOnly&&status?.pending&&<button type="button" className="text-button" disabled={busy} onClick={()=>void action('cancel')}>取消登录</button>}</div>
    {url&&status?.pending&&<p className="subscription-login"><a href={url} target="_blank" rel="noreferrer">打开官方登录页完成授权 ↗</a><small>请自行完成登录和授权；返回本页后刷新登录状态。</small></p>}
    <p><a href="https://chatgpt.com/codex/settings/usage" target="_blank" rel="noreferrer">在官方页面查看与管理额度 ↗</a></p>
    {(error||status?.error)&&<p className="inline-error" role="alert">{error||status?.error}</p>}
  </section>;
}
