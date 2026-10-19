import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

test('Windows proxy bootstrap accepts only existing loopback proxies and keeps local traffic direct', { skip: process.platform !== 'win32' }, () => {
  const shell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference = 'Stop'
    . './scripts/network-env.ps1'
    $values = @('127.0.0.1:8080','http=127.0.0.1:8081;https=127.0.0.1:8082','http://[::1]:8080','http://remote.example:8080','http://user:pass@127.0.0.1:8080','socks5://127.0.0.1:8080','http://127.0.0.1:8080/path','http=127.0.0.1:8080')
    $parsed = @($values | ForEach-Object { $proxy = Get-TeaLoopbackProxy $_; if ($proxy) { $proxy } else { 'rejected' } })
    function Get-ItemProperty { [pscustomobject]@{ProxyEnable=1;ProxyServer='127.0.0.1:8080'} }
    $env:HTTPS_PROXY=''; $env:HTTP_PROXY=''; $env:CHAT_TEA_USE_SYSTEM_PROXY=''; $env:NO_PROXY='existing.internal'
    Initialize-TeaNetwork
    $automatic = $env:HTTPS_PROXY
    $env:HTTPS_PROXY='http://explicit.example:8000'
    Initialize-TeaNetwork
    $explicit = $env:HTTPS_PROXY
    $env:HTTPS_PROXY=''; $env:CHAT_TEA_USE_SYSTEM_PROXY='0'
    Initialize-TeaNetwork
    [pscustomobject]@{parsed=$parsed;automatic=$automatic;explicit=$explicit;disabled=[string]$env:HTTPS_PROXY;noProxy=$env:NO_PROXY;enabled=$env:NODE_USE_ENV_PROXY} | ConvertTo-Json -Compress
  `], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.deepEqual(value.parsed, ['http://127.0.0.1:8080','http://127.0.0.1:8082','http://[::1]:8080',...Array(5).fill('rejected')]);
  assert.equal(value.automatic, 'http://127.0.0.1:8080');
  assert.equal(value.explicit, 'http://explicit.example:8000'); assert.equal(value.disabled, '');
  assert.equal(value.enabled, '1');
  for (const name of ['existing.internal', 'localhost', '127.0.0.1', '::1', '[::1]']) assert.ok(value.noProxy.split(',').includes(name));
});
