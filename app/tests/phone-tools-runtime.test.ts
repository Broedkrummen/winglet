import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import { createStore } from 'zustand/vanilla';
import { PhonePolicy, permitted } from '../src/features/phone-tools/policy.ts';
const tick=()=>new Promise<void>(r=>setImmediate(r));
function harness(supported=true) {
 let generation=0;
 const lock=createStore(()=>({locked:false}));let granted=true,reads=0;let finish:((v:any)=>void)|undefined;
 const sent:any[]=[];const cancelled:string[]=[];
 const imports:Record<string,any>={
  'expo-crypto':{randomUUID:()=> 'fixture-instance-'+String(++generation).padStart(12,'0')},
  zustand:{create:(fn:any)=>createStore(fn)},'../../lib/appLock':{useLock:lock},
  '../../lib/api':{api:async()=>({grants:[{tool:'phone_contacts',scope:'',mode:'ask',enabled:1}],bot_scope:'',server_scope_allowed:true})},
  './policy':{PhonePolicy,permitted},
  './native':{phoneSupported:supported,nativePhone:{permission:async()=>({granted,canAskAgain:true}),cancel:(id:string)=>cancelled.push(id),execute:async()=>{reads++;return await new Promise(resolve=>{finish=resolve;});}}},
 };
 const output:any={};
 vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/features/phone-tools/runtime.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:output,require:(name:string)=>{if(name in imports)return imports[name];throw new Error(name);},Error});
 const server={id:'fixture',bot:{name:'fixture'}};
 output.phoneHello(server,(event:any)=>sent.push(event));
 const r={id:'a'.repeat(32),nonce:'b'.repeat(48),instance_id:sent[0]?.instance_id ?? 'unsupported-instance',tool:'phone_contacts',args:{query:'Synthetic'},ask:true,mode:'ask',requested_at:1,expires_at:121,bot:{name:'fixture',title:'Synthetic'},chat:{id:'general',title:'Synthetic'}};
 const receive=(request=r)=>output.phoneEvent(server.id,{type:'phone_tool.request',request});
 const decide=async()=>{output.phoneDecide(server.id,r.id,true);await tick();};
 const execute=async()=>{output.phoneEvent(server.id,{type:'phone_tool.execute',id:r.id,nonce:r.nonce});await tick();};
 return {output,sent,cancelled,lock,request:r,receive,decide,execute,finish:(v:any)=>finish?.(v),get reads(){return reads;},permission:(v:boolean)=>granted=v};
}
test('actual runtime refuses native reads when Android permission was revoked after allowing',async()=>{
 const h=harness();h.receive();await h.decide();h.permission(false);await h.execute();
 assert.equal(h.reads,0);assert.equal(h.sent.find(e=>e.type==='phone_tool.answer')?.error,'permission');h.output.phoneDisconnect('fixture');
});
test('actual runtime cancels in-flight native work on app lock and connection removal',async()=>{
 for(const reason of ['lock','disconnect','background','revoke']){
  const h=harness();h.receive();await h.decide();await h.execute();assert.equal(h.reads,1);
  if(reason==='lock')h.lock.setState({locked:true});
  if(reason==='disconnect')h.output.phoneDisconnect('fixture');
  if(reason==='background')h.output.phoneVisibility(false);
  if(reason==='revoke')h.output.phoneEvent('fixture',{type:'phone_tool.grants_changed'});
  h.finish({contacts:[{name:'never sent'}]});await tick();await tick();
  assert.ok(h.cancelled.length);assert.equal(h.sent.some(e=>e.ok===true),false);h.output.phoneDisconnect('fixture');
 }
});
test('web or a native build without the module never handshakes, prompts or reads',async()=>{
 const h=harness(false);h.receive();await h.decide();await h.execute();assert.equal(h.reads,0);assert.equal(h.sent.length,0);assert.equal(h.output.usePhone.getState().requests.length,0);
});

test('buffered pre-background requests cannot read after the app resumes with a new lifecycle instance',async()=>{
 const h=harness();const old=h.request;
 h.output.phoneVisibility(false);h.output.phoneVisibility(true);
 assert.notEqual(h.sent.at(-1).instance_id,old.instance_id);
 h.receive(old);await h.decide();await h.execute();
 assert.equal(h.reads,0);assert.equal(h.output.usePhone.getState().requests.length,0);h.output.phoneDisconnect('fixture');
});
