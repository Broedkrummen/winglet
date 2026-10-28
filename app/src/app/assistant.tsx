import {useEffect,useRef,useState} from 'react';
import {router,useLocalSearchParams} from 'expo-router';
import {Text,View} from 'react-native';
import {Screen} from '../components/Screen';
import {Sheet} from '../components/Sheet';
import {Button,Field,Footnote,ListGroup,ListRow,SectionHeader,Toggle} from '../components/ui';
import {useLock} from '../lib/appLock';
import {homeChat,useApp,useServerState} from '../lib/store';
import {makeStyles} from '../lib/themeContext';
import {assistantNative} from '../features/android-assistant/native';
import {AssistantRequestBinding,invocationId,readInvocation,type AssistantInvocation} from '../features/android-assistant/model';

export default function AssistantRoute(){
  const params=useLocalSearchParams<{invocation?:string|string[]}>();
  const id=invocationId(params.invocation);
  return <AssistantPanel key={id ?? 'invalid'} id={id}/>;
}
function AssistantPanel({id}:{id:string|null}){
  const s=useStyles();
  const [invocation,setInvocation]=useState<AssistantInvocation|null>(null);
  const [question,setQuestion]=useState('');
  const [include,setInclude]=useState(false);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [bound,setBound]=useState(false);
  const [sent,setSent]=useState(false);
  const [pick,setPick]=useState<'bot'|'chat'|null>(null);
  const [target,setTarget]=useState<{serverId:string;chatId:string}>({serverId:'',chatId:''});
  const servers=useApp(st=>st.servers);
  const foreground=useApp(st=>st.foreground);
  const network=useApp(st=>st.network);
  const locked=useLock(st=>st.locked);
  const server=servers.find(item=>item.id===target.serverId);
  const rt=useServerState(target.serverId);
  const request=useRef(new AssistantRequestBinding());
  const alive=useRef(true);
  const deadline=useRef(0);
  const online=!!server && network && rt?.status==='online';
  const chat=rt?.chats[target.chatId];
  useEffect(()=>{
    alive.current=true;
    return ()=>{
      alive.current=false;
      queueMicrotask(()=>{
        if(!alive.current && id){request.current.clear();assistantNative?.discard(id);assistantNative?.unprotect(id);}
      });
    };
  },[id]);
  useEffect(()=>{
    const native=assistantNative;
    if(!id || !native){setError('Open Winglet with the Android assistant gesture; links cannot provide screen text.');return;}
    let active=true;
    native.protect(id).then(()=>native.peek(id)).then(value=>{
      if(!active)return;
      const data=readInvocation(value,id);deadline.current=Date.now()+data.remainingMs;
      const state=useApp.getState();
      const selected=state.servers.find(s=>s.id===(data.serverId || state.selection.serverId));
      const runtime=selected?state.runtime[selected.id]:undefined;
      setInvocation(data);setQuestion(data.question);
      setTarget({serverId:selected?.id ?? '',chatId:data.chatId && runtime?.chats[data.chatId]?data.chatId:homeChat(runtime)});
    }).catch(e=>{if(active)setError((e as Error).message);});
    return ()=>{active=false;};
  },[id]);
  useEffect(()=>{
    if(!invocation)return;
    const clear=()=>{if(id)assistantNative?.discard(id);request.current.clear();setInvocation(null);setQuestion('');setInclude(false);setError('Screen context expired. Open the assistant again.');};
    if(!foreground || locked){clear();return;}
    const timer=setInterval(()=>{if(Date.now()>=deadline.current)clear();},1000);
    return ()=>clearInterval(timer);
  },[invocation,foreground,locked,id]);
  const send=async()=>{
    if(!id || !invocation || !assistantNative || !server || !chat || !online || busy || sent || locked || !foreground)return;
    setBusy(true);setError('');
    try{
      const frozen=request.current.freeze(server.id,chat.id,question,include,invocation);setBound(true);
      await assistantNative.bind(id,frozen.serverId,frozen.chatId,frozen.clientId,frozen.digest);
      if(!alive.current || !useApp.getState().foreground || useLock.getState().locked)return;
      await useApp.getState().sendMessage(frozen.serverId,frozen.chatId,frozen.body,{liveOnly:true,clientId:frozen.clientId});
      if(alive.current){request.current.clear();setSent(true);setInvocation(null);setQuestion('');setInclude(false);assistantNative.discard(id);}
    }catch(e){if(alive.current)setError((e as Error).message);}
    finally{if(alive.current)setBusy(false);}
  };
  const open=()=>{
    if(!server || !chat)return;
    useApp.getState().select(server.id,chat.id);if(id)assistantNative?.discard(id);
    router.replace(`/chat/${server.id}/${chat.id}`);
  };
  return <Screen title="Ask Winglet">
    <View style={s.card}>
      {invocation||sent?<ListGroup>
        <ListRow title="Bot" value={server?.bot.title ?? 'Choose a bot'} onPress={bound?undefined:()=>setPick('bot')}/>
        <ListRow title="Conversation" value={chat?.title ?? 'Choose a chat'} onPress={bound?undefined:()=>setPick('chat')}/>
      </ListGroup>:null}
      {invocation?<Field label="Your question" value={question} onChangeText={setQuestion} multiline maxLength={4000} editable={!bound&&!busy} placeholder="What would you like to ask?"/>:null}
      {invocation?.context?<View style={{gap:12}}>
        <SectionHeader title="Screen text"/>
        <Text selectable style={s.context}>{invocation.context}</Text>
        <ListGroup><ListRow title="Include screen text" right={<Toggle label="Include this screen text with my question" value={include} onValueChange={value=>{if(!bound&&!busy)setInclude(value);}}/>}/></ListGroup>
        <Footnote>Only this text is sent to {server?.bot.title ?? 'your agent'}; it expires when you leave.</Footnote>
      </View>:invocation?<Text style={s.note}>No screen text available.</Text>:null}
      {!online && invocation?<Text style={s.note}>Reconnect to send. Assistant requests are never queued.</Text>:null}
      {error?<Text style={s.error} accessibilityLiveRegion="polite">{error}</Text>:null}
      {sent?<Text style={s.note} accessibilityLiveRegion="polite">Sent. Follow the reply in your chat.</Text>:
        invocation?<Button title={bound?'Retry the same question':'Send question'} loading={busy} disabled={!online||!chat||!question.trim()||busy} onPress={send}/>:null}
      {invocation||sent?<Button title="Open full chat" variant="tonal" disabled={!server||!chat} onPress={open}/>:null}
      <Button title="Dismiss" variant="ghost" onPress={()=>{if(id)assistantNative?.discard(id);router.back();}}/>
    </View>
    <Sheet visible={pick!==null} onClose={()=>setPick(null)} title={pick==='bot'?'Choose a bot':'Choose a conversation'} scrollable>
      <ListGroup>{pick==='bot'?servers.map(item=><ListRow key={item.id} title={item.bot.title} onPress={()=>{
        setTarget({serverId:item.id,chatId:homeChat(useApp.getState().runtime[item.id])});setPick(null);
      }}/>):Object.values(rt?.chats ?? {}).filter(item=>item.kind!=='home').map(item=><ListRow key={item.id} title={item.title || 'Conversation'} onPress={()=>{setTarget(old=>({...old,chatId:item.id}));setPick(null);}}/>)}</ListGroup>
    </Sheet>
  </Screen>;
}
const useStyles=makeStyles(t=>({
  card:{marginTop:16,gap:14},note:{...t.type.callout,color:t.colors.textSecondary},
  context:{...t.type.callout,color:t.colors.text,padding:12,borderRadius:t.radius.md,backgroundColor:t.colors.surfaceSunken},
  error:{...t.type.callout,color:t.colors.danger},
}));

