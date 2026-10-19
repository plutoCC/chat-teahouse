import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { installSecurity } from '../server/security.js';
import { createGroupSchema, messageSchema, participantSchema, patchGroupSchema, providerUpdateSchema, runSchema, settingsSchema } from '../server/validation.js';
import { defaultSettings } from '../shared/types.js';

function fixture(production = true) {
  const app = Fastify();
  const { csrfToken } = installSecurity(app, { port: 4317, production });
  app.get('/api/bootstrap', async () => ({ csrfToken }));
  app.post('/api/groups', async () => ({ ok: true }));
  app.get('/assets/app.js', async (_, reply) => reply.type('application/javascript').send('export {};'));
  app.get('/api/raw', (_, reply) => { reply.hijack(); reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream' }); reply.raw.end('data: {}\n\n'); });
  app.get('/dev.html', (_, reply) => { reply.hijack(); reply.raw.setHeader('Content-Type', 'text/html'); reply.raw.end('<!doctype html><title>Development</title>'); });
  return { app, csrfToken };
}

test('local page can read API and send authenticated mutations', async t => {
  const { app, csrfToken } = fixture();
  t.after(() => app.close());
  const get = await app.inject({ url: '/api/bootstrap', headers: { host: '127.0.0.1:4317' } });
  assert.equal(get.statusCode, 200);
  assert.equal(get.json().csrfToken, csrfToken);
  assert.equal(get.headers['cache-control'], 'no-store');
  assert.equal(get.headers['access-control-allow-origin'], undefined);
  assert.equal(get.headers['referrer-policy'], 'no-referrer');
  assert.equal(get.headers['x-content-type-options'], 'nosniff');
  assert.match(String(get.headers['content-security-policy']), /frame-ancestors 'none'/);
  assert.match(String(get.headers['content-security-policy']), /script-src 'self';/);
  const post = await app.inject({ method: 'POST', url: '/api/groups', headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', 'x-csrf-token': csrfToken } });
  assert.equal(post.statusCode, 200);
  const localCli = await app.inject({ method: 'POST', url: '/api/groups', headers: { host: 'localhost:4317', 'x-csrf-token': csrfToken } });
  assert.equal(localCli.statusCode, 200);
});

test('DNS rebinding and forwarded-host spoofing cannot read bootstrap', async t => {
  const { app } = fixture();
  t.after(() => app.close());
  for (const host of ['attacker.test:4317', '127.0.0.1.attacker.test:4317', 'localhost', '127.0.0.1:80', 'localhost:4317@attacker.test', '[::1]:4317']) {
    const res = await app.inject({ url: '/api/bootstrap', headers: { host, 'x-forwarded-host': 'localhost:4317' } });
    assert.equal(res.statusCode, 403, host);
  }
});

test('cross-origin reads and writes are blocked even with a valid token', async t => {
  const { app, csrfToken } = fixture();
  t.after(() => app.close());
  for (const origin of ['https://attacker.test', 'null', 'http://localhost:4317', 'http://127.0.0.1:4318', 'https://127.0.0.1:4317']) {
    for (const method of ['GET', 'POST'] as const) {
      const response = await app.inject({ method, url: method === 'GET' ? '/api/bootstrap' : '/api/groups', headers: { host: '127.0.0.1:4317', origin, 'x-csrf-token': csrfToken } });
      assert.equal(response.statusCode, 403, `${method} ${origin}`);
    }
  }
  const crossSite = await app.inject({ url: '/api/bootstrap', headers: { host: 'localhost:4317', 'sec-fetch-site': 'cross-site' } });
  assert.equal(crossSite.statusCode, 403);
});

test('mutations require the process-specific CSRF token', async t => {
  const { app, csrfToken } = fixture();
  t.after(() => app.close());
  for (const token of [undefined, '', 'guess', 'x'.repeat(csrfToken.length), `${csrfToken}x`]) {
    const response = await app.inject({ method: 'POST', url: '/api/groups', headers: { host: '127.0.0.1:4317', ...(token === undefined ? {} : { 'x-csrf-token': token }) } });
    assert.equal(response.statusCode, 403);
  }
});

test('encoded API path prefixes cannot bypass origin or CSRF checks', async t => {
  const { app, csrfToken } = fixture();
  t.after(() => app.close());
  for (const path of ['/%61pi', '/a%70i', '/ap%69']) {
    const blockedWrite = await app.inject({ method: 'POST', url: `${path}/groups`, headers: { host: 'localhost:4317' } });
    assert.equal(blockedWrite.statusCode, 403, path);
    const blockedRead = await app.inject({ url: `${path}/bootstrap`, headers: { host: 'localhost:4317', origin: 'https://attacker.test' } });
    assert.equal(blockedRead.statusCode, 403, path);
    const allowed = await app.inject({ method: 'POST', url: `${path}/groups`, headers: { host: 'localhost:4317', 'x-csrf-token': csrfToken } });
    assert.equal(allowed.statusCode, 200, path);
  }
});

test('authenticated mutation bursts are bounded while reads remain available', async t => {
  const { app, csrfToken } = fixture();
  t.after(() => app.close());
  for (let i = 0; i < 120; i++) {
    const response = await app.inject({ method: 'POST', url: '/api/groups', headers: { host: '127.0.0.1:4317', 'x-csrf-token': csrfToken } });
    assert.equal(response.statusCode, 200);
  }
  const blocked = await app.inject({ method: 'POST', url: '/api/groups', headers: { host: '127.0.0.1:4317', 'x-csrf-token': csrfToken } });
  assert.equal(blocked.statusCode, 429);
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  assert.equal((await app.inject({ url: '/api/bootstrap', headers: { host: '127.0.0.1:4317' } })).statusCode, 200);
});

test('development assets and same-origin HMR are allowed without weakening production scripts', async t => {
  const { app } = fixture(false);
  t.after(() => app.close());
  const response = await app.inject({ url: '/assets/app.js', headers: { host: 'localhost:4317' } });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers['content-security-policy']), /ws:\/\/localhost:4317/);
});

test('security headers survive hijacked SSE and development middleware responses', async t => {
  const { app } = fixture(false);
  t.after(() => app.close());
  for (const url of ['/api/raw', '/dev.html']) {
    const response = await app.inject({ url, headers: { host: 'localhost:4317' } });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['content-security-policy']), /frame-ancestors 'none'/);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    if (url.startsWith('/api/')) assert.equal(response.headers['cache-control'], 'no-store');
  }
});

