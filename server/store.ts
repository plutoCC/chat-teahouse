import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultSettings, profileFields, connectionKey, type Sticker, type MemberProfile, type Group, type GroupDetail, type Message, type ProviderConfig, type Run } from '../shared/types.js';
import { defaultFreeSettings, type FreeSession, type RoomEvent, type SkillDefinition } from '../shared/free-chat.js';
import type {MemberUsage,RoomUsage,RoomLogEntry} from '../shared/room-journal.js';
import type {GroupSettingsTemplate} from '../shared/types.js';
import type {NotebookEntry} from '../shared/notebook.js';

export interface CallReservation { id: string; groupId: string; sessionId: string; input: number; output: number; usd: number; inputPrice: number; outputPrice: number; memberId?:string;author?:string;model?:string;providerId?:string;connectionId?:string;actualInput?:number;actualOutput?:number;actualUSD?:number;billingMode?:'api'|'subscription'; }

export class Store {
  private db: DatabaseSync;
  private transactionDepth = 0;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDir, 'teahouse.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS app_settings (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notebook (id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS notebook_group ON notebook(group_id);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), run_id TEXT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS browser_config (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS free_sessions (group_id TEXT PRIMARY KEY REFERENCES groups(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS room_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT NOT NULL REFERENCES groups(id), message_id TEXT NOT NULL UNIQUE, participant_id TEXT, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS room_events_group ON room_events(group_id,seq);
      CREATE TABLE IF NOT EXISTS free_posts (id TEXT PRIMARY KEY, message_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS free_calls (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS room_logs (id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS room_logs_group ON room_logs(group_id);
      CREATE TABLE IF NOT EXISTS skills (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS member_profiles (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS avatar_assets (id TEXT PRIMARY KEY, bytes BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS stickers (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sticker_assets (id TEXT PRIMARY KEY, bytes BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_group ON messages(group_id);
      CREATE INDEX IF NOT EXISTS runs_group ON runs(group_id);`);
    // Existing conversations enter the event log once, retaining their insertion order.
    for (const group of this.groups()) for (const message of this.messages(group.id)) {
      if(message.speech?.state==='sending'){message.speech.state='interrupted';this.saveMessage(message);}
      else this.recordEvent(message);
    }
    this.adoptMemberProfiles();
  }
  close() { this.db.close(); }
  notebookEntries(groupId?:string):NotebookEntry[] { return (groupId?this.rows<NotebookEntry>('SELECT data FROM notebook WHERE group_id=?',groupId):this.rows<NotebookEntry>('SELECT data FROM notebook')).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)); }
  notebookCount():number { return Number(this.db.prepare('SELECT count(*) AS n FROM notebook').get()!.n); }
  notebookEntry(id:string):NotebookEntry|undefined { return this.one<NotebookEntry>('SELECT data FROM notebook WHERE id=?',id); }
  saveNotebookEntry(entry:NotebookEntry) { this.db.prepare('INSERT INTO notebook(id,group_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(entry.id,entry.groupId,JSON.stringify(entry)); }
  deleteNotebookEntry(id:string) { this.db.prepare('DELETE FROM notebook WHERE id=?').run(id); }
  stickers(includeDeleted=false):Sticker[] { return this.rows<Sticker>('SELECT data FROM stickers ORDER BY rowid').filter(s=>includeDeleted||!s.deletedAt); }
  sticker(id:string):Sticker|undefined { return this.one<Sticker>('SELECT data FROM stickers WHERE id=?',id); }
  saveSticker(sticker:Sticker) { this.db.prepare('INSERT INTO stickers(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(sticker.id,JSON.stringify(sticker)); }
  stickerAsset(id:string):Buffer|undefined { const row=this.db.prepare('SELECT bytes FROM sticker_assets WHERE id=?').get(id);return row?Buffer.from(row.bytes as Uint8Array):undefined; }
  saveStickerAsset(id:string,bytes:Buffer) { this.db.prepare('INSERT OR IGNORE INTO sticker_assets(id,bytes) VALUES(?,?)').run(id,bytes); }
  stickerStorageBytes():number { return Number(this.db.prepare('SELECT COALESCE(SUM(length(bytes)),0) AS size FROM sticker_assets').get()!.size); }
  callOutput(id:string):number { const row=this.db.prepare('SELECT data FROM free_calls WHERE id=?').get(id);return row?(JSON.parse(String(row.data)) as CallReservation).output:0; }
  browserConfig(id:string): unknown { return this.one('SELECT data FROM browser_config WHERE id=?',id); }
  saveBrowserConfig(id:string,data:unknown) { this.db.prepare('INSERT INTO browser_config(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id,JSON.stringify(data)); }
  groups(): Group[] { return this.rows<Group>('SELECT data FROM groups').sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)); }
  group(id: string): Group | undefined { return this.one<Group>('SELECT data FROM groups WHERE id=?', id); }
  saveGroup(group: Group) { this.db.prepare('INSERT INTO groups(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(group.id, JSON.stringify(group)); }
  groupDefaults():GroupSettingsTemplate {
    return this.one<GroupSettingsTemplate>('SELECT data FROM app_settings WHERE id=?','new-group-defaults')??{conversationMode:'free',settings:{...defaultSettings},freeSettings:{...defaultFreeSettings}};
  }
  saveGroupDefaults(template:GroupSettingsTemplate) {
    // A summary seat belongs to its source group; new rooms select their own member.
    const safe:GroupSettingsTemplate={conversationMode:template.conversationMode,settings:{...template.settings,summaryParticipantId:''},freeSettings:{...defaultFreeSettings,...template.freeSettings}};
    this.db.prepare('INSERT INTO app_settings(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run('new-group-defaults',JSON.stringify(safe));
    return safe;
  }
  profiles(includeDeleted = false): MemberProfile[] { return this.rows<MemberProfile>('SELECT data FROM member_profiles ORDER BY rowid').filter(p=>includeDeleted||!p.deletedAt); }
  avatarAsset(id: string): Buffer | undefined { const row=this.db.prepare('SELECT bytes FROM avatar_assets WHERE id=?').get(id);return row?Buffer.from(row.bytes as Uint8Array):undefined; }
  avatarStorageBytes(): number { return Number(this.db.prepare('SELECT COALESCE(SUM(length(bytes)),0) AS size FROM avatar_assets').get()!.size); }
  saveAvatarAsset(id: string, bytes: Buffer) { this.db.prepare('INSERT OR IGNORE INTO avatar_assets(id,bytes) VALUES(?,?)').run(id,bytes); }
  profile(id: string): MemberProfile | undefined { return this.one<MemberProfile>('SELECT data FROM member_profiles WHERE id=?',id); }
  saveProfile(profile: MemberProfile) { this.db.prepare('INSERT INTO member_profiles(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(profile.id,JSON.stringify(profile)); }
  /** Idempotent legacy migration. Preserve member IDs, enabled flags, timestamps and all historical records. */
  adoptMemberProfiles() {
    this.atomic(()=>{
      const signature=(p:MemberProfile|Group['participants'][number])=>JSON.stringify(profileFields(p));
      const known=new Map(this.profiles().map(p=>[signature(p),p]));
      for(const group of this.groups()) {
        let changed=false;const used=new Set(group.participants.map(p=>p.profileId).filter(Boolean));
        group.participants=group.participants.map(p=>{
          if(p.profileId&&this.profile(p.profileId))return p;
          const key=signature(p);let profile=known.get(key);
          // Never merge two distinct seats inside the same old group.
          if(!profile||used.has(profile.id)) {
            const now=new Date().toISOString();profile={...profileFields(p),id:randomUUID(),revision:1,createdAt:now,updatedAt:now};
            this.saveProfile(profile);known.set(key,profile);
          }
          changed=true;used.add(profile.id);return {...p,profileId:profile.id,profileRevision:profile.revision};
        });
        if(changed)this.saveGroup(group);
      }
    });
  }
  messages(groupId: string): Message[] { return this.rows<Message>('SELECT data FROM messages WHERE group_id=? ORDER BY rowid', groupId); }
  message(id: string) { return this.one<Message>('SELECT data FROM messages WHERE id=?', id); }
  saveMessage(message: Message) { this.atomic(() => {
    this.db.prepare('INSERT INTO messages(id,group_id,run_id,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(message.id,message.groupId,message.runId??null,JSON.stringify(message));
    this.recordEvent(message);
  }); }
  private recordEvent(message: Message) {
    if (message.status !== 'complete') return;
    this.db.prepare('INSERT OR IGNORE INTO room_events(group_id,message_id,participant_id,created_at) VALUES(?,?,?,?)').run(message.groupId,message.id,message.participantId??null,Date.parse(message.createdAt));
  }
  events(groupId: string, afterSeq = 0): RoomEvent[] {
    return this.db.prepare('SELECT seq,message_id,participant_id,created_at FROM room_events WHERE group_id=? AND seq>? ORDER BY seq').all(groupId,afterSeq).map(row => ({seq:Number(row.seq),messageId:String(row.message_id),...(row.participant_id?{participantId:String(row.participant_id)}:{}),createdAt:Number(row.created_at)}));
  }
  freeSession(groupId: string): FreeSession | undefined { return this.one<FreeSession>('SELECT data FROM free_sessions WHERE group_id=?',groupId); }
  logs(groupId:string):RoomLogEntry[]{return this.rows<RoomLogEntry>('SELECT data FROM room_logs WHERE group_id=? ORDER BY rowid DESC LIMIT 500',groupId);}
  saveLog(entry:RoomLogEntry){this.atomic(()=>{
    const safe={...entry,summary:entry.summary.slice(0,1000),...(entry.reasoning?{reasoning:entry.reasoning.length>16000?entry.reasoning.slice(0,16000)+'\n[内容过长，日志仅保留前 16000 字符]':entry.reasoning}:{} )};
    this.db.prepare('INSERT INTO room_logs(id,group_id,data) VALUES(?,?,?)').run(entry.id,entry.groupId,JSON.stringify(safe));
    this.db.prepare('DELETE FROM room_logs WHERE group_id=? AND rowid NOT IN (SELECT rowid FROM room_logs WHERE group_id=? ORDER BY rowid DESC LIMIT 500)').run(entry.groupId,entry.groupId);
  });}
  memberUsage(groupId:string):RoomUsage {
    const members=new Map<string,MemberUsage>();let unattributedCalls=0;
    for(const row of this.db.prepare('SELECT status,data FROM free_calls WHERE group_id=? ORDER BY rowid').all(groupId)) {
      const c=JSON.parse(String(row.data)) as CallReservation;
      if(!c.memberId||!c.model){unattributedCalls++;continue;}
      const key=JSON.stringify([c.memberId,c.model,c.connectionId??c.providerId,c.billingMode??'api']);
      const usage=members.get(key)??{memberId:c.memberId,author:c.author??'已移出成员',model:c.model,providerId:c.providerId??'',connectionId:c.connectionId??c.providerId??'',inputTokens:0,outputTokens:0,estimatedUSD:0,calls:0,uncertainCalls:0,unpricedCalls:0,reservedTokens:0};
      usage.calls++;
      usage.billingMode=c.billingMode??'api';
      if(row.status==='reserved')usage.reservedTokens+=c.input+c.output;
      else {usage.inputTokens+=c.actualInput??c.input;usage.outputTokens+=c.actualOutput??c.output;usage.estimatedUSD+=c.actualUSD??c.usd;if(row.status==='unknown')usage.uncertainCalls++;}
      if(c.billingMode!=='subscription'&&!['demo','ollama'].includes(c.providerId??'')&&(!c.inputPrice||!c.outputPrice))usage.unpricedCalls++;
      members.set(key,usage);
    }
    return {members:[...members.values()],unattributedCalls};
  }
  freeSessions(): FreeSession[] { return this.rows<FreeSession>('SELECT data FROM free_sessions'); }
  saveFreeSession(session: FreeSession) {
    session.updatedAt = new Date().toISOString();
    this.db.prepare('INSERT INTO free_sessions(group_id,data) VALUES(?,?) ON CONFLICT(group_id) DO UPDATE SET data=excluded.data').run(session.groupId,JSON.stringify(session));
  }
  atomic<T>(operation: () => T): T {
    if (this.transactionDepth) return operation();
    this.db.exec('BEGIN IMMEDIATE'); this.transactionDepth++;
    try { const result=operation();this.db.exec('COMMIT');return result; }
    catch(error) { this.db.exec('ROLLBACK');throw error; }
    finally { this.transactionDepth--; }
  }
  mutateFree<T>(groupId: string, operation: (session: FreeSession) => T): T {
    return this.atomic(() => {
      const session=this.freeSession(groupId);if(!session)throw new Error('自由讨论不存在');
      const result=operation(session);this.saveFreeSession(session);return result;
    });
  }
  existingPost(id: string): Message | undefined {
    const row=this.db.prepare('SELECT message_id FROM free_posts WHERE id=?').get(id);return row?this.message(String(row.message_id)):undefined;
  }
  publish(id: string, message: Message) {
    this.saveMessage(message);this.db.prepare('INSERT INTO free_posts(id,message_id) VALUES(?,?)').run(id,message.id);
  }
  reserveCall(ticket: CallReservation) {
    this.db.prepare('INSERT INTO free_calls(id,group_id,status,data) VALUES(?,?,?,?)').run(ticket.id,ticket.groupId,'reserved',JSON.stringify(ticket));
  }
  settleCall(id: string, usage?: {inputTokens:number;outputTokens:number}) {
    this.atomic(() => {
      const row=this.db.prepare('SELECT status,data FROM free_calls WHERE id=?').get(id);
      if(!row||row.status!=='reserved')return;
      const ticket=JSON.parse(String(row.data)) as CallReservation;
      this.db.prepare('UPDATE free_calls SET status=? WHERE id=?').run(usage?'settled':'unknown',id);
      const input=usage?.inputTokens??ticket.input,output=usage?.outputTokens??ticket.output;
      ticket.actualInput=input;ticket.actualOutput=output;ticket.actualUSD=(input*ticket.inputPrice+output*ticket.outputPrice)/1e6;
      this.db.prepare('UPDATE free_calls SET data=? WHERE id=?').run(JSON.stringify(ticket),id);
      const session=this.freeSession(ticket.groupId);if(!session||session.id!==ticket.sessionId)return;
      session.reservedTokens=Math.max(0,session.reservedTokens-ticket.input-ticket.output);
      session.reservedUSD=Math.max(0,session.reservedUSD-ticket.usd);
      session.inputTokens+=input;session.outputTokens+=output;
      session.estimatedUSD+=(input*ticket.inputPrice+output*ticket.outputPrice)/1e6;
      if(!usage)session.uncertainCalls++;
      this.saveFreeSession(session);
    });
  }
  recoverFreeSessions() {
    this.atomic(() => {
      for(const row of this.db.prepare("SELECT id FROM free_calls WHERE status='reserved'").all())this.settleCall(String(row.id));
      for(const session of this.freeSessions()) {
        if(session.status!=='active'){if(session.sending){delete session.sending;this.saveFreeSession(session);}continue;}
        delete session.sending;
        session.status='interrupted';session.epoch++;session.error='后台已重启。已保留消息、已读位置和预算；点击继续后恢复，未自动重发在途请求。';
        for(const member of session.members) { member.status='paused';delete member.wakeAt; }
        this.saveFreeSession(session);
      }
    });
  }
  skills(): SkillDefinition[] { return this.rows<SkillDefinition>('SELECT data FROM skills'); }
  skill(id: string): SkillDefinition | undefined { return this.one<SkillDefinition>('SELECT data FROM skills WHERE id=?',id); }
  saveSkill(skill: SkillDefinition) { this.db.prepare('INSERT INTO skills(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(skill.id,JSON.stringify(skill)); }
  deleteSkill(id: string) { this.db.prepare('DELETE FROM skills WHERE id=?').run(id); }
  runs(groupId: string): Run[] { return this.rows<Run>('SELECT data FROM runs WHERE group_id=? ORDER BY rowid DESC',groupId); }
  allRuns(): Run[] { return this.rows<Run>('SELECT data FROM runs'); }
  run(id: string): Run | undefined { return this.one<Run>('SELECT data FROM runs WHERE id=?',id); }
  saveRun(run: Run) { this.db.prepare('INSERT INTO runs(id,group_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(run.id,run.groupId,JSON.stringify(run)); }
  providers(): ProviderConfig[] { return this.rows<ProviderConfig>('SELECT data FROM providers'); }
  saveProvider(provider: ProviderConfig) { const safe = {...provider,hasKey:false}; this.db.prepare('INSERT INTO providers(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(connectionKey(provider),JSON.stringify(safe)); }
  deleteProvider(id:string) { this.db.prepare('DELETE FROM providers WHERE id=?').run(id); }
  detail(id: string): GroupDetail | undefined { const group=this.group(id); if(!group)return;const runs=this.runs(id);return {group,messages:this.messages(id),runs,activeRun:runs.find(r=>r.status==='running'||r.status==='waiting'||r.status==='awaiting_web')??null,freeSession:this.freeSession(id)??null,usage:this.memberUsage(id)}; }
  interruptOutstanding() {
    for(const run of this.allRuns()) {
      if(run.status!=='running'&&run.status!=='waiting'&&run.status!=='awaiting_web')continue;
      run.status='interrupted';run.error='本地服务已重启。未自动重新调用模型，请检查记录后开始新讨论。';run.finishedAt=new Date().toISOString();delete run.nextAt;delete run.pendingWeb;this.saveRun(run);
      for(const msg of this.messages(run.groupId))if(msg.runId===run.id&&msg.status==='streaming'){msg.status='stopped';this.saveMessage(msg);}
    }
  }
  createGroup(name: string,goal: string): Group {
    const group: Group={id:randomUUID(),name,goal,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),archived:false,participants:[
      {id:randomUUID(),name:'演示成员 A',providerId:'demo',model:'demo',role:'',identityMode:'native',channel:'api',avatar:'A',color:'#507b65',enabled:true},
      {id:randomUUID(),name:'演示成员 B',providerId:'demo',model:'demo',role:'',identityMode:'native',channel:'api',avatar:'B',color:'#b78657',enabled:true},
      {id:randomUUID(),name:'演示成员 C',providerId:'demo',model:'demo',role:'',identityMode:'native',channel:'api',avatar:'C',color:'#617c96',enabled:true}
    ],...this.groupDefaults()};this.saveGroup(group);return group;
  }
  seed(defaults: ProviderConfig[]) {
    const existing=new Set(this.providers().map(p=>p.id));for(const provider of defaults)if(!existing.has(provider.id))this.saveProvider(provider);
    if(this.groups().length)return;
    this.createGroup('产品灵感茶桌','围绕一个产品想法自由讨论：保留自己的判断，阅读群友观点，提出问题、依据或不同意见。有新内容再发言，也可以等待；人的观点同样可以被质疑。');
  }
  private one<T>(sql:string,...params:string[]):T|undefined { const row=this.db.prepare(sql).get(...params);return row?JSON.parse(row.data as string) as T:undefined; }
  private rows<T>(sql:string,...params:string[]):T[] { return this.db.prepare(sql).all(...params).map(row=>JSON.parse(row.data as string) as T); }
}
