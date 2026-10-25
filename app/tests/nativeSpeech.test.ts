import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeSpeech, type NativeSpeechEvent, type NativeSpeechPort } from '../src/features/live-voice/nativeSpeech.ts';

function deferred<T>() {let resolve!:(value:T)=>void;let reject!:(error:Error)=>void;const promise=new Promise<T>((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(permission=async()=>true){
  const listeners={recognition:new Set<(event:NativeSpeechEvent)=>void>(),synthesis:new Set<(event:NativeSpeechEvent)=>void>()};
  const starts:string[]=[];const stops:string[]=[];const cancels:string[]=[];const speaks:string[]=[];const speechCancels:string[]=[];
  let start=async(_id:string)=>{};let speak=async(_id:string)=>{};
  const port:NativeSpeechPort={
    async capabilities(){return {listen:true,speak:true,language:'en-US',voice:'local-fixture',engine:'fixture',listenReason:'Installed language required',speakReason:'Local voice'};},
    async startRecognition(id){starts.push(id);await start(id);},
    async finishRecognition(id){stops.push(id);},
    async cancelRecognition(id){cancels.push(id);},
    async speak(id){speaks.push(id);await speak(id);},
    async cancelSpeech(id){speechCancels.push(id);},
    addListener(channel,fn){listeners[channel].add(fn);return {remove(){listeners[channel].delete(fn);}};},
  };
  return {voice:nativeSpeech(port,permission),starts,stops,cancels,speaks,speechCancels,listeners,
    emit(channel:'recognition'|'synthesis',event:NativeSpeechEvent){listeners[channel].forEach(fn=>fn(event));},
    setStart(fn:typeof start){start=fn;},setSpeak(fn:typeof speak){speak=fn;}};
}
test('native dictation aborts during permission without starting a late microphone',async()=>{
  const gate=deferred<boolean>();const h=fixture(()=>gate.promise);const control=new AbortController();
  const result=h.voice.dictate(control.signal,()=>{},()=>{},()=>assert.fail('late ready'));
  control.abort();await assert.rejects(result,/Cancelled/);gate.resolve(true);await flush();
  assert.equal(h.starts.length,0);assert.equal(h.cancels.length,1);assert.equal(h.listeners.recognition.size,0);
});
test('finishing while permission is pending never opens the microphone later',async()=>{
  const gate=deferred<boolean>();const h=fixture(()=>gate.promise);let finish!:()=>void;
  const result=h.voice.dictate(new AbortController().signal,()=>{},fn=>{finish=fn;},()=>assert.fail('late ready'));
  finish();assert.equal(await result,'');gate.resolve(true);await flush();assert.equal(h.starts.length,0);
});
test('native ready/partial/final packets are scoped, bounded and dispose listeners',async()=>{
  const h=fixture();const partial:string[]=[];const levels:number[]=[];let ready=0;let finish!:()=>void;
  const result=h.voice.dictate(new AbortController().signal,text=>partial.push(text),fn=>{finish=fn;},()=>ready++,n=>levels.push(n));
  await flush();const id=h.starts[0];
  h.emit('recognition',{id:'another-turn',kind:'ready'});h.emit('recognition',{id,kind:'ready'});
  h.emit('recognition',{id,kind:'partial',text:'x'.repeat(9000)});h.emit('recognition',{id,kind:'level',level:NaN});
  h.emit('recognition',{id,kind:'level',level:3});finish();
  assert.deepEqual(h.stops,[id]);h.emit('recognition',{id,kind:'final',text:'final words'});
  assert.equal(await result,'final words');assert.equal(ready,1);assert.equal(partial[0].length,8000);
  assert.deepEqual(levels,[1,0]);assert.equal(h.listeners.recognition.size,0);assert.equal(h.cancels.at(-1),id);
});
test('late packets from cancelled dictation cannot settle a new turn',async()=>{
  const h=fixture();const old=new AbortController();
  const first=h.voice.dictate(old.signal,()=>{},()=>{},()=>{});await flush();const oldId=h.starts[0];
  old.abort();await assert.rejects(first,/Cancelled/);
  const second=h.voice.dictate(new AbortController().signal,()=>{},()=>{},()=>{});await flush();const newId=h.starts[1];
  let settled=false;void second.then(()=>{settled=true;});
  h.emit('recognition',{id:oldId,kind:'final',text:'stale'});await flush();assert.equal(settled,false);
  h.emit('recognition',{id:newId,kind:'final',text:'current'});assert.equal(await second,'current');assert.notEqual(newId,oldId);
});
test('permission denial and unavailable language fail without a server fallback',async()=>{
  const denied=fixture(async()=>false);await assert.rejects(denied.voice.dictate(new AbortController().signal,()=>{},()=>{},()=>{}),/permission denied/);
  assert.equal(denied.starts.length,0);assert.equal(denied.listeners.recognition.size,0);
  const h=fixture();const result=h.voice.dictate(new AbortController().signal,()=>{},()=>{},()=>{});await flush();
  h.emit('recognition',{id:h.starts[0],kind:'error',text:'On-device language pack unavailable. Choose Server.'});
  await assert.rejects(result,/language pack unavailable/);assert.equal(h.starts.length,1);assert.equal(h.listeners.recognition.size,0);
});
test('a late native start acknowledgement after abort is cancelled by its original identity',async()=>{
  const gate=deferred<void>();const h=fixture();h.setStart(()=>gate.promise);const control=new AbortController();
  const result=h.voice.dictate(control.signal,()=>{},()=>{},()=>{});await flush();const id=h.starts[0];
  control.abort();await assert.rejects(result,/Cancelled/);gate.resolve();await flush();
  assert.ok(h.cancels.length>=2);assert.ok(h.cancels.every(cancel=>cancel===id));assert.equal(h.listeners.recognition.size,0);
});
test('native synthesis waits for the matching completion and ignores old utterances',async()=>{
  const h=fixture();const result=h.voice.say('Reply',new AbortController().signal);await flush();const id=h.speaks[0];
  let settled=false;void result.then(()=>{settled=true;});h.emit('synthesis',{id:'old',kind:'done'});await flush();assert.equal(settled,false);
  h.emit('synthesis',{id,kind:'done'});await result;assert.equal(h.listeners.synthesis.size,0);assert.equal(h.speechCancels.at(-1),id);
});
test('aborting pending native synthesis prevents late initialization from completing a new utterance',async()=>{
  const gate=deferred<void>();const h=fixture();h.setSpeak(()=>gate.promise);const control=new AbortController();
  const result=h.voice.say('Reply',control.signal);await flush();const id=h.speaks[0];
  control.abort();await assert.rejects(result,/Cancelled/);gate.resolve();await flush();
  assert.ok(h.speechCancels.every(cancel=>cancel===id));assert.equal(h.listeners.synthesis.size,0);
});
test('already cancelled speech never calls recognition, synthesis or permission',async()=>{
  let permissions=0;const h=fixture(async()=>{permissions++;return true;});const control=new AbortController();control.abort();
  await assert.rejects(h.voice.dictate(control.signal,()=>{},()=>{},()=>{}),/Cancelled/);
  await assert.rejects(h.voice.say('Reply',control.signal),/Cancelled/);
  assert.equal(permissions,0);assert.equal(h.starts.length+h.speaks.length,0);
});
test('native service start errors release listeners and preserve a visible error',async()=>{
  const h=fixture();h.setStart(async()=>{throw new Error('On-device recognition unavailable. Choose Server.');});
  await assert.rejects(h.voice.dictate(new AbortController().signal,()=>{},()=>{},()=>{}),/unavailable/);
  assert.equal(h.listeners.recognition.size,0);assert.equal(h.cancels.length,1);
});
