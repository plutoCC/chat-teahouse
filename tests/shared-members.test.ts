import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import sharp from 'sharp';
import {buildApp} from '../server/app.js';
import {SharedMemberPool,configuredLocalPool} from '../server/hosting/shared-members.js';
import {defaultWorkspaceLimits,profileFields,type Bootstrap,type MemberProfile,type Group,type WorkspaceLimits} from '../shared/types.js';
import {PROVIDER_DEFAULTS} from '../server/providers.js';
import type {RuntimeWake} from '../server/runtime-adapters/types.js';

async function fixture(t:TestContext){
  const root=resolve('.test-artifacts');mkdirSync(root,{recursive:true});const dir=mkdtempSync(join(root,'shared-members-'));
  const pool=new SharedMemberPool(join(dir,'public'));let limits:WorkspaceLimits={...defaultWorkspaceLimits};
  const sharedProviders=[{...PROVIDER_DEFAULTS.find(p=>p.id==='deepseek')!,enabled:true,hasKey:true,inputPrice:1,outputPrice:2}];
  const instances:Array<Awaited<ReturnType<typeof buildApp>>>=[];const seen:Array<{workspace:string;group:string;messages:string[]}>=[];
  const make=async(userId:string,admin=false)=>{
    const dataDir=join(dir,userId),context={pool,userId,userName:userId,workspaceId:userId,admin};
    const app=await buildApp({dataDir,port:48782,production:true,serveUI:false,sharedMembers:context,resourceLimits:()=>limits,
      ...(admin?{}:{hosting:{providers:()=>sharedProviders,getKey:()=> 'fixture-key',userName:userId}}),
      participantRuntime:{run:async(w:RuntimeWake)=>{seen.push({workspace:userId,group:w.group.id,messages:w.read().messages.map(m=>m.content)});w.wait(0);},shutdown:async()=>{}}});
    instances.push(app);const host='127.0.0.1:48782';const token=(await app.app.inject({url:'/api/bootstrap',headers:{host}})).json().csrfToken;
    const request=(method:'GET'|'POST'|'PUT'|'PATCH'|'DELETE',url:string,payload?:unknown)=>app.app.inject({method,url,headers:{host,origin:`http://${host}`,'x-csrf-token':token},...(payload===undefined?{}:{payload:payload as any})});
    return {...app,context,dataDir,request,boot:async()=>{const result=await request('GET','/api/bootstrap');assert.equal(result.statusCode,200,result.body);return result.json<Bootstrap>();}};
  };
  t.after(async()=>{for(const instance of instances)await instance.app.close();pool.close();});
  const a=await make('member-a'),b=await make('member-b');
  const seeded=await a.request('POST','/api/members',{profile:{name:'可用讨论者',providerId:'deepseek',model:sharedProviders[0].model,role:'',avatar:'茶',color:'#34705a',channel:'api',identityMode:'native',skills:[]}});assert.equal(seeded.statusCode,201,seeded.body);
  return {dir,pool,a,b,make,seen,sharedProviders,get limits(){return limits;},setLimits:(patch:Partial<WorkspaceLimits>)=>{limits={...limits,...patch};}};
}

