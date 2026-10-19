import { useState } from 'react';
import { BudgetField } from './ModelPricing';
import { Pause, Play, RefreshCw, Upload } from 'lucide-react';
import { defaultFreeSettings, type FreeSession, type SkillSummary } from '../shared/free-chat';
import type { Group } from '../shared/types';

export function FreeChatControls({ group, session, busy, start, pause }: { group: Group; session?: FreeSession | null; busy: boolean; start: (reset?: boolean) => void; pause: () => void }) {
  const [reset, setReset] = useState(false);
  const active = session?.status === 'active';
  const exhausted = session?.status === 'limit' || !!session && Date.now() >= session.deadline;
  return <div className="discussion-toolbar free-controls"><div className="run-status"><span className={active ? 'live-dot' : 'ready-dot'}/><strong>自主群聊</strong><span>{active ? '成员自行决定发言' : session ? '讨论已暂停' : '准备就绪'}</span></div><div className="toolbar-actions">
    {active ? <button className="stop-button" disabled={busy} onClick={pause}><Pause size={13}/>暂停讨论</button> : <>
      {!exhausted && <button className="text-button" disabled={busy || group.archived || !group.participants.some(p => p.enabled)} onClick={() => { setReset(false); start(); }}><Play size={13}/>{session ? '继续讨论' : '开始讨论'}</button>}
      {session && <button className="text-button" disabled={busy || group.archived} onClick={() => { if (reset) { setReset(false); start(true); } else setReset(true); }}><RefreshCw size={13}/>{reset ? '确认重置上下文与预算' : '重新开始'}</button>}
      {reset && <button className="text-button" onClick={() => setReset(false)}>取消</button>}
    </>}
  </div></div>;
}

const activities = { listening: '聆听中', queued: '排队发送', sending:'正在分段发送', thinking: '独立判断中', waiting: '选择等待', retrying: '限流等待中', budget_wait:'等待在途结算', error: '需要处理', paused: '已暂停' };
export function FreeChatStatus({ group, session, now }: { group: Group; session?: FreeSession | null; now: number }) {
  if (!session) return null;
  return <section className="free-status" aria-label="成员实时状态"><div className="free-status-heading"><span>{session.status === 'active' ? '群聊进行中' : session.status === 'limit' ? '已达到本次限额' : session.status === 'interrupted' ? '上次讨论已中断' : '群聊已暂停'}</span><small>{session.callCount} 次模型调用 · {session.publishedCount} 条公开发言</small></div>
    <div className="free-member-states">{session.members.map(m => { const person = group.participants.find(p => p.id === m.id); if (!person) return null; return <div className={`free-member-state ${m.status}`} key={m.id}><span className="state-avatar" style={{ background: person.color }}>{person.avatar}</span><span><b>{person.name}</b><small>{activities[m.status]}{session.status === 'active' && m.wakeAt && m.wakeAt > now ? ` · ${Math.ceil((m.wakeAt - now) / 1000)} 秒后再判断` : ''}{m.attention === 'mentions' ? ' · 只关注点名' : ''}</small>{session.status==='active'&&m.activity&&m.activity!==activities[m.status]&&<small className="member-activity">{m.activity}{m.status==='queued'&&m.queuedUntil&&m.queuedUntil>now?` · 最早 ${Math.ceil((m.queuedUntil-now)/1000)} 秒后发送`:''}</small>}</span>{m.error && <p role="status">{m.error}</p>}</div>; })}</div>
    <p className="free-budget">已用 {(session.inputTokens+session.outputTokens).toLocaleString()} / {group.settings.maxTotalTokens.toLocaleString()} Token · 在途预留 {session.reservedTokens.toLocaleString()}<small>本群本场限制；不是供应商账户余额。输入量先估算，完成后按实际用量结算。</small></p>
    {session.sending&&session.status==='active'&&<p className="free-notice" role="status">{group.participants.find(p=>p.id===session.sending!.memberId)?.name??'成员'} 正在连发 {session.sending.sent}/{session.sending.total} · {group.freeSettings?.readingCharsPerSecond?`按 ${group.freeSettings.readingCharsPerSecond} 字 / 秒留出阅读时间`:'每段间隔 1 秒'}，其他 AI 等整组发完再回应。你可以随时插话。</p>}
    {!session.sending&&session.nextPublishAt&&session.status==='active'&&session.nextPublishAt>now&&<p className="free-notice">发言间隔：下一位 AI 最早在 {Math.ceil((session.nextPublishAt-now)/1000)} 秒后发送，你可以随时插话。</p>}
    {session.budgetNotice&&<p className="free-notice">{session.budgetNotice}</p>}
    {session.error && <p className="free-notice">{session.error}</p>}
    {session.members.filter(m => !m.error).length < 2 && session.members.some(m => m.error) && <p className="free-notice">当前可正常参与的 AI 少于两位。修复出错成员或加入其他可用模型后，才能形成多 AI 互相讨论。</p>}
    {!!session.uncertainCalls && <p className="free-notice">{session.uncertainCalls} 次调用未能确认实际用量，已按预留额度保守计费。</p>}
    <small className="free-status-note">面向全群讨论：成员自行选择切入点、接续或质疑彼此的观点，也可以保持沉默。你是平等的讨论者，随时可以补充或 @成员。等待期间不轮询模型。</small>
  </section>;
}

