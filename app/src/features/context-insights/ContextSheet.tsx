import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { Sheet } from '../../components/Sheet';
import { Button, Card, Footnote, ListGroup, ListRow, SectionHeader } from '../../components/ui';
import { api, ApiError, signedApi } from '../../lib/api';
import { isOwner, useApp } from '../../lib/store';
import { makeStyles, useTheme } from '../../lib/themeContext';
import type { Server } from '../../lib/types';
import { compressionRetryRequest, contextRows, contextPercent, costLabel, sourceLabel, tokenCount, type AccountView, type CompressionRequest, type ContextOperation, type ContextView } from './model';

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
  const generation=useRef(0);const pending=useRef<CompressionRequest|null>(null);
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
    const current=generation.current;const request=pending.current??={operation_id:`context-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`,revision:data.revision};
    setStarting(true);setError('');
    try{const next=await signedApi<ContextOperation>(server,'POST',`${base}/compress`,request);if(next.status!=='running'&&pending.current===request)pending.current=null;if(current===generation.current){setOperation(next);setConfirm(false);}}
    catch(e){if(pending.current===request)pending.current=compressionRetryRequest(request,e instanceof ApiError?e.status:undefined);if(current===generation.current)setError((e as Error).message);}
    finally{setStarting(false);}
  };
  const segments=data?contextRows(data.context.categories):[];const percent=data?contextPercent(data.context):null;
  return <Sheet visible={visible} title="Context and usage" onClose={onClose}><View style={{height:Math.max(180,Math.min(720,height-170))}}><ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
    {!owner?<Text style={s.note}>An owner can inspect context and provider usage.</Text>:<>
    {!online?<Text style={s.warning}>Offline. Cached values may be stale.</Text>:null}
    {error?<Text accessibilityRole="alert" style={s.error}>{error}</Text>:null}
    <Button title={loading?'Refreshing…':'Refresh context'} variant="secondary" disabled={!online||loading} onPress={()=>setRefresh(x=>x+1)}/>
    {!data&&loading?<ActivityIndicator color={t.colors.accent}/>:null}
    {data?<>
      <SectionHeader title="Current chat"/>
      <ListGroup>
        <ListRow title="Model" value={data.model||'Not reported'}/>
        <ListRow title="Provider" value={data.provider||'Not reported'}/>
        <ListRow title="Measurement" value={sourceLabel(data.context.source)}/>
        <ListRow title="Context used" value={`${tokenCount(data.context.used)} tokens`}/>
        <ListRow title="Model window" value={data.context.window?`${tokenCount(data.context.window)} tokens`:'Unknown'}/>
        {percent!==null?<ListRow title="Window used" value={`${percent.toFixed(1)}%`}/>:null}
      </ListGroup>
      <SectionHeader title="Estimated composition"/>
      {segments.length?<ListGroup>{segments.map(c=><ListRow key={c.id} title={c.label}
        value={c.share===null?'Unknown':`~${tokenCount(c.tokens)} tokens`}
        subtitle={c.share===null?undefined:`${(c.share*100).toFixed(1)}% of ${c.partial?'known estimates':'estimated context'}`}/>)}</ListGroup>
        :<Footnote>A breakdown is available when Hermes retains a resident agent.</Footnote>}
      {data.warning?<Footnote>{data.warning}</Footnote>:null}
      <SectionHeader title="Session usage"/>
      <ListGroup>
        {(['input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','reasoning_tokens','api_call_count'] as const).map(key=><ListRow key={key}
          title={({input_tokens:'Input',output_tokens:'Output',cache_read_tokens:'Cache read',cache_write_tokens:'Cache write',reasoning_tokens:'Reasoning',api_call_count:'API calls'})[key]}
          value={`${tokenCount(data.usage[key])}${key==='api_call_count'?'':' tokens'}`}/>)}
        <ListRow title="Cost" value={costLabel(data.usage.cost)}/>
      </ListGroup>
      <Footnote>Sampled {stamp(data.sampled_at)}{typing?'. Reply in progress; refresh when it finishes.':''}</Footnote>
      {data.details.toolsets.length||data.details.skills.length?<>
        <SectionHeader title="Tools and skills"/>
        <ListGroup>
          {data.details.toolsets.map(x=><ListRow key={x.name} title={x.name} value={`${tokenCount(x.tools)} tools`} subtitle={`~${tokenCount(x.tokens)} schema tokens`}/>)}
          {data.details.skills.map(x=><ListRow key={x.name} title={x.name} value={`~${tokenCount(x.index_tokens)} index tokens`}
            subtitle={x.file_tokens!==null?`~${tokenCount(x.file_tokens)} file tokens`:undefined}/>)}
        </ListGroup>
      </>:null}
      <SectionHeader title="Provider limits"/>
      {data.rate_limits.length?<ListGroup>{data.rate_limits.map(x=><ListRow key={x.label} title={x.label}
        value={`${tokenCount(x.remaining)} of ${tokenCount(x.limit)}`} subtitle={`Observed ${stamp(x.captured_at)}; resets ${stamp(x.resets_at)}`}/>)}</ListGroup>:null}
      <Footnote>Account balances and response-header limits are separate from chat context. Missing limits are unknown.</Footnote>
      <Button title={accountLoading?'Querying account…':account?'Refresh account limits':'Load account limits'} variant="secondary" onPress={()=>void loadLimits()} disabled={!online||accountLoading}/>
      {account?<>
        <ListGroup>
          <ListRow title={account.provider} value={account.kind==='credits'?'Credits and quota':'Account windows'}/>
          {account.windows.map((x,i)=><ListRow key={`${x.label}:${i}`} title={x.label} value={x.used_percent===null?'Unknown':`${x.used_percent.toFixed(1)}% used`}
            subtitle={[x.detail,x.resets_at?`Resets ${stamp(x.resets_at)}`:null].filter(Boolean).join(' · ')}/>)}
        </ListGroup>
        <Footnote>{account.reason||`Fetched ${stamp(account.fetched_at)}${account.cached?' (cached)':''}`}</Footnote>
        {account.details.map((x,i)=><Text selectable key={i} style={s.note}>{x}</Text>)}
      </>:null}
      <SectionHeader title="Compress context"/>
      <Footnote>Uses your provider and may incur usage. Readable chat and unsent drafts stay unchanged.</Footnote>
      {operation?<Card style={s.account}>
        <Text style={s.body}>{operation.status==='running'?'Hermes is processing…':operation.status==='completed'?'Context updated':operation.status==='unchanged'?'Context unchanged':operation.status==='refused'?'Request refused':'Outcome needs review'}</Text>
        <Text selectable style={s.note}>{operation.outcome}</Text>
        {operation.before&&operation.after?<Text style={s.note}>{tokenCount(operation.before.used)} → {tokenCount(operation.after.used)} tokens. Original measurement sources retained.</Text>:null}
      </Card>:null}
      {confirm?<View style={{gap:t.space.md}}><Text style={s.warning}>Compress the reviewed context?</Text><Button title="Compress now" onPress={()=>void compress()} loading={starting} disabled={!online||data.busy||typing||operation?.status==='running'}/><Button title="Keep context" variant="ghost" onPress={()=>setConfirm(false)} disabled={starting}/></View>:<Button title="Review compression" variant="secondary" onPress={()=>setConfirm(true)} disabled={!online||!data.can_compress||data.busy||typing||operation?.status==='running'}/>}
      <Button title="Open usage history" variant="ghost" onPress={()=>{onClose();router.push('/usage');}}/>
    </>:!loading&&!error?<Text style={s.note}>Refresh to inspect this chat’s model context.</Text>:null}
    </>}
  </ScrollView></View></Sheet>;
}

const useStyles=makeStyles(t=>({
  content:{gap:t.space.md,paddingBottom:t.space.xl},header:{gap:6},
  title:{...t.type.title,color:t.colors.text},label:{...t.type.caption,color:t.colors.textSecondary},
  heading:{...t.type.heading,color:t.colors.text,marginTop:10},body:{...t.type.body,color:t.colors.text},
  note:{...t.type.footnote,color:t.colors.textSecondary},metric:{gap:4,paddingVertical:10},
  number:{...t.type.display,color:t.colors.text},row:{flexDirection:'row',alignItems:'center',gap:10,minHeight:38},
  flex:{flex:1},dot:{width:8,height:8,borderRadius:4},bar:{height:12,borderRadius:6,overflow:'hidden',flexDirection:'row'},
  account:{gap:t.space.sm},
  error:{...t.type.callout,color:t.colors.danger},warning:{...t.type.callout,color:t.colors.textSecondary},
}));
