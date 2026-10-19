import type { Group, Participant, ProviderConfig, StickerAttachment } from '../../shared/types.js';
import type { SkillSummary, MemberActivity } from '../../shared/free-chat.js';
import type {LogInput} from '../../shared/room-journal.js';

export interface Delivery {
  messages: {seq:number;id:string;author:string;participantId?:string;kind:string;content:string;senderKind?:'human'|'ai'|'import'|'system';replyTo?:string;sticker?:Pick<StickerAttachment,'id'|'name'|'tags'>;speech?:{id:string;index:number;total:number;state:string}}[];
  pendingSpeech?: {memberId:string};
  readThroughSeq: number;
  more: boolean;
}
export interface RuntimeWake {
  sessionId: string;
  group: Group;
  participant: Participant;
  provider: ProviderConfig;
  apiKey?: string;
  signal: AbortSignal;
  firstWake: boolean;
  memberStates?: {id:string;status:MemberActivity}[];
  skills: SkillSummary[];
  assertActive(): void;
  read(limit?: number): Delivery;
  post(content: string, replyTo: string | undefined, toolCallId: string, stickerId?:string): unknown;
  listStickers?(): {id:string;name:string;tags:string[]}[];
  outputLimit?(ticket:string):number;
  wait(seconds: number,reason?:string): unknown;
  log?(entry:LogInput):void;
  attention(mode: 'all'|'mentions'): unknown;
  loadSkill(id: string): unknown;
  activity(text: string): void;
  reserve(input: number, output: number): string;
  settle(ticket: string, usage?: {inputTokens:number;outputTokens:number}): void;
}
export interface ParticipantRuntime { run(wake: RuntimeWake): Promise<void>; shutdown(): Promise<void>; }
