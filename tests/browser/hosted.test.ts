import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,realpathSync,rmSync,lstatSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {createServer,type AddressInfo} from 'node:net';
import {chromium,type Browser} from 'playwright-core';
import {buildApp} from '../../server/app.js';
import {buildHostingGateway} from '../../server/hosting/gateway.js';
import {SharedMemberPool} from '../../server/hosting/shared-members.js';
import {hostedProviders} from '../../server/hosting/models.js';
import {PROVIDER_DEFAULTS} from '../../server/providers.js';
import {fixtureModelCatalog} from './model-list-fixture.js';

const origin='https://tea.example.test';
async function availablePort(){
  const server=createServer();await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
  const port=(server.address() as AddressInfo).port;await new Promise<void>(yes=>server.close(()=>yes()));return port;
}

test('invited website login isolates groups and notes, hides owner tools, shows quota, and logout clears the secure session',{timeout:90000},async t=>{
  const root=resolve('.test-artifacts');mkdirSync(root,{recursive:true});const dataDir=mkdtempSync(join(root,'hosted-ui-'));
  const tenants=new Map<string,Awaited<ReturnType<typeof buildApp>> & {port:number}>();let browser:Browser|undefined;
  const gateway=buildHostingGateway({origin,dataDir,
    getTenant:async user=>{
      let tenant=tenants.get(user.id);
      if(!tenant){
        const port=await availablePort();
        const app=await buildApp({dataDir:join(dataDir,'users',user.id),port,production:true,
          hosting:{userName:user.name,providers:()=>[],getKey:()=>{throw Error('No model credentials in hosted UI test');}},
          generate:async()=>{throw Error('No model calls in hosted UI test');},nativeGenerate:async()=>{throw Error('No model calls in hosted UI test');},
        });
        await app.app.listen({host:'127.0.0.1',port});tenant={...app,port};tenants.set(user.id,tenant);
      }
      return {port:tenant.port};
    },
    usage:()=>({estimatedCny:0.25,dailyLimitCny:5,calls:2,dailyCallLimit:50,notice:'隔离浏览器测试的模拟额度'}),
  });
  t.after(async()=>{
    await browser?.close();await gateway.app.close();await Promise.all([...tenants.values()].map(tenant=>tenant.app.close()));
    assert.equal(lstatSync(dataDir).isSymbolicLink(),false);assert.equal(dirname(realpathSync(dataDir)),realpathSync(root));rmSync(dataDir,{recursive:true,force:true});
  });
  const first=gateway.accounts.add('受邀朋友甲'),second=gateway.accounts.add('受邀朋友乙');
  await gateway.app.listen({host:'127.0.0.1',port:0});const gatewayPort=(gateway.app.server.address() as AddressInfo).port;
  browser=await chromium.launch({channel:process.env.CHAT_TEA_BROWSER_CHANNEL??'msedge',headless:true,chromiumSandbox:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  // Keep the browser on a secure synthetic origin so Chromium enforces real
  // Secure/HttpOnly/__Host cookie rules. Only transport is mapped to loopback;
  // login, API authorization, tenant proxying and production UI are real.
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!==origin){await route.abort('blockedbyclient');return;}
    if(url.pathname==='/api/events'){
      // route.fetch buffers responses. The real streaming/revocation transport
      // is covered by hosting-gateway.test.ts, so use one finite SSE event here.
      await route.fulfill({status:200,contentType:'text/event-stream',body:'retry: 60000\n\nevent: change\ndata: {}\n\n'});return;
    }
    const response=await route.fetch({url:`http://127.0.0.1:${gatewayPort}${url.pathname}${url.search}`,headers:{...await route.request().allHeaders(),host:'tea.example.test'},maxRedirects:0});
    await route.fulfill({response});
  });
  const page=await context.newPage(),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(12000);
  async function login(code:string,name:string){
    await page.getByLabel('访问码',{exact:true}).fill(code);await page.getByRole('button',{name:'进入茶馆',exact:true}).click();
    await page.locator('.workspace-footer').getByText(name,{exact:true}).waitFor();
    await page.getByText('今日估算用量 / 额度（UTC）：',{exact:false}).waitFor();
  }
  await page.goto(origin);await page.getByText('这是邀请制茶馆。',{exact:false}).waitFor();
  await login(first.code,first.user.name);
  const cookie=(await context.cookies(origin)).find(cookie=>cookie.name==='__Host-teahouse_session');
  assert.ok(cookie);assert.equal(cookie.httpOnly,true);assert.equal(cookie.secure,true);assert.equal(cookie.sameSite,'Strict');
  assert.ok(!(await page.evaluate(()=>document.cookie)).includes('__Host-teahouse_session'));
  for(const name of ['模型连接','浏览器连接','管理模型连接','管理浏览器连接','管理技能库'])assert.equal(await page.getByRole('button',{name,exact:true}).count(),0,name);
  assert.match(await page.locator('.usage-footer').innerText(),/0\.25.*5\.00/);
  await page.getByRole('button',{name:/新建群聊/}).click();
  await page.getByRole('textbox',{name:'圆桌名称',exact:true}).fill('朋友甲的独立群聊');
  await page.getByRole('textbox',{name:'讨论目标',exact:false}).fill('验证邀请网站独立工作空间');
  await page.getByRole('button',{name:'创建圆桌',exact:true}).click();
  await page.getByRole('heading',{name:'朋友甲的独立群聊',exact:true}).waitFor();
  await page.getByRole('button',{name:'群聊笔记',exact:true}).click();await page.getByRole('button',{name:'新建笔记',exact:true}).click();
  await page.getByRole('textbox',{name:'笔记标题',exact:true}).fill('朋友甲的独立灵感');
  await page.getByRole('textbox',{name:'笔记内容',exact:true}).fill('此笔记应只在甲账号出现。');
  await page.getByRole('button',{name:'保存笔记',exact:true}).click();await page.getByRole('heading',{name:'朋友甲的独立灵感',exact:true}).waitFor();
  assert.equal(tenants.get(first.user.id)!.store.notebookEntries().length,1);
  await page.getByRole('button',{name:'关闭笔记本',exact:true}).click();
  await page.reload();await page.getByText(first.user.name,{exact:true}).waitFor();
  assert.equal(await page.locator('.group-item').filter({hasText:'朋友甲的独立群聊'}).count(),1);
  await page.getByRole('button',{name:'退出',exact:true}).click();await page.getByLabel('访问码',{exact:true}).waitFor();
  assert.equal((await context.cookies(origin)).some(cookie=>cookie.name==='__Host-teahouse_session'),false);
  await login(second.code,second.user.name);
  assert.equal(await page.locator('.group-item').filter({hasText:'朋友甲的独立群聊'}).count(),0);
  await page.getByRole('button',{name:'笔记本',exact:true}).click();await page.getByText('0 条记录',{exact:true}).waitFor();
  assert.equal(tenants.get(second.user.id)!.store.notebookEntries().length,0);
  assert.equal(await page.getByRole('heading',{name:'朋友甲的独立灵感',exact:true}).count(),0);
  await page.getByRole('button',{name:'关闭笔记本',exact:true}).click();await page.getByRole('button',{name:'退出',exact:true}).click();await page.getByLabel('访问码',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
});

