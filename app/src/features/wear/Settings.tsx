import {useCallback,useEffect,useRef,useState} from 'react';
import {Text,View} from 'react-native';
import {useFocusEffect} from 'expo-router';
import {Screen} from '../../components/Screen';
import {Button,Card,Footnote,ListGroup,ListRow,LoadError,SectionHeader,Toggle} from '../../components/ui';
import {api,ApiError} from '../../lib/api';
import {useApp} from '../../lib/store';
import {makeStyles,useTheme} from '../../lib/themeContext';
import {Sheet} from '../../components/Sheet';
import {Check} from '../../components/icons';
import type {Chat,Server} from '../../lib/types';
import {wearNative as defaultWearNative,type WearNative,type WatchPending,type WatchLink} from './native';
import {linkWatch,revokeWatch,watchGrants,type RemoteWatch} from './api';
import {watchScope,type WatchScope} from './model';

export function WearSettings({nativeClient=defaultWearNative}:{nativeClient?:WearNative|null}){
  const wearNative=nativeClient;
  const s=useStyles(),t=useTheme(),servers=useApp(st=>st.servers),selection=useApp(st=>st.selection.serverId);
  const [serverId,setServerId]=useState(selection??''),[supported,setSupported]=useState(false);
  const server=servers.find(value=>value.id===serverId);
  const [pending,setPending]=useState<WatchPending[]>([]),[links,setLinks]=useState<WatchLink[]>([]),[remote,setRemote]=useState<RemoteWatch[]>([]);
  const [chats,setChats]=useState<Chat[]>([]),[selected,setSelected]=useState<string[]>([]),[reply,setReply]=useState(true),[background,setBackground]=useState(false);
  const [error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const [details,setDetails]=useState(false);
  const alive=useRef(false),action=useRef<AbortController|null>(null);
  const frozen=useRef<{server:Server;scope:WatchScope;background:boolean}|null>(null);
  const refresh=useCallback(async()=>{
    if(!wearNative)return;
    try{
      const cap=await wearNative.capabilities();if(!alive.current)return;setSupported(cap.supported);
      if(!cap.supported)return;
      const local=await wearNative.status();if(!alive.current)return;setPending(local.pending);setLinks(local.links);
    }catch(e){if(alive.current)setError((e as Error).message);}
  },[wearNative]);
  useFocusEffect(useCallback(()=>{
    alive.current=true;void refresh();const timer=setInterval(()=>void refresh(),3000);
    return()=>{alive.current=false;action.current?.abort();clearInterval(timer);};
  },[refresh]));
  useEffect(()=>{
    const controller=new AbortController();setSelected([]);setChats([]);setRemote([]);frozen.current=null;
    if(server && supported)void Promise.all([api<{chats:Chat[]}>(server,'/api/chats'),watchGrants(server)]).then(([value,grants])=>{
      if(!controller.signal.aborted){setChats(value.chats.filter(chat=>chat.kind!=='home'));setRemote(grants.links);}
    }).catch(e=>{if(!controller.signal.aborted)setError(e instanceof ApiError && e.status===404?'Update Winglet on this bot to enable watch access.':(e as Error).message);});
    return()=>controller.abort();
  },[server,supported]);
  const run=async(work:(signal:AbortSignal)=>Promise<void>)=>{
    if(action.current)return;const controller=new AbortController();action.current=controller;setBusy(true);setError('');setMessage('');
    try{await work(controller.signal);if(alive.current && server)setRemote((await watchGrants(server)).links);}
    catch(e){if(alive.current)setError((e as Error).message);}
    finally{action.current=null;if(alive.current){setBusy(false);void refresh();}}
  };
  const pair=(watch:WatchPending)=>void run(async signal=>{
    if(!server)throw new Error('Choose a bot first.');
    if(!frozen.current)frozen.current={server,scope:watchScope(watch.association,watch.name,selected,reply),background};
    const setup=frozen.current;
    if(setup.scope.association!==watch.association)throw new Error('Finish or cancel the current watch setup first.');
    await linkWatch(setup.server,setup.scope,setup.background,signal,wearNative);frozen.current=null;
    if(alive.current)setMessage('Watch linked. Refresh on the watch to see shared conversations.');
  });
  return <Screen title="Wear OS">
    <ListGroup style={s.status}><ListRow title={!wearNative||!supported?'Android watch setup unavailable':links.length?`${links.length} ${links.length===1?'watch linked':'watches linked'}`:pending.length?'Watch ready to link':'No watch linked'}
      icon={<View style={[s.dot,{backgroundColor:!wearNative||!supported?t.colors.textTertiary:links.length?t.colors.success:t.colors.warning}]} />} /></ListGroup>
    {supported?<>
      <SectionHeader title="Bot"/><ListGroup>{servers.map(value=><ListRow key={value.id} title={value.bot.title}
        right={value.id===serverId?<Check size={20} color={t.colors.accent} accessibilityLabel="Selected"/>:undefined}
        chevron={false} disabled={busy||!!frozen.current} onPress={()=>setServerId(value.id)}/>)}</ListGroup>
      <SectionHeader title="Conversations" right={<Text style={s.note}>{selected.length} of 12</Text>}/>
      {chats.length?<ListGroup>{chats.map(chat=><ListRow key={chat.id} title={chat.title||'Conversation'}
        right={selected.includes(chat.id)?<Check size={20} color={t.colors.accent} accessibilityLabel="Shared on linking"/>:undefined}
        chevron={false} disabled={busy||!!frozen.current} onPress={()=>setSelected(value=>value.includes(chat.id)?value.filter(id=>id!==chat.id):value.length<12?[...value,chat.id]:value)}/>)}</ListGroup>
        :<Footnote>Create a conversation on a supported bot to share it.</Footnote>}
      <SectionHeader title="Access"/>
      <ListGroup>
        <ListRow title="Allow short replies" right={<Toggle label="Allow short replies" value={reply} onValueChange={value=>{if(!busy&&!frozen.current)setReply(value);}}/>}/>
        <ListRow title="Background relay" subtitle="Allow access while the phone is locked or Winglet is closed" right={<Toggle label="Relay while phone is locked or Winglet is closed" value={background} onValueChange={value=>{if(!busy&&!frozen.current)setBackground(value);}}/>}/>
      </ListGroup>
      <Footnote>{background?'Unlock the watch to read shared chats; the phone can stay locked.':'Keep Winglet open and unlocked to use the watch.'} Links expire after 30 days.</Footnote>
      <SectionHeader title="Watch codes"/>
      {!pending.length?<Footnote>Tap Link on your watch; its code appears here for two minutes.</Footnote>:null}
      {pending.map(watch=><Card key={watch.association} style={s.card}>
        <Text style={s.heading}>{watch.name}</Text><Text style={s.code}>{watch.code}</Text>
        <Text style={s.note}>Check this code matches your watch. {selected.length} conversations selected.</Text>
        <Button title={frozen.current?'Retry setup':'Link watch'} disabled={busy||!server||!selected.length} onPress={()=>pair(watch)}/>
        <Button title="Cancel setup" variant="secondary" disabled={busy} onPress={()=>void run(async()=>{
          frozen.current=null;await wearNative?.cancel(watch.association);
          if(server)for(const grant of (await watchGrants(server)).links.filter(value=>value.association===watch.association))await revokeWatch(server,grant.id);
        })}/>
      </Card>)}
      <SectionHeader title="Linked watches"/>
      {links.length?<ListGroup>{links.map(link=><ListRow key={link.association} title={link.name}
        subtitle={servers.find(value=>value.id===link.serverId)?.bot.title??'Removed pairing'}
        value={link.expires<Date.now()/1000?'Expired':link.background?'Background':'Phone open'}
        right={<Button title="Unlink" accessibilityLabel={`Unlink and revoke ${link.name}`} size="sm" variant="ghost" disabled={busy} onPress={()=>void run(async()=>{
          await wearNative?.remove(link.association);const target=servers.find(value=>value.id===link.serverId);
          if(target)await revokeWatch(target,link.grantId);else throw new Error('Local link removed. Revoke any remaining server grant from another paired device.');
        })}/>}/>)}</ListGroup>:<Footnote>No linked watches.</Footnote>}
      <SectionHeader title="Server access"/>
      {remote.length?<ListGroup>{remote.map(grant=><ListRow key={grant.id} title={grant.name}
        subtitle={`${grant.chat_ids.length} conversations, ${grant.can_reply?'replies allowed':'read only'}. Expires ${new Date(grant.expires*1000).toLocaleDateString()}`}
        right={<Button title="Revoke" accessibilityLabel={`Revoke server access for ${grant.name}`} size="sm" variant="ghost" disabled={busy} onPress={()=>void run(async()=>{
          for(const link of links.filter(value=>value.grantId===grant.id))await wearNative?.remove(link.association);
          if(server)await revokeWatch(server,grant.id);
        })}/>}/>)}</ListGroup>:<Footnote>No server grants.</Footnote>}
    </>:null}
    <SectionHeader title="Setup"/>
    <ListGroup>
      <ListRow title="Details" onPress={()=>setDetails(true)}/>
      <ListRow title="Refresh watch status" disabled={busy} onPress={()=>void refresh()} chevron={false}/>
    </ListGroup>
    {message?<Footnote>{message}</Footnote>:null}
    {error?<><LoadError message={error} onRetry={refresh}/><Button title="Reset local watch links" variant="secondary" disabled={busy} onPress={()=>void run(async()=>{await wearNative?.reset();setMessage('Local links reset. Revoke remaining server access above, then pair again.');})}/></>:null}
    <Sheet visible={details} title="Watch details" onClose={()=>setDetails(false)} scrollable>
      <ListGroup>
        <ListRow title="Platform" value="Android + Wear OS"/>
        <ListRow title="Link lifetime" value="30 days"/>
        <ListRow title="Conversation limit" value="12"/>
        <ListRow title="Approvals and tools" value="On phone"/>
      </ListGroup>
      <Footnote>Install matching Winglet builds on a paired phone and watch with Google Play services, then tap Link on the watch.</Footnote>
      <Footnote>The phone relays selected chats and allowed replies; the watch never receives your full pairing credentials.</Footnote>
      <Footnote>Revoke server access here to end a link, including after removing a phone pairing.</Footnote>
    </Sheet>
    <View style={{height:t.space.xl}}/>
  </Screen>;
}
const useStyles=makeStyles(t=>({
  status:{marginTop:t.space.lg},dot:{width:t.space.sm,height:t.space.sm,borderRadius:t.radius.pill},
  card:{marginTop:t.space.md,gap:t.space.md},heading:{...t.type.heading,color:t.colors.text},
  note:{...t.type.footnote,color:t.colors.textSecondary},
  code:{...t.type.display,fontFamily:t.fonts.mono,color:t.colors.text,textAlign:'center'},
}));
