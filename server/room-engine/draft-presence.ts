import {DRAFT_CLEAR_GRACE_MS,DRAFT_LEASE_MS,type DraftPresenceUpdate} from '../../shared/typing.js';

/** Only presence is stored, never draft text. Sequence numbers prevent delayed heartbeats from re-locking a room. */
export class DraftPresence {
  private rooms=new Map<string,Map<string,{sequence:number;hasDraft:boolean;expiresAt:number;clearUntil:number}>>();
  constructor(private now=Date.now){}
  update(groupId:string,update:DraftPresenceUpdate){
    const now=this.now();
    for(const [id,clients] of this.rooms){for(const [client,state] of clients)if(state.expiresAt+600000<now)clients.delete(client);if(!clients.size)this.rooms.delete(id);}
    const clients=this.rooms.get(groupId)??new Map();
    const old=clients.get(update.clientId);if(old&&update.sequence<=old.sequence)return;
    if(!old&&clients.size>=64)throw new Error('Too many draft clients');
    const hasDraft=update.hasDraft&&update.reason==='edit';
    clients.set(update.clientId,{sequence:update.sequence,hasDraft,expiresAt:now+DRAFT_LEASE_MS,clearUntil:hasDraft||update.reason==='sent'?0:old?.hasDraft?now+DRAFT_CLEAR_GRACE_MS:old?.clearUntil??0});this.rooms.set(groupId,clients);
  }
  status(groupId:string){
    const now=this.now();let until=0,hasDraft=false;
    for(const state of this.rooms.get(groupId)?.values()??[]){if(state.hasDraft&&state.expiresAt>now){hasDraft=true;until=Math.max(until,state.expiresAt);}else until=Math.max(until,state.clearUntil);}
    return {until,hasDraft};
  }
}
