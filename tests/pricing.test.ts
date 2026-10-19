import test from 'node:test';
import assert from 'node:assert/strict';
import { cnyToUsd, DEFAULT_USD_CNY, estimateCny, formatCny, referenceFor, suggestedModels, toCny, validExchangeRate } from '../shared/pricing.js';
import { PROVIDER_DEFAULTS } from '../server/providers.js';

test('all built-in providers have reference prices, unknown models and endpoint IDs do not borrow quotes', () => {
  for (const provider of PROVIDER_DEFAULTS) {
    const reference = referenceFor(provider);
    assert.ok(reference, provider.id); assert.ok(reference.tiers.length);
    if (!['demo', 'ollama'].includes(provider.id)) {
      assert.match(reference.source!, /^https:\/\//);
      assert.equal(referenceFor({ ...provider, model: 'unknown-private-model' }), undefined);
      assert.ok(suggestedModels(provider.id).includes(provider.model));
    }
  }
  assert.equal(referenceFor({ id: 'doubao', model: 'ep-example', region: 'cn' }), undefined);
  assert.equal(referenceFor({ id: 'openai', model: 'gpt-6.1 sol', region: 'cn' }), undefined);
});

test('millions of tokens multiply unit prices once; fractional quantities and zero are valid', () => {
  const quote = referenceFor({ id: 'openai', model: 'gpt-6.1-sol', region: 'cn' })!;
  const first = quote.tiers[0];
  assert.deepEqual(estimateCny(2, 0.5, toCny(first.input, quote.currency, 7), toCny(first.output, quote.currency, 7)), { input: 28, output: 35, total: 63 });
  assert.equal(estimateCny(0.1, 0, 10, 20)!.total, 1);
  assert.equal(estimateCny(0, 0, 10, 20)!.total, 0);
  for (const invalid of [-1, Infinity, NaN, 1e10]) assert.equal(estimateCny(invalid, 1, 2, 3), null);
  assert.equal(formatCny(0.00001), '¥0.00001');
});

test('USD storage survives RMB display conversion; CNY references never vary with FX', () => {
  assert.equal(DEFAULT_USD_CNY, 7);
  for (const fx of [6.9, 7, 7.25]) {
    assert.ok(Math.abs(cnyToUsd(toCny(1.6, 'USD', fx), fx) - 1.6) < 1e-12);
    assert.equal(toCny(0.8, 'CNY', fx), 0.8);
  }
  for (const fx of [0, -1, Infinity, NaN, 101]) { assert.equal(validExchangeRate(fx), false); assert.throws(() => cnyToUsd(1, fx)); }
});

test('regional, context and time-of-day tiers remain distinct and explicit', () => {
  const model = { id: 'qwen' as const, model: 'qwen-plus', region: 'cn' as const };
  const cn = referenceFor(model)!, intl = referenceFor({ ...model, region: 'intl' })!;
  assert.equal(cn.tiers[0].input, 0.8); assert.equal(intl.tiers[0].input, 2.936);
  assert.equal(cn.tiers[1].output, 8); assert.equal(cn.tiers.at(-1)!.output, 64);
  const deepseek = referenceFor({ id: 'deepseek', model: 'deepseek-flash', region: 'cn' })!;
  assert.match(deepseek.tiers[0].label, /高峰/); assert.equal(deepseek.tiers[0].input, 2);
  const doubao = referenceFor({ id: 'doubao', model: 'doubao-seed-2-1-lite-260915', region: 'cn' })!;
  assert.equal(doubao.tiers[0].input, 0.8); assert.equal(doubao.tiers[0].output, 2.7);
});
