import type {Participant} from './types.js';
export function containsMention(content:string,name:string):boolean {
  const safe=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp(`(^|[\\s，,。！？!?：:；;（(])@${safe}(?=$|[\\s，,。！？!?：:；;）)])`,'u').test(content);
}
export function inferredMentions(content:string,members:Participant[],includeInactive=false):string[]{
  return members.filter(p=>(p.enabled||includeInactive)&&containsMention(content,p.name)&&members.filter(other=>(other.enabled||includeInactive)&&other.name===p.name).length===1).map(p=>p.id);
}
