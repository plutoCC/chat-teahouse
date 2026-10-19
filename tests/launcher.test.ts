import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {resolve} from 'node:path';

const execute=promisify(execFile);
const windows=process.platform==='win32';
async function launch(args:string){
  const script=resolve('Start-Teahouse.ps1').replaceAll("'","''");
  // Intercept only the browser invocation; never open a user's real browser in tests.
  const command=`function Start-Process { param([string]$FilePath) Write-Host ('BROWSER:' + $FilePath) }; & '${script}' ${args}`;
  try {const result=await execute('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{windowsHide:true,timeout:20000});return {...result,code:0};}
  catch(error){const result=error as {stdout:string;stderr:string;code:number};return result;}
}

test('Windows launcher opens a healthy existing server at its actual port without restarting it',{skip:!windows},async t=>{
  const server=createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,application:'chat-teahouse',version:'fixture'}));});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(()=>new Promise<void>(done=>server.close(()=>done())));
  const port=(server.address() as {port:number}).port;
  const result=await launch(`-Port ${port} -OpenBrowser`);
  assert.equal(result.code,0,result.stderr);assert.ok(result.stdout.includes(`BROWSER:http://127.0.0.1:${port}/`));
  const status=await launch(`-Port ${port} -Action Status -OpenBrowser`);
  assert.equal(status.code,0,status.stderr);assert.ok(!status.stdout.includes('BROWSER:'));
  const backgroundOnly=await launch(`-Port ${port}`);
  assert.equal(backgroundOnly.code,0,backgroundOnly.stderr);assert.ok(!backgroundOnly.stdout.includes('BROWSER:'));
});

test('Windows launcher never opens an unrelated service or an unhealthy occupied port',{skip:!windows},async t=>{
  let validJson=true;
  const server=createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(validJson?JSON.stringify({ok:true,application:'different-app'}):'unhealthy');});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(()=>new Promise<void>(done=>server.close(()=>done())));
  const port=(server.address() as {port:number}).port;
  for(const valid of [true,false]){validJson=valid;const result=await launch(`-Port ${port} -OpenBrowser`);assert.notEqual(result.code,0);assert.ok(!result.stdout.includes('BROWSER:'));}
});
