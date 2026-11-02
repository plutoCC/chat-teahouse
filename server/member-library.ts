import { randomUUID } from 'node:crypto';
import { defaultWorkspaceLimits, profileFields, profileParticipant, resolveConnection, type MemberProfile, type Participant, type ProfileFields, type Group, type ProviderConfig, type WorkspaceLimits } from '../shared/types.js';
import type {SharedMemberContext} from './hosting/shared-members.js';
import { Store } from './store.js';
import { DiscussionError, isActive } from './scheduler.js';
import {projectHostedProvider,sharedModelIds} from '../shared/hosted-models.js';

export class MemberLibrary {
  constructor(private store: Store, private providers:()=>ProviderConfig[]=()=>store.providers(), private shared?:SharedMemberContext, private limits:()=>WorkspaceLimits=()=>defaultWorkspaceLimits,private hosted=false) {}
  profiles(includeDeleted=false):MemberProfile[]{return (this.shared?this.shared.pool.list(this.shared,includeDeleted):this.store.profiles(includeDeleted)).map(p=>this.decorate(p)).filter(p=>!this.hosted||!!p.deletedAt||this.availableHosted(p));}
  private availableHosted(p:MemberProfile):boolean{
    const c=this.providers().find(c=>(c.connectionId??c.id)===(p.connectionId??p.providerId)&&c.id===p.providerId);
    const shared=c&&projectHostedProvider(c);
    return p.channel!=='browser'&&!p.shared?.unavailableReason&&!!shared&&sharedModelIds(shared).includes(p.model);
  }
  profile(id:string):MemberProfile|undefined{const p=this.shared?this.shared.pool.get(this.shared,id):this.store.profile(id);return p?this.decorate(p):undefined;}
  private decorate(p:MemberProfile):MemberProfile{
    if(!p.shared)return p;let reason='';const c=this.providers().find(c=>(c.connectionId??c.id)===(p.connectionId??p.providerId)&&c.id===p.providerId);
    if(this.hosted&&(p.shared.connectionMode==='subscription'||p.providerId==='openai'&&!c))reason='此 ChatGPT 形象的连接未向访客开放。订阅仅供创建者本人使用；请复制形象并明确选择站主开放的 API 连接。';
    else if(p.channel==='browser'?this.hosted:!c?.enabled||c.id!=='demo'&&!c.hasKey&&c.billingMode!=='subscription')reason='此形象使用的模型连接当前不可用；可复制形象并选择可用连接。';
    else if(this.hosted&&c&&(c.billingMode==='subscription'||!sharedModelIds(c).includes(p.model)))reason='此形象的模型未由站主开放；请站主在网站模型连接中勾选开放此模型。';
    if(this.shared?.pool.skillUnavailable(this.shared,p.id)||(p.skills??[]).some(id=>!this.store.skill(id)))reason='此形象绑定了创建者的私有技能。技能正文不会共享，请复制形象后重新选择本账号可用技能。';
    return {...p,shared:{...p.shared,...(reason?{unavailableReason:reason}:{})}};
  }
  requireProfile(id: string): MemberProfile { const p=this.profile(id);if(!p||p.deletedAt)throw new DiscussionError('成员档案不存在或已在回收站，请刷新成员库。',404);return p; }
  requireInvitable(profile:MemberProfile){if(profile.shared?.unavailableReason)throw new DiscussionError(profile.shared.unavailableReason,409);}
  private materialize(profile:MemberProfile){if(this.shared){if(profile.avatarAssetId){const bytes=this.shared.pool.avatar(profile.avatarAssetId);if(bytes)this.store.saveAvatarAsset(profile.avatarAssetId,bytes);}this.store.saveProfile(profile);}return profile;}
  atomic<T>(action:()=>T):T{return this.shared?this.shared.pool.atomic(()=>this.store.atomic(action)):this.store.atomic(action);}
  requireEditable(group: Group) {
    if((this.store.freeSession(group.id)?.status==='active'||this.store.freeSession(group.id)?.members.some(m=>m.manualWake))||this.store.runs(group.id).some(isActive))throw new DiscussionError('请先暂停该成员所在群的讨论，再修改档案或入群状态。',409);
  }
  private requireSkills(fields: ProfileFields) {
    if(fields.connectionId&&!resolveConnection(this.providers(),fields as Participant))throw new DiscussionError('所选 API 连接不存在或不属于此供应商。',409);
    for(const id of fields.skills??[])if(!this.store.skill(id))throw new DiscussionError('所选技能已不存在，请刷新后重新选择。',409);
    if(fields.avatarAssetId&&!this.store.avatarAsset(fields.avatarAssetId)&&!this.shared?.pool.avatar(fields.avatarAssetId))throw new DiscussionError('头像图片不存在，请重新上传。',409);
  }
  create(fields: ProfileFields): MemberProfile {
    this.requireSkills(fields);
    if(this.shared){if(fields.avatarAssetId&&!this.store.avatarAsset(fields.avatarAssetId)){const bytes=this.shared.pool.avatar(fields.avatarAssetId);if(bytes)this.store.saveAvatarAsset(fields.avatarAssetId,bytes);}return this.shared.pool.create(this.shared,fields,this.store,this.limits().maxProfilesPerUser,resolveConnection(this.providers(),fields as Participant)?.billingMode??'api');}
    if(this.store.profiles(true).length>=this.limits().maxProfilesPerUser)throw new DiscussionError(`成员库已达到 ${this.limits().maxProfilesPerUser} 个档案上限（含回收站）。`);
    const now=new Date().toISOString();const profile={...profileFields(fields),id:randomUUID(),revision:1,createdAt:now,updatedAt:now};this.store.saveProfile(profile);return profile;
  }
  update(id: string, fields: ProfileFields, expectedRevision: number): MemberProfile {
    if(this.shared){this.requireSkills(fields);return this.shared.pool.mutate(this.shared,id,expectedRevision,'update',fields,this.store,resolveConnection(this.providers(),fields as Participant)?.billingMode??'api');}
    return this.store.atomic(()=>{
      const current=this.requireProfile(id);if(current.revision!==expectedRevision)throw new DiscussionError('成员档案已在其他页面更新，请重新打开后编辑。',409);
      this.requireSkills(fields);
      const groups=this.store.groups().filter(g=>g.participants.some(p=>p.profileId===id));for(const g of groups)this.requireEditable(g);
      const profile={...current,...profileFields(fields),avatarAssetId:fields.avatarAssetId,connectionId:fields.connectionId,revision:current.revision+1,updatedAt:new Date().toISOString()};this.store.saveProfile(profile);
      for(const g of groups){g.participants=g.participants.map(p=>p.profileId===id?profileParticipant(profile,p.id,p.enabled):p);this.store.saveGroup(g);}
      return profile;
    });
  }
  delete(id: string, expectedRevision: number): MemberProfile {
    if(this.shared)return this.shared.pool.mutate(this.shared,id,expectedRevision,'delete');
    return this.store.atomic(()=>{
      const current=this.requireProfile(id);
      if(current.revision!==expectedRevision)throw new DiscussionError('成员档案已更新，请刷新后重新删除。',409);
      const groups=this.store.groups().filter(g=>g.participants.some(p=>p.profileId===id));
      for(const g of groups)this.requireEditable(g);
      const now=new Date().toISOString();
      for(const g of groups){
        const removedIds=new Set(g.participants.filter(p=>p.profileId===id).map(p=>p.id));
        g.participants=g.participants.filter(p=>p.profileId!==id);
        if(removedIds.has(g.settings.summaryParticipantId))g.settings.summaryParticipantId='';
        g.updatedAt=now;this.store.saveGroup(g);
      }
      const profile={...current,deletedAt:now,updatedAt:now,revision:current.revision+1};
      this.store.saveProfile(profile);return profile;
    });
  }
  restore(id: string, expectedRevision: number): MemberProfile {
    if(this.shared)return this.shared.pool.mutate(this.shared,id,expectedRevision,'restore');
    return this.store.atomic(()=>{
      const current=this.store.profile(id);
      if(!current?.deletedAt)throw new DiscussionError('该成员不在回收站中，请刷新后重试。',404);
      if(current.revision!==expectedRevision)throw new DiscussionError('成员档案已更新，请刷新后重新恢复。',409);
      const {deletedAt,...rest}=current;
      // Removed skills stay removed. Restoring an identity never restarts or rejoins a room.
      const profile={...rest,skills:rest.skills?.filter(id=>!!this.store.skill(id)),revision:current.revision+1,updatedAt:new Date().toISOString()};
      this.store.saveProfile(profile);return profile;
    });
  }
  invite(group: Group, profileId: string) {
    this.requireEditable(group);if(group.archived)throw new DiscussionError('请先恢复群聊再邀请成员。',409);
    const profile=this.requireProfile(profileId);
    if(group.participants.some(p=>p.profileId===profileId))return group; // Idempotent double-click; do not re-enable a muted member.
    this.requireInvitable(profile);
    if(group.participants.length>=this.limits().maxMembersPerGroup)throw new DiscussionError(`每个群最多加入 ${this.limits().maxMembersPerGroup} 位 AI 成员。`);
    group.participants.push(profileParticipant(this.materialize(profile),randomUUID()));group.updatedAt=new Date().toISOString();this.store.saveGroup(group);return group;
  }
  participants(profileIds:string[]):Participant[]{if(profileIds.length>this.limits().maxMembersPerGroup)throw new DiscussionError(`每个群最多加入 ${this.limits().maxMembersPerGroup} 位 AI 成员。`);return profileIds.map(id=>{const p=this.requireProfile(id);this.requireInvitable(p);return profileParticipant(this.materialize(p),randomUUID());});}
  /** Legacy full-member requests remain supported; existing linked profiles must use the profile editor. */
  prepare(participants: Participant[],current:Participant[]=[]): Participant[] {
    if(participants.length>this.limits().maxMembersPerGroup&&participants.length>current.length)throw new DiscussionError(`每个群最多加入 ${this.limits().maxMembersPerGroup} 位 AI 成员。`);
    const seen=new Set<string>();
    return participants.map(p=>{
      const snapshot=this.shared&&current.find(old=>old.id===p.id&&old.profileId===p.profileId);
      if(snapshot){if(JSON.stringify(profileFields(snapshot))!==JSON.stringify(profileFields(p))||snapshot.profileRevision!==p.profileRevision)throw new DiscussionError('群内使用入群时的身份快照；请移出后重新邀请以采用公共档案的新版本。',409);if(p.profileId&&seen.has(p.profileId))throw new DiscussionError('同一成员不能重复加入一个群。');if(p.profileId)seen.add(p.profileId);return {...snapshot,enabled:p.enabled};}
      const profile=p.profileId?this.requireProfile(p.profileId):this.create(p);
      if(seen.has(profile.id))throw new DiscussionError('同一成员不能重复加入一个群。');seen.add(profile.id);
      if(p.profileId&&(JSON.stringify(profileFields(p))!==JSON.stringify(profileFields(profile))||p.profileRevision!==profile.revision))throw new DiscussionError('成员档案已更新或含有群内独立修改；请刷新后通过成员档案编辑。',409);
      this.requireInvitable(profile);return profileParticipant(this.materialize(profile),p.id,p.enabled);
    });
  }
}
