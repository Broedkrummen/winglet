import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import * as model from '../src/features/routine-history/model.ts';

const fallback: any = new Proxy(function () {}, { get: (_t, key) => key === 'then' ? undefined : fallback, apply: () => fallback });
const same = (a: any[], b: any[]) => !!a && a.length === b.length && a.every((v,i) => Object.is(v,b[i]));
function harness() {
  let cursor=0, fail=false, finish: (() => void) | undefined;
  const hooks: any[]=[]; const effects: (() => void)[]=[]; const calls: string[]=[];
  const server={id:'bot',bot:{title:'Synthetic'}};
  const rt={status:'online',info:{features:{routine_history:true}},me:{role:'owner'}};
  const page={routine:{id:'job',name:'Daily synthetic report',prompt:'Read synthetic data',state:'scheduled'},
    runs:[{id:'actual-run',routine_id:'job',status:'completed',claimed_at:100}],next_cursor:null,history_notice:'Retained evidence',archived:false};
  const useApp=Object.assign((select: any)=>select({servers:[server]}),{getState:()=>({toast:()=>{}})});
  const effect=(callback: any,deps: any[])=>{
    const i=cursor++; const old=hooks[i];
    if(!old || !same(old.deps,deps)) { hooks[i]={deps,cleanup:old?.cleanup}; effects.push(()=>{old?.cleanup?.(); hooks[i].cleanup=callback();}); }
  };
  const jsx=(type: any,props: any)=>({type,props});
  const modules: Record<string,any>={
    react:{
      useState:(initial: any)=>{const i=cursor++; if(!(i in hooks))hooks[i]=initial; return [hooks[i],(v: any)=>{hooks[i]=typeof v==='function'?v(hooks[i]):v;}];},
      useRef:(initial: any)=>{const i=cursor++;return hooks[i]??={current:initial};},
      useCallback:(fn: any,deps: any[])=>{const i=cursor++;if(!hooks[i]||!same(hooks[i].deps,deps))hooks[i]={fn,deps};return hooks[i].fn;},
      useEffect:effect,
    },
    'expo-router':{useLocalSearchParams:()=>({serverId:'bot',routineId:'job'}),useFocusEffect:(fn: any)=>effect(fn,[fn]),router:{push:()=>{}}},
    'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'Fragment'},'react-native':{Text:'Text',View:'View'},
    '../../lib/store':{useApp,useServerState:()=>rt,isOwner:(r: any)=>r.me.role==='owner'},
    '../../lib/themeContext':{makeStyles:()=>()=>fallback,useTheme:()=>fallback},
    '../../lib/api':{api:async()=>{if(fail)throw new Error('Synthetic offline');return page;},signedApi:async(_s: any,_m: any,path: string)=>{calls.push(path);await new Promise<void>(resolve=>{finish=resolve;});}},
    '../../components/Screen':{Screen:'Screen'}, '../../components/ui':{Button:'Button',LoadError:'LoadError',SectionHeader:'SectionHeader',Skeleton:'Skeleton',Tap:'Tap'},
    '../../app/schedule':{EditSheet:'EditSheet'},'./model':model,
  };
  const exports: any={};
  const source=readFileSync(new URL('../src/features/routine-history/RoutinePages.tsx',import.meta.url),'utf8')+'\nexport { RoutineHistoryBody };';
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,
    {exports,require:(id: string)=>modules[id]??fallback,setInterval:()=>1,clearInterval:()=>{}});
  const render=()=>{cursor=0;const tree=exports.RoutineHistoryBody();while(effects.length)effects.shift()!();return tree;};
  const settle=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
  return {render,settle,rt,calls,finish:()=>finish?.(),offline:()=>{rt.status='offline';fail=true;}};
}
function nodes(tree: any): any[] {
  if(Array.isArray(tree))return tree.flatMap(nodes);
  if(!tree||typeof tree!=='object')return [];
  return [tree,...nodes(tree.props?.children)];
}
const button=(tree: any,title: string)=>nodes(tree).find(n=>n.type==='Button'&&n.props.title===title);
const rows=(tree: any)=>nodes(tree).filter(n=>n.props?.run).map(n=>n.props.run.id);

test('disconnect retains the loaded timeline and disables all mutations',async()=>{
  const h=harness();h.render();await h.settle();assert.deepEqual(rows(h.render()),['actual-run']);
  h.offline();const offline=h.render();await h.settle();
  assert.deepEqual(rows(h.render()),['actual-run']);
  for(const title of ['Run again','Pause','Edit routine'])assert.equal(button(offline,title).props.disabled,true);
  await button(offline,'Run again').props.onPress();assert.deepEqual(h.calls,[]);
});
test('rapid Run again taps make one signed request and never fabricate a run',async()=>{
  const h=harness();h.render();await h.settle();const tree=h.render();
  const first=button(tree,'Run again').props.onPress();await button(tree,'Run again').props.onPress();
  assert.equal(h.calls.length,1);assert.deepEqual(rows(h.render()),['actual-run']);
  h.finish();await first;
});
test('an owner demotion hides a previously loaded timeline',async()=>{
  const h=harness();h.render();await h.settle();assert.deepEqual(rows(h.render()),['actual-run']);
  h.rt.me.role='member';assert.deepEqual(rows(h.render()),[]);
});
