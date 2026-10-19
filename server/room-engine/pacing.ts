import { setTimeout as sleep } from 'node:timers/promises';

/** Reading time is charged once for the preceding bubble, including the final bubble. */
export function readingSeconds(content:string,charsPerSecond=0):number {
  return charsPerSecond>0?Math.min(90,Array.from(content.trim()).length/charsPerSecond):0;
}
export function segmentDelayMs(content:string,charsPerSecond=0):number {
  return Math.max(1,readingSeconds(content,charsPerSecond))*1000;
}

/** Serialize public delivery, not reasoning. Re-check typing, cancellation and new human input before commit. */
export class PublicationGate {
  private tails=new Map<string,Promise<unknown>>();
  constructor(private now=Date.now){}
  busy(groupId:string){return this.tails.has(groupId);}
  run<T>(groupId:string,signal:AbortSignal,due:()=>number,publish:()=>T|Promise<T>):Promise<T>{
    const previous=this.tails.get(groupId)??Promise.resolve();
    const result=previous.catch(()=>{}).then(async()=>{
      signal.throwIfAborted();
      while(due()>this.now()){await sleep(Math.min(1000,due()-this.now()),undefined,{signal});signal.throwIfAborted();}
      signal.throwIfAborted();return publish();
    });
    const tail=result.then(()=>{},()=>{}).finally(()=>{if(this.tails.get(groupId)===tail)this.tails.delete(groupId);});
    this.tails.set(groupId,tail);return result;
  }
}
