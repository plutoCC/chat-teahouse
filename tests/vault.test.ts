import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SecretVault } from '../server/vault.js';

const testRoot = resolve('.test-artifacts');
function fixture() {
  mkdirSync(testRoot, { recursive: true });
  const dir = mkdtempSync(join(testRoot, 'vault-'));
  return { dir, clean() { const path = resolve(dir); assert.ok(path.startsWith(testRoot + '\\') || path.startsWith(testRoot + '/')); rmSync(path, { recursive: true, force: true }); } };
}

test('vault encrypts credentials, reloads, rotates nonce and removes credentials', () => {
  const f = fixture();
  try {
    const vault = new SecretVault(f.dir);
    assert.equal(vault.has('openai'), false);
    vault.set('openai', 'sk-plaintext-must-never-appear-in-files');
    const first = readFileSync(join(f.dir, 'secrets.enc.json'), 'utf8');
    for (const file of readdirSync(f.dir)) assert.ok(!readFileSync(join(f.dir, file)).includes('sk-plaintext-must-never-appear-in-files'));
    assert.equal(vault.get('openai'), 'sk-plaintext-must-never-appear-in-files');
    const restored = new SecretVault(f.dir);
    assert.equal(restored.get('openai'), vault.get('openai'));
    restored.set('claude', 'a-second-api-key');
    assert.notEqual(JSON.parse(first).iv, JSON.parse(readFileSync(join(f.dir, 'secrets.enc.json'), 'utf8')).iv);
    restored.set('openai', null);
    assert.equal(restored.has('openai'), false);
    assert.equal(new SecretVault(f.dir).get('claude'), 'a-second-api-key');
    if (process.platform === 'win32') assert.ok(existsSync(join(f.dir, 'master.dpapi')));
    assert.throws(() => restored.set('../elsewhere', 'key'), /不支持/);
    assert.throws(() => restored.set('qwen', 'a\nb'), /格式/);
  } finally { f.clean(); }
});

test('tampered encrypted vault fails closed and preserves file', () => {
  const f = fixture();
  try {
    const vault = new SecretVault(f.dir); vault.set('deepseek', 'secret');
    const path = join(f.dir, 'secrets.enc.json');
    const envelope = JSON.parse(readFileSync(path, 'utf8'));
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64'); ciphertext[0] ^= 255;
    envelope.ciphertext = ciphertext.toString('base64'); const changed = JSON.stringify(envelope); writeFileSync(path, changed);
    assert.throws(() => new SecretVault(f.dir), /无法解密/);
    assert.equal(readFileSync(path, 'utf8'), changed);
  } finally { f.clean(); }
});
