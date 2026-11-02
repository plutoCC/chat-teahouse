import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {join, resolve} from 'node:path';

const windows=process.platform==='win32';
const source=resolve('scripts/start-hosted.ps1');
const fixtureCode=`import {createServer} from 'node:http';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const dir=process.env.CHAT_TEA_HOST_DATA_DIR;
mkdirSync(dir,{recursive:true});
writeFileSync(join(dir,'hosting-process.lock'),String(process.pid),{flag:'wx'});
writeFileSync(join(dir,'fixture-data.txt'),'retained');
writeFileSync(join(dir,'fixture-runtime.json'),JSON.stringify({cwd:process.cwd(),dailyCny:process.env.CHAT_TEA_HOST_DAILY_CNY,origin:process.env.CHAT_TEA_PUBLIC_ORIGIN}));
for(const port of [process.env.CHAT_TEA_ADMIN_PORT,process.env.CHAT_TEA_HOST_PORT])createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,application:'chat-teahouse'}));}).listen(Number(port),'127.0.0.1');`;

function fixture(){
  const parent=resolve('.test-artifacts');mkdirSync(parent,{recursive:true});
  const root=mkdtempSync(join(parent,'hosted launcher 茶 '));
  for(const dir of ['scripts','server/hosting','node_modules/tsx','dist'])mkdirSync(join(root,dir),{recursive:true});
  copyFileSync(source,join(root,'scripts/start-hosted.ps1'));
  // No network settings, real data, credentials, or provider calls are used by this fixture.
  writeFileSync(join(root,'scripts/network-env.ps1'),'function Initialize-TeaNetwork {}');
  writeFileSync(join(root,'package.json'),'{"type":"module"}');
  writeFileSync(join(root,'node_modules/tsx/package.json'),'{"type":"module","exports":"./index.js"}');
  writeFileSync(join(root,'node_modules/tsx/index.js'),'export {};');
  writeFileSync(join(root,'server/hosting/index.ts'),fixtureCode);
  writeFileSync(join(root,'dist/index.html'),'fixture');
  return root;
}
async function launch(root:string,args:string[],env:NodeJS.ProcessEnv={}){
  return await new Promise<{stdout:string;stderr:string;code:number}>((done,reject)=>{
    const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(root,'scripts/start-hosted.ps1'),...args],{windowsHide:true,env:{...process.env,...env}});
    let stdout='',stderr='';
    child.stdout.setEncoding('utf8').on('data',data=>stdout+=data);
    child.stderr.setEncoding('utf8').on('data',data=>stderr+=data);
    const timeout=setTimeout(()=>{child.kill();reject(new Error('Fixture launcher timed out'));},45000);
    child.once('error',error=>{clearTimeout(timeout);reject(error);});
    // Windows background processes may retain inherited capture handles. The launcher itself must exit;
    // waiting for its stdio "close" would instead wait for the intentionally independent service.
    child.once('exit',code=>{clearTimeout(timeout);setImmediate(()=>{child.stdout.destroy();child.stderr.destroy();child.stdin.destroy();done({stdout,stderr,code:code??1});});});
  });
}
async function freePort(){
  const server=createServer();await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const port=(server.address() as {port:number}).port;
  await new Promise<void>(done=>server.close(()=>done()));return port;
}

