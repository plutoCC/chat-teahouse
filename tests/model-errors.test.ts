import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProviderFailure, parseRetryAfter, readProviderFailure } from '../server/model-errors.js';
import { hasConciergeEnding } from '../server/discussion-protocol.js';

test('429 credit exhaustion overrides retry headers and never reveals upstream account data',()=>{
  const e=classifyProviderFailure(429,{error:{code:'credit_balance_exhausted',type:'insufficient_quota',message:'SECRET-account-key-id'}},'openai','1');
  assert.equal(e.kind,'quota');assert.equal(e.retryAfterMs,undefined);assert.equal(e.notGenerated,true);
  assert.match(e.message,/预付余额已耗尽/);assert.doesNotMatch(JSON.stringify(e)+e.message,/SECRET/);
  assert.equal(classifyProviderFailure(429,{error:{code:'organization_spend_limit_exceeded'}},'openai').kind,'quota');
  assert.equal(classifyProviderFailure(429,{error:{message:'rate_limit_exceeded'}},'openai').kind,'unknown');
});
test('only explicit rate codes qualify for retry; seconds and HTTP dates preserve server delay',()=>{
  assert.equal(classifyProviderFailure(429,{error:{code:'rate_limit_exceeded'}},'openai','90').retryAfterMs,90000);
  assert.equal(classifyProviderFailure(429,{error:{type:'rate_limit_error'}},'claude').kind,'rate_limit');
  assert.equal(classifyProviderFailure(503,{},'openai').notGenerated,false);
  assert.equal(parseRetryAfter('Mon, 19 Oct 2026 00:02:00 GMT',Date.parse('2026-10-19T00:00:00Z')),120000);
  assert.equal(parseRetryAfter('-1'),undefined);assert.equal(parseRetryAfter('nonsense'),undefined);assert.equal(parseRetryAfter('1.25'),1250);
});
test('error body parser bounds size and stalled reads and tolerates malformed JSON',async()=>{
  const normal=await readProviderFailure(new Response(JSON.stringify({error:{code:'credit_balance_exhausted'}}),{status:429}),'openai');assert.equal(normal.kind,'quota');
  for(const text of ['not JSON','x'.repeat(17000)])assert.equal((await readProviderFailure(new Response(text,{status:429}),'openai')).kind,'unknown');
  let cancelled=false;
  const stalled=new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:429});
  assert.equal((await readProviderFailure(stalled,'openai')).kind,'unknown');assert.equal(cancelled,true);
});
test('concierge guard rejects generic direction handoffs but allows substantive questions and quotations',()=>{
  for(const s of ['海与边界有关。\n你想往哪个方向走——地理/政治、文学意象，还是纯个人感受？','你想聊哪方面？','需要我为你继续分析吗？','如果你愿意，我可以继续展开。'])assert.equal(hasConciergeEnding(s),true,s);
  for(const s of ['海既是屏障，也是航路。','你认为航路变迁足以解释港口衰落吗？','你提到海边生活，那时盐雾影响大吗？','@Qwen，你想从哪个角度反驳这个因果关系？','不应该只问“你想聊哪方面”。','> 你想聊哪方面？','需要更多潮汐数据才能判断。'])assert.equal(hasConciergeEnding(s),false,s);
});
