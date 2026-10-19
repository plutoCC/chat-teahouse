import {useCallback,useEffect,useRef,type MutableRefObject} from 'react';
import type {Group} from '../shared/types';
import {DRAFT_HEARTBEAT_MS,type DraftPresenceUpdate} from '../shared/typing';
import type {LocalApi} from './SubscriptionPanel';

export function useDraftPresence(api:LocalApi,drafts:MutableRefObject<Record<string,string>>,groups:Group[],csrf:MutableRefObject<string>,problem:(message:string)=>void){
  const client=useRef(crypto.randomUUID()),sequence=useRef(0),known=useRef(new Map<string,boolean>()),retry=useRef(new Set<string>()),latest=useRef(groups),onProblem=useRef(problem);
  latest.current=groups;onProblem.current=problem;
  const publish=useCallback(async(groupId:string,hasDraft:boolean,reason:DraftPresenceUpdate['reason']='edit',force=false)=>{
    if(!latest.current.find(g=>g.id===groupId)?.freeSettings?.waitForUserDraft)return;
    if(!force&&reason==='edit'&&known.current.get(groupId)===hasDraft)return;
    known.current.set(groupId,hasDraft);
    const body:DraftPresenceUpdate={clientId:client.current,sequence:++sequence.current,hasDraft,reason};
    try{await api('/api/groups/'+groupId+'/draft-presence','POST',body);retry.current.delete(groupId);}catch{retry.current.add(groupId);onProblem.current('输入等待状态同步失败，请检查连接；断线时 AI 最多等待 90 秒。');}
  },[api]);
  useEffect(()=>{
    const beat=()=>{for(const group of latest.current){const hasDraft=(drafts.current[group.id]?.length??0)>0;if(hasDraft||known.current.get(group.id)||retry.current.has(group.id))void publish(group.id,hasDraft,'edit',true);}};
    const leave=()=>{for(const [groupId,hasDraft] of known.current)if(hasDraft){const body:DraftPresenceUpdate={clientId:client.current,sequence:++sequence.current,hasDraft:false,reason:'leave'};void fetch('/api/groups/'+groupId+'/draft-presence',{method:'POST',credentials:'same-origin',keepalive:true,headers:{'Content-Type':'application/json','X-CSRF-Token':csrf.current},body:JSON.stringify(body)}).catch(()=>{});}};
    const timer=setInterval(beat,DRAFT_HEARTBEAT_MS);window.addEventListener('pagehide',leave);window.addEventListener('pageshow',beat);window.addEventListener('online',beat);document.addEventListener('visibilitychange',beat);
    return()=>{clearInterval(timer);leave();window.removeEventListener('pagehide',leave);window.removeEventListener('pageshow',beat);window.removeEventListener('online',beat);document.removeEventListener('visibilitychange',beat);};
  },[publish,drafts,csrf]);
  return publish;
}
