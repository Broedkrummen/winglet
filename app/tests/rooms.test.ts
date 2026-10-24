import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRoomEvents, mentionQuery, recipients, roomLine, type RoomEvent, type RoomMember } from '../src/features/rooms/model.ts';

const members: RoomMember[] = [
  { member_id:'default',profile:'default',handle:'main',display_name:'Main' },
  { member_id:'ops',profile:'ops',handle:'ops',display_name:'Operations' },
];
test('room text starts no turn without an explicit known recipient', () => {
  assert.deepEqual(recipients('ordinary text and @unknown',members),[]);
  assert.deepEqual(recipients('@OPS @ops please inspect',members).map(x=>x.profile),['ops']);
  assert.equal(recipients('@all please review',members).length,2);
  assert.equal(mentionQuery('please ask @op'),'op');
  assert.equal(mentionQuery('please ask @ops later'),null);
});
test('room replay deduplicates by epoch identity and preserves historical order', () => {
  const event=(id:string,epoch:number,seq:number): RoomEvent => ({id,epoch,seq,kind:'message.user',actor:{kind:'user',id:'u'},payload:{text:id},created_at:1});
  const old=event('0:1',0,1),newer=event('1:1',1,1);
  assert.deepEqual(mergeRoomEvents([newer],[old,newer,old]).map(x=>x.id),['0:1','1:1']);
});
test('room failures and bounded discussions remain visible without invented success', () => {
  const event={kind:'turn.failed',payload:{error:'Bot unavailable'}} as RoomEvent;
  assert.match(roomLine(event)!,/Bot unavailable/);
  assert.equal(roomLine({...event,kind:'room.activity',payload:{status:'settled'}}),null);
  assert.match(roomLine({...event,kind:'room.activity',payload:{status:'bounded'}})!,/turn limit/);
});
