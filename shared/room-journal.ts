export interface MemberUsage {
  memberId:string;author:string;model:string;providerId:string;connectionId:string;
  inputTokens:number;outputTokens:number;estimatedUSD:number;calls:number;uncertainCalls:number;unpricedCalls:number;reservedTokens:number;
  billingMode?:'api'|'subscription';
}
export interface RoomUsage {members:MemberUsage[];unattributedCalls:number;}
export type RoomLogKind='wake'|'model'|'protocol'|'waiting'|'published'|'error';
export interface RoomLogEntry {
  id:string;groupId:string;sessionId:string;memberId:string;author:string;model:string;createdAt:string;
  kind:RoomLogKind;summary:string;reasoning?:string;reasoningLabel?:string;inputTokens?:number;outputTokens?:number;
}
export type LogInput=Pick<RoomLogEntry,'kind'|'summary'|'reasoning'|'reasoningLabel'|'inputTokens'|'outputTokens'>;
