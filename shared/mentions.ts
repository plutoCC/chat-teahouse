import type {Participant} from './types.js';
export function containsMention(content:string,name:string):boolean {
  const safe=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp(`(^|[\\s，,。！？!?：:；;（(])@${safe}(?=$|[\\s，,。！？!?：:；;）)])`,'u').test(content);
}
export function inferredMentions(content:string,members:Participant[]):string[]{
  return members.filter(p=>p.enabled&&containsMention(content,p.name)&&members.filter(other=>other.enabled&&other.name===p.name).length===1).map(p=>p.id);
}
