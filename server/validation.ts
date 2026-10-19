import { z } from 'zod';

export const providerIdSchema = z.enum(['demo', 'openai', 'claude', 'deepseek', 'qwen', 'doubao', 'ollama']);
export const modelListSchema = z.object({region:z.enum(['cn','intl']).optional(),refresh:z.boolean().optional()}).strict();
export const idSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
export const avatarAssetIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const avatarUploadSchema = z.object({data:z.string().min(4).max(2796204).regex(/^[A-Za-z0-9+/]*={0,2}$/).refine(v=>v.length%4===0,'图片编码不完整')}).strict();
export const profileRevisionSchema = z.object({expectedRevision:z.number().int().min(1)}).strict();
const text = (limit: number) => z.string().max(limit).refine(value => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value), '文本含有不支持的控制字符');
const shortText = (limit: number) => z.string().trim().min(1).max(limit).regex(/^[^\u0000-\u001F\u007F]+$/);
const modelSchema = shortText(128).refine(v=>!['__proto__','constructor','prototype'].includes(v),'模型名称无效');

const participantObject = z.object({
  id: idSchema,
  profileId: idSchema.optional(),
  profileRevision: z.number().int().min(1).optional(),
  connectionId: idSchema.optional(),
  name: shortText(80),
  providerId: providerIdSchema,
  model: modelSchema,
  role: text(2000),
  identityMode: z.enum(['native', 'role']).optional(),
  channel: z.enum(['api', 'browser']).optional(),
  avatar: z.string().trim().min(1).max(4).regex(/^[^\u0000-\u0020\u007F<>/\\:]+$/),
  avatarAssetId: avatarAssetIdSchema.optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  enabled: z.boolean(),
  skills: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)).max(8).optional(),
}).strict();
const supportsChannel=(p:{channel?:string;providerId:string})=>p.channel!=='browser'||['openai','claude','deepseek','qwen'].includes(p.providerId);
export const participantSchema = participantObject.refine(supportsChannel, '该服务不支持网页连接');
export const profileFieldsSchema = participantObject.omit({id:true,profileId:true,profileRevision:true,enabled:true}).refine(supportsChannel,'该服务不支持网页连接');
export const createProfileSchema = z.object({profile:profileFieldsSchema,groupId:idSchema.optional()}).strict();
export const updateProfileSchema = z.object({profile:profileFieldsSchema,expectedRevision:z.number().int().min(1)}).strict();
export const inviteProfileSchema = z.object({profileId:idSchema}).strict();

export const settingsSchema = z.object({
  contextMode: z.enum(['round', 'sequential']),
  order: z.enum(['fixed', 'random']),
  roundsMode: z.enum(['fixed', 'random']),
  rounds: z.number().int().min(1).max(12),
  roundsMin: z.number().int().min(1).max(12),
  roundsMax: z.number().int().min(1).max(12),
  delayMode: z.enum(['fixed', 'random']),
  delaySeconds: z.number().min(0).max(300),
  delayMin: z.number().min(0).max(300),
  delayMax: z.number().min(0).max(300),
  maxOutputTokens: z.number().int().min(128).max(8192),
  maxCalls: z.number().int().min(1).max(128),
  maxTotalTokens: z.number().int().min(1000).max(1_000_000),
  budgetUSD: z.number().min(0).max(1000),
  autoSummary: z.boolean(),
  summaryParticipantId: z.union([z.literal(''), idSchema]),
}).strict().superRefine((settings, ctx) => {
  if (settings.roundsMin > settings.roundsMax) ctx.addIssue({ code: 'custom', path: ['roundsMax'], message: '最大轮数不能小于最小轮数' });
  if (settings.delayMin > settings.delayMax) ctx.addIssue({ code: 'custom', path: ['delayMax'], message: '最大间隔不能小于最小间隔' });
});

const participantsSchema = z.array(participantSchema).max(8).superRefine((participants, ctx) => {
  if (new Set(participants.map(p => p.id)).size !== participants.length) {
    ctx.addIssue({ code: 'custom', message: '成员 ID 不能重复' });
  }
});

