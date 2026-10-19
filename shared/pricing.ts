import type { ProviderConfig, ProviderId } from './types.js';

export const PRICE_CHECKED_AT = '2026-10-18';
// A user-editable estimate, deliberately not described as a live exchange quote.
export const DEFAULT_USD_CNY = 7;
export const validExchangeRate = (n: number) => Number.isFinite(n) && n >= 0.01 && n <= 100;
export interface PriceTier { label: string; input: number; output: number; }
export interface PriceReference {
  currency: 'USD' | 'CNY'; tiers: PriceTier[]; note: string; source?: string;
}
export const PRICE_SOURCES: Partial<Record<ProviderId, string>> = {
  openai: 'https://developers.openai.com/api/docs/pricing',
  claude: 'https://platform.claude.com/docs/en/about-claude/pricing',
  deepseek: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
  qwen: 'https://help.aliyun.com/zh/model-studio/model-pricing',
  doubao: 'https://console.volcengine.com/ark/region:cn-beijing/docs/model-pricing',
};
const tier = (label: string, input: number, output: number): PriceTier => ({ label, input, output });
interface Entry { provider: ProviderId; models: string[]; region?: 'cn' | 'intl'; price: PriceReference; }
// Exact aliases/snapshots only: a custom model or ep-* ID must never inherit another model's price.
const entries: Entry[] = [
  { provider: 'openai', models: ['gpt-4.1-mini', 'gpt-4.1-mini-2025-04-14'], price: { currency: 'USD', tiers: [tier('标准文本调用', 0.4, 1.6)], note: '标准在线价格，输入按未缓存计。', source: 'https://developers.openai.com/api/docs/models/gpt-4.1-mini' } },
  { provider: 'openai', models: ['gpt-6.1-sol'], price: { currency: 'USD', tiers: [tier('单次输入 ≤ 272K', 2, 10), tier('单次输入 > 272K', 4, 15)], note: '标准在线调用；长上下文档位按整次请求计价。', source: 'https://developers.openai.com/api/docs/models/gpt-6.1-sol' } },
  { provider: 'claude', models: ['claude-sonnet-4-5', 'claude-sonnet-4-5-20250929'], price: { currency: 'USD', tiers: [tier('标准文本 · ≤ 200K 上下文', 3, 15)], note: '基础标准价格；长上下文、缓存写入等另计，超出本档位请核对官方报价。' } },
  { provider: 'claude', models: ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'], price: { currency: 'USD', tiers: [tier('标准文本调用', 1, 5)], note: '标准在线价格；不含缓存写入等附加费用。' } },
  { provider: 'claude', models: ['claude-opus-4-5', 'claude-opus-4-5-20251101'], price: { currency: 'USD', tiers: [tier('标准文本调用', 5, 25)], note: '标准在线价格；不含缓存写入等附加费用。' } },
  { provider: 'deepseek', models: ['deepseek-flash', 'deepseek-v4-flash'], price: { currency: 'CNY', tiers: [tier('高峰时段 · 输入未缓存', 2, 8), tier('非高峰时段 · 输入未缓存', 1, 4)], note: '北京时间工作日（不含法定节假日）9–12 时、14–18 时为高峰；默认展示较高费率，缓存命中另有折扣。' } },
  { provider: 'deepseek', models: ['deepseek-v4-pro'], price: { currency: 'CNY', tiers: [tier('高峰时段 · 输入未缓存', 9, 27), tier('非高峰时段 · 输入未缓存', 4.5, 13.5)], note: '北京时间工作日（不含法定节假日）9–12 时、14–18 时为高峰；缓存命中另有折扣。' } },
  { provider: 'qwen', models: ['qwen-plus', 'qwen-plus-2025-12-01'], region: 'cn', price: { currency: 'CNY', tiers: [tier('北京 · 非思考 · 输入 ≤ 128K', 0.8, 2), tier('北京 · 思考 · 输入 ≤ 128K', 0.8, 8), tier('北京 · 非思考 · 128K < 输入 ≤ 256K', 2.4, 20), tier('北京 · 思考 · 128K < 输入 ≤ 256K', 2.4, 24), tier('北京 · 非思考 · 256K < 输入 ≤ 1M', 4.8, 48), tier('北京 · 思考 · 256K < 输入 ≤ 1M', 4.8, 64)], note: '按单次请求输入长度及实际思考模式选择；这里选择报价不会改变模型的思考参数。' } },
  { provider: 'qwen', models: ['qwen-plus', 'qwen-plus-2025-12-01'], region: 'intl', price: { currency: 'CNY', tiers: [tier('新加坡 · 非思考 · 输入 ≤ 256K', 2.936, 8.807), tier('新加坡 · 思考 · 输入 ≤ 256K', 2.936, 29.357), tier('新加坡 · 非思考 · 256K < 输入 ≤ 1M', 8.807, 26.421), tier('新加坡 · 思考 · 256K < 输入 ≤ 1M', 8.807, 88.071)], note: '国际部署报价，按单次请求输入长度及实际思考模式选择。' } },
  { provider: 'doubao', models: ['doubao-seed-2-1-lite-260915'], price: { currency: 'CNY', tiers: [tier('常规在线 · 输入 ≤ 1024K', 0.8, 2.7)], note: '豆包 Seed 2.1 Lite，北京 API；不含低延迟、批量、音视频或缓存计费。' } },
  { provider: 'doubao', models: ['doubao-seed-2-1-pro-260915'], price: { currency: 'CNY', tiers: [tier('常规在线 · 输入 ≤ 1024K', 6, 30)], note: '豆包 Seed 2.1 Pro，北京 API；不含低延迟、批量、音视频或缓存计费。' } },
  { provider: 'doubao', models: ['doubao-seed-2-1-turbo-260628'], price: { currency: 'CNY', tiers: [tier('常规在线 · 输入 ≤ 256K', 3, 15)], note: '豆包 Seed 2.1 Turbo，北京 API；不含低延迟、批量、音视频或缓存计费。' } },
  { provider: 'doubao', models: ['doubao-seed-2-0-lite-260428'], price: { currency: 'CNY', tiers: [tier('常规在线 · 输入 ≤ 32K', 0.6, 3.6), tier('常规在线 · 32K < 输入 ≤ 128K', 0.9, 5.4), tier('常规在线 · 128K < 输入 ≤ 256K', 1.8, 10.8)], note: '豆包 Seed 2.0 Lite，北京 API；档位由单次请求输入长度决定。' } },
];

export function referenceFor(provider: Pick<ProviderConfig, 'id' | 'model' | 'region'>): PriceReference | undefined {
  if (provider.id === 'demo' || provider.id === 'ollama') return { currency: 'CNY', tiers: [tier('本地运行 · 无 API 服务费', 0, 0)], note: provider.id === 'demo' ? '预设演示内容，不调用真实模型。' : 'Ollama 本地模型不收 API 服务费；硬件、电力及部署成本未计入。' };
  const entry = entries.find(e => e.provider === provider.id && e.models.includes(provider.model.trim()) && (!e.region || e.region === provider.region));
  return entry ? { ...entry.price, source: entry.price.source ?? PRICE_SOURCES[provider.id] } : undefined;
}
export const suggestedModels = (provider: ProviderId) => [...new Set(entries.filter(e => e.provider === provider).flatMap(e => e.models))];

export function toCny(amount: number, currency: 'USD' | 'CNY', rate: number): number {
  if (!Number.isFinite(amount) || amount < 0 || !validExchangeRate(rate)) throw new Error('金额或估算汇率无效');
  return currency === 'USD' ? amount * rate : amount;
}
export function cnyToUsd(amount: number, rate: number): number {
  if (!Number.isFinite(amount) || amount < 0 || !validExchangeRate(rate)) throw new Error('金额或估算汇率无效');
  return amount / rate;
}
export function estimateCny(inputMillions: number, outputMillions: number, inputRateCny: number, outputRateCny: number) {
  if ([inputMillions, outputMillions, inputRateCny, outputRateCny].some(n => !Number.isFinite(n) || n < 0 || n > 1e9)) return null;
  const input = inputMillions * inputRateCny, output = outputMillions * outputRateCny;
  return { input, output, total: input + output };
}
const formatter = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
export const formatCny = (amount: number) => `¥${formatter.format(amount)}`;
export const displayNumber = (n: number) => Number(n.toFixed(6));
