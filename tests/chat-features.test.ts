import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,realpathSync,lstatSync,readFileSync} from 'node:fs';
import {resolve,join,dirname,basename} from 'node:path';
import sharp from 'sharp';
import {buildApp} from '../server/app.js';
import {Store} from '../server/store.js';
import {migrateChatFeatures} from '../server/migrations.js';
import {profileFields,connectionKey,resolveConnection,type ProviderConfig,type Sticker,type Group,type Message} from '../shared/types.js';
import type {RuntimeWake} from '../server/runtime-adapters/types.js';
import {PublicationGate} from '../server/room-engine/pacing.js';
import {estimateTokens} from '../server/token-estimate.js';
import {containsMention,inferredMentions} from '../shared/mentions.js';

const waitUntil=async(fn:()=>boolean)=>{const end=Date.now()+7000;while(!fn()){assert.ok(Date.now()<end,'condition timeout');await new Promise(r=>setTimeout(r,10));}};

test('default group template saves edited settings atomically and persists without copying seats or changing other rooms',async t=>{
  const f=await fixture(t),source=f.runtime.store.groups()[0],other=(await f.request('POST','/api/groups',{name:'已有其他群',goal:'已有议题',profileIds:[]})).json(),unchanged=JSON.stringify(other);
  const path=`/api/groups/${source.id}/default-template`;
  const template={conversationMode:'round',settings:{...source.settings,rounds:5,budgetUSD:0.8,maxOutputTokens:6000,summaryParticipantId:source.participants[0].id},freeSettings:{...source.freeSettings!,readingCharsPerSecond:20,messageGapMin:2,messageGapMax:6,wakeProbability:0.7,concurrency:3}};
  const saved=await f.request('POST',path,template);assert.equal(saved.statusCode,200,saved.body);const defaults=saved.json();assert.equal(defaults.settings.summaryParticipantId,'');
  assert.equal(f.runtime.store.group(source.id)!.settings.summaryParticipantId,source.participants[0].id);assert.equal(f.runtime.store.group(source.id)!.freeSettings!.readingCharsPerSecond,20);
  assert.equal(JSON.stringify(f.runtime.store.group(other.id)),unchanged);
  for(const invalid of [{...template,apiKey:'must-not-be-copied'},{...template,freeSettings:{...template.freeSettings,readingCharsPerSecond:-1}},{...template,settings:{...template.settings,maxCalls:999}}])assert.equal((await f.request('POST',path,invalid)).statusCode,400);
  assert.deepEqual((await f.request('GET','/api/group-defaults')).json(),defaults);
  assert.equal((await f.runtime.app.inject({method:'POST',url:path,headers:{host:'127.0.0.1:48851'},payload:template})).statusCode,403);
  await f.restart();assert.deepEqual((await f.request('GET','/api/group-defaults')).json(),defaults);
  const created=await f.request('POST','/api/groups',{name:'按模板新建',goal:'独立议题',profileIds:[]});assert.equal(created.statusCode,201,created.body);
  const fresh=created.json();assert.equal(fresh.conversationMode,'round');assert.deepEqual(fresh.settings,defaults.settings);assert.deepEqual(fresh.freeSettings,defaults.freeSettings);assert.deepEqual(fresh.participants,[]);assert.equal(fresh.goal,'独立议题');assert.equal(f.runtime.store.messages(fresh.id).length,0);
  await f.request('PATCH',`/api/groups/${fresh.id}`,{settings:{...fresh.settings,budgetUSD:0.2}});assert.equal((await f.request('GET','/api/group-defaults')).json().settings.budgetUSD,0.8);
  f.runtime.roomEngine.start(source.id);assert.equal((await f.request('POST',path,template)).statusCode,409);f.runtime.roomEngine.pause(source.id);await f.runtime.roomEngine.settle(source.id);
  assert.equal(JSON.stringify(f.runtime.store.group(other.id)),unchanged);
});

