import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, realpathSync, lstatSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { Store } from '../server/store.js';
import { buildApp } from '../server/app.js';
import { profileFields, type Group, type MemberProfile, type Message, type Participant } from '../shared/types.js';
import type { RuntimeWake } from '../server/runtime-adapters/types.js';
import sharp from 'sharp';

function directory(t:TestContext) {
  const root=resolve('.test-artifacts');mkdirSync(root,{recursive:true});const dataDir=mkdtempSync(join(root,'member-library-'));
  const clean=()=>{assert.equal(lstatSync(dataDir).isSymbolicLink(),false);const target=realpathSync(dataDir);assert.equal(dirname(target),realpathSync(root));assert.ok(basename(target).startsWith('member-library-'));rmSync(target,{recursive:true,force:true});};
  return {dataDir,clean};
}
async function fixture(t:TestContext,run?:(w:RuntimeWake)=>Promise<void>) {
  const {dataDir,clean}=directory(t);let runtime=await buildApp({dataDir,port:48762,production:true,serveUI:false,participantRuntime:{run:run??(async w=>{w.wait(0);}),shutdown:async()=>{}}});
  t.after(async()=>{await runtime.app.close();clean();});
  const host='127.0.0.1:48762';let token=(await runtime.app.inject({url:'/api/bootstrap',headers:{host}})).json().csrfToken;
  const request=(method:'GET'|'POST'|'PUT'|'PATCH'|'DELETE',url:string,payload?:unknown)=>runtime.app.inject({method,url,headers:{host,origin:`http://${host}`,'x-csrf-token':token},...(payload!==undefined?{payload:payload as any}:{})});
  return {get runtime(){return runtime;},request,host,async restart(){await runtime.app.close();runtime=await buildApp({dataDir,port:48762,production:true,serveUI:false});token=(await request('GET','/api/bootstrap')).json().csrfToken;}};
}

test('legacy migration preserves IDs, membership flags, history and archives; repeated startup does not duplicate profiles',async t=>{
  const {dataDir,clean}=directory(t);let store=new Store(dataDir);t.after(()=>{store.close();clean();});
  const a=store.createGroup('旧群 A',''),b=store.createGroup('旧群 B','');
  b.archived=true;b.participants=[{...a.participants[0],id:'another-local-id',enabled:false},{...a.participants[1],id:'same-name-other-model',model:'other-model'}];store.saveGroup(b);
  const originalGroups=store.groups();
  const message:Message={id:'old-message',groupId:a.id,participantId:a.participants[0].id,author:a.participants[0].name,avatar:'A',color:'#507b65',kind:'assistant',content:'保留旧记录',reasoning:'',reasoningLabel:'',round:1,status:'complete',createdAt:new Date().toISOString(),inputMessageIds:[],inputTokens:0,outputTokens:0};store.saveMessage(message);
  store.close();store=new Store(dataDir);
  assert.equal(store.profiles().length,4);
  assert.equal(store.group(a.id)!.participants[0].profileId,store.group(b.id)!.participants[0].profileId);
  assert.notEqual(store.group(a.id)!.participants[1].profileId,store.group(b.id)!.participants[1].profileId);
  for(const old of originalGroups){const current=store.group(old.id)!;assert.equal(current.updatedAt,old.updatedAt);assert.deepEqual(current.participants.map(({profileId,profileRevision,...p})=>p),old.participants);assert.equal(current.archived,old.archived);}
  assert.deepEqual(store.messages(a.id),[message]);const profiles=store.profiles();store.close();store=new Store(dataDir);assert.deepEqual(store.profiles(),profiles);
});

