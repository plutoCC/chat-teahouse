import type { ProviderConfig } from '../../shared/types.js';
import { referenceCatalog } from '../../shared/model-catalog.js';

/** All browser fixtures stay offline, including automatic model-list reads. */
export async function fixtureModelCatalog(provider: ProviderConfig) {
  const result = referenceCatalog(provider);
  if (provider.id === 'openai') {
    result.source = 'account';
    result.message = '本地测试模型列表，未访问外部供应商。';
    result.models.push(...['fixture-talk', 'fixture-quiet', 'fixture-model', 'unsaved-draft'].map(id => ({ id, label: id })));
  }
  return result;
}
