export interface FreeChatSettings {
  messageStyle?: 'segmented' | 'single';
  messageGapMin?: number;
  messageGapMax?: number;
  readingCharsPerSecond?: number;
  typingGraceSeconds?: number;
  waitForUserDraft?: boolean;
  allowStickers?: boolean;
  stickerCooldownSeconds?: number;
  quietSeconds: number;
  cooldownMin: number;
  cooldownMax: number;
  concurrency: number;
  maxMinutes: number;
  wakeProbability: number;
  respondToAI: boolean;
}
export const defaultFreeSettings: FreeChatSettings = {
  messageStyle:'segmented', messageGapMin:1, messageGapMax:3, readingCharsPerSecond:0, typingGraceSeconds:2,
  waitForUserDraft:false,
  allowStickers:true, stickerCooldownSeconds:60,
  quietSeconds: 1, cooldownMin: 2, cooldownMax: 5,
  concurrency: 2, maxMinutes: 30, wakeProbability: 1, respondToAI: true,
};
export type MemberActivity = 'listening' | 'queued' | 'sending' | 'thinking' | 'waiting' | 'retrying' | 'budget_wait' | 'error' | 'paused';
export interface FreeMemberState {
  id: string;
  sessionId: string;
  fingerprint: string;
  acknowledgedSeq: number;
  deliveredSeq: number;
  consideredSeq: number;
  status: MemberActivity;
  attention: 'all' | 'mentions';
  cooldownUntil: number;
  wakeAt?: number;
  lastStartedAt: number;
  error?: string;
  activity?: string;
  queuedUntil?: number;
  retryAt?: number;
  rateLimitRetries?: number;
}
export interface FreeSession {
  sending?: {memberId:string;speechId:string;sent:number;total:number};
  nextPublishAt?: number;
  lastStickerAt?: number;
  budgetNotice?: string;
  id: string;
  groupId: string;
  status: 'active' | 'paused' | 'interrupted' | 'limit';
  epoch: number;
  createdAt: string;
  deadline: number;
  updatedAt: string;
  callCount: number;
  publishedCount: number;
  inputTokens: number;
  outputTokens: number;
  reservedTokens: number;
  estimatedUSD: number;
  reservedUSD: number;
  uncertainCalls: number;
  admissionClosed?: boolean;
  error?: string;
  members: FreeMemberState[];
}
export interface RoomEvent { seq: number; messageId: string; participantId?: string; createdAt: number; }
export interface SkillDefinition { id: string; name: string; description: string; instructions: string; builtin: boolean; }
export interface SkillSummary { id: string; name: string; description: string; builtin: boolean; }