test('model prices remain isolated by connection and actual member model across save, switch and restart',async t=>{
  const f=await fixture(t);const path='/api/providers/openai';
  assert.equal((await f.request('PUT',path,{model:'gpt-a',inputPrice:1,outputPrice:2})).statusCode,200);
  assert.equal((await f.request('PUT',path,{model:'gpt-b',inputPrice:5,outputPrice:8})).statusCode,200);
  assert.equal((await f.request('PUT',path,{model:'gpt-a'})).json().inputPrice,1);
  await f.restart();const configs=f.runtime.store.providers(),member={...f.runtime.store.groups()[0].participants[0],providerId:'openai' as const};
  assert.equal(resolveConnection(configs,{...member,model:'gpt-b'})!.outputPrice,8);assert.equal(resolveConnection(configs,{...member,model:'gpt-a'})!.outputPrice,2);assert.equal(resolveConnection(configs,{...member,model:'gpt-unknown'})!.inputPrice,0);
  assert.equal((await f.request('PUT',path,{model:'constructor'})).statusCode,400);
  assert.equal((await f.request('PUT','/api/providers/qwen',{billingMode:'subscription',apiKey:'must-not-save'})).statusCode,400);assert.equal(f.runtime.vault.has('qwen'),false);
});

test('billing credentials persist encrypted separately, routes enforce CSRF and unconfigured refresh stays offline',async t=>{
  const f=await fixture(t);const path='/api/providers/qwen/billing';
  assert.equal((await f.request('POST',path+'/refresh',{})).json().state,'unconfigured');
  const saved=await f.request('PUT',path+'/credentials',{accessKeyId:'financial-id-fixture',secretAccessKey:'financial-secret-fixture',site:'intl'});assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().state,'unverified');
  assert.ok(!saved.body.includes('financial-'));assert.ok(!readFileSync(join(f.path,'secrets.enc.json'),'utf8').includes('financial-'));assert.equal(f.runtime.vault.has('qwen'),false);
  assert.equal((await f.runtime.app.inject({method:'PUT',url:path+'/credentials',headers:{host:'127.0.0.1:48851'},payload:{adminKey:'fixture'}})).statusCode,403);
  await f.restart();assert.equal((await f.request('GET',path)).json().state,'unverified');assert.ok(f.runtime.vault.get('billing:qwen')!.includes('financial-secret-fixture'));
  assert.equal((await f.request('DELETE',path+'/credentials',{})).json().state,'unconfigured');assert.equal(f.runtime.vault.has('billing:qwen'),false);
});
function dir(){const root=resolve('.test-artifacts');mkdirSync(root,{recursive:true});const path=mkdtempSync(join(root,'chat-features-'));return {path,clean(){assert.equal(lstatSync(path).isSymbolicLink(),false);const target=realpathSync(path);assert.equal(dirname(target),realpathSync(root));assert.ok(basename(target).startsWith('chat-features-'));rmSync(target,{recursive:true,force:true});}};}
async function fixture(t:TestContext){
  const d=dir(),wakes:RuntimeWake[]=[],catalogs:{id:string;key?:string}[]=[];
  const options={dataDir:d.path,port:48851,production:true,serveUI:false,participantRuntime:{async run(w:RuntimeWake){wakes.push(w);w.read();w.wait(0);},async shutdown(){}},modelCatalogFetcher:async(p:ProviderConfig,key?:string)=>{catalogs.push({id:connectionKey(p),key});return {providerId:p.id,region:p.region,source:'account' as const,message:'测试目录',models:[{id:'deepseek-chat',label:'deepseek-chat'}],checkedAt:new Date().toISOString()};}};
  let runtime=await buildApp(options),token='';const host='127.0.0.1:48851';
  const request=(method:'GET'|'POST'|'PUT'|'PATCH'|'DELETE',url:string,payload?:unknown)=>runtime.app.inject({method,url,headers:{host,origin:'http://'+host,'x-csrf-token':token},...(payload===undefined?{}:{payload:payload as any})});
  const auth=async()=>{token=(await request('GET','/api/bootstrap')).json().csrfToken;};await auth();
  t.after(async()=>{await runtime.app.close();d.clean();});
  return {get runtime(){return runtime;},request,wakes,catalogs,path:d.path,async restart(){await runtime.app.close();runtime=await buildApp(options);await auth();}};
}

