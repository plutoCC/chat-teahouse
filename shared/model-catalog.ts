import type { ProviderConfig, ProviderId } from './types.js';
import { suggestedModels } from './pricing.js';

export interface ModelOption { id: string; label: string; }
export interface ModelCatalog {
  providerId: ProviderId; region: 'cn' | 'intl'; source: 'account' | 'reference' | 'local' | 'demo';
  models: ModelOption[]; fetchedAt?: string; checkedAt?: string; sourceUrl?: string; message: string; partial?: boolean;
}
export const MODEL_SOURCES: Partial<Record<ProviderId, string>> = {
  openai: 'https://developers.openai.com/api/docs/models/all',
  claude: 'https://platform.claude.com/docs/en/api/models/list',
  deepseek: 'https://api-docs.deepseek.com/api/list-models/',
  qwen: 'https://help.aliyun.com/zh/model-studio/models',
  doubao: 'https://console.volcengine.com/ark/region:cn-beijing/docs/model-list',
  ollama: 'https://docs.ollama.com/api/tags',
};
const featured: Partial<Record<ProviderId, string[]>> = {
  openai: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol'],
  deepseek: ['deepseek-flash', 'deepseek-v4-pro'],
  qwen: ['qwen3.8-max', 'qwen3.7-plus', 'qwen3.8-flash'],
};
export function referenceCatalog(provider: Pick<ProviderConfig, 'id' | 'region'>, message?: string): ModelCatalog {
  const ids = provider.id === 'demo' ? ['demo-roundtable'] : provider.id === 'ollama' ? [] : [...new Set([...(featured[provider.id] ?? []), ...suggestedModels(provider.id)])];
  return { providerId: provider.id, region: provider.region, source: provider.id === 'demo' ? 'demo' : 'reference', models: ids.map(id => ({ id, label: id })), checkedAt: '2026-10-19', sourceUrl: MODEL_SOURCES[provider.id], message: message ?? (provider.id === 'demo' ? '本地演示，无真实模型调用。' : provider.id === 'ollama' ? '启动 Ollama 并下载模型后，刷新本机列表。' : '官方文档参考选项，非完整账号列表；开通权限、地区及工具支持以实际账户为准。') };
}

// Models APIs may also list image/audio/embedding models that this text group cannot call.
export function chatModelId(id: unknown, provider: ProviderId): id is string {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(id) || id.includes('://')) return false;
  if (/(?:^|[-_])(embedding|embed|rerank|tts|whisper|transcribe|moderation|realtime|live|audio|image|instruct)(?:[-_]|$)/i.test(id)) return false;
  if (provider === 'openai') return /^(?:gpt-|chatgpt-|o[1-9](?:-|$)|ft:gpt-)/.test(id);
  if (provider === 'claude') return id.startsWith('claude-');
  if (provider === 'deepseek') return id.startsWith('deepseek-');
  return true;
}
