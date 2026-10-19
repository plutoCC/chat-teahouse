import {useId,useRef,useState} from 'react';
import type {Participant} from '../shared/types';
import {containsMention} from '../shared/mentions';
import {Avatar} from './Avatar';

export function MentionInput({value,change,members,disabled,placeholder,send,picked,onPicked}:{value:string;change:(s:string)=>void;members:Participant[];disabled:boolean;placeholder:string;send:()=>void;picked:string[];onPicked:(ids:string[])=>void}) {
  const ref=useRef<HTMLTextAreaElement>(null),listId=useId();
  const [cursor,setCursor]=useState(value.length),[dismissed,setDismissed]=useState(false),[index,setIndex]=useState(0),[composing,setComposing]=useState(false);
  const prefix=value.slice(0,cursor),match=/(?:^|[\s，,。！？!?：:；;（(])@([^@\n]*)$/.exec(prefix);
  const start=match?cursor-match[1].length-1:-1;
  const options=match&&!dismissed&&!composing?members.filter(p=>p.enabled&&p.name.toLocaleLowerCase().includes(match[1].toLocaleLowerCase())):[];
  const active=Math.min(index,Math.max(0,options.length-1));
  const select=(p:Participant)=>{
    const next=value.slice(0,start)+'@'+p.name+' '+value.slice(cursor),position=start+p.name.length+2;
    change(next);onPicked([...new Set([...picked.filter(id=>members.some(m=>m.id===id&&containsMention(next,m.name))),p.id])]);
    setDismissed(true);setCursor(position);requestAnimationFrame(()=>{ref.current?.focus();ref.current?.setSelectionRange(position,position);});
  };
  return <div className="mention-composer">
    {!!options.length&&<div className="mention-picker" role="listbox" id={listId} aria-label="可提及成员"><div className="mention-picker-hint">选择成员 · ↑↓ 切换 · Enter 确认</div>{options.map((p,i)=><button key={p.id} id={`${listId}-${i}`} type="button" role="option" aria-selected={active===i} onMouseDown={e=>e.preventDefault()} onClick={()=>select(p)}><Avatar person={p}/><span><strong>{p.name}</strong><small>{p.model} · {p.id.slice(0,6)}</small></span></button>)}</div>}
    <textarea ref={ref} value={value} onChange={e=>{change(e.target.value);setCursor(e.target.selectionStart);setDismissed(false);setIndex(0);onPicked(picked.filter(id=>members.some(m=>m.id===id&&containsMention(e.target.value,m.name))));}} onSelect={e=>setCursor(e.currentTarget.selectionStart)} onCompositionStart={()=>setComposing(true)} onCompositionEnd={()=>setComposing(false)} placeholder={placeholder} aria-label="输入讨论问题" aria-controls={options.length?listId:undefined} aria-expanded={!!options.length} aria-autocomplete="list" aria-activedescendant={options.length?`${listId}-${active}`:undefined} disabled={disabled} maxLength={16000} onKeyDown={e=>{
      if(e.nativeEvent.isComposing||composing)return;
      if(options.length){
        if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();setIndex((active+(e.key==='ArrowDown'?1:-1)+options.length)%options.length);return;}
        if((e.key==='Enter'&&!e.shiftKey)||e.key==='Tab'){e.preventDefault();select(options[active]);return;}
        if(e.key==='Escape'){e.preventDefault();setDismissed(true);return;}
      }
      if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}
    }}/>
  </div>;
}