test('saved profiles invite across groups, update globally, retain independent membership and survive removal plus restart',async t=>{
  const f=await fixture(t);const base=f.runtime.store.profiles()[0];
  const created=await f.request('POST','/api/members',{profile:{...profileFields(base),name:'长期成员',avatar:'茶',color:'#123456',identityMode:'role',role:'提出可检验的反例',skills:['argument-check']}});assert.equal(created.statusCode,201);let profile=created.json<MemberProfile>();
  const a=(await f.request('POST','/api/groups',{name:'新群 A',profileIds:[profile.id]})).json<Group>();
  const b=(await f.request('POST','/api/groups',{name:'新群 B',profileIds:[]})).json<Group>();assert.equal(b.participants.length,0);
  const invite=()=>f.request('POST',`/api/groups/${b.id}/members`,{profileId:profile.id});assert.equal((await invite()).statusCode,200);assert.equal((await invite()).statusCode,200);
  let bg=f.runtime.store.group(b.id)!;assert.equal(bg.participants.length,1);assert.notEqual(a.participants[0].id,bg.participants[0].id);assert.deepEqual(profileFields(a.participants[0]),profileFields(bg.participants[0]));
  const old=structuredClone(a.participants[0]);await f.request('PATCH',`/api/groups/${b.id}`,{participants:bg.participants.map(p=>({...p,enabled:false}))});await invite();assert.equal(f.runtime.store.group(b.id)!.participants[0].enabled,false);
  const history:Message={id:'profile-history',groupId:a.id,participantId:old.id,author:old.name,avatar:old.avatar,color:old.color,kind:'assistant',content:'旧发言',reasoning:'',reasoningLabel:'',round:0,status:'complete',createdAt:new Date().toISOString(),inputMessageIds:[],inputTokens:0,outputTokens:0};f.runtime.store.saveMessage(history);
  const changed=await f.request('PUT',`/api/members/${profile.id}`,{profile:{...profileFields(profile),name:'新名字',avatar:'新',color:'#abcdef'},expectedRevision:profile.revision});assert.equal(changed.statusCode,200);profile=changed.json();
  assert.equal(f.runtime.store.group(a.id)!.participants[0].name,'新名字');bg=f.runtime.store.group(b.id)!;assert.equal(bg.participants[0].avatar,'新');assert.equal(bg.participants[0].enabled,false);assert.equal(bg.participants[0].profileRevision,2);
  assert.deepEqual(f.runtime.store.messages(a.id),[history]);assert.equal(f.runtime.store.messages(b.id).length,0);
  assert.equal((await f.request('PATCH',`/api/groups/${a.id}`,{participants:[{...old,enabled:false}]})).statusCode,409);
  assert.equal((await f.request('PUT',`/api/members/${profile.id}`,{profile:profileFields(base),expectedRevision:1})).statusCode,409);
  await f.request('DELETE',`/api/groups/${a.id}/members/${old.id}`);assert.equal(f.runtime.store.group(a.id)!.participants.length,0);assert.ok(f.runtime.store.profile(profile.id));
  await f.restart();assert.equal(f.runtime.store.profile(profile.id)!.name,'新名字');assert.equal(f.runtime.store.group(b.id)!.participants[0].enabled,false);
  await f.request('POST',`/api/groups/${a.id}/members`,{profileId:profile.id});assert.equal(f.runtime.store.group(a.id)!.participants[0].name,'新名字');assert.notEqual(f.runtime.store.group(a.id)!.participants[0].id,old.id);
});

test('profile API validates strict data, CSRF, duplicate invitations, limits and atomic rollback',async t=>{
  const f=await fixture(t);const p=f.runtime.store.profiles()[0];
  assert.equal((await f.runtime.app.inject({method:'POST',url:'/api/members',headers:{host:f.host},payload:{profile:profileFields(p)}})).statusCode,403);
  for(const extra of [{apiKey:'never-store'},{avatar:'https://evil.example/pixel'},{skills:['missing-skill']}]) {
    const response=await f.request('POST','/api/members',{profile:{...profileFields(p),...extra}});assert.ok([400,409].includes(response.statusCode));
  }
  const count=f.runtime.store.profiles().length,groups=f.runtime.store.groups().length;
  assert.equal((await f.request('POST','/api/members',{profile:profileFields(p),groupId:'missing'})).statusCode,404);assert.equal(f.runtime.store.profiles().length,count);
  assert.equal((await f.request('POST','/api/groups',{name:'重复',profileIds:[p.id,p.id]})).statusCode,400);
  assert.equal((await f.request('POST','/api/groups',{name:'不存在',profileIds:['missing']})).statusCode,404);assert.equal(f.runtime.store.groups().length,groups);
  const group=(await f.request('POST','/api/groups',{name:'满员群',profileIds:[]})).json<Group>();
  for(let i=0;i<8;i++)assert.equal((await f.request('POST','/api/members',{profile:{...profileFields(p),name:`成员 ${i}`},groupId:group.id})).statusCode,201);
  const after=f.runtime.store.profiles().length;
  assert.equal((await f.request('POST','/api/members',{profile:profileFields(p),groupId:group.id})).statusCode,400);assert.equal(f.runtime.store.profiles().length,after);
  await f.request('PATCH',`/api/groups/${group.id}`,{archived:true});assert.equal((await f.request('POST',`/api/groups/${group.id}/members`,{profileId:p.id})).statusCode,409);
});

