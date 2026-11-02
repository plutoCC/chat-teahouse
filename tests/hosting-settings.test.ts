import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {HostingSettingsStore} from '../server/hosting/settings.js';
import {defaultHostingSettings,hostingSettingsSchema,normalizeHostingSettings} from '../shared/hosting-settings.js';
import {HostingAccounts} from '../server/hosting/accounts.js';
import {HostingBudget} from '../server/hosting/budget.js';
import {SecretVault} from '../server/vault.js';

function directory(){const root=resolve('.test-artifacts');mkdirSync(root,{recursive:true});return mkdtempSync(join(root,'hosting-settings-'));}

test('settings preserve seeded deployment values, update live across instances and reject stale or invalid writes',()=>{
  const dir=directory(),a=new HostingSettingsStore(dir,{userDailyCny:8}),b=new HostingSettingsStore(dir,{userDailyCny:8});
  assert.equal(existsSync(join(dir,'hosting-settings.json')),false);
  assert.equal(a.snapshot().version,0);assert.equal(a.values().userDailyCny,8);
  const next=a.update({...a.values(),userDailyCny:12,maxAccounts:25,maxMembersPerGroup:20},0);
  assert.equal(next.version,1);assert.equal(b.values().maxAccounts,25);assert.equal(b.values().maxMembersPerGroup,20);
  assert.throws(()=>b.update({...next.values,userDailyCny:1},0),/另一个窗口/);
  assert.equal(a.values().userDailyCny,12);
  for(const patch of [{maxAccounts:0},{maxSessionsPerUser:1.5},{dailyCny:null},{maxMessagesPerGroup:Infinity},{surprise:1}])assert.throws(()=>a.update({...next.values,...patch},1));
  assert.equal(a.snapshot().version,1);
  assert.equal(hostingSettingsSchema.length,Object.keys(defaultHostingSettings).length);
  assert.deepEqual(normalizeHostingSettings({}),defaultHostingSettings);
});

test('settings refuse corrupt files and competing writers without overwriting their data',()=>{
  const dir=directory(),settings=new HostingSettingsStore(dir),path=join(dir,'hosting-settings.json');
  settings.update(settings.values(),0);const before=readFileSync(path,'utf8');
  writeFileSync(path+'.lock','fixture');assert.throws(()=>settings.update(defaultHostingSettings,1),/正在保存/);assert.equal(readFileSync(path,'utf8'),before);
  writeFileSync(path,'invalid');assert.throws(()=>settings.values(),/无效/);assert.equal(readFileSync(path,'utf8'),'invalid');
});

test('recoverable invitations stay encrypted, import only matching old codes, and reset invalidates sessions without deleting accounts',()=>{
  const dir=directory(),settings=new HostingSettingsStore(dir);settings.update({...settings.values(),maxAccounts:1,maxSessionsPerUser:1},0);
  let accounts=new HostingAccounts(dir);const first=accounts.add('甲');const session=accounts.createSession(first.user.id);
  assert.throws(()=>accounts.add('乙'),/1 个/);assert.throws(()=>accounts.createSession(first.user.id),/1 个/);
  accounts.close();accounts=new HostingAccounts(dir);
  try{
    assert.equal(accounts.recoverCode(first.user.id),first.code);
    const raw=new DatabaseSync(join(dir,'accounts.db'));try{
      const encrypted=String(raw.prepare('SELECT code_encrypted FROM hosted_users WHERE id=?').get(first.user.id)!.code_encrypted);assert.ok(!encrypted.includes(first.code));
      const vault=new SecretVault(join(dir,'invitation-codes',first.user.id));assert.throws(()=>vault.openInvitation('invite:00000000-0000-0000-0000-000000000000',encrypted),/解密/);
      raw.prepare('UPDATE hosted_users SET code_encrypted=NULL WHERE id=?').run(first.user.id);
    }finally{raw.close();}
    for(const file of ['accounts.db','accounts.db-wal'])if(existsSync(join(dir,file)))assert.ok(!readFileSync(join(dir,file)).includes(Buffer.from(first.code)));
    assert.equal(accounts.recoverCode(first.user.id),undefined);
    assert.throws(()=>accounts.importCode(first.user.id,'A'.repeat(43)),/不匹配/);
    accounts.importCode(first.user.id,first.code);assert.equal(accounts.recoverCode(first.user.id),first.code);assert.ok(accounts.session(session.token));
    const changed=accounts.resetCode(first.user.id);assert.notEqual(changed.code,first.code);assert.equal(accounts.authenticateCode(first.code),undefined);assert.equal(accounts.session(session.token),undefined);assert.equal(accounts.recoverCode(first.user.id),changed.code);
    assert.equal(accounts.list().length,1);assert.equal(accounts.list()[0].name,'甲');
    settings.update({...settings.values(),maxAccounts:2,maxSessionsPerUser:2},1);accounts.add('乙');accounts.createSession(first.user.id);accounts.createSession(first.user.id);
    settings.update({...settings.values(),maxAccounts:1,maxSessionsPerUser:1},2);assert.equal(accounts.list().length,2);assert.equal(accounts.authenticateCode(changed.code)?.id,first.user.id);
    accounts.revoke(first.user.id);assert.throws(()=>accounts.recoverCode(first.user.id),/撤销/);
  }finally{accounts.close();}
});

