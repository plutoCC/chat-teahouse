import test from 'node:test';
import assert from 'node:assert/strict';
import {DraftPresence} from '../server/room-engine/draft-presence.js';
import {DRAFT_LEASE_MS} from '../shared/typing.js';

test('draft leases renew without keystrokes, clearing waits exactly three seconds, and sends release immediately',()=>{
  let now=1000;const drafts=new DraftPresence(()=>now),clientId=crypto.randomUUID();
  const update=(sequence:number,hasDraft:boolean,reason:'edit'|'sent'|'leave'='edit')=>drafts.update('room',{clientId,sequence,hasDraft,reason});
  update(1,true);now+=DRAFT_LEASE_MS-1;assert.equal(drafts.status('room').hasDraft,true);
  update(2,true);now+=DRAFT_LEASE_MS-1;assert.equal(drafts.status('room').hasDraft,true);
  update(3,false);assert.deepEqual(drafts.status('room'),{until:now+3000,hasDraft:false});
  now+=2999;assert.ok(drafts.status('room').until>now);now++;assert.equal(drafts.status('room').until,now);
  update(4,true);update(5,false,'sent');assert.equal(drafts.status('room').until,0);
  update(4,true);assert.equal(drafts.status('room').hasDraft,false,'delayed requests cannot restore stale drafts');
});

test('multiple tabs and rooms are independent; closed or disconnected tabs cannot block forever',()=>{
  let now=1000;const drafts=new DraftPresence(()=>now),a=crypto.randomUUID(),b=crypto.randomUUID();
  drafts.update('room',{clientId:a,sequence:1,hasDraft:true,reason:'edit'});drafts.update('room',{clientId:b,sequence:1,hasDraft:true,reason:'edit'});
  drafts.update('room',{clientId:a,sequence:2,hasDraft:false,reason:'leave'});assert.equal(drafts.status('room').hasDraft,true);
  assert.equal(drafts.status('other').hasDraft,false);now+=DRAFT_LEASE_MS;assert.equal(drafts.status('room').hasDraft,false);assert.ok(drafts.status('room').until<=now);
  drafts.update('room',{clientId:b,sequence:2,hasDraft:true,reason:'edit'});assert.equal(drafts.status('room').hasDraft,true,'a resumed page renews its lease');
});
