
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';

// Execute the real Composer JSX with its device/services replaced. This checks
// actual sibling identities, including the action that mounts the voice panel.
function composer() {
  const state: any[] = []; let cursor = 0;
  const store = { drafts: {}, draftFiles: {}, replyTo: {}, runtime: { bot: { status: 'online', info: { features: { voice_handsfree: true } } } } };
  const style = new Proxy({}, { get: () => undefined });
  const theme = { colors: new Proxy({}, { get: () => '#123456' }) };
  const hooks = {
    useState(value: any) { const i=cursor++; if(!(i in state))state[i]=value;return [state[i],(v:any)=>{state[i]=typeof v==='function'?v(state[i]):v;}]; },
    useRef(value: any) { return { current:value }; },
    useEffect() {},
  };
  const native = { View:'View', Text:'Text', TextInput:'TextInput', Pressable:'Pressable', ScrollView:'ScrollView', Platform:{OS:'android'} };
  const mock: Record<string, any> = {
    react:hooks, 'react/jsx-runtime':jsx, 'react-native':native,
    'react-native-reanimated':{default:{View:'AnimatedView'}},
    '../lib/store':{draftKey:(server:string,chat:string)=>server+':'+chat,useApp:(fn:any)=>fn(store)},
    '../lib/attach':{canSend:()=>false},
    '../lib/themeContext':{makeStyles:()=>()=>style,useTheme:()=>theme},
    '../lib/prefs':{usePrefs:(fn:any)=>fn({prefs:{busyMode:'queue'},update(){}})},
    './TaskProgress':{TaskProgress:'TaskProgress'},
    '../features/live-voice/VoicePanel':{VoicePanel:'VoicePanel'},
  };
  const exports: any = {};
  const source=readFileSync(new URL('../src/components/Composer.tsx',import.meta.url),'utf8');
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,
    {exports,require:(id:string)=>mock[id]??new Proxy({},{get:(_target,name)=>String(name)}),setTimeout});
  const server={id:'bot',bot:{title:'Fixture'}};
  const render=(chatId='general',busy=false)=>{cursor=0;return exports.Composer({server,chatId,busy,bottomInset:0,target:null,onHeight(){},placeholder:'Message'});};
  return {render};
}
function children(tree:any):any[]{return Array.isArray(tree.props.children)?tree.props.children:[tree.props.children];}
function find(tree:any,label:string):any{
  if(!tree||typeof tree!=='object')return;
  if(tree.props?.accessibilityLabel===label)return tree;
  for(const child of children(tree)){if(Array.isArray(child)){for(const nested of child){const match=find(nested,label);if(match)return match;}}else{const match=find(child,label);if(match)return match;}}
}
test('voice and task remain distinct stable siblings through repeated voice/composer updates',async()=>{
  const h=composer();let tree=h.render();
  const task=children(tree).find(x=>x?.type==='TaskProgress');
  await find(tree,'Open hands-free voice').props.onPress();
  let voiceKey:string|undefined;
  for(let frame=0;frame<100;frame++){
    tree=h.render('general',frame%2===0);
    const keyed=children(tree).filter(x=>x&&x.key!==null);
    assert.equal(new Set(keyed.map(x=>x.key)).size,keyed.length,'Composer children must have unique keys');
    assert.equal(keyed.find(x=>x.type==='TaskProgress').key,task.key);
    const voice=keyed.find(x=>x.type==='VoicePanel');
    voiceKey??=voice.key;assert.equal(voice.key,voiceKey);
  }
  const other=children(h.render('another-chat')).find(x=>x?.type==='TaskProgress');
  assert.notEqual(other.key,task.key,'switching chats still remounts task state');
});