test('hosted Windows launcher starts independently, preserves config, verifies process identity, and stops only its fixture',{skip:!windows,timeout:120000},async t=>{
  const root=fixture(),adminPort=await freePort(),gatewayPort=await freePort();
  const configPath=join(root,'data-hosted/hosting-launch.json'),statePath=join(root,'data-hosted/runtime/hosting-launch-process.json');
  const lockPath=join(root,'data-hosted/hosting-process.lock');
  let stateText='',lockText='';
  t.after(async()=>{
    if(stateText&&existsSync(statePath))writeFileSync(statePath,stateText);
    if(lockText&&existsSync(lockPath))writeFileSync(lockPath,lockText);
    const stopped=await launch(root,['-Action','Stop']);
    assert.equal(stopped.code,0,stopped.stderr);
  });
  const missing=await launch(root,['-SkipBuild']);
  assert.notEqual(missing.code,0);assert.match(missing.stderr,/First startup requires -Origin/);assert.equal(existsSync(configPath),false);
  const started=await launch(root,['-Origin','https://fixture.example.test','-AdminPort',String(adminPort),'-GatewayPort',String(gatewayPort),'-SkipBuild'],{CHAT_TEA_HOST_DAILY_CNY:'1.25'});
  assert.equal(started.code,0,started.stderr);
  stateText=readFileSync(statePath,'utf8');lockText=readFileSync(lockPath,'utf8');
  const state=JSON.parse(stateText),configText=readFileSync(configPath,'utf8'),config=JSON.parse(configText);
  assert.equal(state.processId,Number(lockText));assert.equal(config.limits.dailyCny,1.25);
  assert.deepEqual(JSON.parse(readFileSync(join(root,'data-hosted/fixture-runtime.json'),'utf8')),{cwd:root,dailyCny:'1.25',origin:'https://fixture.example.test'});
  const status=await launch(root,['-Action','Status']);assert.equal(status.code,0,status.stderr);
  const again=await launch(root,['-SkipBuild'],{CHAT_TEA_HOST_DAILY_CNY:'999'});
  assert.equal(again.code,0,again.stderr);assert.match(again.stdout,/Already running/);
  assert.equal(readFileSync(statePath,'utf8'),stateText);assert.equal(readFileSync(configPath,'utf8'),configText);
  const changed=await launch(root,['-Origin','https://different.example.test','-SkipBuild']);
  assert.notEqual(changed.code,0);assert.equal(readFileSync(configPath,'utf8'),configText);
  writeFileSync(statePath,JSON.stringify({...state,startTimeUtcTicks:'1'}));
  const reusedPid=await launch(root,['-Action','Stop']);assert.notEqual(reusedPid.code,0);assert.match(reusedPid.stderr,/identity or lock does not match/);
  assert.doesNotThrow(()=>process.kill(state.processId,0));writeFileSync(statePath,stateText);
  writeFileSync(lockPath,String(process.pid));
  const wrongLock=await launch(root,['-Action','Stop']);assert.notEqual(wrongLock.code,0);assert.match(wrongLock.stderr,/identity or lock does not match/);
  assert.doesNotThrow(()=>process.kill(state.processId,0));writeFileSync(lockPath,lockText);
  const stopped=await launch(root,['-Action','Stop']);assert.equal(stopped.code,0,stopped.stderr);
  assert.throws(()=>process.kill(state.processId,0));assert.equal(existsSync(lockPath),false);assert.equal(existsSync(statePath),false);
  assert.equal(readFileSync(join(root,'data-hosted/fixture-data.txt'),'utf8'),'retained');assert.equal(readFileSync(configPath,'utf8'),configText);
  const stoppedStatus=await launch(root,['-Action','Status']);assert.equal(stoppedStatus.code,1,stoppedStatus.stderr);
  const stopAgain=await launch(root,['-Action','Stop']);assert.equal(stopAgain.code,0,stopAgain.stderr);
  const restarted=await launch(root,['-SkipBuild']);assert.equal(restarted.code,0,restarted.stderr);
  stateText=readFileSync(statePath,'utf8');lockText=readFileSync(lockPath,'utf8');
  assert.equal(readFileSync(configPath,'utf8'),configText);
});

test('hosted Windows launcher rejects occupied ports and the personal port without changing existing services',{skip:!windows,timeout:45000},async t=>{
  const root=fixture();
  const server=createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,application:'chat-teahouse'}));});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(()=>new Promise<void>(done=>server.close(()=>done())));
  const adminPort=(server.address() as {port:number}).port,gatewayPort=await freePort();
  const result=await launch(root,['-Origin','https://fixture.example.test','-AdminPort',String(adminPort),'-GatewayPort',String(gatewayPort),'-SkipBuild']);
  assert.notEqual(result.code,0);assert.match(result.stderr,/port is already occupied/);
  assert.equal(existsSync(join(root,'data-hosted/hosting-launch.json')),false);
  assert.equal((await fetch(`http://127.0.0.1:${adminPort}/api/health`)).status,200);
  const personal=await launch(root,['-Origin','https://fixture.example.test','-AdminPort','4317','-GatewayPort',String(gatewayPort),'-SkipBuild']);
  assert.notEqual(personal.code,0);assert.match(personal.stderr,/4317 is reserved/);
});
