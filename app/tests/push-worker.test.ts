import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const guardSource=readFileSync(new URL('../public/push-guard.js',import.meta.url),'utf8');
const workerSource=readFileSync(new URL('../public/sw.js',import.meta.url),'utf8');
const packet={guard_v:1,id:'a'.repeat(32),issued:100,expires:200,server_id:'server',device_id:'phone',title:'Bot',body:'Reply',url:'/chat/server/chat',tag:'chat',kind:'message'};
const initial=()=>({required:true,scope:{server:'server',device:'phone'},seen:{}});
function policy(){const context=vm.createContext({URL});vm.runInContext(guardSource,context);return context.WingletPushGuard;}
test('worker policy persists duplicate protection and rejects stale, wrong-device, wrong-server and oversized packets',()=>{
  const guard=policy();const first=guard.accept(packet,initial(),100);assert.ok(first.note);
  assert.equal(guard.accept(packet,JSON.parse(JSON.stringify(first.state)),101).note,null);
  for(const change of [{device_id:'other'},{server_id:'other'},{issued:161},{expires:100},{expires:86501},{id:'bad'},{body:'x'.repeat(1201)},{guard_v:2}])
    assert.equal(guard.accept({...packet,...change},initial(),100).note,null);
  const full={...initial(),seen:Object.fromEntries(Array.from({length:2048},(_,i)=>[i.toString(16).padStart(32,'0'),200]))};
  assert.equal(guard.accept({...packet,id:'f'.repeat(32)},full,100).note,null);
});
test('legacy support ends after opt-in and notification actions are always stripped',()=>{
  const guard=policy();const legacy={title:'Bot',body:'Old reply',url:'/',tag:'chat',server_id:'server',actions:[{action:'approve',sig:'ignored'}]};
  assert.ok(guard.accept(legacy,{required:false,scope:null,seen:{}},100).note);
  assert.equal(guard.accept(legacy,initial(),100).note,null);
  assert.equal(guard.accept({...packet,actions:legacy.actions},initial(),100).note.actions,undefined);
});
test('notification URLs cannot navigate to another origin or a mutation API',()=>{
  const guard=policy();const origin='https://winglet.example';
  for(const url of ['https://evil.example','//evil.example','/\\evil.example','/api/inbox/x/respond?sig=bad','javascript:alert(1)'])assert.equal(guard.safeTarget(url,origin),'/');
  assert.equal(guard.safeTarget('/chat/server/chat',origin),'/chat/server/chat');
});
function worker(holder:{state:any}={state:undefined}){
  const listeners:Record<string,any>={},shown:any[]=[],opened:string[]=[];let posts=0;
  const context:any=vm.createContext({URL,Date,console,fetch:async()=>{posts++;return {};},
    indexedDB:{open:()=>{
      const opening:any={};
      queueMicrotask(()=>{
        opening.result={createObjectStore:()=>{},close:()=>{},transaction:()=>{
          const tx:any={abort:()=>queueMicrotask(()=>tx.onabort?.()),objectStore:()=>({
            get:()=>{const request:any={};queueMicrotask(()=>{request.result=structuredClone(holder.state);request.onsuccess?.();});return request;},
            put:(value:any)=>{holder.state=structuredClone(value);queueMicrotask(()=>tx.oncomplete?.());},
          })};return tx;
        }};
        opening.onsuccess?.();
      });return opening;
    }},
    self:{location:{origin:'https://winglet.example'},addEventListener:(name:string,handler:any)=>{listeners[name]=handler;},
      registration:{showNotification:async(title:string,options:any)=>{shown.push({title,options});}},
      clients:{matchAll:async()=>[],openWindow:async(url:string)=>{opened.push(url);}}},
  });
  context.importScripts=()=>vm.runInContext(guardSource,context);
  vm.runInContext(workerSource,context);
  const emit=async(name:string,event:any)=>{let pending=Promise.resolve();listeners[name]({...event,waitUntil:(value:Promise<void>)=>{pending=value;}});await pending;};
  return {shown,opened,get posts(){return posts;},emit};
}
test('actual service worker saves replay state before display and retains it across restart',async()=>{
  const holder={state:initial()};const first=worker(holder);
  const now=Math.floor(Date.now()/1000),note={...packet,issued:now,expires:now+300};
  await first.emit('push',{data:{text:()=>JSON.stringify(note)}});assert.equal(first.shown.length,1);
  const second=worker(holder);await second.emit('push',{data:{text:()=>JSON.stringify(note)}});assert.equal(second.shown.length,0);
  await second.emit('push',{data:{text:()=>'{bad'}});assert.equal(second.shown.length,0);
});
test('cached legacy approval buttons only open the current authenticated UI',async()=>{
  const app=worker();
  await app.emit('notificationclick',{action:'approve',notification:{close:()=>{},data:{url:'/chat/server/chat',item_id:'old',actions:[{action:'approve',sig:'expired'}]}}});
  assert.equal(app.posts,0);assert.deepEqual(app.opened,['/chat/server/chat']);
});
test('removing a pairing closes the worker scope and blocks cached versioned delivery',async()=>{
  const holder={state:initial()};const app=worker(holder);
  await app.emit('message',{source:{url:'https://winglet.example/'},ports:[{postMessage:()=>{}}],data:{type:'winglet.push.retain',scope:null}});
  assert.equal(holder.state.scope,null);assert.equal(holder.state.required,true);
  const now=Math.floor(Date.now()/1000);
  await app.emit('push',{data:{text:()=>JSON.stringify({...packet,issued:now,expires:now+300})}});
  assert.equal(app.shown.length,0);
});
test('removing a legacy pairing also closes its fallback notification path',async()=>{
  const holder={state:{required:false,scope:null,seen:{}}};const app=worker(holder);
  await app.emit('message',{source:{url:'https://winglet.example/'},ports:[{postMessage:()=>{}}],data:{type:'winglet.push.retain',scope:null}});
  assert.equal(holder.state.required,true);
  await app.emit('push',{data:{text:()=>JSON.stringify({title:'Old bot',body:'Cached reply',url:'/',tag:'old',server_id:'server'})}});
  assert.equal(app.shown.length,0);
});
