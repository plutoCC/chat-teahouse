import { useRef, useState } from 'react';
import type { Sticker, StickerAttachment } from '../shared/types';
import { avatarFileData } from './AvatarPicker';
export function StickerImage({sticker}:{sticker:StickerAttachment}) {
  const [broken,setBroken]=useState(false);
  return !broken&&/^[a-f0-9]{64}$/.test(sticker.assetId)?<img className="sticker-image" src={'/api/sticker-assets/'+sticker.assetId} alt={`表情包：${sticker.name}`} title={sticker.tags.join('、')} onError={()=>setBroken(true)}/>:<span>[表情包：{sticker.name}]</span>;
}
type Api=<T>(path:string,method?:string,body?:unknown)=>Promise<T>;
export function Stickers({stickers,api,refresh,send}:{stickers:Sticker[];api:Api;refresh:()=>Promise<void>;send?:(id:string)=>Promise<void>}){
  const [name,setName]=useState(''),[tags,setTags]=useState(''),[file,setFile]=useState<File>(),[editing,setEditing]=useState<Sticker>();
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[query,setQuery]=useState(''),[trash,setTrash]=useState(false),[confirm,setConfirm]=useState('');
  const fileInput=useRef<HTMLInputElement>(null);
  const action=async(fn:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError('');try{await fn();await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  const visible=stickers.filter(s=>!!s.deletedAt===trash&&(!send||!s.deletedAt)&&`${s.name} ${s.tags.join(' ')}`.includes(query));
  return <div className="sticker-library"><p className="native-note">本机表情库。AI 通过名称和情绪标签选择表情，不会自动理解图片内容。自主群聊中可启用 AI 发图；按轮和浏览器成员暂只发文字。</p>
    <div className="library-toolbar"><input type="search" aria-label="搜索表情包" value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索名称或标签…"/>{!send&&<button className="secondary-button" onClick={()=>setTrash(!trash)}>{trash?'返回表情库':'已删除表情'}</button>}</div>
    {error&&<p className="inline-error" role="alert">{error}</p>}
    <div className="sticker-grid">{visible.map(s=><article key={s.id} aria-label={`表情 ${s.name}`}><StickerImage sticker={s}/><strong>{s.name}</strong><small>{s.tags.join(' · ')}</small><div>{send?<button className="primary-button" disabled={busy} onClick={()=>void action(()=>send(s.id))}>发送 {s.name}</button>:trash?<button className="secondary-button" disabled={busy} onClick={()=>void action(async()=>{await api('/api/stickers/'+s.id+'/restore','POST',{});})}>恢复 {s.name}</button>:<><button className="text-button" disabled={busy} onClick={()=>{setEditing(s);setName(s.name);setTags(s.tags.join('，'));}}>编辑 {s.name}</button><button className="text-button danger" disabled={busy} onClick={()=>{if(confirm!==s.id){setConfirm(s.id);return;}void action(async()=>{await api('/api/stickers/'+s.id,'DELETE',{});setConfirm('');});}}>{confirm===s.id?'确认删除':'删除'} {s.name}</button></>}</div></article>)}</div>
    {!visible.length&&<p className="field-help">{trash?'没有已删除的表情。':'表情库为空或无匹配项，请在「管理表情包」中上传。'}</p>}
    {!send&&!trash&&<form className="sticker-upload" onSubmit={e=>{e.preventDefault();void action(async()=>{
      const metadata={name:name.trim(),tags:tags.split(/[,，、]/).map(s=>s.trim()).filter(Boolean)};
      if(editing)await api('/api/stickers/'+editing.id,'PUT',metadata);else{if(!file)throw Error('请选择图片。');if(file.size>4*1024*1024)throw Error('表情包最大 4 MB。');await api('/api/stickers','POST',{...metadata,data:await avatarFileData(file)});}
      setName('');setTags('');setFile(undefined);setEditing(undefined);if(fileInput.current)fileInput.current.value='';
    });}}><h3>{editing?'编辑表情标签':'添加本地表情包'}</h3><label className="field"><span>表情名称</span><input required value={name} maxLength={40} onChange={e=>setName(e.target.value)}/></label><label className="field"><span>情绪 / 使用标签</span><input value={tags} onChange={e=>setTags(e.target.value)} placeholder="例如：赞同，思考，疑惑（逗号分隔，最多 8 个）"/></label>{!editing&&<label className="field"><span>表情图片</span><input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" required onChange={e=>setFile(e.target.files?.[0])}/><small>PNG / JPG / WebP / GIF；最大 4 MB，动画最多 100 帧，保留动画。图片仅存本机。</small></label>}<div className="avatar-picker-actions"><button className="primary-button" disabled={busy}>{busy?'处理中…':editing?'保存表情标签':'上传表情包'}</button>{editing&&<button type="button" className="text-button" onClick={()=>{setEditing(undefined);setName('');setTags('');}}>取消编辑</button>}</div></form>}
  </div>;
}
