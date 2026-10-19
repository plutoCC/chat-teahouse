import { connectionKey, type ProviderConfig, type ProviderId } from '../shared/types.js';
import { chatModelId, referenceCatalog, type ModelCatalog, type ModelOption } from '../shared/model-catalog.js';
import { ModelCallError, readProviderFailure } from './model-errors.js';

const endpoints: Partial<Record<ProviderId, string>> = {
  openai: 'https://api.openai.com/v1/models', claude: 'https://api.anthropic.com/v1/models',
  deepseek: 'https://api.deepseek.com/models', ollama: 'http://127.0.0.1:11434/api/tags',
};
async function boundedJson(response: Response, signal: AbortSignal): Promise<any> {
  if (!response.body) throw new ModelCallError('模型列表为空。');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) { signal.throwIfAborted(); const { done, value } = await reader.read(); signal.throwIfAborted(); if (done) break; size += value.byteLength; if (size > 1024 * 1024) throw new ModelCallError('模型列表超过安全大小限制。'); chunks.push(value); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Only stored credentials and fixed official origins; no prompts or inference requests. */
export async function fetchModelCatalog(provider: ProviderConfig, apiKey?: string): Promise<ModelCatalog> {
  if (provider.id === 'demo') return referenceCatalog(provider);
  if (provider.id === 'doubao') return referenceCatalog(provider, '火山方舟官方文档参考列表。此连接未实现账号模型枚举；自建 ep- 接入点可在高级选项填写。');
  if (provider.id === 'qwen') return referenceCatalog(provider, '百炼官方文档参考列表。当前连接尚未配置枚举列表所需的业务空间信息；所选地域的开通权限以账户为准。');
  if (provider.id !== 'ollama' && !apiKey) return referenceCatalog(provider, '保存 API Key 后可读取账号官方列表；目前显示官方文档参考选项。');
  const signal = AbortSignal.timeout(12000);
  try {
    if (apiKey && /[\r\n]/.test(apiKey)) throw new ModelCallError('已保存的密钥格式无效，请重新配置。');
    const headers: Record<string, string> = provider.id === 'claude' ? { 'x-api-key': apiKey!, 'anthropic-version': '2023-06-01' } : provider.id === 'ollama' ? {} : { Authorization: `Bearer ${apiKey}` };
    const models = new Map<string, ModelOption>(); let cursor = ''; let partial = false;
    for (let page = 0; page < 5; page++) {
      const url = new URL(endpoints[provider.id]!);
      if (provider.id === 'claude') { url.searchParams.set('limit', '100'); if (cursor) url.searchParams.set('after_id', cursor); }
      const response = await fetch(url, { headers, redirect: 'error', signal });
      if (!response.ok) throw await readProviderFailure(response, provider.id);
      const body = await boundedJson(response, signal);
      const rows = provider.id === 'ollama' ? body?.models : body?.data;
      if (!Array.isArray(rows) || rows.length > 5000) throw new ModelCallError('官方模型列表格式异常。');
      for (const item of rows) {
        const id: unknown = provider.id === 'ollama' ? item?.model ?? item?.name : item?.id;
        if (!chatModelId(id, provider.id) || apiKey && id.includes(apiKey)) continue;
        const shutdown = item?.shutdown_date;
        if (typeof shutdown === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(shutdown) && shutdown <= new Date().toISOString().slice(0, 10)) continue;
        // Display only validated IDs; arbitrary names, owners, URLs and other fields stay server-side.
        models.set(id, { id, label: id });
        if (models.size >= 1000) { partial = true; break; }
      }
      if (partial || provider.id !== 'claude' || !body.has_more) break;
      if (!chatModelId(body.last_id, 'claude') || cursor === body.last_id) throw new ModelCallError('模型列表分页格式异常。');
      cursor = body.last_id; if (page === 4) partial = true;
    }
    return { providerId: provider.id, region: provider.region, source: provider.id === 'ollama' ? 'local' : 'account', models: [...models.values()], fetchedAt: new Date().toISOString(), partial, sourceUrl: referenceCatalog(provider).sourceUrl, message: `${partial ? '列表达到单次安全读取上限，当前展示部分选项。' : ''}${provider.id === 'ollama' ? '来自本机已下载模型。' : '来自已保存密钥的官方模型列表。'}仅展示文本对话候选；列表不保证余额充足或支持本群所需工具。刷新列表不会生成回答。` };
  } catch (error) {
    return referenceCatalog(provider, `${signal.aborted ? '读取官方列表超时。' : error instanceof ModelCallError ? error.message : '无法读取官方列表，请检查连接、密钥和代理。'} 当前显示官方文档参考选项，未修改已有模型。`);
  }
}

export class ModelCatalogService {
  private entries = new Map<string, { started: number; result: Promise<ModelCatalog> }>();
  constructor(private fetcher = fetchModelCatalog, private now = Date.now) {}
  invalidate(id: string) { for (const key of this.entries.keys()) if (key.startsWith(id + ':')) this.entries.delete(key); }
  load(provider: ProviderConfig, key?: string, refresh = false): Promise<ModelCatalog> {
    const cacheKey = `${connectionKey(provider)}:${provider.region}`, current = this.entries.get(cacheKey), now = this.now();
    if (current && now - current.started < (refresh ? 5000 : 300000)) return current.result;
    const result = this.fetcher(provider, key);
    this.entries.set(cacheKey, { started: now, result }); return result;
  }
}
