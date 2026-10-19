export interface DraftPresenceUpdate {clientId:string;sequence:number;hasDraft:boolean;reason:'edit'|'sent'|'leave';}
export const DRAFT_HEARTBEAT_MS=15000;
export const DRAFT_LEASE_MS=90000;
export const DRAFT_CLEAR_GRACE_MS=3000;
