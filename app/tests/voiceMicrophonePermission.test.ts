import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

function deferred<T>() { let resolve!: (value:T)=>void; const promise=new Promise<T>(r=>{resolve=r;}); return {promise,resolve}; }
const flush=()=>new Promise(resolve=>setImmediate(resolve));

/** Load the actual device adapter, native bridge and server capture with only OS boundaries replaced. */
function fixture(provider:'device'|'server') {
  let permission={granted:true,canAskAgain:true}; let queries=0; let requests=0; let recorded=0; let ready=0;
  let get=async()=>permission; let request=async()=>permission;
  const starts:string[]=[]; const listeners=new Set<(e:any)=>void>();
  const recorder={
    uri:'file://synthetic-voice', async prepareToRecordAsync(){}, record(){recorded++;},
    async stop(){}, async getCurrentInput(){return {uid:'fixture'};}, getAvailableInputs(){return [];},
    getStatus(){return {isRecording:true,durationMillis:100,metering:-20};},
  };
  const port={
    async startRecognition(id:string){starts.push(id);listeners.forEach(fn=>fn({id,kind:'ready'}));},
    async finishRecognition(){}, async cancelRecognition(){},
    addListener(_channel:string,fn:(e:any)=>void){listeners.add(fn);return {remove(){listeners.delete(fn);}};},
  };
  const mocks:Record<string,any>={
    'react-native':{Platform:{OS:'android'}}, react:{useRef:(value:any)=>({current:value})},
    'expo-audio':{
      getRecordingPermissionsAsync:async()=>{queries++;return get();},
      requestRecordingPermissionsAsync:async()=>{requests++;return request();},
      RecordingPresets:{HIGH_QUALITY:{android:{}}},useAudioRecorder:()=>recorder,
    },
    'expo-modules-core':{requireOptionalNativeModule:()=>port},
    'expo-file-system':{File:class{delete(){}}},
    '../../lib/audioMode':{recordingMode:async()=>{}},
  };
  const cache:Record<string,any>={};
  const load=(name:string):any=>{
    if(cache[name])return cache[name];
    const exports:any={};cache[name]=exports;
    const source=readFileSync(new URL('../src/features/live-voice/'+name+'.ts',import.meta.url),'utf8');
    vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
      {exports,require:(id:string)=>mocks[id]??load(id.slice(2)),AbortController,Date,Math,Set,Map,Error,setTimeout,clearTimeout,setInterval,clearInterval});
    return exports;
  };
  const adapter=provider==='device'?load('deviceSpeech'):load('capture').useCapture();
  return {
    listen(signal:AbortSignal){
      return provider==='device'
        ? adapter.dictate(signal,()=>{},()=>{},()=>ready++)
        : adapter.record(signal,()=>{},()=>ready++);
    },
    complete(text='Synthetic words'){
      if(provider==='device')listeners.forEach(fn=>fn({id:starts.at(-1),kind:'final',text}));
      else adapter.finish();
    },
    setPermission(value:typeof permission){permission=value;},
    setGet(fn:typeof get){get=fn;},setRequest(fn:typeof request){request=fn;},
    get queries(){return queries;},get requests(){return requests;},get starts(){return starts.length+recorded;},get ready(){return ready;},
  };
}

for(const provider of ['device','server'] as const) {
  test(provider+': repeated granted turns never launch a permission activity',async()=>{
    const h=fixture(provider);
    h.setRequest(async()=>{assert.fail('A redundant permission request would background and cancel voice');});
    for(let i=0;i<2;i++){
      const result=h.listen(new AbortController().signal);await flush();
      assert.equal(h.ready,i+1);assert.equal(h.starts,i+1);h.complete();await result;
    }
    assert.equal(h.queries,2);assert.equal(h.requests,0);
  });

  test(provider+': abort while permission query waits cannot launch a late prompt or microphone',async()=>{
    const h=fixture(provider);const gate=deferred<{granted:boolean;canAskAgain:boolean}>();
    h.setGet(()=>gate.promise);const control=new AbortController();const result=h.listen(control.signal);
    const rejected=assert.rejects(result,/Cancelled|permission denied/);
    control.abort();gate.resolve({granted:false,canAskAgain:true});await rejected;await flush();
    assert.equal(h.requests,0);assert.equal(h.starts,0);assert.equal(h.ready,0);
  });

  test(provider+': a genuine permission activity cancels the turn, then a deliberate retry uses the grant',async()=>{
    const h=fixture(provider);h.setPermission({granted:false,canAskAgain:true});
    const control=new AbortController();
    h.setRequest(async()=>{control.abort();h.setPermission({granted:true,canAskAgain:true});return {granted:true,canAskAgain:true};});
    await assert.rejects(h.listen(control.signal),/Cancelled/);
    assert.equal(h.requests,1);assert.equal(h.starts,0);
    const retry=h.listen(new AbortController().signal);await flush();
    assert.equal(h.requests,1);assert.equal(h.starts,1);assert.equal(h.ready,1);h.complete();await retry;
  });

  test(provider+': denied and permanently denied permissions never start capture',async()=>{
    for(const canAskAgain of [true,false]){
      const h=fixture(provider);h.setPermission({granted:false,canAskAgain});
      await assert.rejects(h.listen(new AbortController().signal),/permission denied/);
      assert.equal(h.requests,canAskAgain?1:0);assert.equal(h.starts,0);assert.equal(h.ready,0);
    }
  });
}
