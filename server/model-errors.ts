import type { ProviderId } from '../shared/types.js';

export class ModelCallError extends Error {}
export type ResponseFailureKind = 'output_limit' | 'content_filter' | 'unavailable' | 'aborted' | 'incomplete';
export interface ReturnedReasoning {text:string;label:string;}
/** Partial tool output is discarded. Returned reasoning is non-enumerable and only used by the local journal. */
export class ModelResponseError extends ModelCallError {
  declare readonly returnedReasoning?:ReturnedReasoning;
  constructor(message: string, readonly kind: ResponseFailureKind, readonly usage?: {inputTokens:number;outputTokens:number},returnedReasoning?:ReturnedReasoning) { super(message);Object.defineProperty(this,'returnedReasoning',{value:returnedReasoning,enumerable:false}); }
}
export type FailureKind = 'quota' | 'rate_limit' | 'auth' | 'model' | 'request' | 'unavailable' | 'unknown';
export class ProviderRequestError extends ModelCallError {
  constructor(message: string, readonly kind: FailureKind, readonly status: number, readonly notGenerated: boolean, readonly retryAfterMs?: number) { super(message); }
}

// Ark error codes: https://docs.volcengine.com/docs/ark/error-codes?lang=zh
// Only fixed known codes and our own explanations enter logs, never upstream messages/account IDs.
const arkRateLimits:Record<string,string>={
  'RateLimitExceeded.EndpointRPMExceeded':'接入点每分钟请求数（RPM）',
  'RateLimitExceeded.EndpointTPMExceeded':'接入点每分钟 Token 数（TPM）',
  'RateLimitExceeded.EndpointFlexTPMExceeded':'接入点 Flex Token 速率',
  ModelAccountRpmRateLimitExceeded:'账号当前模型的每分钟请求数（RPM）',
  ModelAccountTpmRateLimitExceeded:'账号当前模型的每分钟 Token 数（TPM）',
  ModelAccountFlexTpmRateLimitExceeded:'账号当前模型的 Flex Token 速率',
  APIAccountRpmRateLimitExceeded:'账号当前接口的每分钟请求数（RPM）',
  ModelAccountIpmRateLimitExceeded:'账号当前模型的每分钟图片数（IPM）',
  InflightBatchsizeExceeded:'并发请求数',
  AccountRateLimitExceeded:'账号请求或 Token 速率',
  RequestBurstTooFast:'突发流量保护',
  ServerOverloaded:'服务负载保护',
};