test('public identities and referenced avatars are shared; private groups, notes, assets and runtime input stay scoped to their owner',async t=>{
  const f=await fixture(t),{a,b}=f;const base=(await a.boot()).profiles![0];
  const bytes=await sharp({create:{width:8,height:8,channels:4,background:'#123456'}}).png().toBuffer();
  const upload=await a.request('POST','/api/avatars',{data:bytes.toString('base64')});assert.equal(upload.statusCode,201);const avatar=upload.json().id;
  assert.equal((await b.request('GET','/api/avatars/'+avatar)).statusCode,404,'unattached private uploads are not shared');
  const create=await a.request('POST','/api/members',{profile:{...profileFields(base),name:'共同讨论者',role:'检查证据',identityMode:'role',avatarAssetId:avatar}});
  assert.equal(create.statusCode,201,create.body);const profile=create.json<MemberProfile>();
  const publicB=(await b.boot()).profiles!.find(p=>p.id===profile.id)!;assert.equal(publicB.name,'共同讨论者');assert.equal(publicB.shared!.creatorName,'member-a');assert.equal(publicB.shared!.canEdit,false);
  assert.equal((await b.request('GET','/api/avatars/'+avatar)).statusCode,200);
  for(const method of ['PUT','DELETE'] as const){const result=await b.request(method,'/api/members/'+profile.id,{expectedRevision:1,...(method==='PUT'?{profile:{...profileFields(profile),role:'forged'}}:{})});assert.equal(result.statusCode,403,result.body);}
  const ga=(await a.request('POST','/api/groups',{name:'A-private-group',goal:'A-private-topic',profileIds:[profile.id]})).json<Group>();
  const gb=(await b.request('POST','/api/groups',{name:'B-private-group',goal:'B-private-topic',profileIds:[profile.id]})).json<Group>();
  assert.notEqual(ga.participants[0].id,gb.participants[0].id);assert.equal(ga.participants[0].profileId,gb.participants[0].profileId);
  await a.request('POST','/api/notebook',{groupId:ga.id,kind:'note',body:'A-private-notebook'});
  await a.request('POST',`/api/groups/${ga.id}/messages`,{content:'A-private-message'});await b.request('POST',`/api/groups/${gb.id}/messages`,{content:'B-private-message'});
  assert.equal((await b.request('GET','/api/groups/'+ga.id)).statusCode,404);assert.equal((await a.request('GET','/api/groups/'+gb.id)).statusCode,404);
  assert.ok(!(await b.request('GET','/api/notebook')).body.includes('A-private-notebook'));
  assert.ok(!JSON.stringify(await b.boot()).includes('A-private'));
  await a.request('POST',`/api/groups/${ga.id}/free/start`,{});await b.request('POST',`/api/groups/${gb.id}/free/start`,{});
  const deadline=Date.now()+5000;while(f.seen.length<2){assert.ok(Date.now()<deadline);await new Promise(done=>setTimeout(done,10));}
  assert.ok(f.seen.find(item=>item.workspace==='member-a')!.messages.includes('A-private-message'));
  assert.ok(!f.seen.find(item=>item.workspace==='member-a')!.messages.includes('B-private-message'));
  assert.ok(f.seen.find(item=>item.workspace==='member-b')!.messages.includes('B-private-message'));
  const serialized=JSON.stringify(f.pool.records());for(const secret of ['A-private-group','A-private-topic','A-private-notebook','A-private-message','B-private-message'])assert.ok(!serialized.includes(secret));
});

test('shared edits and deletion leave existing group snapshots intact; restart migration is idempotent and cannot republish borrowed profiles',async t=>{
  const f=await fixture(t),base=(await f.a.boot()).profiles![0];
  const profile=(await f.a.request('POST','/api/members',{profile:{...profileFields(base),name:'原始名字'}})).json<MemberProfile>();
  const group=(await f.b.request('POST','/api/groups',{name:'B保留快照',profileIds:[profile.id]})).json<Group>();const snapshot=structuredClone(group.participants[0]);
  const changed=await f.a.request('PUT','/api/members/'+profile.id,{expectedRevision:1,profile:{...profileFields(profile),name:'更新名字',role:'新的角色'}});assert.equal(changed.statusCode,200,changed.body);
  assert.equal((await f.b.boot()).profiles!.find(p=>p.id===profile.id)!.name,'更新名字');assert.deepEqual(f.b.store.group(group.id)!.participants[0],snapshot);
  assert.equal((await f.b.request('PATCH','/api/groups/'+group.id,{participants:[{...snapshot,enabled:false}]})).statusCode,200);
  const removal=await f.a.request('DELETE','/api/members/'+profile.id,{expectedRevision:2});assert.equal(removal.statusCode,200);
  assert.ok(!(await f.b.boot()).profiles!.some(p=>p.id===profile.id));assert.equal(f.b.store.group(group.id)!.participants.length,1);
  assert.equal((await f.b.request('PATCH','/api/groups/'+group.id,{participants:[{...snapshot,enabled:true}]})).statusCode,200,'retained snapshots remain usable after unpublishing');
  assert.equal((await f.b.request('POST','/api/members/'+profile.id+'/restore',{expectedRevision:3})).statusCode,403);
  assert.equal((await f.a.request('POST','/api/members/'+profile.id+'/restore',{expectedRevision:3})).statusCode,200);
  const count=f.pool.records().length;for(let n=0;n<2;n++)f.pool.importWorkspace(f.b.dataDir,{userId:'member-b',userName:'member-b',workspaceId:'member-b'});
  assert.equal(f.pool.records().length,count);assert.equal(f.pool.get(f.b.context,profile.id)!.shared!.creatorId,'member-a');
  const clone=await f.b.request('POST','/api/members',{profile:{...profileFields(profile),name:'我的副本'}});assert.equal(clone.statusCode,201);assert.notEqual(clone.json().id,profile.id);assert.equal(clone.json().shared.creatorId,'member-b');
  const admin=await f.make('owner',true);assert.equal((await admin.request('DELETE','/api/members/'+profile.id,{expectedRevision:4})).statusCode,200,'local administrator can manage all public identities');
});