test('mentions validate active room membership, preserve selected duplicate names and avoid partial-name matching',async t=>{
  const f=await fixture(t),group=f.runtime.store.groups()[0];
  group.participants[0].name='甲';group.participants[1].name='甲乙';group.participants[2].name='甲';group.participants[2].enabled=true;f.runtime.store.saveGroup(group);
  assert.equal(containsMention('@甲乙 回应','甲'),false);assert.equal(containsMention('邮箱a@甲','甲'),false);assert.equal(containsMention('@成员 甲，请说','成员 甲'),true);
  assert.deepEqual(inferredMentions('@甲 回应',group.participants),[]);assert.deepEqual(inferredMentions('@甲乙 回应',group.participants),[group.participants[1].id]);
  const url=`/api/groups/${group.id}/messages`;
  const posted=await f.request('POST',url,{content:'@甲 请给出证据',mentions:[group.participants[0].id]});assert.equal(posted.statusCode,201,posted.body);assert.deepEqual(posted.json().mentions,[group.participants[0].id]);
  for(const payload of [{content:'没有点名',mentions:[group.participants[0].id]},{content:'@甲 点名',mentions:['outside-room']}])assert.equal((await f.request('POST',url,payload)).statusCode,400);
  group.participants[0].enabled=false;f.runtime.store.saveGroup(group);assert.equal((await f.request('POST',url,{content:'@甲 点名',mentions:[group.participants[0].id]})).statusCode,400);
  assert.equal(f.wakes.length,0);assert.equal((await f.request('GET',`/api/groups/${group.id}/logs`)).statusCode,200);assert.equal((await f.request('GET',`/api/groups/${group.id}/usage`)).json().members.length,0);
});

test('local journal keeps the newest 500 entries independently per group and caps returned text',async t=>{
  const f=await fixture(t),[group]=f.runtime.store.groups(),other=f.runtime.store.createGroup('另一个群','');
  const entry={id:'other',groupId:other.id,sessionId:'s',memberId:'a',author:'甲',model:'model',createdAt:new Date().toISOString(),kind:'waiting' as const,summary:'另一个群'};f.runtime.store.saveLog(entry);
  for(let i=0;i<505;i++)f.runtime.store.saveLog({...entry,id:String(i),groupId:group.id,summary:String(i),reasoning:'中'.repeat(17000)});
  const logs=(await f.request('GET',`/api/groups/${group.id}/logs`)).json().entries;assert.equal(logs.length,500);assert.equal(logs[0].id,'504');assert.equal(logs.at(-1).id,'5');assert.ok(logs[0].reasoning.length<16100);assert.equal(f.runtime.store.logs(other.id).length,1);
  assert.equal(f.runtime.store.messages(group.id).length,0);
});

test('multiple connections keep secrets, catalogs and selected member routes distinct across restart',async t=>{
  const f=await fixture(t);
  const added=await f.request('POST','/api/providers',{providerId:'deepseek',label:'第二个 DeepSeek'});assert.equal(added.statusCode,201,added.body);const p=added.json<ProviderConfig>(),id=connectionKey(p);assert.notEqual(id,'deepseek');assert.equal(p.enabled,false);assert.equal(p.hasKey,false);
  for(const [key,secret] of [['deepseek','fixture-key-one'],[id,'fixture-key-two']])assert.equal((await f.request('PUT','/api/providers/'+key,{enabled:true,apiKey:secret,model:'deepseek-chat'})).statusCode,200);
  const bootstrap=await f.request('GET','/api/bootstrap');assert.ok(!bootstrap.body.includes('fixture-key'));assert.ok(!readFileSync(join(f.path,'secrets.enc.json'),'utf8').includes('fixture-key'));
  for(const key of ['deepseek',id,id])assert.equal((await f.request('POST','/api/providers/'+key+'/models',{})).statusCode,200);
  assert.deepEqual(f.catalogs,[{id:'deepseek',key:'fixture-key-one'},{id,key:'fixture-key-two'}]);
  const base=profileFields(f.runtime.store.profiles()[0]);
  const create=async(name:string,connectionId:string)=>(await f.request('POST','/api/members',{profile:{...base,name,providerId:'deepseek',connectionId,model:'deepseek-chat',identityMode:'role',role:name+'独立设定'}})).json();
  const a=await create('角色一','deepseek'),b=await create('角色二',id);
  assert.equal((await f.request('POST','/api/members',{profile:{...base,providerId:'openai',connectionId:id}})).statusCode,409);
  assert.equal((await f.request('DELETE','/api/providers/'+id,{})).statusCode,409);
  await f.restart();
  const g=(await f.request('POST','/api/groups',{name:'密钥路由验证',goal:'讨论证据',profileIds:[a.id,b.id],freeSettings:{quietSeconds:0,cooldownMin:1,cooldownMax:1,concurrency:2,maxMinutes:5,wakeProbability:1,respondToAI:true,messageGapMin:0,messageGapMax:0,readingCharsPerSecond:0,typingGraceSeconds:0}})).json<Group>();
  g.settings.budgetUSD=0;f.runtime.store.saveGroup(g);
  const started=await f.request('POST',`/api/groups/${g.id}/free/start`,{});assert.equal(started.statusCode,201,started.body);
  await waitUntil(()=>f.wakes.length===2);
  assert.deepEqual(new Set(f.wakes.map(w=>w.apiKey)),new Set(['fixture-key-one','fixture-key-two']));
  assert.notEqual(f.wakes[0].sessionId,f.wakes[1].sessionId);
  for(const w of f.wakes)assert.equal(w.participant.role,w.participant.name+'独立设定');
  await f.request('POST',`/api/groups/${g.id}/free/pause`,{});await f.runtime.roomEngine.settle(g.id);
  const unused=(await f.request('POST','/api/providers',{providerId:'doubao',label:'待删除连接'})).json<ProviderConfig>();assert.equal((await f.request('DELETE','/api/providers/'+connectionKey(unused),{})).statusCode,200);
});

