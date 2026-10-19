import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const PROVIDERS = new Set(['openai', 'claude', 'deepseek', 'qwen', 'doubao', 'ollama', 'demo']);
const validConnectionId=(id:string)=>PROVIDERS.has(id)||/^conn-[a-f0-9-]{36}$/.test(id);
const validCredentialId=(id:string)=>validConnectionId(id)||(id.startsWith('billing:')&&validConnectionId(id.slice(8)));
const ENTROPY = 'chat-teahouse-vault-v1';
// Static script: all variable data is received via stdin, never shell interpolation.
// stdout is captured in-process only; its contents must never be logged.
const DPAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding
$p = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($p.mode -eq 'acl') {
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
  $propagate = [System.Security.AccessControl.PropagationFlags]::None
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, $propagate, $allow)
  $acl.AddAccessRule($rule)
  $system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($system, 'FullControl', $inherit, $propagate, $allow)))
  [System.IO.Directory]::SetAccessControl($p.directory, $acl)
} else {
  $null = [System.Reflection.Assembly]::LoadWithPartialName('System.Security')
  $data = [Convert]::FromBase64String($p.payload)
  $entropy = [Text.Encoding]::UTF8.GetBytes('${ENTROPY}')
  if ($p.mode -eq 'protect') {
    $result = [Security.Cryptography.ProtectedData]::Protect($data, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  } elseif ($p.mode -eq 'unprotect') {
    $result = [Security.Cryptography.ProtectedData]::Unprotect($data, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  } else { throw 'Invalid operation' }
  [Console]::Out.Write([Convert]::ToBase64String($result))
  [Array]::Clear($data, 0, $data.Length)
  [Array]::Clear($result, 0, $result.Length)
}
`;

function windowsProtection(payload: Record<string, string>): Buffer {
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', DPAPI_SCRIPT], {
    input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 128 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error('Windows 凭据保护初始化失败。请使用当前 Windows 用户运行并检查数据目录权限。');
  if (payload.mode === 'acl') return Buffer.alloc(0);
  const output = result.stdout.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(output)) throw new Error('Windows 凭据保护返回了无效数据。');
  return Buffer.from(output, 'base64');
}
function rejectLink(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('凭据存储不能使用符号链接。');
}
function atomicWrite(path: string, contents: Buffer | string): void {
  rejectLink(path);
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
    if (process.platform !== 'win32') chmodSync(path, 0o600);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
interface Envelope { version: 1; iv: string; tag: string; ciphertext: string; }

/** Local-at-rest encryption, not a boundary against code running as the same user. */
export class SecretVault {
  readonly description: string;
  private readonly master: Buffer;
  private readonly path: string;
  private secrets: Record<string, string> = Object.create(null);

  constructor(dataDir: string) {
    const directory = resolve(dataDir);
    rejectLink(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory()) throw new Error('凭据数据路径必须是目录。');
    if (process.platform === 'win32') {
      windowsProtection({ mode: 'acl', directory });
      this.description = 'AES-256-GCM 加密；主密钥由 Windows DPAPI 当前用户保护；数据目录仅当前用户和 SYSTEM 可访问。';
    } else {
      chmodSync(directory, 0o700);
      this.description = 'AES-256-GCM 加密；本地主密钥文件权限 0600，目录权限 0700（未接入系统钥匙串）。';
    }
    this.path = join(directory, 'secrets.enc.json');
    const keyPath = join(directory, process.platform === 'win32' ? 'master.dpapi' : 'master.key');
    rejectLink(keyPath); rejectLink(this.path);
    if (!existsSync(keyPath)) {
      if (existsSync(this.path)) throw new Error('加密凭据存在，但主密钥缺失。请恢复原始主密钥，避免丢失凭据。');
      const master = randomBytes(32);
      try { atomicWrite(keyPath, process.platform === 'win32' ? windowsProtection({ mode: 'protect', payload: master.toString('base64') }) : master); }
      finally { master.fill(0); }
    }
    const protectedKey = readFileSync(keyPath);
    if (protectedKey.byteLength > 16 * 1024) throw new Error('凭据主密钥文件无效。');
    this.master = process.platform === 'win32' ? windowsProtection({ mode: 'unprotect', payload: protectedKey.toString('base64') }) : protectedKey;
    if (this.master.length !== 32) throw new Error('凭据主密钥长度无效。');
    if (process.platform !== 'win32') chmodSync(keyPath, 0o600);
    if (existsSync(this.path)) this.read();
  }

  private read(): void {
    try {
      if (lstatSync(this.path).size > 128 * 1024) throw new Error();
      const envelope: Envelope = JSON.parse(readFileSync(this.path, 'utf8'));
      if (envelope.version !== 1 || typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string' || typeof envelope.ciphertext !== 'string') throw new Error();
      const iv = Buffer.from(envelope.iv, 'base64'), tag = Buffer.from(envelope.tag, 'base64');
      if (iv.length !== 12 || tag.length !== 16) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.master, iv);
      decipher.setAAD(Buffer.from(ENTROPY));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
      try {
        const data: unknown = JSON.parse(plaintext.toString('utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
        for (const [id, key] of Object.entries(data)) {
          if (!validCredentialId(id) || typeof key !== 'string' || key.length > 4096) throw new Error();
          this.secrets[id] = key;
        }
      } finally { plaintext.fill(0); }
    } catch { throw new Error('无法解密已保存的凭据。文件可能损坏或不属于当前用户，原文件已保留。'); }
  }

  set(providerId: string, key: string | null): void {
    if (!validCredentialId(providerId)) throw new Error('不支持此供应商的凭据。');
    if (key !== null && (typeof key !== 'string' || !key.trim() || key.length > 4096 || /[\r\n]/.test(key))) throw new Error('API Key 格式无效。');
    const updated = { ...this.secrets };
    if (key === null) delete updated[providerId]; else updated[providerId] = key.trim();
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.master, iv);
    cipher.setAAD(Buffer.from(ENTROPY));
    const plaintext = Buffer.from(JSON.stringify(updated));
    try {
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const envelope: Envelope = { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
      atomicWrite(this.path, JSON.stringify(envelope));
      this.secrets = updated;
    } finally { plaintext.fill(0); }
  }

  get(providerId: string): string | undefined { return validCredentialId(providerId) ? this.secrets[providerId] : undefined; }
  has(providerId: string): boolean { return this.get(providerId) !== undefined; }
}
