import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform, Text, View } from 'react-native';
import { Screen } from '../components/Screen';
import { Button, Field, Footnote, ListGroup, ListRow, SectionHeader, Segmented, Skeleton, Toggle } from '../components/ui';
import { api, signedApi } from '../lib/api';
import { useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import { nativePhone, phoneSupported } from '../features/phone-tools/native';
import { phoneSuspend, usePhone, type Snapshot } from '../features/phone-tools/runtime';
import { TOOLS, type Grant, type Tool } from '../features/phone-tools/policy';

export default function PhoneToolsScreen() {
  const t = useTheme();
  const s = useStyles();
  const server=useApp(s=>s.servers.find(server=>server.id===s.selection.serverId));
  const online=useApp(s=>s.runtime[s.selection.serverId ?? '']?.status==='online');
  const supported=useApp(s=>s.runtime[s.selection.serverId ?? '']?.info?.features.phone_tools===true);
  const activeServer=useRef(server?.id);
  activeServer.current=server?.id;
  const readSequence=useRef(0);
  const [data,setData]=useState<Snapshot>();
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [permission,setPermission]=useState<Record<string,{granted:boolean;canAskAgain:boolean}>>({});
  const notes=usePhone(s=>s.notes);
  const refresh=useCallback(async()=>{
    if(!server || !supported || !phoneSupported) return;
    const sequence=++readSequence.current;
    try {
      const snapshot=await api<Snapshot>(server,'/api/phone-tools');
      if(activeServer.current!==server.id || readSequence.current!==sequence) return;
      setData(snapshot);setError('');
      const states=await Promise.all(TOOLS.map(async tool=>[tool,await nativePhone!.permission(tool)] as const));
      if(activeServer.current===server.id && readSequence.current===sequence) setPermission(Object.fromEntries(states));
    } catch(e) { if(activeServer.current===server.id && readSequence.current===sequence) setError((e as Error).message); }
  },[server,supported]);
  useEffect(()=>{setData(undefined);void refresh();},[refresh]);
  useEffect(()=>{const sub=AppState.addEventListener('change',state=>{if(state==='active') void refresh();});return()=>sub.remove();},[refresh]);
  const mutate=async(method:'PUT'|'DELETE',body?:unknown)=>{
    if(!server || busy || !online) return;
    phoneSuspend(server.id);setBusy(true);setError('');
    try {const snapshot=await signedApi<Snapshot>(server,method,'/api/phone-tools',body);if(activeServer.current===server.id) setData(snapshot);}
    catch(e) {setError((e as Error).message);}
    finally {setBusy(false);}
  };
  const update=(tool:Tool,grant:Partial<Grant>,existing?:Grant)=>mutate('PUT',{tool,mode:existing?.mode ?? 'ask',scope:existing?.scope==='*'?'server':'bot',...grant,enabled:grant.enabled===undefined?!!existing?.enabled:!!grant.enabled});
  const repair=async(tool:Tool)=>{
    try { if(permission[tool]?.canAskAgain===false) await nativePhone!.openSettings();else await nativePhone!.requestPermission(tool);await refresh(); }
    catch {setError('Open Android app settings to repair this permission.');}
  };

  const message = (text: string) => <View style={s.empty}><Text style={s.body}>{text}</Text></View>;
  return <Screen title="Phone tools" subtitle={server?.bot.title} onRefresh={refresh}>
    {!phoneSupported ? message(`${Platform.OS==='android' ? 'This build has no phone bridge. Install a native Winglet build with Phone tools.' : 'Phone tools run on a paired Android phone.'} Nothing is shared from this device.`)
    : !server ? message('Choose a paired bot first.')
    : !supported ? message('This server does not offer Phone tools. Update the server and reconnect.')
    : <>
      {!online ? <Text accessibilityRole="alert" style={s.alert}>Offline. Changes need the server, and no phone requests run meanwhile.</Text> : null}
      {error ? <View style={s.errorBox}><Text accessibilityRole="alert" style={s.error}>{error}</Text><Button title="Try again" variant="secondary" onPress={()=>void refresh()}/></View> : null}
      {!data ? <View style={s.loading}><Skeleton height={52}/><Skeleton height={120}/></View> : <>
        <ListGroup style={{marginTop:t.space.md}}>
          <ListRow title="Phone access" value={data.grants.some(g=>g.enabled)?'On for some tools':'Off'}/>
        </ListGroup>
        <Footnote>Reads need Winglet open and unlocked, plus Android permission where needed. Results go to this agent's chat. Recent access records only the tool and outcome.</Footnote>
        <Button style={{marginTop:t.space.md}} title="Revoke all phone access" variant="danger" disabled={busy || !online} onPress={()=>void mutate('DELETE')}/>

        {['Everyday','Personal information'].map((group,index)=><View key={group}>
          <SectionHeader title={group}/>
          <ListGroup>{TOOLS.filter(tool=>!!data.catalog[tool]?.sensitive===!!index).flatMap(tool=>{
            const item=data.catalog[tool];
            const grant=data.grants.find(g=>g.tool===tool);
            const applies=grant && (grant.scope===data.bot_scope || grant.scope==='*');
            const enabled=!!grant?.enabled && !!applies;
            const controls=enabled || tool==='phone_shared_note';
            return [
              <ListRow key={tool} title={item.title} subtitle={item.description}
                right={<View style={{opacity: busy || !online ? 0.5 : 1}}>
                  <Toggle label={`Allow ${item.title}`} value={enabled} onValueChange={enabled=>void update(tool,{enabled:enabled?1:0,scope:'bot'},grant)} />
                </View>} />,
              controls ? <View key={`${tool}-controls`} style={s.controls}>
                <Text style={s.hint}>Shares: {item.fields}</Text>
                {enabled ? <>
                  <Segmented label="When to ask" value={grant?.mode ?? 'ask'} onChange={mode=>void update(tool,{mode},grant)} options={[{value:'ask',label:'Ask each time'},{value:'while_open',label:'While open'}]}/>
                  <Text style={s.hint}>{grant?.mode==='while_open'?'Reads may run automatically while open and unlocked. Precise location always asks.':'Each request shows its bot, chat and exact fields before you allow it.'}</Text>
                  {data.server_scope_allowed ? <Segmented label="Bot scope" value={grant?.scope==='*'?'server':'bot'} onChange={scope=>void mutate('PUT',{tool,enabled:true,mode:grant?.mode ?? 'ask',scope})} options={[{value:'bot',label:'This bot'},{value:'server',label:'Every server bot'}]}/> : null}
                  <Text style={s.hint}>{grant?.scope==='*'?'Any bot on this server, for your own phone only.':`Only ${server?.bot.title} on this server.`}</Text>
                  {!permission[tool]?.granted ? <Button title={permission[tool]?.canAskAgain===false?'Open Android settings':`Allow ${item.title} in Android`} variant="secondary" onPress={()=>void repair(tool)}/> : null}
                  {tool==='phone_location' && permission[tool]?.granted ? <Button title="Review approximate / precise permission" variant="ghost" onPress={()=>void repair(tool)}/> : null}
                </> : null}
                {tool==='phone_shared_note' ? <Field label="Your shared note" placeholder="Write only what you want your agent to read" multiline maxLength={2000} value={notes[server!.id] ?? ''} onChangeText={note=>usePhone.setState(s=>({notes:{...s.notes,[server!.id]:note}}))} hint="Up to 2000 characters. Kept for this app session only, never saved to a plaintext cache."/> : null}
              </View> : null,
            ];
          })}</ListGroup>
        </View>)}

        <SectionHeader title="Recent access"/>
        <ListGroup>
          {data.history.length ? data.history.map((event,index)=><ListRow key={`${event.ts}:${index}`}
            title={data.catalog[event.tool as Tool]?.title ?? 'Phone tools'} value={event.event}
            subtitle={new Date(event.ts*1000).toLocaleString()} />) : <ListRow title="No access yet." />}
        </ListGroup>
      </>}
    </>}
  </Screen>;
}

const useStyles = makeStyles((t) => ({
  empty: { paddingTop: t.space.xl },
  body: { ...t.type.callout, color: t.colors.textSecondary },
  hint: { ...t.type.caption, color: t.colors.textSecondary },
  alert: { ...t.type.callout, color: t.colors.textSecondary, marginTop: t.space.md },
  error: { ...t.type.callout, color: t.colors.danger },
  errorBox: { gap: t.space.sm, marginTop: t.space.md },
  loading: { gap: t.space.md, marginTop: t.space.xl },
  controls: { gap: t.space.md, paddingHorizontal: t.space.lg, paddingBottom: t.space.lg },
}));