test('global edits block while any joined group runs, and private runtime contexts remain scoped to each group',async t=>{
  const wakes:RuntimeWake[]=[],delivered:{group:string;contents:string[]}[]=[];const f=await fixture(t,async w=>{delivered.push({group:w.group.name,contents:w.read().messages.map(m=>m.content)});wakes.push(w);w.wait(0);});const p=f.runtime.store.profiles()[0];
  const make=async(name:string)=>(await f.request('POST','/api/groups',{name,goal:'隔离的讨论目标',profileIds:[p.id],freeSettings:{messageGapMin:0,messageGapMax:0,readingCharsPerSecond:0,typingGraceSeconds:0,quietSeconds:0,cooldownMin:1,cooldownMax:1,concurrency:1,maxMinutes:5,wakeProbability:1,respondToAI:true}})).json<Group>();
  const a=await make('A'),b=await make('B');
  await f.request('POST',`/api/groups/${a.id}/messages`,{content:'A 群专属内容'});await f.request('POST',`/api/groups/${b.id}/messages`,{content:'B 群专属内容'});
  await f.request('POST',`/api/groups/${a.id}/free/start`,{});await f.request('POST',`/api/groups/${b.id}/free/start`,{});
  const deadline=Date.now()+5000;while(wakes.length<2){assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,10));}
  assert.notEqual(wakes[0].sessionId,wakes[1].sessionId);assert.notEqual(wakes[0].participant.id,wakes[1].participant.id);
  for(const w of wakes)assert.equal(w.participant.profileId,p.id);
  for(const record of delivered){assert.equal(record.contents.length,1);assert.ok(record.contents.every(content=>content.startsWith(record.group)));}
  const response=await f.request('PUT',`/api/members/${p.id}`,{profile:{...profileFields(p),name:'不应生效'},expectedRevision:p.revision});assert.equal(response.statusCode,409);assert.equal(f.runtime.store.profile(p.id)!.name,p.name);
  const beforeDelete=f.runtime.store.groups();
  assert.equal((await f.request('DELETE',`/api/members/${p.id}`,{expectedRevision:p.revision})).statusCode,409);assert.deepEqual(f.runtime.store.groups(),beforeDelete);assert.equal(f.runtime.store.profile(p.id)!.deletedAt,undefined);
  assert.equal((await f.request('DELETE',`/api/groups/${a.id}/members/${a.participants[0].id}`)).statusCode,409);
  for(const g of [a,b]){await f.request('POST',`/api/groups/${g.id}/free/pause`,{});await f.runtime.roomEngine.settle(g.id);}
  const round=await f.request('POST',`/api/groups/${b.id}/runs`,{});assert.equal(round.statusCode,201);
  assert.equal((await f.request('PUT',`/api/members/${p.id}`,{profile:{...profileFields(p),name:'轮次运行时禁止'},expectedRevision:p.revision})).statusCode,409);
  assert.equal((await f.request('DELETE',`/api/members/${p.id}`,{expectedRevision:p.revision})).statusCode,409);
  assert.equal((await f.request('POST',`/api/groups/${b.id}/members`,{profileId:f.runtime.store.profiles()[1].id})).statusCode,409);
  await f.request('POST',`/api/runs/${round.json().id}/cancel`,{});await f.runtime.scheduler.settle(round.json().id);
  assert.equal((await f.request('PUT',`/api/members/${p.id}`,{profile:{...profileFields(p),name:'已更新'},expectedRevision:p.revision})).statusCode,200);
  const previous=f.runtime.store.freeSession(a.id)!.members[0].sessionId;
  await f.request('POST',`/api/groups/${a.id}/free/start`,{});assert.notEqual(f.runtime.store.freeSession(a.id)!.members[0].sessionId,previous);await f.request('POST',`/api/groups/${a.id}/free/pause`,{});
});