test('local stickers validate raster uploads, preserve animation and history, and never accept external resources',async t=>{
  const f=await fixture(t),g=f.runtime.store.groups()[0];
  const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>').toString('base64');
  assert.equal((await f.request('POST','/api/stickers',{name:'bad',tags:[],data:svg})).statusCode,400);
  assert.equal((await f.request('POST','/api/stickers',{name:'bad',tags:[],data:Buffer.from('GIF89acorrupt').toString('base64')})).statusCode,400);
  assert.equal((await f.request('POST','/api/stickers',{name:'remote',tags:[],url:'https://example.com/a.gif'})).statusCode,400);
  const raw=Buffer.concat([Buffer.alloc(16*16*3,20),Buffer.alloc(16*16*3,220)]);
  const gif=await sharp(raw,{raw:{width:16,height:32,channels:3,pageHeight:16}}).gif({delay:[200,300],loop:0}).toBuffer();assert.equal((await sharp(gif).metadata()).pages,2);
  const upload=await f.request('POST','/api/stickers',{name:'点头',tags:['赞同','赞同'],data:gif.toString('base64')});assert.equal(upload.statusCode,201,upload.body);const s=upload.json<Sticker>();assert.deepEqual(s.tags,['赞同']);
  const asset=await f.request('GET','/api/sticker-assets/'+s.assetId);assert.equal(asset.headers['content-type'],'image/webp');const meta=await sharp(asset.rawPayload).metadata();assert.equal(meta.pages,2);assert.equal(meta.exif,undefined);
  assert.equal((await f.runtime.app.inject({method:'POST',url:'/api/stickers',headers:{host:'127.0.0.1:48851'},payload:{name:'未授权',tags:[],data:gif.toString('base64')}})).statusCode,403);
  const sent=await f.request('POST',`/api/groups/${g.id}/stickers`,{stickerId:s.id});assert.equal(sent.statusCode,201);const message=sent.json();assert.equal(message.sticker.assetId,s.assetId);assert.equal(message.kind,'user');
  await f.request('PUT','/api/stickers/'+s.id,{name:'新版点头',tags:['同意']});await f.request('DELETE','/api/stickers/'+s.id,{});
  assert.equal((await f.request('POST',`/api/groups/${g.id}/stickers`,{stickerId:s.id})).statusCode,404);
  assert.equal(f.runtime.store.message(message.id)!.sticker!.name,'点头');assert.equal((await f.request('GET','/api/sticker-assets/'+s.assetId)).statusCode,200);
  await f.restart();assert.equal(f.runtime.store.stickers().length,0);assert.equal(f.runtime.store.message(message.id)!.sticker!.assetId,s.assetId);
  assert.equal((await f.request('POST','/api/stickers/'+s.id+'/restore',{})).statusCode,200);assert.equal(f.runtime.store.stickers()[0].name,'新版点头');
});

test('publication queue respects room spacing and typing extension, and cancellation prevents late delivery',async()=>{
  const gate=new PublicationGate(),signal=new AbortController(),times:number[]=[];let due=Date.now()+60;
  const first=gate.run('g',signal.signal,()=>due,()=>{times.push(Date.now());due=Date.now()+80;});
  const second=gate.run('g',signal.signal,()=>due,()=>times.push(Date.now()));
  const extended=Date.now()+160;due=extended;
  await Promise.all([first,second]);assert.ok(times[0]>=extended);assert.ok(times[1]-times[0]>=75);
  let published=false;due=Date.now()+5000;const cancelled=gate.run('g',signal.signal,()=>due,()=>{published=true;});signal.abort();await assert.rejects(cancelled);assert.equal(published,false);
  assert.equal(await gate.run('different',new AbortController().signal,()=>0,()=>42),42);
});

