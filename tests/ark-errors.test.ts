import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classifyProviderFailure,readProviderFailure} from '../server/model-errors.js';

const privateMessage='Account PRIVATE_ACCOUNT reached limit; key PRIVATE_KEY; Request ID PRIVATE_REQUEST';
test('Ark configured usage limit has actionable diagnosis without confusing local tokens, balance or auth',async()=>{
  const error=await readProviderFailure(new Response(JSON.stringify({error:{code:'SetLimitExceeded',type:'TooManyRequests',message:privateMessage}}),{status:429,headers:{'retry-after':'2'}}),'doubao');
  assert.equal(error.kind,'quota');assert.equal(error.notGenerated,true);assert.equal(error.retryAfterMs,undefined);
  assert.match(error.message,/SetLimitExceeded/);assert.match(error.message,/安心体验模式/);assert.match(error.message,/不是茶馆的 Token 上限/);assert.doesNotMatch(error.message,/PRIVATE_/);
});
test('Ark rate limits and burst protection allow bounded existing retry policy and retain server delay',()=>{
  const codes=['RateLimitExceeded.EndpointRPMExceeded','RateLimitExceeded.EndpointTPMExceeded','RateLimitExceeded.EndpointFlexTPMExceeded','ModelAccountRpmRateLimitExceeded','ModelAccountTpmRateLimitExceeded','ModelAccountFlexTpmRateLimitExceeded','APIAccountRpmRateLimitExceeded','ModelAccountIpmRateLimitExceeded','InflightBatchsizeExceeded','AccountRateLimitExceeded','RequestBurstTooFast','ServerOverloaded'];
  for(const code of codes){
    const error=classifyProviderFailure(429,{error:{code,message:privateMessage}},'doubao','125');
    assert.equal(error.kind,'rate_limit',code);assert.equal(error.notGenerated,true);assert.equal(error.retryAfterMs,125000);assert.ok(error.message.includes(code));assert.doesNotMatch(error.message,/PRIVATE_/);
  }
});
test('daily and ambiguous Ark quotas never trigger short automatic retries, foreign and unknown codes stay unclassified',()=>{
  for(const code of ['ModelAccountTpdRateLimitExceeded','QuotaExceeded','AccountQuotaExceeded','QuotaExceeded.AgentPlanQuotaExceeded']){
    const error=classifyProviderFailure(429,{error:{code,message:privateMessage}},'doubao');assert.equal(error.kind,'quota');assert.doesNotMatch(error.message,/PRIVATE_/);
  }
  assert.match(classifyProviderFailure(429,{error:{code:'QuotaExceeded'}},'doubao').message,/不能仅据此判定现金余额耗尽/);
  for(const code of ['unknown_PRIVATE_KEY','__proto__','constructor']){
    const error=classifyProviderFailure(429,{error:{code,message:privateMessage}},'doubao');assert.equal(error.kind,'unknown');assert.doesNotMatch(error.message,/PRIVATE_|__proto__|constructor/);
  }
  assert.equal(classifyProviderFailure(429,{error:{code:'SetLimitExceeded'}},'openai').kind,'unknown');
});
