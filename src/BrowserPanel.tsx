import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import type { BrowserProfile, BrowserSelectors, WebProviderId } from '../shared/types';

type Api = <T>(path:string,method?:string,body?:unknown)=>Promise<T>;
const names:Record<WebProviderId,string>={openai:'ChatGPT',claude:'Claude',deepseek:'DeepSeek',qwen:'Qwen'};
const stateNames={closed:'尚未打开',opening:'启动中',open:'窗口已打开',busy:'正在处理讨论'};
const fields:Record<keyof BrowserSelectors,string>={composer:'输入框',send:'发送按钮',response:'完整回答容器',busy:'生成中 / 停止按钮',done:'回复完成标记（如复制按钮）',reasoning:'可见思考容器（可留空）'};

export function BrowserPanel({api}:{api:Api}) {
  const [profiles,setProfiles]=useState<BrowserProfile[]>([]);
  const [selected,setSelected]=useState<WebProviderId>('deepseek');
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [message,setMessage]=useState('');
  const load=useCallback(async()=>setProfiles(await api<BrowserProfile[]>('/api/browser')),[api]);
  useEffect(()=>{void load().catch(e=>setError(e.message));},[load]);
  const action=async(task:()=>Promise<void>)=>{setBusy(true);setError('');setMessage('');try{await task();await load();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  const profile=profiles.find(p=>p.providerId===selected);
  return <div className="browser-panel">
    <p className="browser-intro">在专用窗口自行登录，随后茶馆可以输入讨论内容并读取网页回复。当前为实验连接；页面变化、验证或额度限制会暂停。请仅在平台允许的情况下使用，不保证网站免费额度或模型可用性。</p>
    <div className="browser-provider-tabs">{Object.entries(names).map(([id,name])=><button key={id} className={selected===id?'active':''} disabled={busy} onClick={()=>{setSelected(id as WebProviderId);setMessage('');setError('');}}>{name}</button>)}</div>
    {profile&&<><div className="browser-status"><strong>{names[selected]} 专用窗口</strong><span>{stateNames[profile.state]}</span></div>
      <ol className="browser-steps"><li>点击打开窗口，在官网完成登录或验证。</li><li>回到这里检查输入框；检测不会发送消息。</li><li>为群聊成员选择「浏览器连接」，再开始讨论。</li></ol>
      <div className="browser-actions"><button className="primary-button" disabled={busy||profile.state==='opening'} onClick={()=>void action(async()=>setMessage((await api<{message:string}>(`/api/browser/${selected}/open`,'POST',{})).message))}><ExternalLink size={15}/>打开 / 显示专用窗口</button><button className="secondary-button" disabled={busy||profile.state==='closed'||profile.state==='busy'} onClick={()=>void action(async()=>setMessage((await api<{message:string}>(`/api/browser/${selected}/check`,'POST',{})).message))}><RefreshCw size={14}/>检查输入框</button><button className="text-button" disabled={busy||profile.state!=='open'} onClick={()=>void action(async()=>{await api(`/api/browser/${selected}/close`,'POST',{});setMessage('专用窗口已关闭。登录资料仍保留在本机。');})}>关闭窗口</button><button className="text-button" disabled={busy} onClick={()=>void action(load)}>刷新状态</button></div>
      {message&&<p className="browser-notice" role="status">{message}</p>}
      <details className="browser-advanced"><summary>高级页面适配 · 网站改版时使用</summary><p>这些预设尚未完成你账号的真实对话验证。只有匹配唯一输入框、发送按钮和完整回答，并检测到结束标记时才自动回传。无法识别时会暂停，请检查页面适配。这里只接受 CSS 选择器，不接受网址或脚本。</p><SelectorForm key={selected+JSON.stringify(profile.selectors)} value={profile.selectors} disabled={busy||profile.state==='busy'} save={value=>action(async()=>{await api(`/api/browser/${selected}/selectors`,'PUT',value);setMessage('已保存页面适配。请检查输入框，再进行一次短对话验证。');})}/></details>
      <p className="field-help">每次发言会新建网页会话；实际模型和账户记忆由网站决定。网页登录资料保存在本机 data/browser-profiles，不通过茶馆接口导出。关闭茶馆服务也会关闭专用窗口。</p>
    </>}{error&&<p className="inline-error" role="alert">{error}</p>}
  </div>;
}
function SelectorForm({value,disabled,save}:{value:BrowserSelectors;disabled:boolean;save:(value:BrowserSelectors)=>Promise<void>}) {
  const [draft,setDraft]=useState(value);
  return <form onSubmit={e=>{e.preventDefault();void save(draft);}}><fieldset disabled={disabled}>{Object.entries(fields).map(([key,label])=><label className="field" key={key}><span>{label}</span><input spellCheck={false} required={key!=='reasoning'} maxLength={800} value={draft[key as keyof BrowserSelectors]} onChange={e=>setDraft({...draft,[key]:e.target.value})}/></label>)}<button className="secondary-button" type="submit">保存页面适配</button></fieldset></form>;
}