test('new hosted accounts and groups start empty and never publish demo personas',async t=>{
  const f=await fixture(t);assert.equal(f.pool.records().length,1);const ids=(await f.a.boot()).profiles!.map(p=>p.id);
  const c=await f.make('member-c');assert.equal(f.pool.records().length,1);assert.deepEqual((await c.boot()).profiles!.map(p=>p.id),ids);
  assert.deepEqual(c.store.groups()[0].participants,[]);
  assert.equal(f.a.store.groups()[0].participants.length,0);
  assert.ok((await c.boot()).profiles!.every(p=>p.providerId!=='demo'));
  assert.equal((await c.request('POST','/api/groups',{name:'仅使用默认示例'})).statusCode,201);assert.equal(f.pool.records().length,1,'new groups must not add demo identities');
});

test('subscriptions and private skills are hidden from visitor choices and remain blocked for direct invites',async t=>{
  const f=await fixture(t),owner=await f.make('owner',true),base=(await owner.boot()).profiles![0];
  owner.store.saveProvider({...PROVIDER_DEFAULTS.find(p=>p.id==='openai')!,enabled:true,billingMode:'subscription',model:'subscription-model'});
  const subscription=await owner.request('POST','/api/members',{profile:{...profileFields(base),providerId:'openai',model:'subscription-model',name:'订阅 GPT'}});assert.equal(subscription.statusCode,201,subscription.body);
  const visible=subscription.json<MemberProfile>();assert.ok(!(await f.b.boot()).profiles!.some(p=>p.id===visible.id));
  f.sharedProviders.push({...PROVIDER_DEFAULTS.find(p=>p.id==='openai')!,enabled:true,hasKey:true,billingMode:'api',model:'subscription-model'});
  assert.ok(!(await f.b.boot()).profiles!.some(p=>p.id===visible.id),'an API with the same connection ID and model must not silently replace a subscription persona');
  const bg=(await f.b.boot()).groups[0];const denied=await f.b.request('POST',`/api/groups/${bg.id}/members`,{profileId:visible.id});assert.ok([403,409].includes(denied.statusCode));
  assert.equal((await owner.boot()).profiles!.find(p=>p.id===visible.id)!.shared!.unavailableReason,undefined,'the owner can still use their local subscription');
  owner.store.saveSkill({id:'private-skill',name:'private',description:'private',instructions:'SECRET_SKILL_BODY',builtin:false});
  const privateProfile=await owner.request('POST','/api/members',{profile:{...profileFields(base),name:'私有技能形象',skills:['private-skill']}});assert.equal(privateProfile.statusCode,201);
  const bootB=await f.b.boot(),borrowed=privateProfile.json<MemberProfile>();assert.ok(!bootB.profiles!.some(p=>p.id===borrowed.id));
  assert.ok(!JSON.stringify(bootB).includes('SECRET_SKILL_BODY'));assert.ok(!JSON.stringify(f.pool.records()).includes('SECRET_SKILL_BODY'));
  assert.equal((await f.b.request('POST',`/api/groups/${bg.id}/members`,{profileId:borrowed.id})).statusCode,409);
});