export function ConversationMode({ group, disabled, save }: { group: Group; disabled: boolean; save: (value: 'free' | 'round') => void }) {
  return <label className="field free-mode"><span>讨论模式</span><select disabled={disabled} value={group.conversationMode || 'round'} onChange={e => save(e.target.value as 'free' | 'round')}><option value="free">自主群聊 · 成员自行发言</option><option value="round">按轮圆桌 · 依次安排发言</option></select><small>{disabled ? '暂停讨论后可修改设置。' : '自主群聊使用支持工具调用的 API 模型。网页成员目前使用按轮圆桌。'}</small></label>;
}

export function FreeSettingsForm({ group, disabled, save }: { group: Group; disabled: boolean; save: (patch: Partial<Group>,asDefault?:boolean) => Promise<void> }) {
  const [free, setFree] = useState({ ...defaultFreeSettings, ...group.freeSettings });
  const [budget, setBudget] = useState({ ...group.settings });
  const number = (label: string, key: 'quietSeconds' | 'cooldownMin' | 'cooldownMax' | 'concurrency' | 'maxMinutes' | 'messageGapMin' | 'messageGapMax' | 'readingCharsPerSecond' | 'typingGraceSeconds' | 'stickerCooldownSeconds', min: number, max: number) => <label className="field"><span>{label}</span><input type="number" required min={min} max={max} step="1" value={free[key]} onChange={e => setFree({ ...free, [key]: Number(e.target.value) })}/></label>;
  return <form className="free-settings" onSubmit={e => { e.preventDefault(); if (free.cooldownMax < free.cooldownMin || (free.messageGapMax??3)<(free.messageGapMin??1)) return; void save({ freeSettings: free, settings: budget },(e.nativeEvent as SubmitEvent).submitter?.getAttribute('value')==='default-template'); }}><fieldset disabled={disabled}>
    <h4>让讨论自然发生</h4><p>新消息会唤醒成员，由各自的模型选择发言、继续阅读或等待。频率设置决定何时有机会判断，不能保证每次都会回复。</p>
    <h4>全群消息发送节奏</h4>
    <label className="field"><span>消息发送方式</span><select value={free.messageStyle??'segmented'} onChange={e=>setFree({...free,messageStyle:e.target.value as 'segmented'|'single'})}><option value="segmented">短消息连发 · 可跟随阅读速度</option><option value="single">整条发送</option></select></label>
    <small>长回复按自然段和句子拆成短消息，代码块与表格保持完整。其他 AI 读完整组再接话；拆分不额外调用模型。暂停立即停止剩余段落。</small>
    <div className="free-form-grid">{number('最短发言间隔（秒）','messageGapMin',0,300)}{number('最长发言间隔（秒）','messageGapMax',free.messageGapMin??0,300)}</div><small>这是两次完整发言之间的基础间隔，默认随机 1–3 秒；会与最后一条消息的阅读时间取较长者。实际回复还需要模型生成时间。</small>
    {number('阅读速度（字 / 秒，0 关闭）','readingCharsPerSecond',0,60)}<small>连发时按上一段字数 ÷ 阅读速度等待，最短 1 秒、最长 90 秒。最后一段也预留阅读时间，不重复计算整篇；整条发送同样生效。填 0 时连发固定每秒一段。例如 100 字、20 字 / 秒，约等待 5 秒。</small>
    {number('用户输入保护（秒）','typingGraceSeconds',0,60)}<small>你正在输入或刚发言时，暂缓下一组 AI 发言。已经开始的连发按阅读节奏继续，新的人类消息会在接话前交付给其他成员。</small>
    <h4>平等讨论规则 · 所有成员生效</h4><p className="field-help">先独立判断，再有依据地赞同、反对或保留意见。改变立场要说明新依据；不先恭维、不列服务菜单，也不为了显得独立而强行唱反调。原生模式同样遵守这些规则，人设仍由你单独设置。</p>
    <label className="free-checkbox"><input type="checkbox" checked={free.allowStickers??true} onChange={e=>setFree({...free,allowStickers:e.target.checked})}/>允许 AI 从本地表情库选择表情</label>
    {number('AI 表情包间隔（秒）','stickerCooldownSeconds',0,600)}
    <h4>成员判断频率</h4>
    {number('合并消息等待（秒）', 'quietSeconds', 0, 30)}
    <div className="free-form-grid">{number('最短冷却（秒）', 'cooldownMin', 1, 300)}{number('最长冷却（秒）', 'cooldownMax', free.cooldownMin, 300)}</div>
    <small>两者相同为固定间隔，不同则在区间内随机。冷却后只有新消息或成员预约时才判断。</small>
    {number('同时判断的成员数', 'concurrency', 1, 4)}
    <label className="field"><span>普通消息唤醒概率（%）</span><input type="number" required min="0" max="100" step="1" value={Math.round(free.wakeProbability * 100)} onChange={e => setFree({ ...free, wakeProbability: Number(e.target.value) / 100 })}/><small>点名跳过随机抽样、合并等待和成员冷却；仍遵守预算、并发、发送间隔与供应商限流。</small></label>
    <label className="free-checkbox"><input type="checkbox" checked={free.respondToAI} onChange={e => setFree({ ...free, respondToAI: e.target.checked })}/>让 AI 的新消息也唤醒其他成员</label>
    <h4>本次讨论上限</h4>{number('最长持续时间（分钟）', 'maxMinutes', 1, 120)}
    <label className="field"><span>最多模型调用次数</span><input type="number" required min="1" max="128" value={budget.maxCalls} onChange={e => setBudget({ ...budget, maxCalls: Number(e.target.value) })}/><small>沉默判断、技能读取后的继续判断也计入调用。</small></label>
    <label className="field"><span>最多 tokens</span><input type="number" required min="1000" max="1000000" value={budget.maxTotalTokens} onChange={e => setBudget({ ...budget, maxTotalTokens: Number(e.target.value) })}/></label>
    <label className="field"><span>单次输出上限</span><input type="number" required min="128" max="8192" value={budget.maxOutputTokens} onChange={e => setBudget({ ...budget, maxOutputTokens: Number(e.target.value) })}/></label>
    <p className="field-help">限制单次 API 生成，不限制单个聊天气泡的长度。思考 Token 是否共用此额度取决于模型及接口；分段发送不会缩短完整发言。当前可填写 128～8192，这是茶馆的应用限制，并非各模型的官方上限。剩余群预算不足时会进一步降低请求额度，实际费用按生成用量计算。</p>
    <BudgetField valueUSD={budget.budgetUSD} change={usd => setBudget({ ...budget, budgetUSD: usd })}/><p className="field-help">云端模型需先填写输入、输出单价。每次调用前预留额度；0 表示不设费用上限，次数和 tokens 上限仍生效。</p>
    <button className="primary-button full" type="submit">保存自主群聊设置</button>
    <button className="secondary-button full" type="submit" value="default-template">设为新群默认模板</button><small>同时保存当前修改。后续新群沿用讨论模式、节奏、唤醒规则和预算；现有其他群不变，议题与成员在新群中选择。</small>
  </fieldset></form>;
}

