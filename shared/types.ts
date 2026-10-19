import type { FreeChatSettings, FreeSession, SkillSummary } from './free-chat.js';
import type {RoomUsage} from './room-journal.js';
export type ProviderId = 'demo' | 'openai' | 'claude' | 'deepseek' | 'qwen' | 'doubao' | 'ollama';
export interface ProviderConfig {
  id: ProviderId; name: string; model: string; hasKey: boolean; enabled: boolean;
  connectionId?: string; label?: string;
  region: 'cn' | 'intl'; inputPrice: number; outputPrice: number;
  modelPrices?:Record<string,{inputPrice:number;outputPrice:number}>;
  billingMode?:'api'|'subscription';
}
export const connectionKey = (p: ProviderConfig) => p.connectionId ?? p.id;
export const memberConnection = (p: Participant) => p.connectionId ?? p.providerId;
export function resolveConnection(configs: ProviderConfig[], p: Participant) {
  const c=configs.find(c=>connectionKey(c)===memberConnection(p)&&c.id===p.providerId);if(!c)return;
  const price=c.billingMode==='subscription'?{inputPrice:0,outputPrice:0}:(c.modelPrices&&Object.hasOwn(c.modelPrices,p.model)?c.modelPrices[p.model]:c.modelPrices?{inputPrice:0,outputPrice:0}:{inputPrice:c.inputPrice,outputPrice:c.outputPrice});
  return {...c,...price,model:p.model};
}
export interface Sticker { id:string; name:string; tags:string[]; assetId:string; createdAt:string; deletedAt?:string; }
export interface StickerAttachment { id:string; name:string; tags:string[]; assetId:string; }
export interface Participant { id: string; profileId?: string; profileRevision?: number; connectionId?: string; name: string; providerId: ProviderId; model: string; role: string; avatar: string; avatarAssetId?: string; color: string; enabled: boolean; identityMode?: 'native' | 'role'; channel?: 'api' | 'browser'; skills?: string[]; }
export type ProfileFields = Omit<Participant, 'id' | 'profileId' | 'profileRevision' | 'enabled'>;
export interface MemberProfile extends ProfileFields { id: string; revision: number; createdAt: string; updatedAt: string; deletedAt?: string; }
/** Explicit allowlist keeps membership flags and private runtime state out of global identities. */
export function profileFields(p: ProfileFields): ProfileFields {
  return { name:p.name, providerId:p.providerId, model:p.model, role:p.role, avatar:p.avatar, ...(p.connectionId?{connectionId:p.connectionId}:{}), ...(p.avatarAssetId?{avatarAssetId:p.avatarAssetId}:{}), color:p.color, identityMode:p.identityMode??(p.role.trim()?'role':'native'), channel:p.channel??'api', skills:[...(p.skills??[])] };
}
export function profileParticipant(profile: MemberProfile, id: string, enabled = true): Participant {
  return {...profileFields(profile),id,profileId:profile.id,profileRevision:profile.revision,enabled};
}
// Old saved members retain their existing role; explicitly native members ignore even a saved role draft.
export const identityModeOf = (p: Participant): 'native' | 'role' => p.identityMode ?? (p.role.trim() ? 'role' : 'native');
export const WEB_CHAT_URLS: Partial<Record<ProviderId, string>> = {openai:'https://chatgpt.com/',claude:'https://claude.ai/',deepseek:'https://chat.deepseek.com/',qwen:'https://chat.qwen.ai/'};
export type WebProviderId = 'openai' | 'claude' | 'deepseek' | 'qwen';
export interface BrowserProgress { phase: 'opening' | 'sending' | 'reading' | 'paused'; message: string; sent: boolean; }
export interface BrowserSelectors { composer: string; send: string; response: string; busy: string; done: string; reasoning: string; }
export interface BrowserProfile { providerId: WebProviderId; state: 'closed' | 'opening' | 'open' | 'busy'; selectors: BrowserSelectors; }
export interface PendingWebTurn { requestId: string; participantId: string; prompt: string; url: string; createdAt: string; inputMessageIds: string[]; liveMessageIds: string[]; round: number; summary: boolean; browser?: BrowserProgress; }
export interface DiscussionSettings {
  contextMode: 'round' | 'sequential'; order: 'fixed' | 'random';
  roundsMode: 'fixed' | 'random'; rounds: number; roundsMin: number; roundsMax: number;
  delayMode: 'fixed' | 'random'; delaySeconds: number; delayMin: number; delayMax: number;
  maxOutputTokens: number; maxCalls: number; maxTotalTokens: number; budgetUSD: number;
  autoSummary: boolean; summaryParticipantId: string;
}
export interface Group { id: string; name: string; goal: string; createdAt: string; updatedAt: string; archived: boolean; participants: Participant[]; settings: DiscussionSettings; conversationMode?: 'round' | 'free'; freeSettings?: FreeChatSettings; }
export interface GroupSettingsTemplate { conversationMode:'round'|'free';settings:DiscussionSettings;freeSettings:FreeChatSettings; }
export interface Message {
  id: string; groupId: string; runId?: string; participantId?: string;
  author: string; avatar: string; avatarAssetId?: string; color: string; providerId?: ProviderId; model?: string;
  kind: 'user' | 'assistant' | 'summary' | 'import'; content: string; reasoning: string; reasoningLabel: string;
  round: number; status: 'streaming' | 'complete' | 'stopped' | 'failed';
  createdAt: string; inputMessageIds: string[]; inputTokens: number; outputTokens: number;
  source?: 'api' | 'web' | 'browser'; sticker?: StickerAttachment;
  discussionMode?: 'free'; replyTo?: string; runtime?: 'deepseek-harness';
  speech?: {id:string;index:number;total:number;state:'sending'|'complete'|'interrupted'};
  mentions?:string[];
}
export interface Run {
  id: string; groupId: string; goal: string; status: 'running' | 'waiting' | 'awaiting_web' | 'failed' | 'completed' | 'cancelled' | 'interrupted';
  createdAt: string; finishedAt?: string; chosenRounds: number; currentRound: number; turnCount: number;
  nextSpeakerId?: string; nextAt?: string; error?: string; inputTokens: number; outputTokens: number;
  estimatedUSD: number; settings: DiscussionSettings; participants: Participant[];
  baseMessageIds: string[]; roundStartMessageIds: string[]; roundOrder: string[]; nextIndex: number;
  summaryDone: boolean; targetId?: string; summaryOnly?: boolean;
  pendingWeb?: PendingWebTurn;
}
export interface GroupDetail { group: Group; messages: Message[]; runs: Run[]; activeRun: Run | null; freeSession?: FreeSession | null; usage?:RoomUsage; }
export interface Bootstrap { csrfToken: string; groups: Group[]; profiles?: MemberProfile[]; deletedProfiles?: MemberProfile[]; stickers?: Sticker[]; providers: ProviderConfig[]; skills?: SkillSummary[]; security: { localOnly: boolean; vault: string; version: string }; }
export interface StreamDelta { content?: string; reasoning?: string; reasoningLabel?: string; }
export interface CompletionRequest {
  provider: ProviderConfig; apiKey?: string; participant: Participant; goal: string;
  roster: string; history: Message[]; round: number; summary: boolean; maxOutputTokens: number;
  signal: AbortSignal; onDelta: (delta: StreamDelta) => void;
}
export interface CompletionResult { inputTokens: number; outputTokens: number; }
export const defaultSettings: DiscussionSettings = {
  contextMode:'round',order:'fixed',roundsMode:'fixed',rounds:2,roundsMin:2,roundsMax:4,
  delayMode:'fixed',delaySeconds:2,delayMin:1,delayMax:5,maxOutputTokens:1200,
  maxCalls:32,maxTotalTokens:80000,budgetUSD:2,autoSummary:true,summaryParticipantId:''
};