test('resource limits apply to live member/group operations beyond the old eight-member bound and preserve existing larger groups',async t=>{
  const f=await fixture(t),base=(await f.a.boot()).profiles![0];f.setLimits({maxMembersPerGroup:10});const ids:string[]=[];
  for(let n=0;n<9;n++){const result=await f.a.request('POST','/api/members',{profile:{...profileFields(base),name:'成员'+n}});assert.equal(result.statusCode,201);ids.push(result.json().id);}
  const created=await f.a.request('POST','/api/groups',{name:'九人群',profileIds:ids});assert.equal(created.statusCode,201,created.body);const group=created.json<Group>();assert.equal(group.participants.length,9);
  f.setLimits({maxMembersPerGroup:2});assert.equal((await f.a.boot()).limits!.maxMembersPerGroup,2);
  assert.equal((await f.a.request('POST','/api/groups',{name:'超过新上限',profileIds:ids.slice(0,3)})).statusCode,400);
  assert.equal((await f.a.request('PATCH','/api/groups/'+group.id,{participants:group.participants.map(p=>({...p,enabled:false}))})).statusCode,200);
  f.setLimits({maxGroupsPerUser:f.a.store.groups().length});assert.equal((await f.a.request('POST','/api/groups',{name:'超过群数',profileIds:[]})).statusCode,400);
  f.setLimits({maxGroupsPerUser:100,maxDiscussionCalls:1,maxDiscussionRounds:1,maxConcurrentMembers:1,maxCallsPerWake:1});
  const small=await f.a.request('POST','/api/groups',{name:'继承默认值但适应新上限',profileIds:[]});assert.equal(small.statusCode,201,small.body);assert.equal(small.json().settings.maxCalls,1);assert.equal(small.json().freeSettings.concurrency,1);
  const creatorCount=f.pool.records().filter(r=>r.creatorId==='member-a').length;f.setLimits({maxProfilesPerUser:creatorCount});
  assert.equal((await f.a.request('POST','/api/members',{profile:{...profileFields(base),name:'超出档案上限'}})).statusCode,400);
  assert.equal(configuredLocalPool(resolve('.'),f.a.dataDir),undefined,'temporary fixtures never autoattach to the real website pool');
});

test('publishing additional models makes owner personas invitable; withdrawal hides choices and blocks later use without removing history',async t=>{
  const f=await fixture(t),owner=await f.make('owner',true),base=(await f.a.boot()).profiles![0],p=f.sharedProviders[0];
  p.sharedModels=[p.model];p.modelPrices={[p.model]:{inputPrice:1,outputPrice:2},'another-model':{inputPrice:3,outputPrice:4}};
  const created=await owner.request('POST','/api/members',{profile:{...profileFields(base),name:'其他模型形象',model:'another-model'}});assert.equal(created.statusCode,201,created.body);
  const id=created.json().id;assert.ok(!(await f.b.boot()).profiles!.some(p=>p.id===id));
  const group=(await f.b.boot()).groups[0];assert.equal((await f.b.request('POST',`/api/groups/${group.id}/members`,{profileId:id})).statusCode,403);
  p.sharedModels.push('another-model');assert.ok((await f.b.boot()).profiles!.some(p=>p.id===id));
  const catalog=await f.b.request('POST','/api/providers/deepseek/models',{});assert.deepEqual(catalog.json().models.map((m:{id:string})=>m.id),p.sharedModels);
  assert.equal((await f.b.request('POST',`/api/groups/${group.id}/members`,{profileId:id})).statusCode,200);
  const current=f.b.store.group(group.id)!;assert.equal((await f.b.request('PATCH',`/api/groups/${group.id}`,{freeSettings:{...current.freeSettings,publicSummary:{connectionId:'deepseek',model:'another-model'}}})).statusCode,200);
  p.sharedModels=[p.model];assert.ok(!(await f.b.boot()).profiles!.some(p=>p.id===id));assert.equal(f.b.store.group(group.id)!.participants.length,1);
  assert.equal((await f.b.request('POST',`/api/groups/${group.id}/free/start`,{})).statusCode,403);
  assert.ok((await owner.boot()).profiles!.some(p=>p.id===id),'owner retains management access to hidden profiles');
});
