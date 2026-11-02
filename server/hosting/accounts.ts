import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {chmodSync,existsSync,lstatSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SecretVault} from '../vault.js';
import {HostingSettingsStore} from './settings.js';
import {type HostingSettings} from '../../shared/hosting-settings.js';

export interface HostedUser {id:string;name:string;createdAt:string;revokedAt?:string;}
export type HostingUser=HostedUser;
export class HostingAccountError extends Error {}
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const validToken=(value:string)=>/^[A-Za-z0-9_-]{43}$/.test(value);
const SESSION_MS=7*24*60*60*1000;

const validId=(id:string)=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
/** Authentication uses hashes only. Sealed invitations commit with hashes; per-account keys stay in owner-only vaults. */
export class HostingAccounts {
  private db:DatabaseSync;
  private directory:string;
  private settings:()=>HostingSettings;
  constructor(dataDir:string,private now:()=>number=Date.now,settings?:()=>HostingSettings){
    const directory=resolve(dataDir),file=join(directory,'accounts.db');
    this.directory=directory;this.settings=settings??(()=>new HostingSettingsStore(directory).values());
    for(const path of [directory,file])if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw new HostingAccountError('分享账号路径不能使用符号链接。');
    mkdirSync(directory,{recursive:true,mode:0o700});
    if(process.platform!=='win32')chmodSync(directory,0o700);
    this.db=new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS hosted_users(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at INTEGER NOT NULL,revoked_at INTEGER,code_hash TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS hosted_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES hosted_users(id),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS hosted_sessions_user ON hosted_sessions(user_id);`);
    if(!this.db.prepare('PRAGMA table_info(hosted_users)').all().some(row=>row.name==='code_encrypted'))this.db.exec('ALTER TABLE hosted_users ADD COLUMN code_encrypted TEXT');
    if(process.platform!=='win32')chmodSync(file,0o600);
  }
  private user(row:Record<string,unknown>):HostedUser{return {id:String(row.id),name:String(row.name),createdAt:new Date(Number(row.created_at)).toISOString(),...(row.revoked_at===null?{}:{revokedAt:new Date(Number(row.revoked_at)).toISOString()})};}
  list():HostedUser[]{return this.db.prepare('SELECT id,name,created_at,revoked_at FROM hosted_users ORDER BY created_at,id').all().map(row=>this.user(row));}
  get(id:string):HostedUser|undefined{const row=this.db.prepare('SELECT id,name,created_at,revoked_at FROM hosted_users WHERE id=? AND revoked_at IS NULL').get(id);return row?this.user(row):undefined;}
  add(name:string):{user:HostedUser;code:string}{
    name=name.trim();
    if(!name||name.length>60||/[\u0000-\u001f\u007f]/.test(name))throw new HostingAccountError('名字须为 1–60 字符，不能包含控制字符。');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const maximum=this.settings().maxAccounts;
      if(Number(this.db.prepare('SELECT count(*) AS n FROM hosted_users WHERE revoked_at IS NULL').get()!.n)>=maximum)throw new HostingAccountError(`最多保留 ${maximum} 个有效邀请账号，可在分享设置中调整。`);
      const id=randomUUID(),code=randomBytes(32).toString('base64url'),now=this.now();
      const sealed=this.vault(id).sealInvitation('invite:'+id,code);
      this.db.prepare('INSERT INTO hosted_users(id,name,created_at,code_hash,code_encrypted) VALUES(?,?,?,?,?)').run(id,name,now,digest(code),sealed);
      this.db.exec('COMMIT');return {user:{id,name,createdAt:new Date(now).toISOString()},code};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  revoke(id:string):boolean{
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const changed=this.db.prepare('UPDATE hosted_users SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').run(this.now(),id).changes;
      this.db.prepare('DELETE FROM hosted_sessions WHERE user_id=?').run(id);
      this.db.exec('COMMIT');return Number(changed)>0;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  authenticateCode(code:string):HostedUser|undefined{
    if(!validToken(code))return;
    const row=this.db.prepare('SELECT id,name,created_at,revoked_at FROM hosted_users WHERE code_hash=? AND revoked_at IS NULL').get(digest(code));
    return row?this.user(row):undefined;
  }
  private vault(id:string):SecretVault{
    if(!validId(id))throw new HostingAccountError('邀请账号 ID 无效。');
    const root=join(this.directory,'invitation-codes');
    if(existsSync(root)&&lstatSync(root).isSymbolicLink())throw new HostingAccountError('邀请码路径不能使用符号链接。');
    return new SecretVault(join(root,id));
  }
  hasRecoverableCode(id:string):boolean{
    if(!validId(id)||!this.get(id))return false;
    if(this.db.prepare('SELECT code_encrypted FROM hosted_users WHERE id=?').get(id)?.code_encrypted)return true;
    const root=join(this.directory,'invitation-codes'),directory=join(root,id),file=join(directory,'secrets.enc.json');
    for(const path of [root,directory,file])if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw new HostingAccountError('邀请码路径不能使用符号链接。');
    return existsSync(file);
  }
  /** Owner-only management API; never expose it as a tenant/public HTTP route. */
  recoverCode(id:string):string|undefined{
    if(!this.get(id))throw new HostingAccountError('邀请账号不存在或已撤销。');
    if(!this.hasRecoverableCode(id))return;
    const encrypted=this.db.prepare('SELECT code_encrypted FROM hosted_users WHERE id=? AND revoked_at IS NULL').get(id)?.code_encrypted;
    const vault=this.vault(id),code=encrypted?vault.openInvitation('invite:'+id,String(encrypted)):vault.get('invite:'+id);
    if(!code||this.authenticateCode(code)?.id!==id)throw new HostingAccountError('已保存邀请码与当前登录记录不匹配，请导入当前邀请码或重置。');
    return code;
  }
  importCode(id:string,code:string):void{
    this.db.exec('BEGIN IMMEDIATE');
    try{
      if(!validId(id)||this.authenticateCode(code)?.id!==id)throw new HostingAccountError('邀请码与此账号不匹配，未做任何修改。');
      const sealed=this.vault(id).sealInvitation('invite:'+id,code);
      this.db.prepare('UPDATE hosted_users SET code_encrypted=? WHERE id=?').run(sealed,id);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  resetCode(id:string):{user:HostedUser;code:string}{
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const user=this.get(id);if(!user)throw new HostingAccountError('邀请账号不存在或已撤销。');
      const code=randomBytes(32).toString('base64url');
      const sealed=this.vault(id).sealInvitation('invite:'+id,code);
      this.db.prepare('UPDATE hosted_users SET code_hash=?,code_encrypted=? WHERE id=?').run(digest(code),sealed,id);
      this.db.prepare('DELETE FROM hosted_sessions WHERE user_id=?').run(id);
      this.db.exec('COMMIT');return {user,code};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  createSession(userId:string):{token:string;expiresAt:number}{
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const now=this.now();this.db.prepare('DELETE FROM hosted_sessions WHERE expires_at<=?').run(now);
      if(!this.db.prepare('SELECT id FROM hosted_users WHERE id=? AND revoked_at IS NULL').get(userId))throw new HostingAccountError('账号不可用。');
      const maximum=this.settings().maxSessionsPerUser;
      if(Number(this.db.prepare('SELECT count(*) AS n FROM hosted_sessions WHERE user_id=?').get(userId)!.n)>=maximum)throw new HostingAccountError(`此账号已有 ${maximum} 个登录会话，请退出其他设备或联系管理员。`);
      const token=randomBytes(32).toString('base64url'),expiresAt=now+SESSION_MS;
      this.db.prepare('INSERT INTO hosted_sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)').run(digest(token),userId,now,expiresAt);
      this.db.exec('COMMIT');return {token,expiresAt};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  session(token:string):HostedUser|undefined{
    if(!validToken(token))return;
    const row=this.db.prepare('SELECT u.id,u.name,u.created_at,u.revoked_at FROM hosted_sessions s JOIN hosted_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.revoked_at IS NULL').get(digest(token),this.now());
    return row?this.user(row):undefined;
  }
  deleteSession(token:string):void{if(validToken(token))this.db.prepare('DELETE FROM hosted_sessions WHERE token_hash=?').run(digest(token));}
  close(){this.db.close();}
}