test('invitation reset and import are atomic with hash/session changes, including database failures and competing writers',()=>{
  const dir=directory(),accounts=new HostingAccounts(dir),original=accounts.add('保留原码'),session=accounts.createSession(original.user.id),db=new DatabaseSync(join(dir,'accounts.db'));
  try{
    const before=db.prepare('SELECT code_hash,code_encrypted FROM hosted_users WHERE id=?').get(original.user.id);
    db.exec("CREATE TRIGGER fixture_fail_reset BEFORE DELETE ON hosted_sessions BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;");
    assert.throws(()=>accounts.resetCode(original.user.id),/fixture rollback/);
    assert.deepEqual(db.prepare('SELECT code_hash,code_encrypted FROM hosted_users WHERE id=?').get(original.user.id),before);
    assert.equal(accounts.recoverCode(original.user.id),original.code);assert.equal(accounts.authenticateCode(original.code)?.id,original.user.id);assert.ok(accounts.session(session.token));
    db.exec('DROP TRIGGER fixture_fail_reset');
    db.exec('BEGIN IMMEDIATE');
    try{assert.throws(()=>accounts.importCode(original.user.id,original.code),/locked|busy/i);}finally{db.exec('ROLLBACK');}
    assert.deepEqual(db.prepare('SELECT code_hash,code_encrypted FROM hosted_users WHERE id=?').get(original.user.id),before);
    accounts.importCode(original.user.id,original.code);assert.equal(accounts.recoverCode(original.user.id),original.code);
    const vault=new SecretVault(join(dir,'invitation-codes',original.user.id));vault.set('invite:'+original.user.id,original.code);
    db.prepare('UPDATE hosted_users SET code_encrypted=NULL WHERE id=?').run(original.user.id);
    assert.equal(accounts.recoverCode(original.user.id),original.code,'legacy encrypted file remains readable');
    const reset=accounts.resetCode(original.user.id);assert.equal(accounts.recoverCode(original.user.id),reset.code,'transactional database copy wins over old encrypted file');
  }finally{db.close();accounts.close();}
});

test('live financial changes preserve ledger and in-flight exchange rates while applying new caps to new requests',()=>{
  const dir=directory(),settings=new HostingSettingsStore(dir),budget=new HostingBudget(dir,undefined,Date.now,()=>settings.values());
  try{
    const first=budget.reserve('a',1000,100,1,2);const oldUsage=budget.usage('a');
    settings.update({...settings.values(),exchangeRate:10,userDailyCalls:1,maxInputTokens:20},0);
    assert.equal(budget.usage('a').pending,1);assert.equal(budget.usage('a').estimatedCny,oldUsage.estimatedCny);
    budget.settle(first,{inputTokens:1000,outputTokens:100});assert.equal(budget.usage('a').estimatedCny,0.0084);
    assert.throws(()=>budget.reserve('a',10,10,1,2),/次数/);assert.throws(()=>budget.reserve('b',21,10,1,2),/输入/);
    settings.update({...settings.values(),userDailyCalls:2,maxInputTokens:100},1);
    const second=budget.reserve('a',10,10,1,2);budget.settle(second,{inputTokens:10,outputTokens:10});assert.equal(budget.usage('a').estimatedCny,0.0087);assert.equal(budget.usage('a').calls,2);
    const readonly=new DatabaseSync(join(dir,'hosting-budget.sqlite'),{readOnly:true});try{assert.equal(readonly.prepare('SELECT COUNT(*) AS n FROM host_calls').get()!.n,2);}finally{readonly.close();}
  }finally{budget.close();}
});
