import assert from 'node:assert/strict';
import {test} from 'node:test';
import {syncPushRegistration} from '../src/features/encrypted-push/registration.ts';
const key={v:1 as const,kid:'a'.repeat(32),key:'test-only',revision:2,subscription:{endpoint:'https://ntfy.sh/up/test',keys:{p256dh:'test',auth:'test'}}};
const remote={v:1 as const,enrolled:true,encrypted_required:true,kid:key.kid,delivery:'unknown'};
test('registration binds current server key generation and exact endpoint revision',async()=>{
  const calls:unknown[]=[];
  const result=await syncPushRegistration({assertActive:()=>{},status:async()=>({...remote,kid:'b'.repeat(32)}),credentials:async()=>key,
    post:async data=>{calls.push(data);return remote;},activate:async(kid,revision)=>{calls.push([kid,revision]);}});
  assert.equal(result,remote);assert.deepEqual(calls,[{...key,previous_kid:'b'.repeat(32)},[key.kid,2]]);
});
test('background, lock or pairing removal after export cannot provision a late key',async()=>{
  let active=true,posted=false;
  await assert.rejects(syncPushRegistration({assertActive:()=>{if(!active)throw new Error('paused');},status:async()=>remote,
    credentials:async()=>{active=false;return key;},post:async()=>{posted=true;return remote;},activate:async()=>assert.fail('late activate')}),/paused/);
  assert.equal(posted,false);
});
test('a lost acknowledgement can retry the existing key without silently rotating or falling back',async()=>{
  let posts=0,activations=0;
  const port={assertActive:()=>{},status:async()=>remote,credentials:async()=>key,
    post:async()=>{if(++posts===1)throw new Error('connection lost');return remote;},activate:async()=>{activations++;}};
  await assert.rejects(syncPushRegistration(port),/connection lost/);
  await syncPushRegistration(port);assert.equal(posts,2);assert.equal(activations,1);
});
test('unconfirmed or different server key never activates local delivery',async()=>{
  await assert.rejects(syncPushRegistration({assertActive:()=>{},status:async()=>remote,credentials:async()=>key,
    post:async()=>({...remote,kid:'c'.repeat(32)}),activate:async()=>assert.fail('wrong key activated')}),/did not confirm/);
});
test('key loss refuses enrollment without a plaintext route or automatic key replacement',async()=>{
  let posted=false;
  await assert.rejects(syncPushRegistration({assertActive:()=>{},status:async()=>remote,
    credentials:async()=>{throw new Error('key lost');},post:async()=>{posted=true;return remote;},activate:async()=>assert.fail('lost key activated')}),/key lost/);
  assert.equal(posted,false);
});
