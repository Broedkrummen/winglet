import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AssistantRequestBinding,assistantPrompt,invocationId,readInvocation} from '../src/features/android-assistant/model.ts';
const invocation={id:'a'.repeat(32),serverId:'one',chatId:'chat',question:'Why?',context:'Private screen 🌱',source:'example.app',remainingMs:90000};
test('external URLs cannot manufacture or inject private invocation state',()=>{
  for(const value of [null,{},['a'.repeat(32)],'a'.repeat(31),'a'.repeat(32)+'&context=secret','A'.repeat(32)])assert.equal(invocationId(value),null);
  assert.equal(invocationId(invocation.id),invocation.id);
  assert.throws(()=>readInvocation({...invocation,id:'b'.repeat(32)},invocation.id));
});
test('expired, malformed and oversized native payloads fail closed',()=>{
  for(const remainingMs of [0,-1,90001,NaN,Infinity])assert.throws(()=>readInvocation({...invocation,remainingMs},invocation.id));
  for(const [key,value] of [['context','x'.repeat(6001)],['question','x'.repeat(4001)],['source',null],['serverId',123]])
    assert.throws(()=>readInvocation({...invocation,[key]:value},invocation.id));
  assert.deepEqual(readInvocation(invocation,invocation.id),invocation);
});
test('screen text is included only after explicit opt-in, as quoted data',()=>{
  assert.equal(assistantPrompt('  Why?  ',false,invocation),'Why?');
  const prompt=assistantPrompt('Why?',true,invocation);
  assert.ok(prompt.includes(JSON.stringify({source:invocation.source,text:invocation.context},null,2)));
  assert.throws(()=>assistantPrompt('/reset',true,invocation));
  assert.throws(()=>assistantPrompt('  ',true,invocation));
  assert.throws(()=>assistantPrompt('x'.repeat(4001),false,invocation));
});
test('a retry retains its exact destination, client identity and body',()=>{
  const binding=new AssistantRequestBinding();
  const first=binding.freeze('one','chat','Why?',true,invocation);
  const retry=binding.freeze('other','different','Changed',false,{...invocation,context:'other screen'});
  assert.equal(retry,first);assert.equal(first.serverId,'one');assert.equal(first.chatId,'chat');
  assert.equal(first.clientId,'assistant-'+invocation.id);assert.match(first.digest,/^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(first),true);
  assert.throws(()=>new AssistantRequestBinding().freeze('','chat','Why?',false,invocation));
});
