import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { fetchModelCatalog, ModelCatalogService } from '../server/model-catalog.js';
import { referenceCatalog } from '../shared/model-catalog.js';
import { PROVIDER_DEFAULTS } from '../server/providers.js';
import type { ProviderId } from '../shared/types.js';
import { buildApp } from '../server/app.js';

const provider = (id: ProviderId) => ({ ...PROVIDER_DEFAULTS.find(p => p.id === id)! });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test('official list uses only fixed origins, stored key and GET; filters unrelated and malformed models', async t => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL, options: RequestInit) => {
    calls.push(String(url)); assert.equal(options.method ?? 'GET', 'GET'); assert.equal(options.body, undefined);
    assert.equal(options.redirect, 'error'); assert.equal((options.headers as any).Authorization, 'Bearer fixture-key');
    return json({ data: [
      { id: 'gpt-6.1-sol', owned_by: 'private-owner', display_name: 'secret-name' }, { id: 'gpt-6.1-sol' }, { id: 'o3' },
      { id: 'gpt-image-1' }, { id: 'gpt-live-1' }, { id: 'gpt-audio' }, { id: 'text-embedding-3-small' },
      { id: 'gpt-retired', shutdown_date: '2000-01-01' }, { id: 'https://foreign.example' }, { id: '<script>' },
      { id: 'gpt-fixture-key' }, { id: 'gpt-' + 'x'.repeat(200) }, null,
    ] });
  });
  const result = await fetchModelCatalog(provider('openai'), 'fixture-key');
  assert.deepEqual(calls, ['https://api.openai.com/v1/models']); assert.equal(result.source, 'account');
  assert.deepEqual(result.models.map(m => m.id), ['gpt-6.1-sol', 'o3']);
  assert.doesNotMatch(JSON.stringify(result), /fixture-key|private-owner|secret-name/);
});

test('Claude pagination and Ollama local tags have their own formats and credentials', async t => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL, options: RequestInit) => {
    calls.push(String(url));
    if (url.hostname === '127.0.0.1') { assert.deepEqual(options.headers, {}); return json({ models: [{ name: 'qwen3:8b' }, { model: 'nomic-embed-text:latest' }] }); }
    assert.equal((options.headers as any)['x-api-key'], 'fixture-key'); assert.equal((options.headers as any).Authorization, undefined);
    if (!url.searchParams.has('after_id')) return json({ data: [{ id: 'claude-sonnet-4-5' }], has_more: true, last_id: 'claude-sonnet-4-5' });
    assert.equal(url.searchParams.get('after_id'), 'claude-sonnet-4-5');
    return json({ data: [{ id: 'claude-haiku-4-5' }], has_more: false });
  });
  const result = await fetchModelCatalog(provider('claude'), 'fixture-key');
  assert.equal(result.source, 'account'); assert.equal(result.models.length, 2);
  const local = await fetchModelCatalog(provider('ollama'));
  assert.equal(local.source, 'local'); assert.deepEqual(local.models.map(m => m.id), ['qwen3:8b']);
  assert.equal(calls.length, 3); assert.equal(calls[2], 'http://127.0.0.1:11434/api/tags');
});

test('DeepSeek list and empty official list stay distinct from reference fallback', async t => {
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    assert.equal(String(url), 'https://api.deepseek.com/models');
    return json({ data: [{ id: 'deepseek-flash' }, { id: 'unrelated-model' }] });
  });
  assert.deepEqual((await fetchModelCatalog(provider('deepseek'), 'fixture-key')).models.map(m => m.id), ['deepseek-flash']);
  t.mock.method(globalThis, 'fetch', async () => json({ data: [] }));
  const empty = await fetchModelCatalog(provider('openai'), 'fixture-key');
  assert.equal(empty.source, 'account'); assert.deepEqual(empty.models, []);
});

test('missing key and documentation-only providers never make a network request', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
  for (const id of ['demo', 'openai', 'claude', 'deepseek', 'qwen', 'doubao'] as const) {
    const result = await fetchModelCatalog(provider(id), id === 'qwen' || id === 'doubao' ? 'fixture-key' : undefined);
    assert.equal(result.source, id === 'demo' ? 'demo' : 'reference'); assert.ok(result.models.length > 0);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('upstream errors never leak response bodies, keys or private account details', async t => {
  t.mock.method(globalThis, 'fetch', async () => json({ error: { code: 'insufficient_quota', message: 'private-account fixture-key' } }, 429));
  let result = await fetchModelCatalog(provider('openai'), 'fixture-key');
  assert.equal(result.source, 'reference'); assert.match(result.message, /额度/); assert.doesNotMatch(JSON.stringify(result), /private-account|fixture-key/);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('private-proxy-password'); });
  result = await fetchModelCatalog(provider('openai'), 'fixture-key');
  assert.match(result.message, /无法读取官方列表/); assert.doesNotMatch(JSON.stringify(result), /private-proxy-password/);
});

