import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, realpathSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { buildApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { PROVIDER_DEFAULTS } from '../server/providers.js';
import { nativeRequest, parseNativeReply } from '../server/runtime-adapters/native-model.js';
import { participantSchema } from '../server/validation.js';

test('upgrade adds Doubao without resetting saved settings; encrypted key and real Harness skill continuation survive restart', { timeout: 30000 }, async t => {
  const root = resolve('.test-artifacts'); mkdirSync(root, { recursive: true }); const dataDir = mkdtempSync(join(root, 'doubao-'));
  const old = new Store(dataDir); old.seed(PROVIDER_DEFAULTS.filter(p => p.id !== 'doubao'));
  old.saveProvider({ ...old.providers().find(p => p.id === 'openai')!, enabled: true, inputPrice: 0.123, model: 'previous-custom-model' }); old.close();
  let calls = 0;
  const options = { dataDir, port: 4399, production: true, serveUI: false, nativeGenerate: async (options: Parameters<typeof nativeRequest>[0], provider: Parameters<typeof nativeRequest>[1], key: string | undefined) => {
    calls++; assert.equal(provider.id, 'doubao'); assert.equal(key, 'test-ark-only-not-a-real-key');
    const body = nativeRequest(options, provider, key).body as any;
    if (calls === 2) { assert.equal(body.messages.find((m: any) => m.role === 'assistant').encrypted_content, 'signed-private-ark'); assert.ok(body.messages.some((m: any) => m.role === 'tool')); }
    return parseNativeReply({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, encrypted_content: 'signed-private-ark', tool_calls: [{ id: `ark-${calls}`, type: 'function', function: { name: calls === 1 ? 'load_skill' : 'post_message', arguments: JSON.stringify(calls === 1 ? { id: 'argument-check' } : { content: '豆包本地模拟：读取技能后参与讨论' }) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }, provider, 100, 100);
  } };
  let runtime = await buildApp(options);
  t.after(async () => { await runtime.app.close(); assert.equal(lstatSync(dataDir).isSymbolicLink(), false); const target = realpathSync(dataDir); assert.equal(dirname(target), realpathSync(root)); assert.ok(basename(target).startsWith('doubao-')); rmSync(target, { recursive: true, force: true }); });
  assert.equal(runtime.store.providers().filter(p => p.id === 'doubao').length, 1);
  assert.equal(runtime.store.providers().find(p => p.id === 'openai')!.inputPrice, 0.123);
  assert.equal(runtime.store.providers().find(p => p.id === 'openai')!.enabled, true);
  assert.equal(runtime.store.providers().find(p => p.id === 'openai')!.model, 'previous-custom-model');
  const host = '127.0.0.1:4399', boot = (await runtime.app.inject({ url: '/api/bootstrap', headers: { host } })).json();
  const headers = { host, origin: `http://${host}`, 'x-csrf-token': boot.csrfToken };
  const saved = await runtime.app.inject({ method: 'PUT', url: '/api/providers/doubao', headers, payload: { apiKey: 'test-ark-only-not-a-real-key', enabled: true, inputPrice: 0.8 / 7, outputPrice: 2.7 / 7 } });
  assert.equal(saved.statusCode, 200); assert.doesNotMatch(saved.body, /test-ark-only/);
  for (const name of readdirSync(dataDir).filter(n => /secrets|master/.test(n))) assert.ok(!readFileSync(join(dataDir, name)).includes('test-ark-only-not-a-real-key'));
  const group = runtime.store.groups()[0]; group.participants = [{ ...group.participants[0], providerId: 'doubao', model: 'doubao-seed-2-1-lite-260915', skills: ['argument-check'] }];
  assert.equal(participantSchema.safeParse(group.participants[0]).success, true);
  assert.equal(participantSchema.safeParse({ ...group.participants[0], channel: 'browser' }).success, false);
  runtime.store.saveGroup(group); runtime.roomEngine.start(group.id);
  const deadline = Date.now() + 10000; while (!runtime.store.messages(group.id).length) { assert.ok(Date.now() < deadline); await new Promise(done => setTimeout(done, 20)); }
  runtime.roomEngine.pause(group.id); await runtime.roomEngine.settle(group.id);
  assert.equal(calls, 2); const message = runtime.store.messages(group.id)[0]; assert.match(message.reasoning, /读取技能/); assert.doesNotMatch(JSON.stringify(message), /signed-private-ark/);
  await runtime.app.close(); runtime = await buildApp(options);
  assert.equal(runtime.vault.get('doubao'), 'test-ark-only-not-a-real-key'); assert.equal(runtime.store.providers().find(p => p.id === 'doubao')!.enabled, true); assert.equal(calls, 2);
});
