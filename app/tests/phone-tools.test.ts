import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PhonePolicy, permitted, readRequest, type PhoneRequest, type Tool } from '../src/features/phone-tools/policy.ts';
const request=(tool:Tool='phone_status',args:Record<string,unknown>={}):PhoneRequest=>({id:'a'.repeat(32),nonce:'b'.repeat(48),instance_id:'fixture-instance-123456',tool,args,ask:true,mode:'ask',requested_at:100,expires_at:120,bot:{name:'fixture',title:'Fixture bot'},chat:{id:'test',title:'Fixture chat'}});
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function setup() {
 let ready=true,authorized=true,reads=0,now=0;
 const events:any[]=[];const cancelled:string[]=[];
 let finish:((value:unknown)=>void)|undefined;
 const policy=new PhonePolicy({ready:()=>ready,authority:async()=>authorized,send:e=>events.push(e),now:()=>now,
 run:async()=>{reads++;return await new Promise(resolve=>{finish=resolve;});},cancel:id=>cancelled.push(id),changed:()=>{}});
 return {policy,events,cancelled,get reads(){return reads;},setReady:(v:boolean)=>ready=v,setAuthority:(v:boolean)=>authorized=v,setNow:(v:number)=>now=v,finish:(v:unknown)=>finish?.(v)};
}
test('unknown, malformed, broad contacts, calendar range and silent precise requests are refused',()=>{
 assert.equal(readRequest({...request(),tool:'shell'}),null);
 assert.equal(readRequest(request('phone_contacts',{query:''})),null);
 assert.equal(readRequest(request('phone_calendar',{start_ms:0,end_ms:32*86400000})),null);
 assert.equal(readRequest({...request('phone_location',{precise:true}),ask:false}),null);
 assert.equal(readRequest(request('phone_status',{command:'anything'})),null);
 assert.ok(readRequest(request('phone_contacts',{query:'Synthetic'})));
});
test('grant must match current tool, bot, mode and server scope role',()=>{
 const r=request();const grants=[{tool:r.tool,scope:'fixture',mode:r.mode,enabled:1}];
 assert.equal(permitted(grants,r,'other',true),false);
 assert.equal(permitted(grants,r,'fixture',false),true);
 assert.equal(permitted([{...grants[0],scope:'*'}],r,'fixture',false),false);
 assert.equal(permitted([{...grants[0],scope:'*'}],r,'fixture',true),true);
 assert.equal(permitted([{...grants[0],enabled:0}],r,'fixture',true),false);
});
test('deny, unsupported platform and locked/offline state never execute native code',async()=>{
 for(const unavailable of [false,true]){
  const s=setup();s.setReady(!unavailable);s.policy.receive(request());await s.policy.decide(request().id,false);await s.policy.execute(request().id,request().nonce);
  assert.equal(s.reads,0);s.policy.clear();
 }
});
test('allow decision needs a server execute frame; duplicate taps, replay and wrong nonces do not read twice',async()=>{
 const s=setup();const r=request();s.policy.receive(r);s.policy.receive(r);
 await Promise.all([s.policy.decide(r.id,true),s.policy.decide(r.id,true)]);
 assert.equal(s.reads,0);assert.equal(s.events.length,1);
 await s.policy.execute(r.id,'wrong');assert.equal(s.reads,0);
 const run=s.policy.execute(r.id,r.nonce);await flush();assert.equal(s.reads,1);
 await s.policy.execute(r.id,r.nonce);assert.equal(s.reads,1);
 s.finish({battery:42});await run;
 assert.equal(s.events.filter(e=>e.type==='phone_tool.answer').length,1);
 s.policy.receive(r);assert.equal(s.events.length,2);s.policy.clear();
});
test('revocation, lock/background, expiry and cancellation discard a native result already in flight',async()=>{
 for(const reason of ['revoke','lock','expiry','cancel']){
  const s=setup(),r=request();s.policy.receive(r);await s.policy.decide(r.id,true);
  const run=s.policy.execute(r.id,r.nonce);await flush();assert.equal(s.reads,1);
  if(reason==='revoke')s.setAuthority(false);
  if(reason==='lock')s.setReady(false);
  if(reason==='expiry')s.setNow(30000);
  if(reason==='cancel')s.policy.clear();
  s.finish({private:'must not send'});await run;
  assert.equal(s.events.some(e=>e.ok===true),false);s.policy.clear();
 }
});
test('revocation before the execute frame prevents all native reads',async()=>{
 const s=setup(),r=request();s.policy.receive(r);await s.policy.decide(r.id,true);s.setAuthority(false);
 await s.policy.execute(r.id,r.nonce);assert.equal(s.reads,0);s.policy.clear();
});
test('each sensitive tool independently checks and revokes its matching grant',async()=>{
 for(const [tool,args] of [['phone_location',{precise:false}],['phone_contacts',{query:'Synthetic'}],['phone_calendar',{start_ms:1000,end_ms:2000}]] as [Tool,Record<string,unknown>][]){
  const s=setup(),r=request(tool,args);s.policy.receive(r);await s.policy.decide(r.id,true);s.policy.cancel(r.id);
  await s.policy.execute(r.id,r.nonce);assert.equal(s.reads,0);s.policy.clear();
 }
});
