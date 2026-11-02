import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,existsSync,symlinkSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {HostingAccounts} from '../server/hosting/accounts.js';
import {HostingBudget} from '../server/hosting/budget.js';
import {HostingSettingsStore} from '../server/hosting/settings.js';
import {classifyFunnel,executeManager,loadManagerConfig,runCommand,type ManagerDeps,type CommandOptions} from '../scripts/sharing-manager.js';

const origin='https://fixture.tailfixture.ts.net';
const funnelEnabled={TCP:{443:{HTTPS:true}},Web:{'fixture.tailfixture.ts.net:443':{Handlers:{'/':{Proxy:'http://127.0.0.1:4319'}}}},AllowFunnel:{'fixture.tailfixture.ts.net:443':true}};
const limits={dailyCny:20,userDailyCny:5,monthlyCny:300,exchangeRate:7,dailyCalls:200,userDailyCalls:50,concurrency:4,userConcurrency:2,maxOutputTokens:16384};
function fixture(){
  const parent=resolve('.test-artifacts');mkdirSync(parent,{recursive:true});
  const root=mkdtempSync(join(parent,'sharing-manager-')),dataDir=join(root,'data-hosted');
  mkdirSync(dataDir);mkdirSync(join(root,'scripts'));writeFileSync(join(root,'scripts','start-hosted.ps1'),'# test fixture, never executed');
  const configPath=join(dataDir,'hosting-launch.json');
  writeFileSync(configPath,JSON.stringify({publicOrigin:origin,dataDir,adminPort:4318,gatewayPort:4319,limits}));
  writeFileSync(join(dataDir,'hosting-mode.json'),'{"format":"chat-teahouse-hosting-v1"}\n');
  const accounts=new HostingAccounts(dataDir);accounts.close();
  const calls:{file:string;args:string[];options:CommandOptions}[]=[];
  let current:unknown=funnelEnabled,running=true;
  const deps:ManagerDeps={root,powershell:'fixture-powershell',tailscale:'fixture-tailscale',hasTailscale:()=>true,run:async(file,args,options)=>{
    calls.push({file,args,options});
    if(file==='fixture-powershell'){
      const action=options.env?.CHAT_TEA_MANAGER_ACTION;
      if(action==='Start')running=true;if(action==='Stop')running=false;
      return {code:action==='Status'&&!running?1:0,stdout:action==='Status'?(running?'Running: '+origin:'Hosted service is stopped.'):'Done',stderr:''};
    }
    if(args.join(' ')==='status --json')return {code:0,stdout:JSON.stringify({BackendState:'Running',Self:{DNSName:'fixture.tailfixture.ts.net.'}}),stderr:''};
    if(args.join(' ')==='funnel status --json')return {code:0,stdout:JSON.stringify(current),stderr:''};
    if(args.join(' ')==='funnel --bg http://127.0.0.1:4319')current=funnelEnabled;
    else if(args.join(' ')==='funnel --https=443 off')current={};
    else throw new Error('unexpected command');
    return {code:0,stdout:'https://fixture.tailfixture.ts.net/',stderr:''};
  }};
  return {root,dataDir,configPath,deps,calls,setFunnel(value:unknown){current=value;},setRunning(value:boolean){running=value;}};
}
test('manager returns metadata only and uses existing read-only account database',async()=>{
  const f=fixture(),store=new HostingAccounts(f.dataDir),created=store.add('朋友'),revoked=store.add('旧朋友');store.revoke(revoked.user.id);store.close();
  writeFileSync(join(f.dataDir,'secrets.enc.json'),'do-not-read-or-modify');
  const result=await executeManager('status',{},f.deps);
  assert.equal(result.ok,true);assert.equal(result.app?.state,'running');assert.equal(result.funnel?.state,'enabled');
  assert.equal(result.adminUrl,'http://127.0.0.1:4318');assert.equal(result.publicOrigin,origin);
  assert.deepEqual(result.accountCounts,{active:1,revoked:1});assert.equal(result.accounts?.length,2);assert.deepEqual(result.limits,limits);
  assert.ok(!JSON.stringify(result).includes(created.code));assert.ok(!JSON.stringify(result).includes('code_hash'));
  assert.equal(readFileSync(join(f.dataDir,'secrets.enc.json'),'utf8'),'do-not-read-or-modify');
  assert.ok(f.calls.every(call=>!call.args.includes('up')&&!call.args.includes('set')));
});
test('unconfigured status never creates database or invokes a child',async()=>{
  const f=fixture(),root=join(f.root,'unconfigured');mkdirSync(root);
  const result=await executeManager('status',{}, {...f.deps,root});
  assert.equal(result.ok,true);assert.equal(result.configured,false);assert.equal(result.app?.state,'unconfigured');assert.deepEqual(result.accounts,[]);
  assert.equal(existsSync(join(root,'data-hosted')),false);assert.equal(f.calls.length,0);
});
test('status preserves service controls when account metadata is unavailable or a child command fails',async()=>{
  const f=fixture();unlinkSync(join(f.dataDir,'accounts.db'));
  const result=await executeManager('status',{},f.deps);assert.equal(result.ok,true);assert.equal(result.app?.state,'running');assert.equal(result.funnel?.state,'enabled');assert.match(result.accountsError!,/邀请列表/);assert.equal(existsSync(join(f.dataDir,'accounts.db')),false);
  const unavailable=await executeManager('status',{}, {...f.deps,run:async()=>{throw new Error('secret internal output');}});
  assert.equal(unavailable.ok,true);assert.equal(unavailable.app?.state,'error');assert.equal(unavailable.funnel?.state,'unavailable');assert.equal(unavailable.publicOrigin,origin);assert.ok(!JSON.stringify(unavailable).includes('secret internal output'));
});
test('invites keep names out of shell arguments, persist hashes, and revoke their sessions',async()=>{
  const f=fixture(),name='朋友 " ; $(Get-Secret) & < >';
  const invite=await executeManager('invite',{name},f.deps);
  assert.equal(invite.ok,true);assert.equal(invite.user?.name,name);assert.match(invite.code!,/^[A-Za-z0-9_-]{43}$/);assert.equal(f.calls.length,0);
  let accounts=new HostingAccounts(f.dataDir);assert.equal(accounts.authenticateCode(invite.code!)?.id,invite.user!.id);const session=accounts.createSession(invite.user!.id);accounts.close();
  const revoked=await executeManager('revoke',{id:invite.user!.id},f.deps);assert.equal(revoked.ok,true);
  accounts=new HostingAccounts(f.dataDir);assert.equal(accounts.authenticateCode(invite.code!),undefined);assert.equal(accounts.session(session.token),undefined);accounts.close();
  assert.ok(!readFileSync(join(f.dataDir,'accounts.db')).includes(Buffer.from(invite.code!)));
  assert.ok(!JSON.stringify(await executeManager('status',{},f.deps)).includes(invite.code!));
});
test('account metadata is bounded and invitation limit is preserved',async()=>{
  const f=fixture(),accounts=new HostingAccounts(f.dataDir);
  for(let n=0;n<25;n++){const {user}=accounts.add('撤销'+n);accounts.revoke(user.id);}
  for(let n=0;n<10;n++)accounts.add('有效'+n);accounts.close();
  const status=await executeManager('status',{},f.deps);assert.deepEqual(status.accountCounts,{active:10,revoked:25});assert.equal(status.accounts?.length,30);
  const extra=await executeManager('invite',{name:'第11位'},f.deps);assert.equal(extra.ok,false);assert.match(extra.message,/10/);
});
test('invalid actions, extra fields, dangerous ids, and malformed names fail before side effects',async()=>{
  const f=fixture();
  for(const [action,input] of [['shell',{}],['start',{command:'whoami'}],['invite',{name:'a',code:'not accepted'}],['invite',{name:'x\nInjected'}],['invite',{name:''}],['revoke',{id:'123; Stop-Process'}],['stop',[]]] as const){
    const result=await executeManager(action,input,f.deps);assert.equal(result.ok,false);
  }
  assert.equal(f.calls.length,0);assert.deepEqual((await executeManager('status',{},f.deps)).accountCounts,{active:0,revoked:0});
});
test('config validation refuses personal paths, different ports, noncanonical hosts, and invalid quotas',()=>{
  const f=fixture(),base=JSON.parse(readFileSync(f.configPath,'utf8'));
  for(const patch of [{gatewayPort:4317},{adminPort:4319},{publicOrigin:'https://fixture.tailfixture.ts.net/'},{publicOrigin:'https://fixture.tailfixture.ts.net.evil.test'},{publicOrigin:'https://user:pw@fixture.tailfixture.ts.net'},{publicOrigin:'https://fixture.tailfixture.ts.net:8443'},{dataDir:join(f.root,'data')},{dataDir:f.root},{limits:{...limits,dailyCny:0}},{limits:{...limits,userDailyCalls:1.2}}]){
    writeFileSync(f.configPath,JSON.stringify({...base,...patch}));assert.throws(()=>loadManagerConfig(f.root));
  }
});
test('config rejects junction ancestors before reading or changing external hosted files',{skip:process.platform!=='win32'},()=>{
  const f=fixture(),other=fixture(),linked=join(f.root,'linked');symlinkSync(other.dataDir,linked,'junction');
  const base=JSON.parse(readFileSync(f.configPath,'utf8'));writeFileSync(f.configPath,JSON.stringify({...base,dataDir:linked}));
  assert.throws(()=>loadManagerConfig(f.root),/符号链接|目录联接/);
});
test('funnel inspection only accepts the exact 4319 route and hostname',()=>{
  assert.equal(classifyFunnel({},origin),'disabled');assert.equal(classifyFunnel(funnelEnabled,origin),'enabled');
  assert.equal(classifyFunnel({...funnelEnabled,AllowFunnel:{}},origin),'disabled');
  for(const value of [null,[],{TCP:{22:{TCPForward:'127.0.0.1:22'}}},{...funnelEnabled,Foreground:{'other-session':{}}},{...funnelEnabled,AllowFunnel:{'other.tailfixture.ts.net:443':true}},JSON.parse(JSON.stringify(funnelEnabled).replace('4319','4317')),JSON.parse(JSON.stringify(funnelEnabled).replace('fixture.tailfixture.ts.net:443','other.tailfixture.ts.net:443'))])assert.equal(classifyFunnel(value,origin),'conflict');
});
test('sharing actions preserve unrelated serve configurations and never enable a stopped site',async()=>{
  const f=fixture();f.setFunnel({TCP:{22:{TCPForward:'127.0.0.1:22'}}});
  assert.equal((await executeManager('share-start',{},f.deps)).ok,false);assert.equal((await executeManager('share-stop',{},f.deps)).ok,false);
  assert.equal(f.calls.some(call=>call.args.includes('--bg')||call.args.includes('off')),false);
  f.calls.length=0;f.setFunnel({});f.setRunning(false);
  assert.equal((await executeManager('share-start',{},f.deps)).ok,false);assert.equal(f.calls.some(call=>call.file==='fixture-tailscale'),false);
});
test('sharing toggle is idempotent, verifies results, and sends fixed argument arrays',async()=>{
  const f=fixture();f.setFunnel({});
  assert.equal((await executeManager('share-start',{},f.deps)).ok,true);
  assert.equal((await executeManager('share-start',{},f.deps)).ok,true);
  assert.equal(f.calls.filter(call=>call.args.includes('--bg')).length,1);
  assert.equal((await executeManager('share-stop',{},f.deps)).ok,true);
  assert.equal((await executeManager('share-stop',{},f.deps)).ok,true);
  assert.equal(f.calls.filter(call=>call.args.includes('off')).length,1);
});
test('website lifecycle uses only fixed launcher actions and errors never expose child output',async()=>{
  const f=fixture();assert.equal((await executeManager('start',{},f.deps)).ok,true);assert.equal((await executeManager('stop',{},f.deps)).ok,true);
  assert.equal(f.calls[0].options.env?.CHAT_TEA_MANAGER_ACTION,'Start');assert.equal(f.calls[1].options.env?.CHAT_TEA_MANAGER_ACTION,'Stop');
  assert.equal(f.calls[0].options.env?.CHAT_TEA_MANAGER_SCRIPT,join(f.root,'scripts','start-hosted.ps1'));
  const result=await executeManager('start',{}, {...f.deps,run:async()=>({code:1,stdout:'sk-secret',stderr:'private data'})});
  assert.equal(result.ok,false);assert.ok(!JSON.stringify(result).includes('sk-secret'));assert.ok(!JSON.stringify(result).includes('private data'));
});
test('command runner returns after parent exit even if a background child inherits its pipes',{timeout:10000},async()=>{
  const result=await runCommand(process.execPath,['-e',`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>{},2500)'],{stdio:['ignore',1,2],windowsHide:true});c.unref();process.stdout.write('done');`],{cwd:process.cwd(),timeoutMs:5000});
  assert.equal(result.code,0);assert.equal(result.stdout,'done');
});
test('CLI rejects oversized requests with sanitized JSON without running commands',{timeout:15000},async()=>{
  const result=await new Promise<{out:string;code:number|null}>(done=>{
    const child=spawn(process.execPath,['--import','tsx',resolve('scripts/sharing-manager.ts'),'status'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    let out='';child.stdout.setEncoding('utf8').on('data',value=>out+=value);child.stderr.resume();child.once('exit',code=>done({out,code}));child.stdin.end(JSON.stringify({payload:'x'.repeat(5000)}));
  });
  assert.equal(result.code,1);const parsed=JSON.parse(result.out);assert.equal(parsed.ok,false);assert.match(parsed.message,/过长/);
});

test('manager saves versioned settings, reports usage without reconciling pending calls and preserves the ledger',async()=>{
  const f=fixture(),accounts=new HostingAccounts(f.dataDir),invited=accounts.add('测试');accounts.close();
  const budget=new HostingBudget(f.dataDir);try{
    budget.reserve(invited.user.id,1000,100,1,2);
    const status=await executeManager('status',{},f.deps);assert.equal(status.ok,true);
    assert.equal(status.accounts?.[0].usage?.dailyCny,0.0084);assert.equal(status.accounts?.[0].usage?.dailyCalls,1);assert.equal(status.usage?.pending,1);
    assert.equal(budget.usage(invited.user.id).pending,1);assert.equal(budget.usage(invited.user.id).uncertain,0);
    const values={...status.settings!.values,userDailyCny:12,maxAccounts:24,maxMembersPerGroup:16};
    const saved=await executeManager('settings-save',{version:status.settings!.version,values},f.deps);assert.equal(saved.ok,true);assert.equal(saved.settings?.values.maxAccounts,24);
    assert.equal(new HostingSettingsStore(f.dataDir).values().userDailyCny,12);assert.equal(budget.usage(invited.user.id).calls,1);
    const stale=await executeManager('settings-save',{version:status.settings!.version,values},f.deps);assert.equal(stale.ok,false);assert.match(stale.message,/重新加载/);
    assert.equal((await executeManager('settings-save',{version:1,values:{dailyCny:2}},f.deps)).ok,false);
    const changed=await executeManager('status',{},f.deps);assert.equal(changed.limits?.userDailyCny,12);assert.equal(changed.accounts?.[0].usage?.pending,1);
  }finally{budget.close();}
});

test('manager recovers only the selected invitation, can import a legacy code, and resets without deleting the user',async()=>{
  const f=fixture(),created=await executeManager('invite',{name:'甲'},f.deps);assert.equal(created.ok,true);
  const id=created.user!.id,status=await executeManager('status',{},f.deps);
  assert.equal(status.accounts?.[0].codeAvailable,true);assert.ok(!JSON.stringify(status).includes(created.code!));
  const shown=await executeManager('account-code',{id},f.deps);assert.equal(shown.code,created.code);
  const raw=new DatabaseSync(join(f.dataDir,'accounts.db'));try{raw.prepare('UPDATE hosted_users SET code_encrypted=NULL WHERE id=?').run(id);}finally{raw.close();}
  const legacy=await executeManager('account-code',{id},f.deps);assert.equal(legacy.ok,true);assert.equal(legacy.codeAvailable,false);assert.equal(legacy.code,undefined);
  assert.equal((await executeManager('account-code-import',{id,code:'A'.repeat(43)},f.deps)).ok,false);
  const restored=await executeManager('account-code-import',{id,code:created.code},f.deps);assert.equal(restored.ok,true);assert.equal(restored.code,created.code);
  const rotated=await executeManager('account-code-reset',{id},f.deps);assert.equal(rotated.ok,true);assert.notEqual(rotated.code,created.code);
  const accounts=new HostingAccounts(f.dataDir);try{assert.equal(accounts.list().length,1);assert.equal(accounts.authenticateCode(created.code!),undefined);assert.equal(accounts.authenticateCode(rotated.code!)?.id,id);}finally{accounts.close();}
  assert.equal(f.calls.some(call=>call.args.includes(created.code!)),false);
});
