import {useCallback,useEffect,useRef,useState} from 'react';
import {Text,View} from 'react-native';
import {useFocusEffect} from 'expo-router';
import {Screen} from '../../components/Screen';
import {Button,Card,ListGroup,ListRow,LoadError,SectionHeader,Toggle} from '../../components/ui';
import {api} from '../../lib/api';
import {useApp} from '../../lib/store';
import {makeStyles} from '../../lib/themeContext';
import type {Chat,Server} from '../../lib/types';
import {wearNative as defaultWearNative,type WearNative,type WatchPending,type WatchLink} from './native';
import {linkWatch,revokeWatch,watchGrants,type RemoteWatch} from './api';
import {watchScope,type WatchScope} from './model';

export function WearSettings({nativeClient=defaultWearNative}:{nativeClient?:WearNative|null}){
  const wearNative=nativeClient;
  const s=useStyles(),servers=useApp(st=>st.servers),selection=useApp(st=>st.selection.serverId);
  const [serverId,setServerId]=useState(selection??''),[supported,setSupported]=useState(false);
  const server=servers.find(value=>value.id===serverId);
  const [pending,setPending]=useState<WatchPending[]>([]),[links,setLinks]=useState<WatchLink[]>([]),[remote,setRemote]=useState<RemoteWatch[]>([]);
  const [chats,setChats]=useState<Chat[]>([]),[selected,setSelected]=useState<string[]>([]),[reply,setReply]=useState(true),[background,setBackground]=useState(false);
  const [error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
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
    if(server)void Promise.all([api<{chats:Chat[]}>(server,'/api/chats'),watchGrants(server)]).then(([value,grants])=>{
      if(!controller.signal.aborted){setChats(value.chats.filter(chat=>chat.kind!=='home'));setRemote(grants.links);}
    }).catch(e=>{if(!controller.signal.aborted)setError((e as Error).message);});
    return()=>controller.abort();
  },[server]);
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
  return <Screen title="Wear OS" subtitle="A small, private companion for your paired Android phone.">
    <Card style={s.card}><Text style={s.heading}>Your agents, on your wrist</Text>
      <Text style={s.note}>Read recent messages and send short replies in conversations you choose. Your phone relays each request; the watch never receives your full pairing credentials. Approvals and tools open on the phone.</Text>
      <Text style={s.note}>Install the Winglet watch app with the same package and signing certificate as this phone, then tap Link on the watch. Both devices need Google Play services.</Text>
      {!wearNative || !supported?<Text style={s.note}>Watch setup needs the Android build with Google Play services. Your other Winglet features still work.</Text>:null}
    </Card>
    {supported?<>
      <SectionHeader title="Share from this bot"/><ListGroup>{servers.map(value=><ListRow key={value.id} title={value.bot.title} subtitle={value.id===serverId?'Selected':undefined} disabled={busy||!!frozen.current} onPress={()=>setServerId(value.id)}/>)}</ListGroup>
      <SectionHeader title="Conversations"/><ListGroup>{chats.map(chat=><ListRow key={chat.id} title={chat.title||'Conversation'} subtitle={selected.includes(chat.id)?'Shared on linking':'Tap to include'} disabled={busy||!!frozen.current} onPress={()=>setSelected(value=>value.includes(chat.id)?value.filter(id=>id!==chat.id):value.length<12?[...value,chat.id]:value)}/>)}</ListGroup>
      {!chats.length?<Text style={s.note}>Connect to a supported bot and create a conversation before sharing.</Text>:null}
      <Card style={s.card}>
        <ListRow title="Allow short replies" right={<Toggle label="Allow short replies" value={reply} onValueChange={value=>{if(!busy&&!frozen.current)setReply(value);}}/>}/>
        <ListRow title="Relay while phone is locked or Winglet is closed" right={<Toggle label="Relay while phone is locked or Winglet is closed" value={background} onValueChange={value=>{if(!busy&&!frozen.current)setBackground(value);}}/>}/>
        <Text style={s.note}>{background?'This watch may read selected conversations and send allowed replies without unlocking the phone or Winglet. Unlock the watch to view content.':'Default privacy: keep Winglet open and unlocked on the phone when using the watch.'} Links expire after 30 days and can be revoked here.</Text>
      </Card>
      <SectionHeader title="Watch codes"/>
      {!pending.length?<Text style={s.note}>Tap Link on your nearby watch. Its code appears here for two minutes.</Text>:null}
      {pending.map(watch=><Card key={watch.association} style={s.card}>
        <Text style={s.heading}>{watch.name}</Text><Text style={s.code}>{watch.code}</Text>
        <Text style={s.note}>Only continue if this code matches your watch. {selected.length} conversations selected.</Text>
        <Button title={frozen.current?'Retry the same setup':'Codes match — link watch'} disabled={busy||!server||!selected.length} onPress={()=>pair(watch)}/>
        <Button title="Cancel setup" variant="secondary" disabled={busy} onPress={()=>void run(async()=>{
          frozen.current=null;await wearNative?.cancel(watch.association);
          if(server)for(const grant of (await watchGrants(server)).links.filter(value=>value.association===watch.association))await revokeWatch(server,grant.id);
        })}/>
      </Card>)}
      <SectionHeader title="Linked on this phone"/>
      {links.map(link=><Card key={link.association} style={s.card}>
        <Text style={s.heading}>{link.name}</Text><Text style={s.note}>{servers.find(value=>value.id===link.serverId)?.bot.title??'Removed pairing'} · {link.background?'Background relay allowed':'Phone must be open'}{link.expires<Date.now()/1000?' · Expired':''}</Text>
        <Button title="Unlink and revoke" variant="secondary" disabled={busy} onPress={()=>void run(async()=>{
          await wearNative?.remove(link.association);const target=servers.find(value=>value.id===link.serverId);
          if(target)await revokeWatch(target,link.grantId);else throw new Error('Local link removed. Revoke any remaining server grant from another paired device.');
        })}/>
      </Card>)}
      <SectionHeader title="Server access"/>
      {remote.map(grant=><Card key={grant.id} style={s.card}><Text style={s.heading}>{grant.name}</Text>
        <Text style={s.note}>{grant.chat_ids.length} conversations · {grant.can_reply?'Replies allowed':'Read only'} · expires {new Date(grant.expires*1000).toLocaleDateString()}</Text>
        <Button title="Revoke server access" variant="secondary" disabled={busy} onPress={()=>void run(async()=>{
          for(const link of links.filter(value=>value.grantId===grant.id))await wearNative?.remove(link.association);
          if(server)await revokeWatch(server,grant.id);
        })}/></Card>)}
      <Button title="Refresh watch status" variant="secondary" disabled={busy} onPress={()=>void refresh()}/>
    </>:null}
    {message?<Text style={s.note}>{message}</Text>:null}
    {error?<><LoadError message={error} onRetry={refresh}/><Button title="Reset local watch links" variant="secondary" disabled={busy} onPress={()=>void run(async()=>{await wearNative?.reset();setMessage('Local links reset. Revoke remaining server access above, then pair again.');})}/></>:null}
    <View style={{height:24}}/>
  </Screen>;
}
const useStyles=makeStyles(t=>({card:{marginTop:16,gap:12},heading:{...t.type.heading,color:t.colors.text},note:{...t.type.callout,color:t.colors.textSecondary},code:{fontSize:32,fontWeight:'700',letterSpacing:6,color:t.colors.text,textAlign:'center'}}));
