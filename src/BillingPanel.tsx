import {useEffect,useState} from 'react';
import {BILLING_CAPABILITIES,type BillingStatus} from '../shared/billing';
import {connectionKey,type ProviderConfig} from '../shared/types';
import type {LocalApi} from './SubscriptionPanel';
import {useExchangeRate} from './currency';
import {formatCny} from '../shared/pricing';

const stateLabels={unconfigured:'尚未配置',unverified:'已配置 · 尚未查询验证',ready:'官方数据',partial:'部分数据 / 提示',error:'本次查询失败',unsupported:'不适用'};
const tidy=(v:string)=>v.includes('.')?v.replace(/0+$/,'').replace(/\.$/,''):v;
export function BillingPanel({provider,api}:{provider:ProviderConfig;api:LocalApi}){
  const capability=BILLING_CAPABILITIES[provider.id],id=connectionKey(provider),base=`/api/providers/${id}/billing`,fx=useExchangeRate();
  const [status,setStatus]=useState<BillingStatus>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[keyId,setKeyId]=useState(''),[secret,setSecret]=useState(''),[site,setSite]=useState<'cn'|'intl'>('cn'),[month,setMonth]=useState(new Date().toISOString().slice(0,7));
  useEffect(()=>{let cancelled=false;void api<BillingStatus>(base).then(v=>{if(!cancelled)setStatus(v);}).catch(e=>{if(!cancelled)setError(e.message);});return()=>{cancelled=true;};},[base,api,provider]);
  if(capability.credential==='none')return null;
  const perform=async(action:'refresh'|'save'|'remove')=>{setBusy(true);setError('');try{
    const next=await api<BillingStatus>(base+(action==='refresh'?'/refresh':'/credentials'),action==='refresh'?'POST':action==='remove'?'DELETE':'PUT',action==='refresh'?{month}:action==='remove'?{}:capability.credential==='admin-key'?{adminKey:secret}:{accessKeyId:keyId,secretAccessKey:secret,site});
    setStatus(next);if(action!=='refresh'){setSecret('');setKeyId('');}
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  return <section className="billing-panel" aria-label={capability.title}><div className="billing-heading"><h3>{capability.title}</h3><span className="badge">{status?stateLabels[status.state]:'读取配置中'}</span></div><p className="journal-note">{capability.description}</p>
    <div className="billing-metrics">{status?.metrics.map((m,i)=><div className={status.state==='error'?'stale':''} key={i}><span>{m.label}{m.partial?'（部分）':''}</span><strong>{m.currency==='CNY'?'¥':m.currency==='USD'?'$':''}{tidy(m.amount)} <small>{m.currency}</small></strong>{m.currency==='USD'&&<small>≈ {formatCny(Number(m.amount)*fx)}（估算汇率 {fx}）</small>}<small>{m.scope==='account'?'整个账户':m.scope==='organization'?'整个组织的费用报告':'可识别的火山方舟账单'}{m.period?' · '+m.period:''}</small></div>)}</div>
    {status?.retrievedAt&&<p className="journal-note">数据查询时间：{new Date(status.retrievedAt).toLocaleString('zh-CN')}。官方出账可能滞后，余额与账单不加入成员费用合计。</p>}
    {status?.state==='unconfigured'&&<p className="journal-note">{capability.credential==='model-key'?'先在上方保存模型 API Key，再查询官方余额。':'保存下方账单凭据后，才可查询。没有配置时不访问厂商接口。'}</p>}
    {capability.credential!=='model-key'&&<details className="billing-credentials"><summary>{status?.configured?'更新或移除账单凭据':'配置只读账单凭据'}</summary><div className="billing-fields" onKeyDown={e=>{if(e.key==='Enter')e.preventDefault();}}>
      <p className="journal-note">建议使用仅有余额 / 费用查询权限的凭据。单独加密保存在本机，不发送给讨论模型。保存不等于验证成功。</p>
      {capability.credential==='access-key'&&<label>AccessKey ID<input type="password" autoComplete="new-password" spellCheck={false} value={keyId} onChange={e=>setKeyId(e.target.value)} placeholder="输入新凭据，不回显已保存内容"/></label>}
      <label>{capability.credential==='admin-key'?'Admin API Key':'SecretAccessKey'}<input type="password" autoComplete="new-password" spellCheck={false} value={secret} onChange={e=>setSecret(e.target.value)} placeholder="单独的账单查询凭据"/></label>
      {provider.id==='qwen'&&<label>财务账户站点<select value={site} onChange={e=>setSite(e.target.value as 'cn'|'intl')}><option value="cn">阿里云中国站</option><option value="intl">阿里云国际站</option></select></label>}
      <div className="provider-actions"><button type="button" className="secondary-button" disabled={busy||!secret.trim()||(capability.credential==='access-key'&&!keyId.trim())} onClick={()=>void perform('save')}>保存账单凭据</button>{status?.configured&&<button type="button" className="text-button danger" disabled={busy} onClick={()=>void perform('remove')}>移除账单凭据</button>}</div>
    </div></details>}
    <div className="provider-actions">{['openai','claude','doubao'].includes(provider.id)&&<label className="billing-month">账单月份<input type="month" aria-label="账单月份" value={month} max={new Date(Date.now()+8*3600000).toISOString().slice(0,7)} onChange={e=>setMonth(e.target.value)}/></label>}<button type="button" className="secondary-button" disabled={busy||!status?.configured} onClick={()=>void perform('refresh')}>{busy?'查询中…':'查询官方余额 / 账单'}</button><a href={capability.docs} target="_blank" rel="noreferrer">官方接口说明 ↗</a></div>
    {!!status?.warnings.length&&status.warnings.map(w=><p className="journal-note" key={w}>{w}</p>)}{(error||status?.error)&&<p className="inline-error" role="alert">{error||status?.error}</p>}
  </section>;
}
