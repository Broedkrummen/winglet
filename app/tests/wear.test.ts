import {test} from 'node:test';
import assert from 'node:assert/strict';
import {watchScope,wearAad,validateWatchGrant} from '../src/features/wear/model.ts';
test('watch scope is a sorted copy with fixed association and bounded conversations',()=>{
  const input=['b','a'];const scope=watchScope('ab'.repeat(16),' Watch ',input,true);
  input.push('c');assert.deepEqual(scope.chat_ids,['a','b']);assert.equal(scope.name,'Watch');
  for(const ids of [[],['a','a'],Array.from({length:13},(_,i)=>String(i))])assert.throws(()=>watchScope('ab'.repeat(16),'Watch',ids,true));
  assert.throws(()=>watchScope('bad','Watch',['a'],false));
});
test('length framed response binds server/device/nonce/purpose without delimiter collisions',()=>{
  const frame=wearAad('server','device','nonce');
  assert.equal(new DataView(frame.buffer).getUint32(0),17);
  assert.equal(new TextDecoder().decode(frame.slice(4,21)),'winglet.wear.link');
  assert.notDeepEqual(wearAad('a','bc','n'),wearAad('ab','c','n'));
  assert.notDeepEqual(frame,wearAad('server','device','nonce','response'));
});
test('grant accepts only current server, exact version, canonical credential and future bounded expiry',()=>{
  const good={v:1,id:'ab'.repeat(16),token:'wr1_'+'x'.repeat(43),expires:1001,server_id:'server~bot'};
  assert.equal(validateWatchGrant(good,'server~bot',1000).id,good.id);
  for(const value of [{...good,server_id:'other'},{...good,v:2},{...good,expires:999},{...good,expires:1000+32*86400},{...good,token:'full-pairing-token'}])assert.throws(()=>validateWatchGrant(value,'server~bot',1000));
});