export const freeSettingsSchema = z.object({
  messageStyle:z.enum(['segmented','single']).optional(),
  messageGapMin:z.number().min(0).max(300).optional(),
  messageGapMax:z.number().min(0).max(300).optional(),
  readingCharsPerSecond:z.number().min(0).max(60).optional(),
  typingGraceSeconds:z.number().min(0).max(60).optional(),
  allowStickers:z.boolean().optional(),
  stickerCooldownSeconds:z.number().min(0).max(600).optional(),
  quietSeconds: z.number().min(0).max(30),
  cooldownMin: z.number().min(1).max(300),
  cooldownMax: z.number().min(1).max(300),
  concurrency: z.number().int().min(1).max(4),
  maxMinutes: z.number().int().min(1).max(120),
  wakeProbability: z.number().min(0).max(1),
  respondToAI: z.boolean(),
}).strict().refine(s => s.cooldownMax >= s.cooldownMin, '最长冷却不能小于最短冷却').refine(s=>(s.messageGapMax??3)>=(s.messageGapMin??1),'最长发言间隔不能小于最短间隔');
export const freeStartSchema = z.object({ reset: z.boolean().optional() }).strict();
export const groupTemplateSchema = z.object({conversationMode:z.enum(['round','free']),settings:settingsSchema,freeSettings:freeSettingsSchema}).strict();
export const skillImportSchema = z.object({ markdown: text(24000).min(1) }).strict();

export const createGroupSchema = z.object({
  name: shortText(80),
  goal: text(8000).default(''),
  participants: participantsSchema.optional(),
  profileIds: z.array(idSchema).max(8).refine(ids=>new Set(ids).size===ids.length,'不能重复邀请同一成员').optional(),
  settings: settingsSchema.optional(),
  conversationMode: z.enum(['round', 'free']).optional(),
  freeSettings: freeSettingsSchema.optional(),
}).strict().refine(v=>!(v.participants&&v.profileIds),'请选择成员档案或完整成员配置，不可同时提交');

export const patchGroupSchema = z.object({
  name: shortText(80).optional(),
  goal: text(8000).optional(),
  archived: z.boolean().optional(),
  participants: participantsSchema.optional(),
  settings: settingsSchema.optional(),
  conversationMode: z.enum(['round', 'free']).optional(),
  freeSettings: freeSettingsSchema.optional(),
}).strict().refine(value => Object.keys(value).length > 0, '请提供至少一个要修改的字段');

export const messageSchema = z.object({
  content: text(16_000).refine(value => value.trim().length > 0, '消息不能为空'),
  mentions:z.array(idSchema).max(16).optional(),
}).strict();

export const runSchema = z.object({
  targetId: idSchema.optional(),
  summaryOnly: z.boolean().optional(),
}).strict().refine(v=>!(v.targetId&&v.summaryOnly),'点名发言和单独总结不能同时选择');

export const browserRequestSchema = z.object({requestId:idSchema}).strict();
export const webProviderSchema = z.enum(['openai','claude','deepseek','qwen']);
export const emptyBodySchema = z.object({}).strict();
const selector = z.string().trim().max(800).refine(v=>!/[\u0000-\u001F]/.test(v),'选择器不能含控制字符');
export const browserSelectorsSchema = z.object({composer:selector.min(1),send:selector.min(1),response:selector.min(1),busy:selector.min(1),done:selector.min(1),reasoning:selector}).strict();

export const connectionCreateSchema = z.object({providerId:providerIdSchema.refine(id=>!['demo','ollama'].includes(id)),label:shortText(40)}).strict();
export const providerUpdateSchema = z.object({
  label: shortText(40).optional(),
  model: modelSchema.optional(),
  enabled: z.boolean().optional(),
  region: z.enum(['cn', 'intl']).optional(),
  billingMode:z.enum(['api','subscription']).optional(),
  modelPrices:z.record(modelSchema,z.object({inputPrice:z.number().min(0).max(10000),outputPrice:z.number().min(0).max(10000)}).strict()).refine(v=>Object.keys(v).length<=100,'最多配置 100 个模型价格').optional(),
  inputPrice: z.number().min(0).max(10_000).optional(),
  outputPrice: z.number().min(0).max(10_000).optional(),
  apiKey: z.string().trim().min(1).max(4096).regex(/^[^\u0000-\u0020\u007F]+$/).nullable().optional(),
}).strict().refine(value => Object.keys(value).length > 0, '请提供至少一个要修改的字段');
