import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,realpathSync,rmSync,lstatSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {buildApp} from '../server/app.js';
import {hostedProviders} from '../server/hosting/tenant-policy.js';
import {PROVIDER_DEFAULTS} from '../server/providers.js';
import type {ProviderConfig} from '../shared/types.js';

const shared:ProviderConfig={...PROVIDER_DEFAULTS.find(p=>p.id==='deepseek')!,connectionId:'shared-deepseek',enabled:true,hasKey:true,model:'deepseek-chat',inputPrice:0.2,outputPrice:0.3};

test('hosted tenant denies local/admin endpoints and exposes only approved model metadata without calling providers',async t=>{
  const root=resolve('.test-artifacts');mkdirSync(root,{recursive:true});const dataDir=mkdtempSync(join(root,'hosting-policy-'));
  let upstreamCalls=0,keyReads=0,configured=[shared];
  const runtime=await buildApp({dataDir,port:46783,production:true,serveUI:false,
    hosting:{providers:()=>configured,getKey:()=>{keyReads++;return 'fixture-private-owner-key';},userName:'受邀测试用户'},
    modelCatalogFetcher:async()=>{upstreamCalls++;throw new Error('must not request owner account catalog');},
  });
  runtime.app.get('/api/future-admin',async()=>({secret:'future admin'}));
  t.after(async()=>{await runtime.app.close();assert.equal(lstatSync(dataDir).isSymbolicLink(),false);assert.equal(dirname(realpathSync(dataDir)),realpathSync(root));rmSync(dataDir,{recursive:true,force:true});});
  const host='127.0.0.1:46783',bootResponse=await runtime.app.inject({url:'/api/bootstrap',headers:{host}}),boot=bootResponse.json();
  const headers={host,origin:'http://'+host,'x-csrf-token':boot.csrfToken};
  const playbackUrl='/api/groups/'+boot.groups[0].id+'/playback-presence';
  const playback={clientId:crypto.randomUUID(),sequence:1,active:true};
  assert.equal((await runtime.app.inject({method:'POST',url:playbackUrl,headers,payload:playback})).statusCode,200);
  assert.equal((await runtime.app.inject({method:'POST',url:playbackUrl,headers:{host,origin:'http://'+host},payload:playback})).statusCode,403);
  assert.equal((await runtime.app.inject({method:'POST',url:playbackUrl,headers,payload:{...playback,text:'never store speech'}})).statusCode,400);
  assert.equal((await runtime.app.inject({method:'POST',url:'/api/groups/missing/playback-presence',headers,payload:playback})).statusCode,404);
  assert.equal(boot.security.hosted,true);assert.equal(boot.security.localOnly,false);assert.equal(boot.security.userName,'受邀测试用户');
  assert.equal(boot.providers.length,1);assert.ok(boot.providers.every((p:ProviderConfig)=>p.id!=='demo'));assert.equal(boot.profiles.length,0);assert.equal(boot.groups[0].participants.length,0);
  assert.ok(!bootResponse.body.includes(dataDir));assert.ok(!bootResponse.body.includes('fixture-private-owner-key'));
  const forbidden:[string,string][]=[
    ['POST','/api/service/stop'],['GET','/api/browser'],['POST','/api/browser/deepseek/open'],['POST','/api/browser/deepseek/check'],['POST','/api/browser/deepseek/close'],['PUT','/api/browser/deepseek/selectors'],
    ['POST','/api/providers'],['PUT','/api/providers/shared-deepseek'],['DELETE','/api/providers/shared-deepseek'],['POST','/api/providers/shared-deepseek/test'],
    ['GET','/api/providers/shared-deepseek/billing'],['PUT','/api/providers/shared-deepseek/billing/credentials'],['DELETE','/api/providers/shared-deepseek/billing/credentials'],['POST','/api/providers/shared-deepseek/billing/refresh'],
    ['GET','/api/providers/shared-deepseek/subscription'],['POST','/api/providers/shared-deepseek/subscription/login'],['POST','/api/providers/shared-deepseek/subscription/refresh'],
    ['POST','/api/skills'],['DELETE','/api/skills/example'],['POST','/api/runs/example/browser-start'],['POST','/api/runs/example/browser-pause'],
    ['PUT','/%61pi/providers/shared-deepseek'],['POST','/%61pi/service/stop'],['GET','/api/future-admin'],['GET','/api/unreviewed'],
  ];
  for(const [method,url]of forbidden){const response=await runtime.app.inject({method:method as any,url,headers,...(method==='GET'?{}:{payload:{}})});assert.equal(response.statusCode,403,method+' '+url+' '+response.body);}
  const models=await runtime.app.inject({method:'POST',url:'/api/providers/shared-deepseek/models',headers,payload:{refresh:true,region:'intl'}});
  assert.equal(models.statusCode,200);assert.deepEqual(models.json().models,[{id:'deepseek-chat',label:'deepseek-chat'}]);assert.equal(models.json().region,shared.region);assert.equal(keyReads,0);assert.equal(upstreamCalls,0);
  const profile={name:'独立成员',providerId:'deepseek',connectionId:'shared-deepseek',model:'deepseek-chat',role:'独立思考',avatar:'茶',color:'#34705a',channel:'api',identityMode:'role',skills:[]};
  for(const patch of [{channel:'browser'},{model:'unapproved-model'},{connectionId:'deepseek'},{providerId:'ollama',connectionId:undefined},{providerId:'openai',connectionId:'shared-deepseek'}]){
    const response=await runtime.app.inject({method:'POST',url:'/api/members',headers,payload:{profile:{...profile,...patch}}});assert.equal(response.statusCode,403,response.body);
  }
  const created=await runtime.app.inject({method:'POST',url:'/api/members',headers,payload:{profile}});assert.equal(created.statusCode,201,created.body);const member=created.json();
  const groupResponse=await runtime.app.inject({method:'POST',url:'/api/groups',headers,payload:{name:'独立群聊',profileIds:[member.id]}});assert.equal(groupResponse.statusCode,201,groupResponse.body);const group=groupResponse.json();
  for(const model of ['unapproved-model','deepseek-chat']){
    const summary=await runtime.app.inject({method:'PATCH',url:'/api/groups/'+group.id,headers,payload:{freeSettings:{...group.freeSettings,publicSummary:{connectionId:'shared-deepseek',model}}}});
    assert.equal(summary.statusCode,model==='deepseek-chat'?200:403,summary.body);
  }
  const summaryTemplate=await runtime.app.inject({method:'POST',url:'/api/groups/'+group.id+'/default-template',headers,payload:{conversationMode:'free',settings:group.settings,freeSettings:{...group.freeSettings,publicSummary:{connectionId:'shared-deepseek',model:'unapproved-model'}}}});assert.equal(summaryTemplate.statusCode,403);
  assert.equal((await runtime.app.inject({method:'PUT',url:'/api/members/'+member.id,headers,payload:{profile:{...profile,model:'unapproved-model'},expectedRevision:member.revision}})).statusCode,403);
  const before=runtime.store.groups().length;
  assert.equal((await runtime.app.inject({method:'POST',url:'/api/groups',headers,payload:{name:'不允许网页',participants:[{...profile,id:'web-member',enabled:true,channel:'browser'}]}})).statusCode,403);
  assert.equal(runtime.store.groups().length,before,'invalid group creation rolls back');
  assert.equal((await runtime.app.inject({method:'PATCH',url:'/api/groups/'+group.id,headers,payload:{participants:[{...group.participants[0],model:'unapproved-model'}]}})).statusCode,403);
  assert.equal((await runtime.app.inject({method:'POST',url:'/api/groups/'+group.id+'/messages',headers,payload:{content:'自己的观点'}})).statusCode,201);
  assert.equal((await runtime.app.inject({method:'POST',url:'/api/notebook',headers,payload:{kind:'note',groupId:group.id,title:'自己的笔记',body:'独立保存'}})).statusCode,201);
  assert.equal((await runtime.app.inject({url:'/api/notebook',headers:{host}})).json().length,1);
  configured=[];
  assert.equal((await runtime.app.inject({method:'POST',url:'/api/groups/'+group.id+'/free/start',headers,payload:{}})).statusCode,403);
  assert.equal((await runtime.app.inject({method:'POST',url:'/api/groups/'+group.id+'/runs',headers,payload:{}})).statusCode,403);
  assert.equal(upstreamCalls,0);assert.equal(keyReads,0);
  // No fabricated AI seats in a fresh visitor workspace, even without shared providers.
  const defaultGroup=await runtime.app.inject({method:'POST',url:'/api/groups',headers,payload:{name:'空白新群'}});
  assert.equal(defaultGroup.statusCode,201,defaultGroup.body);
  for(const demoGroup of [boot.groups[0],defaultGroup.json()]){
    assert.equal((await runtime.app.inject({method:'POST',url:'/api/groups/'+demoGroup.id+'/messages',headers,payload:{content:'用于隔离验证的演示讨论'}})).statusCode,201);
    const start=await runtime.app.inject({method:'POST',url:'/api/groups/'+demoGroup.id+'/free/start',headers,payload:{}});
    assert.equal(demoGroup.participants.length,0);assert.equal(start.statusCode,400,start.body);
    assert.equal(runtime.store.freeSession(demoGroup.id),undefined);
  }
});

test('hosted provider projection excludes subscriptions, local services, disabled and keyless connections',()=>{
  const result=hostedProviders([shared,{...shared,connectionId:'subscription',billingMode:'subscription'}, {...shared,id:'ollama'}, {...shared,connectionId:'disabled',enabled:false}, {...shared,connectionId:'keyless',hasKey:false}]);
  assert.deepEqual(result.map(p=>p.connectionId??p.id),['shared-deepseek']);
  assert.deepEqual(result[0].modelPrices,{'deepseek-chat':{inputPrice:0.2,outputPrice:0.3}});
  assert.deepEqual(hostedProviders([]),[]);
});