test('owner publishes multiple models in the UI; visitors choose only usable real personas and can select either model',{timeout:90000},async t=>{
  const root=resolve('.test-artifacts');mkdirSync(root,{recursive:true});const dataDir=mkdtempSync(join(root,'shared-models-ui-'));
  const pool=new SharedMemberPool(dataDir),adminPort=await availablePort(),port=await availablePort();let browser:Browser|undefined;
  const admin=await buildApp({dataDir:join(dataDir,'owner'),port:adminPort,production:true,hostingAdmin:true,modelCatalogFetcher:fixtureModelCatalog,
    sharedMembers:{pool,userId:'owner',userName:'站主',workspaceId:'owner',admin:true}});
  const p={...PROVIDER_DEFAULTS.find(p=>p.id==='deepseek')!,enabled:true,model:'model-one',inputPrice:1,outputPrice:2,sharedModels:['model-one'],modelPrices:{'model-one':{inputPrice:1,outputPrice:2},'model-two':{inputPrice:3,outputPrice:4},'unpriced':{inputPrice:0,outputPrice:0}}};
  admin.store.saveProvider(p);admin.vault.set('deepseek','fixture-not-a-real-key');
  const profile=pool.create({pool,userId:'owner',userName:'站主',workspaceId:'owner',admin:true},{name:'真正的讨论者',providerId:'deepseek',model:'model-two',avatar:'茶',color:'#34705a',role:'',identityMode:'native',channel:'api',skills:[]},admin.store,100);
  const source={providers:()=>admin.store.providers(),getKey:(id:string)=>admin.vault.get(id)};
  const tenant=await buildApp({dataDir:join(dataDir,'visitor'),port,production:true,
    hosting:{providers:()=>hostedProviders(source),getKey:source.getKey,userName:'测试会员'},sharedMembers:{pool,userId:'visitor',userName:'测试会员',workspaceId:'visitor'}});
  t.after(async()=>{await browser?.close();await tenant.app.close();await admin.app.close();pool.close();assert.equal(lstatSync(dataDir).isSymbolicLink(),false);assert.equal(dirname(realpathSync(dataDir)),realpathSync(root));rmSync(dataDir,{recursive:true,force:true});});
  await admin.app.listen({host:'127.0.0.1',port:adminPort});await tenant.app.listen({host:'127.0.0.1',port});
  browser=await chromium.launch({channel:process.env.CHAT_TEA_BROWSER_CHANNEL??'msedge',headless:true,chromiumSandbox:true});
  const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(12000);
  const adminUrl=`http://127.0.0.1:${adminPort}`,tenantUrl=`http://127.0.0.1:${port}`;
  await page.route('**/*',route=>[adminUrl,tenantUrl].some(origin=>new URL(route.request().url()).origin===origin)?route.continue():route.abort());
  await page.goto(adminUrl);await page.getByRole('button',{name:'模型连接',exact:true}).click();await page.locator('.provider-nav').getByRole('button',{name:/DeepSeek/}).click();
  const section=page.getByRole('group',{name:'向网站会员开放的模型',exact:true});await section.waitFor();
  assert.equal(await section.getByLabel('model-one',{exact:true}).isChecked(),true);assert.equal(await section.getByLabel('unpriced',{exact:false}).isDisabled(),true);
  await section.getByLabel('model-two',{exact:true}).check();await page.getByRole('button',{name:'保存连接',exact:true}).click();await page.getByText('连接配置已保存',{exact:true}).waitFor();
  assert.deepEqual(admin.store.providers().find(p=>p.id==='deepseek')!.sharedModels,['model-one','model-two']);
  mkdirSync(resolve('output/playwright'),{recursive:true});await section.screenshot({path:resolve('output/playwright/model-sharing-fixture.png')});
  await page.reload();await page.getByRole('button',{name:'模型连接',exact:true}).click();await page.locator('.provider-nav').getByRole('button',{name:/DeepSeek/}).click();assert.equal(await page.getByRole('group',{name:'向网站会员开放的模型'}).getByLabel('model-two',{exact:true}).isChecked(),true);
  await page.goto(tenantUrl);await page.getByRole('button',{name:'AI 成员库',exact:true}).click();await page.getByRole('article',{name:'成员档案 真正的讨论者',exact:true}).waitFor();
  assert.equal(await page.locator('.profile-card').count(),1);assert.ok(!(await page.locator('.member-library').innerText()).includes('系统示例'));
  await page.getByRole('button',{name:'创建新成员',exact:true}).click();
  assert.deepEqual(await page.getByLabel('模型名称',{exact:true}).locator('option').allTextContents(),['model-one','model-two']);await page.getByLabel('模型名称',{exact:true}).selectOption('model-two');
  // Changing the owner allowlist never deletes the original persona or a visitor's workspace.
  admin.store.saveProvider({...admin.store.providers().find(p=>p.id==='deepseek')!,sharedModels:[]});await page.reload();
  await page.getByRole('button',{name:'AI 成员库',exact:true}).click();assert.equal(await page.locator('.profile-card').count(),0);
  await page.getByRole('button',{name:'创建新成员',exact:true}).click();await page.getByText('站主暂未开放可用模型，请联系站主在本机模型设置中配置。',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'保存成员',exact:true}).isDisabled(),true);
  assert.ok(pool.records().some(r=>r.profile.id===profile.id));assert.deepEqual(errors,[]);
});