test('discussion controls enforce finite limits and ordered random ranges', () => {
  assert.equal(settingsSchema.safeParse(defaultSettings).success, true);
  assert.equal(settingsSchema.safeParse({ ...defaultSettings, budgetUSD: 0, delaySeconds: 0 }).success, true);
  for (const change of [{ rounds: 0 }, { rounds: 13 }, { roundsMin: 5, roundsMax: 2 }, { delayMin: 20, delayMax: 10 }, { delaySeconds: -1 }, { delaySeconds: 301 }, { delaySeconds: Infinity }, { maxCalls: 129 }, { maxCalls: 1.5 }, { maxOutputTokens: 8193 }, { maxTotalTokens: 999 }, { maxTotalTokens: 1_000_001 }, { budgetUSD: -1 }, { budgetUSD: NaN }, { budgetUSD: 1001 }]) {
    assert.equal(settingsSchema.safeParse({ ...defaultSettings, ...change }).success, false, JSON.stringify(change));
  }
});

test('group and message input reject oversized content and unexpected fields', () => {
  assert.deepEqual(createGroupSchema.parse({ name: '茶桌' }), { name: '茶桌', goal: '' });
  assert.equal(createGroupSchema.safeParse({ name: '   ' }).success, false);
  assert.equal(createGroupSchema.safeParse({ name: 'x'.repeat(81) }).success, false);
  assert.equal(createGroupSchema.safeParse({ name: '茶桌', goal: 'x'.repeat(8001) }).success, false);
  assert.equal(patchGroupSchema.safeParse({}).success, false);
  assert.equal(patchGroupSchema.safeParse({ goal: '', participants: [] }).success, true);
  assert.equal(patchGroupSchema.safeParse({ settings: { rounds: 2 } }).success, false);
  assert.equal(messageSchema.safeParse({ content: '  ' }).success, false);
  assert.equal(messageSchema.safeParse({ content: 'x'.repeat(16001) }).success, false);
  assert.equal(messageSchema.safeParse({ content: '你好\n第二行' }).success, true);
  assert.equal(messageSchema.safeParse({ content: 'hello', reasoning: 'forged' }).success, false);
  assert.equal(messageSchema.safeParse({ content: 'hello', kind: 'assistant' }).success, false);
  assert.equal(runSchema.safeParse({ targetId: '../other' }).success, false);
  assert.equal(runSchema.safeParse({ maxCalls: Infinity }).success, false);
  assert.equal(runSchema.safeParse({ targetId:'member-1',summaryOnly:true }).success, false);
});

test('participant display values and provider fields cannot introduce URLs or arbitrary endpoints', () => {
  const participant = { id: 'member-1', name: '策划师', providerId: 'demo', model: 'demo', role: '', avatar: '策', color: '#507b65', enabled: true };
  assert.equal(participantSchema.safeParse(participant).success, true);
  for (const change of [{ avatar: 'https://evil.test/a.png' }, { avatar: '<svg' }, { color: 'url(https://evil.test)' }, { model: 'model\nheader' }, { role: 'x'.repeat(2001) }, { providerId: 'unknown' }]) {
    assert.equal(participantSchema.safeParse({ ...participant, ...change }).success, false);
  }
  assert.equal(patchGroupSchema.safeParse({ participants: [participant, participant] }).success, false);
  assert.equal(patchGroupSchema.safeParse({ participants: Array.from({ length: 9 }, (_, i) => ({ ...participant, id: `p${i}` })) }).success, false);
  assert.equal(providerUpdateSchema.safeParse({ apiKey: null }).success, true);
  assert.equal(providerUpdateSchema.safeParse({ apiKey: '' }).success, false);
  assert.equal(providerUpdateSchema.safeParse({ apiKey: 'x'.repeat(4097) }).success, false);
  assert.equal(providerUpdateSchema.safeParse({ apiKey: 'secret', baseURL: 'http://169.254.169.254' }).success, false);
  assert.equal(providerUpdateSchema.safeParse({ apiKey: 'secret\r\nextra' }).success, false);
  assert.equal(providerUpdateSchema.safeParse({ inputPrice: -1 }).success, false);
  assert.equal(providerUpdateSchema.safeParse({ outputPrice: Infinity }).success, false);
});
