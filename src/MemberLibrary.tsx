import { useEffect, useRef, useState } from 'react';
import { Check, Plus, Pencil, Users, Trash2, RotateCcw } from 'lucide-react';
import { identityModeOf, type Group, type MemberProfile } from '../shared/types';
import { Avatar } from './Avatar';

function ProfileIdentity({ profile }: {profile:MemberProfile}) {
  return <><Avatar person={profile}/><span className="profile-identity"><strong>{profile.name}</strong><small>{profile.model}</small></span></>;
}

export function ProfileSelection({ profiles, selected, change, disabled }: {profiles:MemberProfile[];selected:string[];change:(ids:string[])=>void;disabled:boolean}) {
  const [query,setQuery]=useState('');const visible=profiles.filter(p=>`${p.name} ${p.model}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="profile-selection" aria-label="选择入群成员"><h3>邀请已保存的 AI <small>{selected.length} / 8</small></h3><p className="field-help">也可以先建空群，稍后再邀请。头像、名称和身份沿用成员档案。</p><input type="search" aria-label="筛选已保存成员" placeholder="搜索名字或模型…" value={query} onChange={e=>setQuery(e.target.value)}/><div className="profile-selection-list">{visible.map(p=><label className="profile-choice" key={p.id}><input type="checkbox" aria-label={`邀请 ${p.name}`} disabled={disabled||(!selected.includes(p.id)&&selected.length>=8)} checked={selected.includes(p.id)} onChange={e=>change(e.target.checked?[...selected,p.id]:selected.filter(id=>id!==p.id))}/><ProfileIdentity profile={p}/></label>)}{!visible.length&&<p className="field-help">{profiles.length?'没有匹配的成员。':'成员库暂时为空，可先创建群聊，再建立成员档案。'}</p>}</div></section>;
}

interface LibraryProps {
  profiles:MemberProfile[];deletedProfiles:MemberProfile[];groups:Group[];group?:Group;
  create:()=>void;edit:(p:MemberProfile)=>void;invite:(id:string)=>Promise<void>;
  remove:(p:MemberProfile)=>Promise<void>;restore:(p:MemberProfile)=>Promise<void>;
}
export function MemberLibrary({ profiles, deletedProfiles, groups, group, create, edit, invite, remove, restore }: LibraryProps) {
  const [query,setQuery]=useState(''),[busy,setBusy]=useState(''),[error,setError]=useState('');
  const [trash,setTrash]=useState(false),[confirm,setConfirm]=useState<MemberProfile>();
  const [notice,setNotice]=useState('');
  const confirmation=useRef<HTMLElement>(null);
  useEffect(()=>{if(confirm){confirmation.current?.scrollIntoView({block:'nearest'});confirmation.current?.focus();}},[confirm?.id]);
  const visible=(trash?deletedProfiles:profiles).filter(p=>`${p.name} ${p.model} ${p.role}`.toLowerCase().includes(query.toLowerCase()));
  const perform=async(p:MemberProfile,action:()=>Promise<void>,message:string)=>{
    if(busy)return;setBusy(p.id);setError('');setNotice('');
    try{await action();setConfirm(undefined);setNotice(message);}catch(e){setError(e instanceof Error?e.message:'操作失败，请重试。');}finally{setBusy('');}
  };
  return <div className="member-library">
    <p className="native-note">成员档案长期保存在本机。头像、名字、模型、身份与技能在各群保持一致；每个群的启用状态和讨论记录独立。移出群聊后，仍可再次邀请。</p>
    <div className="library-toolbar"><input type="search" aria-label="搜索成员库" placeholder="搜索名字、模型或身份…" value={query} onChange={e=>setQuery(e.target.value)}/><button className="primary-button" disabled={!!busy} onClick={create}><Plus size={15}/>创建新成员</button></div>
    <div className="library-tabs" role="group" aria-label="成员列表范围">
      <button className={!trash?'selected':''} aria-pressed={!trash} disabled={!!busy} onClick={()=>{setTrash(false);setConfirm(undefined);setError('');}}>成员库 · {profiles.length}</button>
      <button className={trash?'selected':''} aria-pressed={trash} disabled={!!busy} onClick={()=>{setTrash(true);setConfirm(undefined);setError('');}}><Trash2 size={14}/>回收站 · {deletedProfiles.length}</button>
    </div>
    {trash&&<p className="field-help">恢复会保留原有名字、头像与身份。恢复后需重新邀请入群；已卸载的技能不会自动恢复。</p>}
    {notice&&<p className="library-notice" role="status">{notice}</p>}
    {error&&<p className="inline-error" role="alert">{error}</p>}
    {confirm&&<section ref={confirmation} tabIndex={-1} className="library-delete-confirm" aria-label={`确认删除 ${confirm.name}`}>
      <strong>将「{confirm.name}」移到回收站？</strong>
      <p>将从已加入的 {groups.filter(g=>g.participants.some(p=>p.profileId===confirm.id)).length} 个群中移出（含归档群）。过去的聊天记录和头像仍会保留。请先暂停这些群的讨论；之后可从回收站恢复成员。</p>
      <div><button className="secondary-button" disabled={!!busy} onClick={()=>setConfirm(undefined)}>取消删除</button><button className="danger-button" disabled={!!busy} onClick={()=>void perform(confirm,()=>remove(confirm),'成员已移到回收站，聊天记录已保留。')}>{busy?'删除中…':'确认删除成员'}</button></div>
    </section>}
    <div className="library-grid">{visible.map(p=>{
      const membership=group?.participants.find(m=>m.profileId===p.id);const joined=groups.filter(g=>g.participants.some(m=>m.profileId===p.id));
      return <article className="profile-card" key={p.id} aria-label={`成员档案 ${p.name}`}>
        <header><ProfileIdentity profile={p}/></header>
        <p>{identityModeOf({...p,enabled:true})==='native'?'原生模式 · 不附加角色设定':p.role||'自定义身份'}{!!p.skills?.length&&` · ${p.skills.length} 个技能`}</p>
        <small title={joined.map(g=>g.name).join('、')}><Users size={12}/>{trash?'已在回收站':joined.length?`已加入 ${joined.length} 个群`:'尚未加入群聊'}</small>
        <footer>{trash?<button className="secondary-button" disabled={!!busy} aria-label={`恢复成员 ${p.name}`} onClick={()=>void perform(p,()=>restore(p),'成员已恢复到成员库，可以重新邀请入群。')}><RotateCcw size={13}/>恢复成员</button>:<>
          <button className="secondary-button" aria-label={`编辑档案 ${p.name}`} disabled={!!busy} onClick={()=>edit(p)}><Pencil size={13}/>编辑档案</button>
          {group&&<button className="primary-button" aria-label={membership?`${p.name} 已在本群`:`邀请 ${p.name}`} disabled={!!busy||!!membership||group.participants.length>=8||group.archived} onClick={()=>void perform(p,()=>invite(p.id),'成员已加入本群。')}>{membership?<><Check size={13}/>{membership.enabled?'已在本群':'已在本群 · 停用'}</>:busy===p.id?'邀请中…':'邀请入群'}</button>}
          <button className="library-delete" aria-label={`删除成员 ${p.name}`} disabled={!!busy} onClick={()=>{setConfirm(p);setError('');setNotice('');}}><Trash2 size={13}/>删除</button>
        </>}</footer>
      </article>;
    })}</div>
    {!visible.length&&<p className="library-empty">{query?'没有匹配的成员。':trash?'回收站为空。':'创建第一个 AI 成员，之后可邀请到任意群聊。'}</p>}
    {group&&!trash&&group.participants.length>=8&&<p className="field-help">本群已达到 8 位 AI 成员上限，可以移出一位后再邀请。</p>}
  </div>;
}
