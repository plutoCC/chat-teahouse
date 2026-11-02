import {useEffect,useRef,useState,type MutableRefObject} from 'react';
import {Volume2,VolumeX,Pause,Play,SkipForward,Settings2,X} from 'lucide-react';
import type {GroupDetail,Message,Participant} from '../shared/types';
import type {LocalApi} from './SubscriptionPanel';
import {defaultVoice,spokenText,SpeechQueue,type VoicePreference,type SpeechState} from './speech';
import './speech.css';

const empty:SpeechState={author:'',messageId:'',pending:0,paused:false};
interface Preferences {allowRemote:boolean;members:Record<string,VoicePreference>;}
function readPreferences(key:string):Preferences{
  try{const value=JSON.parse(localStorage.getItem(key)??'{}'),members:Record<string,VoicePreference>={};
    for(const [id,p] of Object.entries(value.members??{}) as [string,any][]){if(p&&typeof p.voice==='string'&&p.voice.length<1000&&Number.isFinite(p.rate)&&p.rate>=0.5&&p.rate<=2&&Number.isFinite(p.volume)&&p.volume>=0&&p.volume<=1)members[id]={voice:p.voice,rate:p.rate,volume:p.volume};}
    return {allowRemote:value.allowRemote===true,members};
  }catch{return {allowRemote:false,members:{}};}
}
export function useBrowserSpeech(groupId:string,detail:GroupDetail|null,storageScope:string,api:LocalApi,csrf:MutableRefObject<string>){
  const supported=typeof window.speechSynthesis!=='undefined'&&typeof window.SpeechSynthesisUtterance!=='undefined';
  const storageKey='teahouse-speech-v1:'+storageScope;
  const [preferences,setPreferences]=useState(()=>readPreferences(storageKey));
  const [voices,setVoices]=useState<SpeechSynthesisVoice[]>([]),[state,setState]=useState(empty),[enabled,setEnabled]=useState(false),[error,setError]=useState(''),[settings,setSettings]=useState(false),[wait,setWait]=useState(false);
  const controller=useRef<SpeechQueue|null>(null),seen=useRef(new Set<string>()),room=useRef(''),ready=useRef(false);
  const current=useRef({preferences,voices,detail,groupId});current.current={preferences,voices,detail,groupId};
  const enableRef=useRef(false),waitRef=useRef(false);
  const presence=useRef({clientId:crypto.randomUUID(),sequence:0,groupId:'',holding:false});
  const presenceUpdate=useRef((holding:boolean,force=false)=>{});
  presenceUpdate.current=(holding:boolean,force=false)=>{
    const p=presence.current,id=current.current.groupId;if(!id||(!force&&p.groupId===id&&p.holding===holding))return;
    if(p.groupId&&p.groupId!==id&&p.holding)void api('/api/groups/'+p.groupId+'/playback-presence','POST',{clientId:p.clientId,sequence:++p.sequence,active:false}).catch(()=>{});
    p.groupId=id;p.holding=holding;
    void api('/api/groups/'+id+'/playback-presence','POST',{clientId:p.clientId,sequence:++p.sequence,active:holding}).catch(()=>{setError('朗读等待状态同步失败；断线后最多等待 90 秒自动解除。');});
  };
  useEffect(()=>{setPreferences(readPreferences(storageKey));},[storageKey]);
  const updatePreferences=(next:Preferences)=>{setPreferences(next);try{localStorage.setItem(storageKey,JSON.stringify(next));}catch{setError('浏览器无法保存朗读偏好，本次设置仍可使用。');}};
  useEffect(()=>{
    if(!supported)return;const synth=window.speechSynthesis;
    const refresh=()=>setVoices(synth.getVoices());refresh();synth.addEventListener('voiceschanged',refresh);
    const choose=(id:string)=>{const {voices,preferences}=current.current;const available=voices.filter(v=>preferences.allowRemote||v.localService);return id?available.find(v=>v.voiceURI===id):available.find(v=>v.localService&&/^zh\b/i.test(v.lang))??available.find(v=>/^zh\b/i.test(v.lang))??available.find(v=>v.default)??available[0];};
    controller.current=new SpeechQueue(synth,text=>new SpeechSynthesisUtterance(text),choose,next=>{setState(next);if(waitRef.current)presenceUpdate.current(next.pending>0);},message=>{setError(message);setEnabled(false);enableRef.current=false;});
    const leave=()=>{controller.current?.stop();enableRef.current=false;setEnabled(false);const p=presence.current;if(p.groupId)void fetch('/api/groups/'+p.groupId+'/playback-presence',{method:'POST',credentials:'same-origin',keepalive:true,headers:{'Content-Type':'application/json','X-CSRF-Token':csrf.current},body:JSON.stringify({clientId:p.clientId,sequence:++p.sequence,active:false})}).catch(()=>{});};
    const timer=setInterval(()=>{if(waitRef.current&&presence.current.holding)presenceUpdate.current(true,true);},15000);
    window.addEventListener('pagehide',leave);
    return()=>{leave();clearInterval(timer);synth.removeEventListener('voiceschanged',refresh);window.removeEventListener('pagehide',leave);controller.current=null;};
  },[supported,csrf]);
  useEffect(()=>{
    if(room.current!==groupId){controller.current?.stop();setEnabled(false);enableRef.current=false;setWait(false);waitRef.current=false;setError('');setSettings(false);seen.current.clear();ready.current=false;room.current=groupId;}
    if(!detail||detail.group.id!==groupId)return;
    if(!ready.current){detail.messages.forEach(m=>seen.current.add(m.id));ready.current=true;return;}
    const fresh=detail.messages.filter(m=>m.status==='complete'&&!seen.current.has(m.id));fresh.forEach(m=>seen.current.add(m.id));
    if(!enableRef.current)return;
    controller.current?.add(fresh.filter(m=>m.kind==='assistant'||m.kind==='summary').map(item));
  },[groupId,detail]);
  const memberKey=(p?:Participant)=>p?.profileId??`${groupId}:${p?.id??'default'}`;
  function item(m:Message){const p=current.current.detail?.group.participants.find(p=>p.id===m.participantId);return {id:m.id,author:m.author,text:spokenText(m.content),preference:current.current.preferences.members[p?.profileId??`${current.current.groupId}:${p?.id??'default'}`]??defaultVoice};}
  const toggle=()=>{setError('');const next=!enableRef.current;enableRef.current=next;setEnabled(next);if(!next)controller.current?.stop();else{detail?.messages.forEach(m=>seen.current.add(m.id));if(!voices.some(v=>preferences.allowRemote||v.localService)){enableRef.current=false;setEnabled(false);setError('当前没有可用声音。请打开朗读设置，检查本机中文语音。');setSettings(true);}}};
  const readFrom=(m:Message)=>{const messages=detail?.messages??[];const index=messages.findIndex(message=>message.id===m.id);if(index<0)return;setError('');controller.current?.stop();const selected=messages.slice(index).filter(message=>message.status==='complete');selected.forEach(message=>seen.current.add(message.id));const items=selected.map(item).filter(entry=>entry.text);if(!items.length){setError('从这条消息起没有可朗读的正文。');return;}controller.current?.add(items);};
  return {readFrom,supported,enabled,state,error,settings,setSettings,voices,preferences,updatePreferences,toggle,
    pause:()=>controller.current?.pause(),resume:()=>controller.current?.resume(),skip:()=>controller.current?.skip(),stop:()=>controller.current?.stop(),
    wait,setWait:(value:boolean)=>{waitRef.current=value;setWait(value);presenceUpdate.current(value&&state.pending>0);},memberKey,
    setMember:(p:Participant,value:VoicePreference)=>updatePreferences({...preferences,members:{...preferences.members,[memberKey(p)]:value}}),
    preview:(p:Participant)=>{controller.current?.stop();setError('');controller.current?.add([{id:'preview',author:p.name,text:`你好，我是${p.name}。这是我的朗读声音。`,preference:preferences.members[memberKey(p)]??defaultVoice}]);},
  };
}
export type BrowserSpeech=ReturnType<typeof useBrowserSpeech>;
export function SpeechControls({speech:s}:{speech:BrowserSpeech}){
  return <div className="speech-controls" aria-label="消息朗读控制"><button type="button" className="text-button" disabled={!s.supported} aria-pressed={s.enabled} onClick={s.toggle}>{s.enabled?<Volume2 size={15}/>:<VolumeX size={15}/>}自动朗读{s.enabled?'：开':'：关'}</button><button type="button" className="icon-button" aria-label="朗读设置" onClick={()=>s.setSettings(true)}><Settings2 size={15}/></button>
    {!s.supported&&<small>当前浏览器不支持语音朗读</small>}{s.error&&<small role="alert">{s.error}</small>}
  </div>;
}
export function SpeechSettings({speech:s,participants,free}:{speech:BrowserSpeech;participants:Participant[];free:boolean}){
  const available=s.voices.filter(v=>s.preferences.allowRemote||v.localService);
  return <div className="modal-form speech-settings"><p>声音、语速和音量仅保存在此浏览器；成员库中的同一成员跨群复用偏好。开启后只朗读新发布的 AI 正文，代码、链接、推理日志不会朗读。刷新或切群后需重新开启。</p>
    <label><input type="checkbox" checked={s.preferences.allowRemote} onChange={e=>{s.stop();s.updatePreferences({...s.preferences,allowRemote:e.target.checked});}}/>允许浏览器远程声音（待朗读文本会交给对应语音服务）</label>
    {available.length===0&&<p role="status">没有找到可用声音。请在系统中安装中文语音包并重新打开浏览器；不同设备、浏览器提供的音色可能不同。</p>}
    {free&&<label><input type="checkbox" checked={s.wait} onChange={e=>s.setWait(e.target.checked)}/>自主群聊等待此浏览器朗读完成后继续发送、唤醒</label>}
    <small>默认不改变讨论节奏。等待开启时，暂停朗读也会继续等待；关闭等待或停止朗读可解除。关闭页面或断线最多 90 秒自动解除。</small>
    {participants.map(p=>{const pref=s.preferences.members[s.memberKey(p)]??defaultVoice;return <fieldset key={p.id}><legend>{p.name}</legend><label className="field"><span>{p.name}的声音</span><select aria-label={`${p.name}的声音`} value={pref.voice} onChange={e=>s.setMember(p,{...pref,voice:e.target.value})}><option value="">自动选择（优先本地中文）</option>{pref.voice&&!available.some(v=>v.voiceURI===pref.voice)&&<option value={pref.voice}>已保存声音当前不可用，请重新选择</option>}{available.map(v=><option key={v.voiceURI} value={v.voiceURI}>{v.name} · {v.lang} · {v.localService?'本地':'远程'}</option>)}</select></label><div className="form-grid"><label className="field"><span>{p.name}的语速</span><input aria-label={`${p.name}的语速`} type="range" min="0.5" max="2" step="0.1" value={pref.rate} onChange={e=>s.setMember(p,{...pref,rate:Number(e.target.value)})}/><small>{pref.rate} 倍</small></label><label className="field"><span>{p.name}的音量</span><input aria-label={`${p.name}的音量`} type="range" min="0" max="1" step="0.1" value={pref.volume} onChange={e=>s.setMember(p,{...pref,volume:Number(e.target.value)})}/><small>{Math.round(pref.volume*100)}%</small></label></div><button type="button" className="secondary-button" disabled={!s.supported||!available.length} onClick={()=>s.preview(p)}>试听 {p.name}</button></fieldset>;})}
  </div>;
}

export function SpeechFloating({speech:s}:{speech:BrowserSpeech}){
  if(!s.enabled&&!s.state.pending)return null;
  return <aside className="speech-floating" aria-label="朗读悬浮控制窗"><div className="speech-float-title"><Volume2 size={16}/><span role="status">{s.state.pending?(s.state.paused?'朗读已暂停':`正在朗读 ${s.state.author}`):'自动朗读 · 等待新消息'}</span></div><small>待播 {s.state.pending} 条</small><div className="speech-float-actions"><button className="icon-button" disabled={!s.state.pending} aria-label={s.state.paused?'继续朗读':'暂停朗读'} onClick={s.state.paused?s.resume:s.pause}>{s.state.paused?<Play size={18}/>:<Pause size={18}/>}</button><button className="icon-button" disabled={!s.state.pending} aria-label="跳过当前消息" onClick={s.skip}><SkipForward size={18}/></button><button className="icon-button" aria-label="停止朗读并关闭自动朗读" onClick={()=>{s.stop();if(s.enabled)s.toggle();}}><X size={18}/></button></div></aside>;
}
