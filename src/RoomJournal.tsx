import {SubscriptionPanel} from './SubscriptionPanel';
import {useEffect,useState} from 'react';
import type {RoomLogEntry,RoomUsage} from '../shared/room-journal';
import type {Group} from '../shared/types';
import {formatCny} from '../shared/pricing';
import {useExchangeRate} from './currency';

const labels={wake:'唤醒',model:'模型返回',protocol:'系统提醒',waiting:'选择等待',published:'已发言',error:'遇到问题'};
export function MemberUsagePanel({usage,group}:{usage?:RoomUsage;group:Group}) {
  const fx=useExchangeRate();
  const rows=usage?.members??[];
  return <section className="member-usage" aria-label="成员用量与费用"><h3>成员用量与费用 <small>本群自主群聊累计</small></h3>
    <div className="usage-table-scroll"><table><thead><tr><th>成员 / 模型</th><th>输入 Token</th><th>输出 Token</th><th>人民币 / 订阅</th></tr></thead><tbody>{rows.map(row=><tr key={JSON.stringify([row.memberId,row.model,row.connectionId,row.billingMode])}><td><strong>{group.participants.find(p=>p.id===row.memberId)?.name??row.author}</strong><small>{row.model} · {row.calls} 次调用</small>{!!row.reservedTokens&&<small>请求中，预留 {row.reservedTokens.toLocaleString()} Token</small>}{!!row.uncertainCalls&&<small>{row.uncertainCalls} 次用量未确认，按预留量估算</small>}</td><td>{row.inputTokens.toLocaleString()}</td><td>{row.outputTokens.toLocaleString()}</td><td><strong>{row.billingMode==='subscription'?'使用订阅额度':formatCny(row.estimatedUSD*fx)}</strong>{!!row.unpricedCalls&&<small>部分单价未填写，费用不完整</small>}</td></tr>)}</tbody></table></div>
    {!rows.length&&<p className="journal-note">尚无可拆分的调用记录。后续发言和等待判断都会计入。</p>}
    {!!usage?.unattributedCalls&&<p className="journal-note">另有 {usage.unattributedCalls} 次升级前调用未记录成员归属，未计入此表；原讨论总用量仍保留。</p>}
    <p className="journal-note">按每次调用时填写的输入、输出单价计算；改价不重算历史。人民币按当前估算汇率 1 美元 ≈ {fx} 元换算。思考和等待也可能消耗 Token；以供应商账单为准。重新开始讨论不会清空此累计。</p>
  </section>;
}
export function RoomJournal({group,usage,api,revision}:{group:Group;usage?:RoomUsage;api:<T>(path:string)=>Promise<T>;revision:string}) {
  const [entries,setEntries]=useState<RoomLogEntry[]>([]),[error,setError]=useState(''),[member,setMember]=useState(''),[kind,setKind]=useState('');
  useEffect(()=>{let cancelled=false;void api<{entries:RoomLogEntry[]}>(`/api/groups/${group.id}/logs`).then(data=>{if(!cancelled){setEntries(data.entries);setError('');}}).catch(e=>{if(!cancelled)setError(e.message);});return()=>{cancelled=true;};},[api,group.id,revision]);
  const authors=new Map(entries.map(e=>[e.memberId,e.author]));
  return <div className="modal-form room-journal"><MemberUsagePanel usage={usage} group={group}/>{[...new Set((usage?.members??[]).filter(r=>r.billingMode==='subscription').map(r=>r.connectionId))].map(id=><SubscriptionPanel key={id} id={id} api={api} readOnly/>)}<div className="journal-heading"><h3>活动日志</h3><span>每群保留最近 500 条 · 仅本机查看</span></div><p className="journal-note">日志不会发送给其他成员。展示供应商实际返回的推理内容或摘要，以及模型填写的等待原因；没有返回时标记“未提供”，不补写内部思考。</p>
    <div className="journal-filters"><label>成员<select aria-label="日志成员" value={member} onChange={e=>setMember(e.target.value)}><option value="">全部成员</option>{[...authors].map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label><label>活动<select aria-label="日志活动" value={kind} onChange={e=>setKind(e.target.value)}><option value="">全部活动</option>{Object.entries(labels).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label></div>
    {error&&<p role="alert" className="inline-error">{error}</p>}
    <div className="journal-entries">{entries.filter(e=>(!member||e.memberId===member)&&(!kind||e.kind===kind)).map(e=><article key={e.id} className={`journal-entry journal-${e.kind}`}><header><strong>{e.author}</strong><span className="badge">{labels[e.kind]}</span><time>{new Date(e.createdAt).toLocaleString('zh-CN')}</time></header><small>{e.model}{e.inputTokens!==undefined?` · 输入 ${e.inputTokens.toLocaleString()} / 输出 ${(e.outputTokens??0).toLocaleString()} Token`:''}</small><p>{e.summary}</p>{e.reasoning?<details><summary>{e.reasoningLabel??'供应商返回的推理内容'}</summary><pre>{e.reasoning}</pre></details>:e.kind==='model'?<small>供应商未提供可展示的推理内容或摘要。</small>:null}</article>)}{!entries.length&&<p className="journal-note">暂无日志。开始或继续自主群聊后，会记录唤醒、返回、等待与发言。</p>}</div>
  </div>;
}