test('avatar uploads decode and sanitize raster bytes, enforce local access and size, and survive global edits plus restart',async t=>{
  const f=await fixture(t);
  const original=await sharp({create:{width:32,height:48,channels:3,background:'#43826a'}}).withExif({IFD0:{Artist:'private-metadata'}}).jpeg().toBuffer();
  const payload={data:original.toString('base64')};
  assert.equal((await f.runtime.app.inject({method:'POST',url:'/api/avatars',headers:{host:f.host},payload})).statusCode,403);
  const uploaded=await f.request('POST','/api/avatars',payload);assert.equal(uploaded.statusCode,201);const id=uploaded.json().id;assert.match(id,/^[a-f0-9]{64}$/);
  assert.equal((await f.request('POST','/api/avatars',payload)).json().id,id);
  const picture=await f.request('GET',`/api/avatars/${id}`);assert.equal(picture.statusCode,200);assert.match(picture.headers['content-type']!,/^image\/png/);assert.equal(picture.headers['x-content-type-options'],'nosniff');assert.equal(picture.headers['cross-origin-resource-policy'],'same-origin');
  const metadata=await sharp(picture.rawPayload).metadata();assert.equal(metadata.width,256);assert.equal(metadata.height,256);assert.equal(metadata.exif,undefined);assert.equal(metadata.icc,undefined);
  assert.equal((await f.runtime.app.inject({url:`/api/avatars/${id}`,headers:{host:f.host,origin:'https://evil.example','sec-fetch-site':'cross-site'}})).statusCode,403);
  for(const format of ['png','webp','gif'] as const){const bytes=await sharp({create:{width:12,height:20,channels:4,background:'#b76742'}}).toFormat(format).toBuffer();assert.equal((await f.request('POST','/api/avatars',{data:bytes.toString('base64')})).statusCode,201);}
  for(const bytes of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),Buffer.from([255,216,255,0,0]),Buffer.from('https://evil.example/avatar.png')])assert.equal((await f.request('POST','/api/avatars',{data:bytes.toString('base64')})).statusCode,400);
  const tooLarge=await f.request('POST','/api/avatars',{data:Buffer.alloc(2*1024*1024+1).toString('base64')});assert.ok([400,413].includes(tooLarge.statusCode));
  const tooManyPixels=await sharp({create:{width:5000,height:5000,channels:3,background:'#ffffff'}}).png().toBuffer();assert.equal((await f.request('POST','/api/avatars',{data:tooManyPixels.toString('base64')})).statusCode,400);
  assert.equal((await f.request('GET',`/api/avatars/${'0'.repeat(64)}`)).statusCode,404);
  let p=f.runtime.store.profiles()[0];const group=f.runtime.store.groups()[0];
  assert.equal((await f.request('PUT',`/api/members/${p.id}`,{profile:{...profileFields(p),avatarAssetId:'0'.repeat(64)},expectedRevision:p.revision})).statusCode,409);
  assert.equal((await f.request('PUT',`/api/members/${p.id}`,{profile:{...profileFields(p),avatarAssetId:'https://evil.example/pixel'},expectedRevision:p.revision})).statusCode,400);
  p=(await f.request('PUT',`/api/members/${p.id}`,{profile:{...profileFields(p),avatarAssetId:id},expectedRevision:p.revision})).json();
  assert.equal(f.runtime.store.group(group.id)!.participants.find(m=>m.profileId===p.id)!.avatarAssetId,id);
  await f.restart();assert.equal(f.runtime.store.profile(p.id)!.avatarAssetId,id);assert.deepEqual((await f.request('GET',`/api/avatars/${id}`)).rawPayload,picture.rawPayload);
  const {avatarAssetId,...textAvatar}=profileFields(p);
  const cleared=await f.request('PUT',`/api/members/${p.id}`,{profile:textAvatar,expectedRevision:p.revision});assert.equal(cleared.statusCode,200);assert.equal(cleared.json().avatarAssetId,undefined);
  assert.equal(f.runtime.store.group(group.id)!.participants.find(m=>m.profileId===p.id)!.avatarAssetId,undefined);
  assert.equal((await f.request('GET',`/api/avatars/${id}`)).statusCode,200); // Old message avatars remain readable.
});