test('upgrade disables old manual relay seats without losing identities or history and is idempotent',()=>{
  const d=dir(),store=new Store(d.path);try{
    const created=store.createGroup('旧群','目标');store.adoptMemberProfiles();const g=store.group(created.id)!,p=store.profile(g.participants[0].profileId!)!;
    store.saveProfile({...p,channel:'web' as any});g.participants[0].channel='web' as any;store.saveGroup(g);
    migrateChatFeatures(store);assert.equal(store.profile(p.id)!.channel,'browser');assert.equal(store.group(g.id)!.participants[0].enabled,false);assert.equal(store.group(g.id)!.freeSettings!.messageGapMin,1);
    const snapshot=JSON.stringify([store.groups(),store.profiles()]);migrateChatFeatures(store);assert.equal(JSON.stringify([store.groups(),store.profiles()]),snapshot);
  }finally{store.close();d.clean();}
});

test('Chinese token estimates are separate from UTF-8 bytes and include bounded overhead',()=>{
  const text='这是中文群聊消息。'.repeat(1000);assert.ok(estimateTokens(text)<Buffer.byteLength(text)*0.7);assert.ok(estimateTokens(text)>text.length);assert.ok(estimateTokens('hello world '.repeat(1000))<12000);
});

test('short-chat migration changes only pacing once and preserves later user choices',()=>{
  const d=dir(),store=new Store(d.path);try{
    const group=store.createGroup('已有群','已有目标');group.freeSettings={...group.freeSettings!,messageGapMin:6,messageGapMax:20,readingCharsPerSecond:30,typingGraceSeconds:5,concurrency:3,maxMinutes:45,allowStickers:false};delete group.freeSettings.messageStyle;store.saveGroup(group);
    const budget=JSON.stringify(group.settings),members=JSON.stringify(group.participants);migrateChatFeatures(store);
    const updated=store.group(group.id)!;assert.equal(updated.freeSettings!.messageStyle,'segmented');assert.equal(updated.freeSettings!.messageGapMin,1);assert.equal(updated.freeSettings!.messageGapMax,3);assert.equal(updated.freeSettings!.readingCharsPerSecond,0);assert.equal(updated.freeSettings!.concurrency,3);assert.equal(updated.freeSettings!.maxMinutes,45);assert.equal(updated.freeSettings!.allowStickers,false);assert.equal(JSON.stringify(updated.settings),budget);assert.equal(JSON.stringify(updated.participants),members);
    updated.freeSettings!.messageStyle='single';updated.freeSettings!.messageGapMax=8;store.saveGroup(updated);migrateChatFeatures(store);assert.equal(store.group(group.id)!.freeSettings!.messageGapMax,8);assert.equal(store.group(group.id)!.freeSettings!.messageStyle,'single');
  }finally{store.close();d.clean();}
});

test('restart retains only already emitted bubbles and clears interrupted speech activity without adding posts',()=>{
  const d=dir();let store=new Store(d.path);try{
    const group=store.createGroup('崩溃恢复','仅本地数据');
    const message:Message={id:'emitted',groupId:group.id,participantId:group.participants[0].id,author:'测试成员',avatar:'测',color:'#000000',kind:'assistant',content:'已发送的第一段',reasoning:'',reasoningLabel:'',round:0,status:'complete',createdAt:new Date().toISOString(),inputMessageIds:[],inputTokens:0,outputTokens:0,speech:{id:'speech-id',index:1,total:3,state:'sending'}};
    store.publish('original-tool',message);store.saveFreeSession({id:'session',groupId:group.id,status:'active',epoch:1,createdAt:message.createdAt,updatedAt:message.createdAt,deadline:Date.now()+60000,callCount:1,publishedCount:1,inputTokens:20,outputTokens:30,reservedTokens:0,estimatedUSD:0,reservedUSD:0,uncertainCalls:0,members:[],sending:{memberId:group.participants[0].id,speechId:'speech-id',sent:1,total:3}});
    store.close();store=new Store(d.path);store.recoverFreeSessions();assert.equal(store.messages(group.id).length,1);assert.equal(store.messages(group.id)[0].speech!.state,'interrupted');assert.equal(store.freeSession(group.id)!.sending,undefined);assert.equal(store.freeSession(group.id)!.status,'interrupted');assert.equal(store.events(group.id).length,1);assert.equal(store.existingPost('original-tool')!.id,'emitted');
  }finally{store.close();d.clean();}
});
