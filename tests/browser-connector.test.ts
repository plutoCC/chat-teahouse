import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_PRESETS, providerOrigin, safeBrowserRequest } from '../server/browser-connector.js';
import { browserSelectorsSchema, participantSchema } from '../server/validation.js';

test('browser connector permits fixed official origins and rejects credentials, lookalikes and loopback requests',()=>{
  assert.equal(providerOrigin('openai','https://chatgpt.com/c/test'),true);
  for(const url of ['https://chatgpt.com.attacker.test/','http://chatgpt.com/','https://x:y@chatgpt.com/','https://chatgpt.com:444/','file:///test'])assert.equal(providerOrigin('openai',url),false,url);
  for(const url of ['http://127.0.0.1:4317/api/bootstrap','https://127.1/','https://2130706433/','https://[::1]/','https://192.168.1.1/','https://localhost/','https://a.localhost/','https://metadata.google.internal/','file:///C:/data','javascript:alert(1)','https://x:y@chat.qwen.ai/'])assert.equal(safeBrowserRequest(url),false,url);
  assert.equal(safeBrowserRequest('https://chat.deepseek.com/'),true);
  assert.equal(safeBrowserRequest('https://accounts.google.com/'),true);
});
test('browser selectors cannot add URL, code, profile paths or unsupported providers',()=>{
  assert.equal(browserSelectorsSchema.safeParse(BROWSER_PRESETS.openai).success,true);
  for(const extra of [{url:'http://127.0.0.1/'},{script:'document.cookie'},{profilePath:'C:/Users'},{executablePath:'cmd.exe'}])assert.equal(browserSelectorsSchema.safeParse({...BROWSER_PRESETS.openai,...extra}).success,false);
  assert.equal(browserSelectorsSchema.safeParse({...BROWSER_PRESETS.openai,composer:'x'.repeat(801)}).success,false);
  const participant={id:'test',name:'browser',providerId:'qwen',model:'网页',role:'',avatar:'Q',color:'#123456',enabled:true,channel:'browser'};
  assert.equal(participantSchema.safeParse(participant).success,true);
  assert.equal(participantSchema.safeParse({...participant,providerId:'ollama'}).success,false);
});