export function SkillPicker({ skills, value, change, disabled }: { skills: SkillSummary[]; value: string[]; change: (value: string[]) => void; disabled: boolean }) {
  return <fieldset className="skill-picker" disabled={disabled}><legend>成员技能 · 可不选</legend><p>{disabled ? '网页成员暂不支持技能工具。' : '用于自主群聊；成员按需要读取。原生模式也可以使用技能，不会强加角色。'}</p>{skills.map(s => <label className="skill-option" key={s.id}><input type="checkbox" checked={value.includes(s.id)} disabled={!value.includes(s.id) && value.length >= 8} onChange={e => change(e.target.checked ? [...value, s.id] : value.filter(id => id !== s.id))}/><span><b>{s.name}</b><small>{s.description}</small></span></label>)}</fieldset>;
}

export function SkillLibrary({ skills, disabled, save, remove }: { skills: SkillSummary[]; disabled: boolean; save: (markdown: string) => Promise<void>; remove: (id: string) => Promise<void> }) {
  const [text, setText] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const action = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <div className="modal-form skill-library"><p>技能库在本机保存，分配给成员后，相关说明会发送给该成员使用的模型。这里只导入 SKILL.md 文字，不安装脚本、依赖或外部工具。</p>{disabled && <p className="free-notice">请先暂停正在运行的自主群聊，再修改技能库。</p>}
    <div className="skill-library-list">{skills.map(s => <div key={s.id}><strong>{s.name}</strong><small>{s.description}</small>{s.builtin ? <span className="badge">内置</span> : <button className="text-button" disabled={disabled || busy} onClick={() => void action(() => remove(s.id))}>移除</button>}</div>)}</div>
    <form onSubmit={e => { e.preventDefault(); void action(async () => { await save(text); setText(''); }); }}><fieldset disabled={disabled || busy}>
      <label className="field"><span>选择 SKILL.md 文件</span><input type="file" accept=".md,text/markdown,text/plain" onChange={e => { const file = e.target.files?.[0]; if (!file) return; void action(async () => { if (file.size > 100000) throw new Error('技能文件过大'); const value = await file.text(); if (value.length > 24000) throw new Error('技能最多 24000 个字符'); setText(value); }); }}/></label>
      <label className="field"><span>检查技能内容后导入</span><textarea rows={8} maxLength={24000} required value={text} onChange={e => setText(e.target.value)} placeholder={'---\nname: evidence-check\ndescription: 检查论据是否支持结论\n---\n说明具体工作方法。'}/></label>
      <button type="submit" className="primary-button" disabled={!text.trim()}><Upload size={15}/>导入文字技能</button>
    </fieldset></form>{error && <p className="inline-error" role="alert">{error}</p>}
  </div>;
}