/** Return only recognized categories, never upstream messages, IDs, URLs or account information. */
export function classifyProviderFailure(status: number, payload: unknown, provider: ProviderId, retryAfter?: string | null, now = Date.now()): ProviderRequestError {
  const raw = payload && typeof payload === 'object' ? (payload as any).error : undefined;
  const code = typeof raw?.code === 'string' ? raw.code : '';
  const type = typeof raw?.type === 'string' ? raw.type : '';
  const label = provider === 'openai' ? 'OpenAI API' : provider === 'doubao' ? '豆包 · 火山方舟' : '模型服务';
  const delay = parseRetryAfter(retryAfter, now);
  if(provider==='doubao'&&status===429){
    if(code==='SetLimitExceeded')return new ProviderRequestError(`${label} 已达到供应商侧设置的模型或接入点用量上限（HTTP 429 / SetLimitExceeded），推理服务已暂停。请在火山方舟控制台的「开通管理」检查模型用量上限及「安心体验模式」；使用接入点时也检查接入点用量上限。这不是茶馆的 Token 上限，也不代表 API Key 失效；调整前请确认可接受的费用。本程序不会自动重试或修改供应商限额。`,'quota',status,true);
    if(code==='ModelAccountTpdRateLimitExceeded')return new ProviderRequestError(`${label} 当前模型的每日 Token 配额已达到上限（HTTP 429 / ModelAccountTpdRateLimitExceeded）。请等待供应商配额重置或在控制台申请调整；本程序不会短间隔自动重试。`,'quota',status,true);
    if(code==='QuotaExceeded.AgentPlanQuotaExceeded')return new ProviderRequestError(`${label} Agent Plan 套餐额度已耗尽（HTTP 429 / QuotaExceeded.AgentPlanQuotaExceeded）。请在供应商控制台检查套餐额度；本程序不会自动重试。`,'quota',status,true);
    if(code==='QuotaExceeded'||code==='AccountQuotaExceeded')return new ProviderRequestError(`${label} 额度或任务配额受限（HTTP 429 / ${code}）。该错误码可能涉及试用/套餐额度或排队任务配额，不能仅据此判定现金余额耗尽；请在火山方舟控制台核对当前模型服务、套餐及任务配额。本程序不会自动重试。`,'quota',status,true);
    if(Object.hasOwn(arkRateLimits,code))return new ProviderRequestError(`${label} 触发${arkRateLimits[code]}限制（HTTP 429 / ${code}）。${delay!==undefined?`至少等待 ${Math.ceil(delay/1000)} 秒后再试。`:'请降低并发与发送频率，稍后再试。'}这不代表密钥失效或现金余额耗尽。`,'rate_limit',status,true,delay);
  }
  const quotaCodes = ['insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded', 'organization_usage_limit_exceeded', 'project_spend_limit_exceeded', 'billing_hard_limit_reached'];
  if (status === 429 && (quotaCodes.includes(code) || type === 'insufficient_quota')) {
    const detail = code === 'credit_balance_exhausted' ? '预付余额已耗尽' : code === 'organization_spend_limit_exceeded' || code === 'project_spend_limit_exceeded' ? '已达到组织或项目支出上限' : code === 'organization_usage_limit_exceeded' ? '已达到组织的 API 使用额度上限' : '可用额度不足或已达到账单上限';
    return new ProviderRequestError(`${label} ${detail}（HTTP 429）。请在供应商 API 账单与限额中处理后再继续；更换模型名称不能补足额度，本程序不会自动重试。${provider === 'openai' ? 'ChatGPT 订阅与 API 余额分别计费。' : ''}`, 'quota', status, true);
  }
  if (status === 429 && (['rate_limit_exceeded', 'slow_down'].includes(code) || type === 'rate_limit_error')) {
    return new ProviderRequestError(`${label} 暂时达到请求或 Token 速率限制（HTTP 429）。${delay !== undefined ? `至少等待 ${Math.ceil(delay / 1000)} 秒后再试。` : '请降低并发与唤醒频率，稍后再试。'}这不等于密钥无效或余额耗尽。`, 'rate_limit', status, true, delay);
  }
  if (status === 429) return new ProviderRequestError(`${label} 拒绝请求（HTTP 429），但未返回可识别的限流或额度错误码。请核对 API 账单及速率限制；为避免反复请求，已暂停该成员。`, 'unknown', status, true);
  if (status === 401 || status === 403) return new ProviderRequestError(`模型服务拒绝访问（HTTP ${status}）。请检查 API Key、项目权限及服务地区。`, 'auth', status, true);
  if (status === 404 || code === 'model_not_found') return new ProviderRequestError(`模型或接口不可用（HTTP ${status}）。请核对成员实际使用的模型 ID 和模型访问权限。`, 'model', status, status >= 400 && status < 500);
  if (status === 400 || status === 422) return new ProviderRequestError(`模型请求参数不被支持（HTTP ${status}）。请检查所选模型的输出上限与工具调用能力。`, 'request', status, true);
  return new ProviderRequestError(`模型服务请求失败（HTTP ${status}）。服务可能暂时不可用，请稍后检查连接；未自动重发。`, status >= 500 ? 'unavailable' : 'unknown', status, false);
}

export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return;
  const text = value.trim();
  const delay = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) * 1000 : /^[A-Za-z]{3},/.test(text) ? Date.parse(text) - now : NaN;
  if (!Number.isFinite(delay)) return;
  // Do not shorten a long server delay to our automatic retry window.
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(delay)));
}

export async function readProviderFailure(response: Response, provider: ProviderId): Promise<ProviderRequestError> {
  let payload: unknown; const reader = response.body?.getReader(); let timer: ReturnType<typeof setTimeout> | undefined;
  if (reader) {
    try {
      const reading = (async () => {
        const chunks: Uint8Array[] = []; let length = 0;
        while (true) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > 16384) return undefined; chunks.push(value); }
        try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return undefined; }
      })();
      payload = await Promise.race([reading, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 1500); })]);
    } catch { /* Incomplete error bodies still produce a safe HTTP diagnostic. */ }
    finally { clearTimeout(timer); void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  return classifyProviderFailure(response.status, payload, provider, response.headers.get('retry-after'));
}
