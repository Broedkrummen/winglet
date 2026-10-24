import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { Sheet } from '../../components/Sheet';
import { Button } from '../../components/ui';
import { api, ApiError, signedApi } from '../../lib/api';
import { isOwner, useApp } from '../../lib/store';
import { makeStyles, useTheme } from '../../lib/themeContext';
import type { Server } from '../../lib/types';
import { composition, contextPercent, costLabel, sourceLabel, tokenCount, type AccountView, type ContextOperation, type ContextView } from './model';

const stamp=(seconds?:number|null)=>seconds?new Date(seconds*1000).toLocaleString():'Unknown';

export function ContextSheet({server,chatId,visible,onClose}:{server:Server;chatId:string;visible:boolean;onClose:()=>void}){
  const s=useStyles();const t=useTheme();const {height}=useWindowDimensions();
  const online=useApp(st=>st.network&&st.runtime[server.id]?.status==='online');
  const owner=useApp(st=>isOwner(st.runtime[server.id]));
  const changed=useApp(st=>st.runtime[server.id]?.chats[chatId]?.updated_at);
  const typing=useApp(st=>!!st.runtime[server.id]?.typing[chatId]);
  const [data,setData]=useState<ContextView|null>(null);const [account,setAccount]=useState<AccountView|null>(null);
  const [operation,setOperation]=useState<ContextOperation|null>(null);const [error,setError]=useState('');
  const [loading,setLoading]=useState(false);const [accountLoading,setAccountLoading]=useState(false);
  const [refresh,setRefresh]=useState(0);const [confirm,setConfirm]=useState(false);const [starting,setStarting]=useState(false);
  const generation=useRef(0);const pending=useRef<{operation_id:string;revision:string}|null>(null);
  const base=`/api/context/chats/${encodeURIComponent(chatId)}`;
  useEffect(()=>{setData(null);setAccount(null);setOperation(null);setError('');setConfirm(false);pending.current=null;},[server.id,chatId,owner]);
  useEffect(()=>{
    const current=++generation.current;let cancelled=false;
    if(!visible||!online||!owner)return;
    const timer=setTimeout(()=>{setLoading(true);void api<ContextView>(server,base).then(next=>{
      if(!cancelled&&current===generation.current){setData(next);setOperation(next.last_operation);setAccount(null);setError('');}
    }).catch(e=>{if(!cancelled&&current===generation.current){setError((e as Error).message);if(e instanceof ApiError&&[401,403,404].includes(e.status)){setData(null);setAccount(null);setOperation(null);}}}).finally(()=>{if(!cancelled&&current===generation.current)setLoading(false);});},typing?800:100);
    return()=>{cancelled=true;clearTimeout(timer);};
  },[server,base,visible,online,owner,changed,typing,refresh]);
  useEffect(()=>{
    if(!visible||!online||!owner||operation?.status!=='running')return;
    let cancelled=false;let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{try{const next=await api<ContextOperation>(server,`${base}/operations/${encodeURIComponent(operation.operation_id)}`);if(cancelled)return;setOperation(next);if(next.status!=='running'){pending.current=null;setRefresh(x=>x+1);return;}}catch(e){if(!cancelled)setError((e as Error).message);}if(!cancelled)timer=setTimeout(poll,2000);};
    void poll();return()=>{cancelled=true;clearTimeout(timer);};
  },[visible,online,owner,server,base,operation?.operation_id,operation?.status]);
  const loadLimits=async()=>{
    if(!online||!owner||accountLoading)return;const current=generation.current;setAccountLoading(true);
    try{const next=await api<AccountView>(server,`${base}/limits`);if(current===generation.current)setAccount(next);}
    catch(e){if(current===generation.current)setError((e as Error).message);}
    finally{setAccountLoading(false);}
  };
  const compress=async()=>{
    if(!data||!online||!owner||starting||typing)return;
    const current=generation.current;pending.current??={operation_id:`context-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`,revision:data.revision};
    setStarting(true);setError('');
    try{const next=await signedApi<ContextOperation>(server,'POST',`${base}/compress`,pending.current);if(current===generation.current){setOperation(next);setConfirm(false);if(next.status!=='running')pending.current=null;}}
    catch(e){if(current===generation.current)setError((e as Error).message);}
    finally{setStarting(false);}
  };
  const segments=data?composition(data.context.categories):[];const percent=data?contextPercent(data.context):null;
  const palette=[t.colors.accent,'#4C9FBA','#A47BBB','#BD8752','#5E9D79','#AE718C'];
  return <Sheet visible={visible} title="Context and usage" onClose={onClose}><View style={{height:Math.max(180,Math.min(720,height-170))}}><ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
    {!owner?<Text style={s.note}>An owner can inspect context and provider usage.</Text>:<>
    {!online?<Text style={s.warning}>Offline. Cached numbers may be stale; controls need a live connection.</Text>:null}
    {error?<Text accessibilityRole="alert" style={s.error}>{error}</Text>:null}
    <Button title={loading?'Refreshing…':'Refresh context'} variant="secondary" disabled={!online||loading} onPress={()=>setRefresh(x=>x+1)}/>
    {!data&&loading?<ActivityIndicator color={t.colors.accent}/>:null}
    {data?<>
      <View style={s.header}><Text style={s.label}>CURRENT CHAT</Text><Text selectable style={s.title}>{data.model||'Model not reported'}</Text><Text style={s.note}>{data.provider||'Provider not reported'} · {sourceLabel(data.context.source)}</Text></View>
      <View style={s.metric}><Text style={s.number}>{tokenCount(data.context.used)}</Text><Text style={s.note}>tokens in context{data.context.window?` of ${tokenCount(data.context.window)}`:' · window unknown'}</Text>{percent!==null?<Text style={s.note}>{percent.toFixed(1)}% of this model’s reported window</Text>:null}</View>
      <Text accessibilityRole="header" style={s.heading}>Estimated composition</Text>
      {segments.length?<View accessible accessibilityLabel={segments.map(c=>`${c.label}: approximately ${tokenCount(c.tokens)} tokens`).join('; ')} style={s.bar}>{segments.map((c,i)=><View key={c.id} style={{flexGrow:c.share,flexBasis:0,backgroundColor:palette[i%palette.length]}}/>)}</View>:<Text style={s.note}>A detailed breakdown becomes available when Hermes retains a resident agent.</Text>}
      {data.context.categories.map((c,i)=><View key={c.id} style={s.row}><View style={[s.dot,{backgroundColor:palette[i%palette.length]}]}/><Text style={[s.body,s.flex]}>{c.label}</Text><Text selectable style={s.note}>~{tokenCount(c.tokens)} tokens</Text></View>)}
      <Text style={s.note}>{data.warning}</Text>
      <Text accessibilityRole="header" style={s.heading}>Session throughput and cost</Text>
      {(['input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','reasoning_tokens','api_call_count'] as const).map(key=><View key={key} style={s.row}><Text style={[s.body,s.flex]}>{({input_tokens:'Input',output_tokens:'Output',cache_read_tokens:'Cache read',cache_write_tokens:'Cache write',reasoning_tokens:'Reasoning',api_call_count:'API calls'})[key]}</Text><Text selectable style={s.note}>{tokenCount(data.usage[key])}{key==='api_call_count'?'':' tokens'}</Text></View>)}
      <Text selectable style={s.body}>{costLabel(data.usage.cost)}</Text><Text style={s.note}>Sampled {stamp(data.sampled_at)}{typing?' · A reply is running; refresh after it finishes.':''}</Text>
      {data.details.toolsets.length||data.details.skills.length?<><Text accessibilityRole="header" style={s.heading}>Tools and skills</Text>{data.details.toolsets.map(x=><Text key={x.name} selectable style={s.note}>{x.name}: ~{tokenCount(x.tokens)} schema tokens · {tokenCount(x.tools)} tools</Text>)}{data.details.skills.map(x=><Text key={x.name} selectable style={s.note}>{x.name}: ~{tokenCount(x.index_tokens)} index tokens{ x.file_tokens!==null?` · ~${tokenCount(x.file_tokens)} file tokens`:''}</Text>)}</>:null}
      <Text accessibilityRole="header" style={s.heading}>Provider limits</Text><Text style={s.note}>Response-header limits and account balances are separate from chat context. Missing limits are unknown.</Text>
      {data.rate_limits.map(x=><Text key={x.label} selectable style={s.note}>{x.label}: {tokenCount(x.remaining)} remaining of {tokenCount(x.limit)} · observed {stamp(x.captured_at)} · reset {stamp(x.resets_at)}</Text>)}
      <Button title={accountLoading?'Querying account…':account?'Refresh account limits':'Load account limits'} variant="secondary" onPress={()=>void loadLimits()} disabled={!online||accountLoading}/>
      {account?<View style={s.account}><Text style={s.body}>{account.provider} · {account.kind==='credits'?'Credits and monetary quota':'Account windows'}</Text><Text style={s.note}>{account.reason||`Fetched ${stamp(account.fetched_at)}${account.cached?' · cached':''}`}</Text>{account.windows.map((x,i)=><View key={`${x.label}:${i}`} style={{gap:4}}><Text style={s.body}>{x.label}: {x.used_percent===null?'Unknown':`${x.used_percent.toFixed(1)}% used`}</Text>{x.detail?<Text selectable style={s.note}>{x.detail}</Text>:null}{x.resets_at?<Text style={s.note}>Resets {stamp(x.resets_at)}</Text>:null}</View>)}{account.details.map((x,i)=><Text selectable key={i} style={s.note}>{x}</Text>)}</View>:null}
      <Text accessibilityRole="header" style={s.heading}>Compress model context</Text><Text style={s.note}>Hermes summarizes the model’s context using your configured provider. This may incur usage. Your readable chat and unsent draft stay available.</Text>
      {operation?<View style={s.account}><Text style={s.body}>{operation.status==='running'?'Hermes is processing…':operation.status==='completed'?'Context updated':operation.status==='unchanged'?'Context unchanged':operation.status==='refused'?'Request refused':'Outcome needs review'}</Text><Text selectable style={s.note}>{operation.outcome}</Text>{operation.before&&operation.after?<Text style={s.note}>Before {tokenCount(operation.before.used)} → after {tokenCount(operation.after.used)} tokens. Values retain their original measurement or estimate source.</Text>:null}</View>:null}
      {confirm?<View style={{gap:12}}><Text style={s.warning}>Compress the freshly reviewed context now?</Text><Button title="Compress now" onPress={()=>void compress()} loading={starting} disabled={!online||data.busy||typing||operation?.status==='running'}/><Button title="Keep context" variant="ghost" onPress={()=>setConfirm(false)} disabled={starting}/></View>:<Button title="Review compression" variant="secondary" onPress={()=>setConfirm(true)} disabled={!online||!data.can_compress||data.busy||typing||operation?.status==='running'}/>}
      <Button title="Open usage history" variant="ghost" onPress={()=>{onClose();router.push('/usage');}}/>
    </>:!loading&&!error?<Text style={s.note}>Refresh to inspect this chat’s model context.</Text>:null}
    </>}
  </ScrollView></View></Sheet>;
}

const useStyles=makeStyles(t=>({
  content:{gap:14,padding:4,paddingBottom:24},header:{gap:6},
  title:{...t.type.title,color:t.colors.text},label:{...t.type.caption,color:t.colors.textSecondary},
  heading:{...t.type.heading,color:t.colors.text,marginTop:10},body:{...t.type.body,color:t.colors.text},
  note:{...t.type.callout,color:t.colors.textSecondary},metric:{gap:4,paddingVertical:10},
  number:{...t.type.display,color:t.colors.text},row:{flexDirection:'row',alignItems:'center',gap:10,minHeight:38},
  flex:{flex:1},dot:{width:8,height:8,borderRadius:4},bar:{height:12,borderRadius:6,overflow:'hidden',flexDirection:'row'},
  account:{gap:10,padding:14,borderRadius:16,backgroundColor:t.colors.surface},
  error:{...t.type.callout,color:t.colors.danger},warning:{...t.type.callout,color:t.colors.textSecondary},
}));
