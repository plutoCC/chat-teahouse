import { randomUUID } from 'node:crypto';
import { profileFields, profileParticipant, resolveConnection, type MemberProfile, type Participant, type ProfileFields, type Group } from '../shared/types.js';
import { Store } from './store.js';
import { DiscussionError, isActive } from './scheduler.js';

export class MemberLibrary {
  constructor(private store: Store) {}
  requireProfile(id: string): MemberProfile { const p=this.store.profile(id);if(!p||p.deletedAt)throw new DiscussionError('成员档案不存在或已在回收站，请刷新成员库。',404);return p; }
  requireEditable(group: Group) {
    if(this.store.freeSession(group.id)?.status==='active'||this.store.runs(group.id).some(isActive))throw new DiscussionError('请先暂停该成员所在群的讨论，再修改档案或入群状态。',409);
  }
  private requireSkills(fields: ProfileFields) {
    if(fields.connectionId&&!resolveConnection(this.store.providers(),fields as Participant))throw new DiscussionError('所选 API 连接不存在或不属于此供应商。',409);
    for(const id of fields.skills??[])if(!this.store.skill(id))throw new DiscussionError('所选技能已不存在，请刷新后重新选择。',409);
    if(fields.avatarAssetId&&!this.store.avatarAsset(fields.avatarAssetId))throw new DiscussionError('头像图片不存在，请重新上传。',409);
  }
  create(fields: ProfileFields): MemberProfile {
    this.requireSkills(fields);
    if(this.store.profiles(true).length>=2000)throw new DiscussionError('成员库已达到 2000 个档案上限（含回收站）。');
    const now=new Date().toISOString();const profile={...profileFields(fields),id:randomUUID(),revision:1,createdAt:now,updatedAt:now};this.store.saveProfile(profile);return profile;
  }
  update(id: string, fields: ProfileFields, expectedRevision: number): MemberProfile {
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
    if(group.participants.length>=8)throw new DiscussionError('每个群最多加入 8 位 AI 成员。');
    group.participants.push(profileParticipant(profile,randomUUID()));group.updatedAt=new Date().toISOString();this.store.saveGroup(group);return group;
  }
  /** Legacy full-member requests remain supported; existing linked profiles must use the profile editor. */
  prepare(participants: Participant[]): Participant[] {
    const seen=new Set<string>();
    return participants.map(p=>{
      const profile=p.profileId?this.requireProfile(p.profileId):this.create(p);
      if(seen.has(profile.id))throw new DiscussionError('同一成员不能重复加入一个群。');seen.add(profile.id);
      if(p.profileId&&(JSON.stringify(profileFields(p))!==JSON.stringify(profileFields(profile))||p.profileRevision!==profile.revision))throw new DiscussionError('成员档案已更新或含有群内独立修改；请刷新后通过成员档案编辑。',409);
      return profileParticipant(profile,p.id,p.enabled);
    });
  }
}
