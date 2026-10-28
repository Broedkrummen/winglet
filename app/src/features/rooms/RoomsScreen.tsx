import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AgentFace } from '../../components/AgentFace';
import { BotAvatar } from '../../components/BotAvatar';
import { KeyboardViewport } from '../../components/KeyboardViewport';
import { Markdown } from '../../components/Markdown';
import { Screen } from '../../components/Screen';
import { withSelectedServer } from '../../components/ServerScreen';
import { Sheet } from '../../components/Sheet';
import { ArrowLeft, MoreHorizontal, Plus, Send, Square, Users } from '../../components/icons';
import { Button, Chip, Footnote, IconButton, Field, ListGroup, ListRow, SectionHeader, Tap } from '../../components/ui';
import { api, ApiError, signedApi } from '../../lib/api';
import { isOwner, useApp } from '../../lib/store';
import { makeStyles, useTheme } from '../../lib/themeContext';
import type { Server } from '../../lib/types';
import { mergeRoomEvents, mentionQuery, recipients, roomLine, type Cursor, type Room, type RoomAction, type RoomBot, type RoomEvent, type RoomList, type RoomPage } from './model';

const operationId = () => `room-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
const pathOf = (id: string) => `/api/rooms/${encodeURIComponent(id)}`;

export default withSelectedServer(RoomsScreen);

function RoomsScreen() {
  const chosen = useApp(st => st.servers.find(x => x.id === st.selection.serverId) ?? st.servers[0]);
  const server = useApp(st => st.servers.find(x => x.id === chosen?.parent) ?? chosen);
  const online = useApp(st => !!server && st.network && st.runtime[server.id]?.status === 'online');
  const feature = useApp(st => !!server && !!st.runtime[server.id]?.info?.features?.rooms);
  const owner = useApp(st => !!server && isOwner(st.runtime[server.id]));
  const params = useLocalSearchParams<{ room?: string }>();
  const s = useStyles(); const t = useTheme();
  const [list, setList] = useState<RoomList | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useFocusEffect(useCallback(() => {
    if (!server || !online || !feature || params.room) return;
    let disposed = false; let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try { const data = await api<RoomList>(server, '/api/rooms'); if (!disposed) { setList(data); setError(''); } }
      catch (e) { if (!disposed) { setError((e as Error).message); if (e instanceof ApiError && [401,403].includes(e.status)) setList(null); } }
      finally { if (!disposed) timer = setTimeout(load, 5000); }
    };
    void load(); return () => { disposed = true; clearTimeout(timer); };
  }, [server, online, feature, params.room, refresh]));
  useEffect(() => { setList(null); setError(''); setCreating(false); }, [server?.id, owner]);
  if (!server) return null;
  if (params.room) return <RoomConversation key={`${server.id}:${params.room}`} server={server} roomId={params.room} online={online} owner={owner} />;
  return <Screen title="Rooms"
    right={online && feature && owner ? <IconButton label="Create room" variant="tonal" onPress={() => setCreating(true)}><Plus size={22} color={t.colors.accent} /></IconButton> : undefined}>
    {!online ? <Text style={s.notice}>Connect to load rooms.</Text> : !feature ? <Text style={s.notice}>Update this gateway to use rooms.</Text> : null}
    {error ? <View style={s.notice}><Text style={s.error}>{error}</Text><Button title="Reload rooms" variant="secondary" onPress={() => setRefresh(x => x+1)} /></View> : null}
    {online && feature && !list && !error ? <ActivityIndicator color={t.colors.accent} style={{ margin: 30 }} /> : null}
    {list && !list.rooms.length ? <View style={s.empty}><Users size={34} color={t.colors.textSecondary} /><Text style={s.title}>No rooms yet</Text><Text style={s.meta}>{owner ? 'Create a room with two to six bots.' : 'Ask an owner to invite you to a room.'}</Text>{owner ? <Button title="Create a room" onPress={() => setCreating(true)} disabled={!online} /> : null}</View> : null}
    {list?.rooms.length ? <><SectionHeader title="Conversations" /><ListGroup>{list.rooms.map(room => <ListRow key={room.id}
      icon={<Users />} title={room.title} subtitle={room.members.map(m=>m.display_name).join(', ')}
      value={room.archived ? 'Archived' : room.driver.working ? 'Working' : room.unread ? 'Unread' : 'Ready'}
      onPress={() => router.push({ pathname:'/rooms', params:{ room:room.id } })} />)}</ListGroup></> : null}
    {creating ? <RoomManage server={server} bots={list?.bots ?? []} onClose={() => setCreating(false)} onSaved={id => { setCreating(false); router.push({ pathname:'/rooms', params:{ room:id } }); }} /> : null}
  </Screen>;
}

function RoomConversation({ server, roomId, online, owner }: { server: Server; roomId: string; online: boolean; owner: boolean }) {
  const s=useStyles(); const t=useTheme(); const insets=useSafeAreaInsets();
  const [room,setRoom]=useState<Room | null>(null); const [events,setEvents]=useState<RoomEvent[]>([]);
  const [older,setOlder]=useState<Cursor | null>(null); const [error,setError]=useState('');
  const draftId=`room-${roomId}`;
  const [text,setText]=useState(()=>useApp.getState().drafts[`${server.id}:${draftId}`]??''); const textRef=useRef(text);
  const [manage,setManage]=useState(false); const [busy,setBusy]=useState(false); const [confirm,setConfirm]=useState(false);
  const [history,setHistory]=useState(false);
  const [refresh,setRefresh]=useState(0); const [revoked,setRevoked]=useState(false); const [follow,setFollow]=useState(true);
  const cursor=useRef<Cursor | null>(null); const mutation=useRef(0); const alive=useRef(true); const scroll=useRef<FlashListRef<RoomEvent>>(null);
  const pending=useRef<{ action:string; key:string; body:Record<string,any> } | null>(null);
  const updateText=(value:string) => { textRef.current=value; setText(value); pending.current=null;
    useApp.getState().setDraft(server.id,draftId,value); };
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{ if(!owner) { setManage(false); setConfirm(false); pending.current=null; } },[owner]);
  useFocusEffect(useCallback(()=>{
    if(!online) return;
    let disposed=false; let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      const version=mutation.current;let terminal=false;
      try {
        const next=await api<Room>(server,pathOf(roomId));
        if(history) {if(!disposed&&version===mutation.current)setRoom(next);return;}
        const at=cursor.current;
        const page=await api<RoomPage>(server,`${pathOf(roomId)}/log${at ? `?epoch=${at[0]}&after=${at[1]}` : '?tail=1'}`);
        if(disposed || version!==mutation.current) return;
        setRoom(next); setRevoked(false); setError('');
        setEvents(old=>mergeRoomEvents(old,page.events).slice(-1000));
        if(!at) setOlder(page.older);
        cursor.current=page.cursor;
        if(!page.has_more) void signedApi(server,'POST',`${pathOf(roomId)}/seen`,{operation_id:operationId(),cursor:page.cursor}).catch(()=>{});
      } catch(e) { if(!disposed) {setError((e as Error).message); if(e instanceof ApiError && [401,403,404].includes(e.status)) {terminal=true;setRevoked(true);setRoom(null);setEvents([]);return;} } }
      finally {if(!disposed&&!terminal) timer=setTimeout(poll,2500);}
    };
    void poll();return()=>{disposed=true;clearTimeout(timer);};
  },[server,roomId,online,refresh,owner,history]));
  const action=async(name:string,body:Record<string,any>={})=>{
    if(!online || busy || !owner || !room?.can_manage) return false;
    const key=JSON.stringify([name,body]);
    if(!pending.current || pending.current.key!==key) pending.current={action:name,key,body:{...body,operation_id:operationId()}};
    const request=pending.current.body; mutation.current++; setBusy(true); setError('');
    try { await signedApi(server,'POST',`${pathOf(roomId)}/${name}`,request); if(!alive.current) return false;
      pending.current=null;setConfirm(false);setRefresh(x=>x+1);return true;
    } catch(e) { if(alive.current) setError((e as Error).message);return false; }
    finally {mutation.current++;if(alive.current)setBusy(false);}
  };
  const send=async()=>{ const sent=textRef.current; if(await action('send',{text:sent,revision:room?.revision}) && textRef.current===sent) updateText(''); };
  const loadEarlier=async()=>{if(!older || !online) return;setHistory(true);setBusy(true);try {const page=await api<RoomPage>(server,`${pathOf(roomId)}/log?epoch=${older[0]}&after=${older[1]}`);if(alive.current){setEvents(old=>mergeRoomEvents(old,page.events).slice(0,1000));setOlder(page.older);}} catch(e){if(alive.current)setError((e as Error).message);}finally{if(alive.current)setBusy(false);}};
  const addressed=room ? recipients(text,room.members):[]; const query=mentionQuery(text);
  return <KeyboardViewport>{()=> <View style={s.root}>
    <View style={[s.roomHeader,{paddingTop:insets.top+t.space.xs}]}><View style={s.roomHeaderInner}>
      <IconButton label="All rooms" onPress={()=>router.setParams({room:undefined})}><ArrowLeft size={22} color={t.colors.text} /></IconButton>
      <Text style={[s.title,s.flex]} accessibilityRole="header" numberOfLines={1}>{room?.title ?? 'Room'}</Text>
      {room?.can_manage ? <IconButton label="Room settings" onPress={()=>setManage(true)}><MoreHorizontal size={23} color={t.colors.text} /></IconButton>:null}
    </View></View>
    <View style={s.column}>
    {!online ? <Text style={s.notice}>Offline. Your draft is saved.</Text> : null}
    {error ? <View style={s.notice}><Text style={s.error}>{error}</Text><Button title="Reload room" variant="secondary" onPress={()=>{cursor.current=null;setRefresh(x=>x+1);}} /></View>:null}
    {room ? <View style={s.participants}><View style={s.wrap}>{room.members.map(m=><View key={m.member_id} pointerEvents={room.can_send ? 'auto' : 'none'}><Chip label={`@${m.handle}`} accessibilityLabel={`Mention ${m.display_name}`} onPress={()=>{if(room.can_send)updateText(`${textRef.current}${textRef.current && !textRef.current.endsWith(' ') ? ' ':''}@${m.handle} `);}} /></View>)}</View>
      <Text style={s.meta}>{room.archived ? 'Archived room' : room.driver.working ? `${room.driver.turns?.map(turn=>`${room.members.find(m=>m.profile===turn.profile)?.display_name??turn.profile}: ${turn.status}`).join(' · ')||'Bots are taking turns'} · maximum 3 rounds, 10 replies` : room.driver.blocked ? 'Discussion needs attention' : 'Address a bot to start a turn'}{room.epoch_count>1 ? ` · Roster ${room.epoch_count}`:''}</Text></View>:!error&&online?<ActivityIndicator color={t.colors.accent} style={{margin:24}}/>:null}
    <FlashList ref={scroll} data={events} keyExtractor={event=>event.id} style={s.transcript} contentContainerStyle={s.messages}
      ItemSeparatorComponent={()=> <View style={{height:12}}/>}
      keyboardShouldPersistTaps="handled" onContentSizeChange={()=>{if(follow)scroll.current?.scrollToEnd({animated:false});}}
      ListHeaderComponent={<>{history?<Text style={s.meta}>Reading earlier messages. Follow latest replies for live updates.</Text>:null}{events.length>=1000?<Text style={s.meta}>Showing up to 1,000 loaded events.</Text>:null}
      {older ? <Button title="Earlier messages" variant="ghost" onPress={()=>{setFollow(false);void loadEarlier();}} disabled={busy||!online}/>:null}
      {room && !events.some(e=>e.kind.startsWith('message.')) ? <View style={s.empty}><Users size={32} color={t.colors.accent}/><Text style={s.title}>Mention a bot to start</Text><Text style={s.meta}>Tap a participant or type @.</Text></View>:null}
      </>}
      renderItem={({item:event,index})=>{
        const line=roomLine(event);
        if(line===null)return null;
        const human=event.kind==='message.user';
        const bot=room?.members.find(m=>m.member_id===event.payload.member_id);
        const message=event.kind.startsWith('message.');
        const previous=events[index-1];
        const speaker=event.payload.display_name??bot?.display_name??event.payload.member_id??'Bot';
        return <View style={[s.message,human&&s.human,!message&&s.system]}>
          {previous && previous.epoch!==event.epoch ? <Text style={s.meta}>Participants changed. New room context.</Text>:null}
          {message?<View style={s.speaker}>
            {human?<View style={s.avatar}><Text style={s.meta}>{event.actor.id==='winglet:'+server.deviceId?'You':(event.actor.label??'Participant').slice(0,2)}</Text></View>:<RoomBotFace server={server} profile={event.payload.member_id} name={speaker}/>}
            <Text style={s.speakerName}>{human?(event.actor.id==='winglet:'+server.deviceId?'You':event.actor.label??'Participant'):speaker}</Text>
            <Text style={s.meta}>{new Date(event.created_at*1000).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}</Text>
          </View>:null}
          {message?<Markdown text={line} selectable/>:<Text selectable style={s.meta}>{line}</Text>}
        </View>;
      }}
    />
    {room?.driver.pending_actions.map(item=><PendingAction key={`${item.task_id}:${item.request_id??item.kind}`} item={item} disabled={!owner||!online||busy} onAction={(name,body)=>void action(name,body)}/>) }
    {room && <View style={[s.composer,{paddingBottom:Math.max(10,insets.bottom)}]}>
      {room.driver.working && owner?<View style={s.statusRow}><Text style={[s.meta,s.flex]}>Discussion in progress</Text><Button title="Stop room" variant="danger" icon={<Square size={15} color={t.colors.danger}/>} onPress={()=>setConfirm(true)} disabled={!online||busy}/></View>:null}
      {!room.can_send?<Text style={s.meta}>{room.archived?'Restore this room in settings to send.':'Read access. Member execution is unavailable because this Hermes cannot enforce Winglet tool limits in rooms.'}</Text>:<>
      {query!==null?<View style={s.wrap}>{room.members.filter(m=>m.handle.toLowerCase().startsWith(query.toLowerCase())||m.display_name.toLowerCase().includes(query.toLowerCase())).map(m=><Button key={m.member_id} title={`@${m.handle}`} variant="secondary" onPress={()=>updateText(text.replace(/@[A-Za-z0-9._:-]*$/,`@${m.handle} `))}/>)}</View>:null}
      <Text style={s.meta}>{addressed.length?`To ${addressed.map(m=>m.display_name).join(', ')}`:'Choose recipients with @mention'}</Text>
      <View style={s.composeRow}><TextInput accessibilityLabel="Message this room" placeholder="Ask @main and @ops…" placeholderTextColor={t.colors.textSecondary} multiline value={text} onChangeText={updateText} style={s.input} maxLength={16000}/><Button title="" accessibilityLabel="Send room message" variant="tonal" style={{minWidth:48,minHeight:48}} disabled={!online||busy||room.driver.working||!addressed.length||!text.trim()} onPress={()=>void send()} icon={<Send size={23} color={t.colors.accent}/>} /></View>
      </>}
      {events.length>0?<Button title={follow?'Pause following replies':'Follow latest replies'} variant="ghost" onPress={()=>{if(history){setHistory(false);cursor.current=null;setEvents([]);setFollow(true);setRefresh(x=>x+1);}else{setFollow(x=>!x);if(!follow)scroll.current?.scrollToEnd({animated:false});}}}/>:null}
    </View>}
    </View>
    <Sheet visible={confirm} title="Stop room" onClose={()=>setConfirm(false)}><View style={s.sheetBody}><Footnote>Stops queued and active turns after the worker acknowledges cancellation.</Footnote><Button title="Stop room" variant="danger" loading={busy} disabled={!online||!owner||revoked} onPress={()=>void action('stop')}/><Button title="Keep working" variant="secondary" onPress={()=>setConfirm(false)}/></View></Sheet>
    {manage && room ? <RoomManage server={server} room={room} bots={room.available_profiles} onClose={()=>setManage(false)} onSaved={()=>{setManage(false);setRefresh(x=>x+1);}}/>:null}
  </View>}</KeyboardViewport>;
}

function RoomBotFace({server,profile,name}:{server:Server;profile:string;name:string}) {
  const bot=useApp(st=>st.servers.find(candidate=>(candidate.parent??candidate.id)===server.id&&(candidate.profile??'default')===profile));
  return bot?<AgentFace server={bot} size={30} still/>:<BotAvatar name={name} size={30}/>;
}

function PendingAction({item,disabled,onAction}:{item:RoomAction;disabled:boolean;onAction:(name:string,body:Record<string,any>)=>void}) {
  const s=useStyles(); const {kind,summary,...coordinates}=item;
  return <View style={s.notice}><Text style={s.body}>{kind==='approval'?summary||'A bot needs approval to continue.':'A bot turn needs an explicit retry.'}</Text>{disabled?<Text style={s.meta}>An owner can respond while connected.</Text>:<View style={s.wrap}>{kind==='approval'?<><Button title="Allow once" onPress={()=>onAction('approve',{...coordinates,choice:'once'})}/><Button title="Deny" variant="secondary" onPress={()=>onAction('approve',{...coordinates,choice:'deny'})}/></>:<Button title="Retry this turn" onPress={()=>onAction('retry',coordinates)}/>}</View>}</View>;
}

function RoomManage({server,room,bots,onClose,onSaved}:{server:Server;room?:Room;bots:RoomBot[];onClose:()=>void;onSaved:(id:string)=>void}) {
  const s=useStyles();const t=useTheme();const {height}=useWindowDimensions(); const online=useApp(st=>st.network&&st.runtime[server.id]?.status==='online'); const owner=useApp(st=>isOwner(st.runtime[server.id]));
  const [title,setTitle]=useState(room?.title??'');const [selected,setSelected]=useState(room?.members.map(m=>m.profile)??[] as string[]);const [readers,setReaders]=useState(room?.readers??[]);
  const [devices,setDevices]=useState<{id:string;name:string;role:string}[]>([]);const [archived,setArchived]=useState(room?.archived??false);const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  const live=useRef(true);const pending=useRef<{key:string;body:Record<string,any>}|null>(null);
  useEffect(()=>{live.current=true;void api<{devices:{id:string;name:string;role:string}[]}>(server,'/api/devices').then(data=>{if(live.current)setDevices(data.devices.filter(x=>x.role!=='owner'));}).catch(()=>{});return()=>{live.current=false;};},[server]);
  const save=async()=>{if(!online||!owner||busy)return;setBusy(true);const body={title,bots:selected,...(room?{revision:room.revision,readers,archived}:{})};const key=JSON.stringify(body);if(!pending.current||pending.current.key!==key)pending.current={key,body:{...body,operation_id:operationId()}};
    try{const result=await signedApi<{id?:string}>(server,'POST',room?`${pathOf(room.id)}/update`:'/api/rooms',pending.current.body);if(live.current)onSaved(room?.id??result.id!);}catch(e){if(live.current)setError((e as Error).message);}finally{if(live.current)setBusy(false);}};
  return <Sheet visible title={room?'Room settings':'Create a room'} onClose={onClose}><View style={[s.sheetBody,{height:Math.max(180,Math.min(580,height-180))}]}><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{gap:14,paddingBottom:16}}>
    <Field accessibilityLabel="Room title" placeholder="Room title" value={title} onChangeText={setTitle} maxLength={80}/>
    <SectionHeader title="Bots" right={<Text style={s.meta}>{selected.length} of 2–6</Text>} />{bots.map(bot=><Tap key={bot.name} accessibilityRole="checkbox" accessibilityState={{checked:selected.includes(bot.name),disabled:!bot.served&&!selected.includes(bot.name)}} disabled={!bot.served&&!selected.includes(bot.name)} style={s.choice} onPress={()=>setSelected(old=>old.includes(bot.name)?old.filter(x=>x!==bot.name):[...old,bot.name])}><Text style={[s.body,s.flex]}>{bot.title}{!bot.served?' · Unavailable':''}</Text><Text style={{color:t.colors.accent}}>{selected.includes(bot.name)?'Selected':'Add'}</Text></Tap>)}
    {room?<><Text style={s.meta}>Changing bots stops the discussion; earlier messages stay readable.</Text><Text style={s.body}>Devices with read access</Text><Text style={s.meta}>Owners manage all rooms. Invited members have read-only access.</Text>{devices.map(device=><Tap key={device.id} accessibilityRole="checkbox" accessibilityState={{checked:readers.includes(device.id)}} style={s.choice} onPress={()=>setReaders(old=>old.includes(device.id)?old.filter(x=>x!==device.id):[...old,device.id])}><Text style={[s.body,s.flex]}>{device.name}</Text><Text style={s.chipText}>{readers.includes(device.id)?'Can read':'Invite'}</Text></Tap>)}<Button title={archived?'Restore room':'Archive room'} variant="secondary" onPress={()=>setArchived(x=>!x)}/><Text style={s.meta}>{archived?'Will be archived after Save. Pending work must stop first.':'Active room'}</Text></>:null}
    {error?<Text style={s.error}>{error}</Text>:null}
    </ScrollView><Button title={room?'Save changes':'Create room'} loading={busy} disabled={!online||!owner||!title.trim()||selected.length<2||selected.length>6} onPress={()=>void save()}/></View></Sheet>;
}

const useStyles=makeStyles(t=>({
  root:{flex:1,backgroundColor:t.colors.bg},column:{flex:1,minHeight:0,width:'100%',maxWidth:680,alignSelf:'center'},flex:{flex:1,minWidth:0},
  roomHeader:{backgroundColor:t.colors.bg,borderBottomWidth:1,borderBottomColor:t.colors.border},roomHeaderInner:{flexDirection:'row',alignItems:'center',gap:t.space.sm,minHeight:52,paddingHorizontal:t.space.sm,maxWidth:696,width:'100%',alignSelf:'center'},
  roomRow:{flexDirection:'row',alignItems:'center',gap:12,paddingVertical:18,borderBottomWidth:1,borderBottomColor:t.colors.border},
  face:{width:46,height:46,borderRadius:17,backgroundColor:t.colors.surfaceSunken,alignItems:'center',justifyContent:'center'},
  title:{...t.type.heading,color:t.colors.text},body:{...t.type.body,color:t.colors.text},meta:{...t.type.caption,color:t.colors.textSecondary},error:{...t.type.callout,color:t.colors.danger},
  notice:{...t.type.callout,color:t.colors.textSecondary,padding:t.space.lg,gap:t.space.sm,backgroundColor:t.colors.surface,borderRadius:t.radius.lg,marginVertical:t.space.md},empty:{alignItems:'center',gap:14,padding:28},
  participants:{paddingHorizontal:16,paddingVertical:10,gap:9,borderBottomWidth:1,borderBottomColor:t.colors.border},wrap:{flexDirection:'row',flexWrap:'wrap',gap:8},
  chip:{paddingHorizontal:13,minHeight:44,borderRadius:18,backgroundColor:t.colors.accentSoft,justifyContent:'center'},chipText:{...t.type.caption,color:t.colors.textSecondary},
  transcript:{flex:1,minHeight:0},messages:{padding:16,gap:16},message:{gap:9,padding:12,borderRadius:18,backgroundColor:t.colors.surfaceRaised},
  human:{backgroundColor:t.colors.surfaceSunken},system:{paddingVertical:5,backgroundColor:'transparent'},speaker:{flexDirection:'row',alignItems:'center',gap:8},speakerName:{...t.type.caption,color:t.colors.text,flex:1},
  avatar:{width:30,height:30,borderRadius:12,alignItems:'center',justifyContent:'center'},composer:{paddingHorizontal:14,paddingTop:10,gap:8,borderTopWidth:1,borderTopColor:t.colors.border},
  composeRow:{flexDirection:'row',alignItems:'flex-end',gap:8},input:{...t.type.body,color:t.colors.text,backgroundColor:t.colors.surfaceSunken,borderRadius:18,paddingHorizontal:14,paddingVertical:12,minHeight:48,maxHeight:140,flex:1,minWidth:0},
  statusRow:{flexDirection:'row',alignItems:'center',gap:8},sheetBody:{paddingBottom:t.space.lg,gap:t.space.md},choice:{minHeight:52,flexDirection:'row',gap:t.space.md,alignItems:'center',padding:t.space.md,borderBottomWidth:1,borderBottomColor:t.colors.border},
}));
