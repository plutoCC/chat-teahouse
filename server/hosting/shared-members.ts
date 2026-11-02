import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,existsSync,readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {profileFields,type MemberProfile,type ProfileFields,type Participant} from '../../shared/types.js';
import {DiscussionError} from '../scheduler.js';
import type {Store} from '../store.js';

interface PublishedProfile {profile:MemberProfile;creatorId:string;creatorName:string;workspaceId:string;privateSkillIds:string[];connectionMode?:'api'|'subscription';}
export interface SharedMemberContext {pool:SharedMemberPool;userId:string;userName:string;workspaceId:string;admin?:boolean;}
/** This database deliberately has no conversations, runtime contexts, keys, or notebook tables. */
export class SharedMemberPool {
  private db:DatabaseSync;
  private depth=0;
  constructor(directory:string){
    mkdirSync(directory,{recursive:true,mode:0o700});this.db=new DatabaseSync(join(directory,'shared-members.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS profiles(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS avatars(id TEXT PRIMARY KEY,bytes BLOB NOT NULL); CREATE TABLE IF NOT EXISTS revision(id INTEGER PRIMARY KEY CHECK(id=1),value INTEGER NOT NULL); INSERT OR IGNORE INTO revision VALUES(1,0);');
  }
  close(){this.db.close();}
  atomic<T>(action:()=>T):T {if(this.depth)return action();this.db.exec('BEGIN IMMEDIATE');this.depth++;try{const result=action();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}finally{this.depth--;}}
  private record(id:string):PublishedProfile|undefined {const row=this.db.prepare('SELECT data FROM profiles WHERE id=?').get(id);return row?JSON.parse(String(row.data)):undefined;}
  records():PublishedProfile[]{return this.db.prepare('SELECT data FROM profiles ORDER BY rowid').all().map(row=>JSON.parse(String(row.data)) as PublishedProfile);}
  version():number{return Number(this.db.prepare('SELECT value FROM revision WHERE id=1').get()!.value);}
  /** Stable system templates are created once; each new account stores only its own group snapshots. */
  defaultProfiles(context:SharedMemberContext,participants:Participant[]):MemberProfile[]{return this.atomic(()=>participants.flatMap((p,index)=>{
    const id=`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`;let record=this.record(id);
    if(record&&record.creatorId!=='system')throw new Error('Reserved demonstration identity is occupied');
    if(!record){const now=new Date().toISOString();record={profile:{...profileFields(p),id,revision:1,createdAt:now,updatedAt:now},creatorId:'system',creatorName:'系统示例',workspaceId:'system',privateSkillIds:[],connectionMode:'api'};this.save(record);}
    // Removing a system example remains effective for later sign-ins.
    return record.profile.deletedAt||record.profile.providerId!=='demo'?[]:[this.publicProfile(record,context)];
  }));}
  private save(record:PublishedProfile){this.db.prepare('INSERT INTO profiles(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(record.profile.id,JSON.stringify(record));this.db.exec('UPDATE revision SET value=value+1 WHERE id=1');}
  private publicProfile(record:PublishedProfile,context:SharedMemberContext):MemberProfile {return {...record.profile,shared:{creatorId:record.creatorId,creatorName:record.creatorName,canEdit:!!context.admin||record.creatorId===context.userId,connectionMode:record.connectionMode??'api'}};}
  list(context:SharedMemberContext,includeDeleted=false):MemberProfile[]{return this.records().filter(r=>includeDeleted||!r.profile.deletedAt).map(r=>this.publicProfile(r,context));}
  get(context:SharedMemberContext,id:string):MemberProfile|undefined{const r=this.record(id);return r?this.publicProfile(r,context):undefined;}
  skillUnavailable(context:SharedMemberContext,id:string):boolean {const r=this.record(id);return !!r?.privateSkillIds.length&&r.workspaceId!==context.workspaceId;}
  avatar(id:string):Buffer|undefined {if(!/^[a-f0-9]{64}$/.test(id))return;const row=this.db.prepare('SELECT bytes FROM avatars WHERE id=?').get(id);return row?Buffer.from(row.bytes as Uint8Array):undefined;}
  private publishAvatar(id:string|undefined,load:(id:string)=>Buffer|undefined){
    if(!id||this.avatar(id))return;const bytes=load(id);
    if(!bytes||bytes.length>2*1024*1024||createHash('sha256').update(bytes).digest('hex')!==id||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new DiscussionError('公共头像无效，请重新上传。',409);
    this.db.prepare('INSERT OR IGNORE INTO avatars(id,bytes) VALUES(?,?)').run(id,bytes);
  }
  create(context:SharedMemberContext,fields:ProfileFields,store:Store,maxProfiles:number,connectionMode:'api'|'subscription'='api'):MemberProfile{return this.atomic(()=>{
    if(this.records().filter(r=>r.creatorId===context.userId).length>=maxProfiles)throw new DiscussionError(`此账号的成员档案已达到 ${maxProfiles} 个上限（含回收站）。`);
    const now=new Date().toISOString();const profile={...profileFields(fields),id:randomUUID(),revision:1,createdAt:now,updatedAt:now};
    this.publishAvatar(profile.avatarAssetId,id=>store.avatarAsset(id));
    const record={profile,creatorId:context.userId,creatorName:context.userName,workspaceId:context.workspaceId,privateSkillIds:(fields.skills??[]).filter(id=>!store.skill(id)?.builtin),connectionMode};
    this.save(record);return this.publicProfile(record,context);
  });}
  mutate(context:SharedMemberContext,id:string,revision:number,action:'update'|'delete'|'restore',fields?:ProfileFields,store?:Store,connectionMode:'api'|'subscription'='api'):MemberProfile{return this.atomic(()=>{
    const record=this.record(id);if(!record)throw new DiscussionError('公共成员不存在。',404);
    if(!context.admin&&record.creatorId!==context.userId)throw new DiscussionError('只有创建者或站主能修改此公共成员；可以复制为自己的新成员。',403);
    if(record.profile.revision!==revision)throw new DiscussionError('公共成员已被更新，请刷新后重试。',409);
    if(action==='restore'?!record.profile.deletedAt:!!record.profile.deletedAt)throw new DiscussionError('公共成员状态已改变，请刷新后重试。',409);
    if(action==='update'){
      if(!fields||!store)throw new Error('Profile update requires fields and workspace');
      this.publishAvatar(fields.avatarAssetId,asset=>store.avatarAsset(asset));
      record.profile={...record.profile,...profileFields(fields),avatarAssetId:fields.avatarAssetId,connectionId:fields.connectionId};
      record.privateSkillIds=(fields.skills??[]).filter(skill=>!store.skill(skill)?.builtin);record.workspaceId=context.workspaceId;
      record.connectionMode=connectionMode;
    }
    const now=new Date().toISOString();record.profile.updatedAt=now;record.profile.revision++;
    if(action==='delete')record.profile.deletedAt=now;if(action==='restore')delete record.profile.deletedAt;
    this.save(record);return this.publicProfile(record,context);
  });}
  /** Read only the identity and referenced avatar tables. Never instantiate Store on another user's directory. */
  importWorkspace(directory:string,context:Omit<SharedMemberContext,'pool'>){
    const path=join(directory,'teahouse.sqlite');if(!existsSync(path))return;
    const source=new DatabaseSync(path,{readOnly:true});try{
      const has=(name:string)=>!!source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
      if(!has('member_profiles'))return;
      const builtins=new Set<string>();if(has('skills'))for(const row of source.prepare('SELECT data FROM skills').all()){const skill=JSON.parse(String(row.data));if(skill.builtin)builtins.add(skill.id);}
      const subscriptionConnections=new Set<string>();if(has('providers'))for(const row of source.prepare('SELECT data FROM providers').all()){const provider=JSON.parse(String(row.data));if(provider.billingMode==='subscription')subscriptionConnections.add(provider.connectionId??provider.id);}
      this.atomic(()=>{for(const row of source.prepare('SELECT data FROM member_profiles').all()){
        const profile=JSON.parse(String(row.data)) as MemberProfile;
        // Materialized snapshots carry attribution, so restarting cannot publish a borrowed identity as one's own.
        if(profile.shared)continue;
        const existing=this.record(profile.id);if(existing){if(existing.creatorId!==context.userId)throw new Error('A legacy profile ID collides with another creator; migration stopped without replacing any identity.');continue;}
        const safe:MemberProfile={...profileFields(profile),id:profile.id,revision:profile.revision,createdAt:profile.createdAt,updatedAt:profile.updatedAt,...(profile.deletedAt?{deletedAt:profile.deletedAt}:{})};
        this.publishAvatar(safe.avatarAssetId,id=>{const row=source.prepare('SELECT bytes FROM avatar_assets WHERE id=?').get(id);return row?Buffer.from(row.bytes as Uint8Array):undefined;});
        this.save({profile:safe,creatorId:context.userId,creatorName:context.userName,workspaceId:context.workspaceId,privateSkillIds:(profile.skills??[]).filter(id=>!builtins.has(id)),connectionMode:subscriptionConnections.has(profile.connectionId??profile.providerId)?'subscription':'api'});
      }});
    }finally{source.close();}
  }
}

/** Explicit local entrypoint discovery; buildApp fixtures never attach themselves to real hosting data. */
export function configuredLocalPool(projectRoot:string,dataDir:string):{context:SharedMemberContext;close:()=>void}|undefined{
  const configPath=join(projectRoot,'data-hosted','hosting-launch.json');if(resolve(dataDir)!==resolve(projectRoot,'data')||!existsSync(configPath))return;
  const config=JSON.parse(readFileSync(configPath,'utf8')) as {DataDir?:string;dataDir?:string};
  const directory=config.DataDir??config.dataDir??join(projectRoot,'data-hosted');
  if(resolve(directory)!==resolve(projectRoot,'data-hosted'))return;
  const pool=new SharedMemberPool(directory);const context={pool,userId:'owner',userName:'站主',workspaceId:'personal',admin:true};
  return {context,close:()=>pool.close()};
}

export function importHostingProfiles(pool:SharedMemberPool,dataDir:string,personalDataDir:string,names:Map<string,string>){
  pool.importWorkspace(personalDataDir,{userId:'owner',userName:'站主',workspaceId:'personal',admin:true});
  pool.importWorkspace(join(dataDir,'owner'),{userId:'owner',userName:'站主',workspaceId:'hosting-owner',admin:true});
  const users=join(dataDir,'users');if(existsSync(users))for(const entry of readdirSync(users,{withFileTypes:true})){
    if(!entry.isDirectory()||entry.isSymbolicLink()||!/^[a-f0-9-]{36}$/i.test(entry.name)||!names.has(entry.name))continue;
    pool.importWorkspace(join(users,entry.name),{userId:entry.name,userName:names.get(entry.name)!,workspaceId:entry.name});
  }
}
