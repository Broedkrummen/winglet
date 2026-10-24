import { useCallback, useEffect, useState } from 'react';
import { AppState, Platform, Switch, Text, View } from 'react-native';
import { Screen } from '../components/Screen';
import { Button, Card, Field, SectionHeader, Segmented, Skeleton } from '../components/ui';
import { api, signedApi } from '../lib/api';
import { useApp } from '../lib/store';
import { useTheme } from '../lib/themeContext';
import { nativePhone, phoneSupported } from '../features/phone-tools/native';
import { phoneSuspend, usePhone, type Snapshot } from '../features/phone-tools/runtime';
import { TOOLS, type Grant, type Tool } from '../features/phone-tools/policy';

export default function PhoneToolsScreen() {
  const t=useTheme();
  const server=useApp(s=>s.servers.find(server=>server.id===s.selection.serverId));
  const online=useApp(s=>s.runtime[s.selection.serverId ?? '']?.status==='online');
  const supported=useApp(s=>s.runtime[s.selection.serverId ?? '']?.info?.features.phone_tools===true);
  const [data,setData]=useState<Snapshot>();
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [permission,setPermission]=useState<Record<string,{granted:boolean;canAskAgain:boolean}>>({});
  const notes=usePhone(s=>s.notes);
  const refresh=useCallback(async()=>{
    if(!server || !supported || !phoneSupported) return;
    try {
      const snapshot=await api<Snapshot>(server,'/api/phone-tools');
      setData(snapshot);setError('');
      const states=await Promise.all(TOOLS.map(async tool=>[tool,await nativePhone!.permission(tool)] as const));
      setPermission(Object.fromEntries(states));
    } catch(e) { setError((e as Error).message); }
  },[server,supported]);
  useEffect(()=>{setData(undefined);void refresh();},[refresh]);
  useEffect(()=>{const sub=AppState.addEventListener('change',state=>{if(state==='active') void refresh();});return()=>sub.remove();},[refresh]);
  const mutate=async(method:'PUT'|'DELETE',body?:unknown)=>{
    if(!server || busy || !online) return;
    phoneSuspend(server.id);setBusy(true);setError('');
    try {setData(await signedApi<Snapshot>(server,method,'/api/phone-tools',body));}
    catch(e) {setError((e as Error).message);}
    finally {setBusy(false);}
  };
  const update=(tool:Tool,grant:Partial<Grant>,existing?:Grant)=>mutate('PUT',{tool,mode:existing?.mode ?? 'ask',scope:existing?.scope==='*'?'server':'bot',...grant,enabled:grant.enabled===undefined?!!existing?.enabled:!!grant.enabled});
  const repair=async(tool:Tool)=>{
    try { if(permission[tool]?.canAskAgain===false) await nativePhone!.openSettings();else await nativePhone!.requestPermission(tool);await refresh(); }
    catch {setError('Open Android app settings to repair this permission.');}
  };
  const text={...t.type.body,color:t.colors.textSecondary};
  return <Screen title="Phone tools" subtitle={server ? `Share deliberately with ${server.bot.title}` : 'Choose a paired bot first'} onRefresh={refresh}>
    {!phoneSupported ? <Card style={{marginTop:24,gap:12}}><Text style={{...t.type.title,color:t.colors.text}}>Android only</Text><Text style={text}>{Platform.OS==='android' ? 'This build does not include the phone bridge. Install a native Winglet build with Phone tools to continue.' : 'Phone tools run on a paired Android phone. This browser cannot read your device data.'}</Text><Text style={text}>Nothing is shared from this device.</Text></Card>
    : !supported ? <Card style={{marginTop:24}}><Text style={text}>This server does not offer Phone tools. Update the server and reconnect.</Text></Card>
    : <>
      {!online ? <Text accessibilityRole="alert" style={{...text,marginTop:20}}>Offline · changes need the server. No phone requests run while disconnected.</Text> : null}
      {error ? <View style={{gap:8,marginTop:16}}><Text accessibilityRole="alert" style={{...text,color:t.colors.danger}}>{error}</Text><Button title="Try again" variant="secondary" onPress={()=>void refresh()}/></View> : null}
      {!data ? <View style={{gap:16,marginTop:24}}><Skeleton height={90}/><Skeleton height={190}/></View> : <>
        <Card style={{marginTop:24,gap:12}}>
          <Text style={{...t.type.title,color:t.colors.text}}>{data.grants.some(g=>g.enabled)?'Your choices, on this phone':'Off by default'}</Text>
          <Text style={text}>Enable only what you need. Every read requires Winglet to be open and unlocked, and Android permission where needed.</Text>
          <Text style={{...t.type.caption,color:t.colors.textSecondary}}>Results are sent to this agent conversation. Recent access records the tool and outcome only.</Text>
          <Button title="Revoke all phone access" variant="danger" disabled={busy || !online} onPress={()=>void mutate('DELETE')}/>
        </Card>
        {['Everyday','Personal information'].map((group,index)=><View key={group}>
          <SectionHeader title={group}/>
          <View style={{gap:12}}>{TOOLS.filter(tool=>!!data.catalog[tool]?.sensitive===!!index).map(tool=>{
            const item=data.catalog[tool];
            const grant=data.grants.find(g=>g.tool===tool);
            const applies=grant && (grant.scope===data.bot_scope || grant.scope==='*');
            const enabled=!!grant?.enabled && !!applies;
            return <Card key={tool} style={{gap:12}}>
              <View style={{flexDirection:'row',alignItems:'center',gap:12}}><View style={{flex:1,gap:4}}><Text style={{...t.type.heading,color:t.colors.text}}>{item.title}</Text><Text style={text}>{item.description}</Text></View><Switch accessibilityLabel={`Allow ${item.title}`} value={enabled} disabled={busy || !online} onValueChange={enabled=>void update(tool,{enabled:enabled?1:0,scope:'bot'},grant)}/></View>
              <Text style={{...t.type.caption,color:t.colors.textSecondary}}>Shared fields: {item.fields}</Text>
              {enabled ? <>
                <Segmented label="When to ask" value={grant?.mode ?? 'ask'} onChange={mode=>void update(tool,{mode},grant)} options={[{value:'ask',label:'Ask each time'},{value:'while_open',label:'While open'}]}/>
                <Text style={{...t.type.caption,color:t.colors.textSecondary}}>{grant?.mode==='while_open'?'Reads may run automatically while open and unlocked. Precise location always asks.':'Each request shows its bot, chat and exact fields before you allow it.'}</Text>
                {data.server_scope_allowed ? <Segmented label="Bot scope" value={grant?.scope==='*'?'server':'bot'} onChange={scope=>void mutate('PUT',{tool,enabled:true,mode:grant?.mode ?? 'ask',scope})} options={[{value:'bot',label:'This bot'},{value:'server',label:'Every server bot'}]}/> : null}
                <Text style={{...t.type.caption,color:t.colors.textSecondary}}>{grant?.scope==='*'?'Any bot on this server, for your own phone only.':`Only ${server?.bot.title} on this server.`}</Text>
                {!permission[tool]?.granted ? <Button title={permission[tool]?.canAskAgain===false?'Open Android settings':`Allow ${item.title} in Android`} variant="secondary" onPress={()=>void repair(tool)}/> : null}
                {tool==='phone_location' && permission[tool]?.granted ? <Button title="Review approximate / precise permission" variant="ghost" onPress={()=>void repair(tool)}/> : null}
              </> : null}
              {tool==='phone_shared_note' ? <Field label="Your shared note" placeholder="Write only what you want your agent to read" multiline maxLength={2000} value={notes[server!.id] ?? ''} onChangeText={note=>usePhone.setState(s=>({notes:{...s.notes,[server!.id]:note}}))} hint="Up to 2000 characters. Held only for this app session; never saved to a new plaintext cache."/> : null}
            </Card>;
          })}</View>
        </View>)}
        <SectionHeader title="Recent access"/>
        <Card style={{gap:16}}>{data.history.length ? data.history.map((event,index)=><View key={`${event.ts}:${index}`} style={{gap:3}}><Text style={{...t.type.heading,color:t.colors.text}}>{data.catalog[event.tool as Tool]?.title ?? 'Phone tools'} · {event.event}</Text><Text style={{...t.type.caption,color:t.colors.textSecondary}}>{new Date(event.ts*1000).toLocaleString()}</Text></View>) : <Text style={text}>No access yet. Each request and outcome will appear here.</Text>}</Card>
      </>}
    </>}
  </Screen>;
}
