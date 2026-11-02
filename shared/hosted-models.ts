import type { ProviderConfig } from './types.js';

/** Undefined preserves the previously published default; [] explicitly closes sharing. */
export function sharedModelIds(provider: ProviderConfig): string[] {
  return [...new Set(provider.sharedModels ?? [provider.model])];
}

export function modelPrice(provider: ProviderConfig, model: string) {
  return provider.modelPrices?.[model] ?? (model === provider.model
    ? { inputPrice: provider.inputPrice, outputPrice: provider.outputPrice }
    : undefined);
}

export function hasHostedPrice(provider: ProviderConfig, model: string): boolean {
  const price = modelPrice(provider, model);
  return !!price && [price.inputPrice, price.outputPrice].every(n => Number.isFinite(n) && n > 0 && n <= 10000);
}

/** Public metadata only. Never publish subscriptions, demos, local services or unpriced models. */
export function projectHostedProvider(provider: ProviderConfig): ProviderConfig | undefined {
  if (!provider.enabled || !provider.hasKey || provider.billingMode === 'subscription' ||
      !['openai', 'claude', 'deepseek', 'qwen', 'doubao'].includes(provider.id)) return;
  const models = sharedModelIds(provider).filter(model => hasHostedPrice(provider, model));
  if (!models.length) return;
  const model = models.includes(provider.model) ? provider.model : models[0];
  return {
    id: provider.id, name: provider.name, model, enabled: true, hasKey: true,
    ...(provider.connectionId ? { connectionId: provider.connectionId } : {}),
    ...(provider.label ? { label: provider.label } : {}),
    region: provider.region, billingMode: 'api', ...modelPrice(provider, model)!,
    sharedModels: models,
    modelPrices: Object.fromEntries(models.map(id => [id, modelPrice(provider, id)!])),
  };
}