test('oversized and invalid model lists are bounded and fall back safely', async t => {
  for (const body of [{ data: Array(5001).fill({ id: 'gpt-a' }) }, { data: 'invalid' }, { data: [], padding: 'x'.repeat(1024 * 1024) }]) {
    t.mock.method(globalThis, 'fetch', async () => json(body));
    const result = await fetchModelCatalog(provider('openai'), 'fixture-key');
    assert.equal(result.source, 'reference'); assert.match(result.message, /安全大小限制|格式异常/);
  }
});

test('catalog caches and throttles refreshes, separates regions and invalidates replaced credentials', async () => {
  let now = 0, calls = 0;
  const service = new ModelCatalogService(async p => { calls++; return referenceCatalog(p); }, () => now);
  const p = provider('openai');
  await Promise.all([service.load(p, 'a'), service.load(p, 'a'), service.load(p, 'a', true)]); assert.equal(calls, 1);
  now = 5001; await service.load(p, 'a'); assert.equal(calls, 1);
  await service.load(p, 'a', true); assert.equal(calls, 2);
  await service.load({ ...p, region: 'intl' }, 'a'); assert.equal(calls, 3);
  service.invalidate('openai'); await service.load(p, 'b'); assert.equal(calls, 4);
  now += 300001; await service.load(p, 'b'); assert.equal(calls, 5);
});

test('models endpoint protects credentials, validates input and never changes saved models or regions', async t => {
  const root = resolve('.test-artifacts'); mkdirSync(root, { recursive: true }); const dataDir = mkdtempSync(join(root, 'model-catalog-'));
  const inputs: { key?: string; region: string }[] = [];
  const runtime = await buildApp({ dataDir, port: 48761, production: true, serveUI: false, modelCatalogFetcher: async (p, key) => { inputs.push({ key, region: p.region }); return referenceCatalog(p); } });
  t.after(async () => { await runtime.app.close(); assert.equal(lstatSync(dataDir).isSymbolicLink(), false); const target = realpathSync(dataDir); assert.equal(dirname(target), realpathSync(root)); assert.ok(basename(target).startsWith('model-catalog-')); rmSync(target, { recursive: true, force: true }); });
  const host = '127.0.0.1:48761'; const boot = (await runtime.app.inject({ url: '/api/bootstrap', headers: { host } })).json();
  const headers = { host, origin: `http://${host}`, 'x-csrf-token': boot.csrfToken };
  const url = '/api/providers/openai/models';
  assert.equal((await runtime.app.inject({ method: 'POST', url, headers: { host }, payload: {} })).statusCode, 403);
  assert.equal((await runtime.app.inject({ method: 'POST', url, headers, payload: { endpoint: 'https://foreign.example', apiKey: 'draft' } })).statusCode, 400);
  assert.equal((await runtime.app.inject({ method: 'POST', url: '/api/providers/unknown/models', headers, payload: {} })).statusCode, 404);
  const update = (apiKey: string) => runtime.app.inject({ method: 'PUT', url: '/api/providers/openai', headers, payload: { apiKey } });
  assert.equal((await update('fixture-key-1')).statusCode, 200);
  const original = runtime.store.providers().find(p => p.id === 'openai')!;
  const response = await runtime.app.inject({ method: 'POST', url, headers, payload: { region: 'intl', refresh: true } });
  assert.equal(response.statusCode, 200); assert.doesNotMatch(response.body, /fixture-key/); assert.match(response.headers['cache-control']!, /no-store/);
  assert.deepEqual(inputs, [{ key: 'fixture-key-1', region: 'intl' }]);
  assert.deepEqual(runtime.store.providers().find(p => p.id === 'openai'), original);
  await update('fixture-key-2'); await runtime.app.inject({ method: 'POST', url, headers, payload: { region: 'intl' } });
  assert.equal(inputs[1].key, 'fixture-key-2'); assert.equal(inputs.length, 2);
});