test('profile recycle bin removes all memberships atomically, preserves messages and images, blocks stale retries and restores identity only',async t=>{
  const f=await fixture(t);let p=f.runtime.store.profiles()[0];
  const bytes=await sharp({create:{width:16,height:16,channels:3,background:'#47845a'}}).png().toBuffer();const avatar=(await f.request('POST','/api/avatars',{data:bytes.toString('base64')})).json().id;
  p=(await f.request('PUT',`/api/members/${p.id}`,{profile:{...profileFields(p),avatarAssetId:avatar},expectedRevision:p.revision})).json();
  const originalGroup=f.runtime.store.groups()[0];
  const b=(await f.request('POST','/api/groups',{name:'回收测试群',goal:'测试头像消息',profileIds:[p.id]})).json<Group>();
  await f.request('PATCH',`/api/groups/${b.id}`,{settings:{...b.settings,rounds:1,roundsMode:'fixed',autoSummary:false,delaySeconds:0,delayMode:'fixed',summaryParticipantId:b.participants[0].id}});
  const run=(await f.request('POST',`/api/groups/${b.id}/runs`,{})).json();await f.runtime.scheduler.settle(run.id);
  const messages=f.runtime.store.messages(b.id);assert.equal(messages.length,1);assert.equal(messages[0].avatarAssetId,avatar);
  f.runtime.store.saveRun({...f.runtime.store.run(run.id)!,status:'failed',error:'test retry'});
  await f.request('PATCH',`/api/groups/${b.id}`,{archived:true});
  const runs=f.runtime.store.runs(b.id),events=f.runtime.store.events(b.id),beforeGroups=f.runtime.store.groups();
  assert.equal((await f.runtime.app.inject({method:'DELETE',url:`/api/members/${p.id}`,headers:{host:f.host},payload:{expectedRevision:p.revision}})).statusCode,403);
  assert.equal((await f.request('DELETE',`/api/members/${p.id}`,{})).statusCode,400);
  assert.equal((await f.request('DELETE',`/api/members/${p.id}`,{expectedRevision:p.revision-1})).statusCode,409);assert.deepEqual(f.runtime.store.groups(),beforeGroups);
  const deleted=await f.request('DELETE',`/api/members/${p.id}`,{expectedRevision:p.revision});assert.equal(deleted.statusCode,200);p=deleted.json();assert.ok(p.deletedAt);
  assert.equal(f.runtime.store.group(originalGroup.id)!.participants.some(m=>m.profileId===p.id),false);assert.equal(f.runtime.store.group(b.id)!.participants.length,0);assert.equal(f.runtime.store.group(b.id)!.settings.summaryParticipantId,'');
  assert.equal(f.runtime.store.profiles().some(m=>m.id===p.id),false);assert.equal(f.runtime.store.profiles(true).some(m=>m.id===p.id),true);
  assert.deepEqual(f.runtime.store.messages(b.id),messages);assert.deepEqual(f.runtime.store.events(b.id),events);assert.deepEqual(f.runtime.store.runs(b.id),runs);
  assert.equal((await f.request('POST',`/api/groups/${originalGroup.id}/members`,{profileId:p.id})).statusCode,404);
  await f.request('PATCH',`/api/groups/${b.id}`,{archived:false});assert.equal((await f.request('POST',`/api/runs/${run.id}/retry`,{})).statusCode,409);
  await f.restart();const boot=(await f.request('GET','/api/bootstrap')).json();assert.equal(boot.deletedProfiles.length,1);assert.equal(boot.deletedProfiles[0].id,p.id);assert.ok(!boot.profiles.some((m:MemberProfile)=>m.id===p.id));
  assert.equal((await f.request('POST',`/api/members/${p.id}/restore`,{expectedRevision:p.revision-1})).statusCode,409);
  const restored=await f.request('POST',`/api/members/${p.id}/restore`,{expectedRevision:p.revision});assert.equal(restored.statusCode,200);p=restored.json();assert.equal(p.deletedAt,undefined);assert.equal(p.avatarAssetId,avatar);
  assert.equal(f.runtime.store.groups().some(g=>g.participants.some(m=>m.profileId===p.id)),false);assert.equal((await f.request('GET',`/api/avatars/${avatar}`)).statusCode,200);
  const invited=(await f.request('POST',`/api/groups/${b.id}/members`,{profileId:p.id})).json<Group>();assert.notEqual(invited.participants[0].id,b.participants[0].id);assert.equal(invited.participants[0].avatarAssetId,avatar);
  assert.equal((await f.request('POST',`/api/runs/${run.id}/retry`,{})).statusCode,409);assert.deepEqual(f.runtime.store.messages(b.id),messages);
});
