import {useEffect,useMemo,useRef,useState} from 'react';
import {router} from 'expo-router';
import {Text, View} from 'react-native';
import {Sheet} from '../../components/Sheet';
import {Button, Card, Field, Footnote, SectionHeader} from '../../components/ui';
import {focusComposer} from '../../components/Composer';
import {requestFocus} from '../../lib/focus';
import {useApp, useServerState} from '../../lib/store';
import {makeStyles,useTheme} from '../../lib/themeContext';
import type {Message, Server} from '../../lib/types';
import {anchorValid, canQuote, makeAnchor, occurrences, quoteRef, MAX_QUOTE} from './model';
import {SourceSelection} from './SourceSelection';

export function QuoteSheet({server, chatId, message, visible, onClose, onBranch}: {
  server: Server; chatId: string; message: Message | null; visible: boolean; onClose: () => void; onBranch?: () => void;
}) {
  const s=useStyles();
  const t=useTheme();
  const rt=useServerState(server.id);
  const network=useApp(st=>st.network);
  const [typed,setTyped]=useState('');
  const [range,setRange]=useState<{start:number;end:number} | null>(null);
  const [match,setMatch]=useState(0);
  const [question,setQuestion]=useState('');
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [originalText]=useState(message?.text ?? '');
  const mounted=useRef(true);
  useEffect(()=>()=>{mounted.current=false;},[]);
  const matches=useMemo(()=>occurrences(message?.text ?? '',typed),[message?.text,typed]);
  const start=range?.start ?? matches[match] ?? -1;
  const end=range?.end ?? start+typed.length;
  const sourceValid=!!message && canQuote(message) && message.text===originalText;
  const supported=rt?.info?.features?.quoted_comments === true;
  const online=network && rt?.status==='online';
  const anchor=useMemo(()=>{
    if(!message || !sourceValid || start<0) return null;
    try{return makeAnchor(message,start,end);}catch{return null;}
  },[message,sourceValid,start,end]);
  const prepare=async(side:boolean)=>{
    if(!message || !anchor || busy || !supported) return;
    if(side && !online){setError('Reconnect to start a side question.');return;}
    const current=()=>useApp.getState().runtime[server.id]?.messages[chatId]?.find(m=>m.id===anchor.message_id);
    if(!anchorValid(current(),anchor)){setError('The original reply changed or is no longer loaded. Select it again.');return;}
    setBusy(true);setError('');
    try{
      const destination=side ? (await useApp.getState().createChat(server.id,'Question about a quote'))?.id : chatId;
      if(!mounted.current) return;
      if(!destination) throw new Error('Could not create a side question.');
      if(!anchorValid(current(),anchor)) throw new Error('The original reply changed. Select it again before sending.');
      const state=useApp.getState();
      if(!state.servers.some(s=>s.id===server.id)) return;
      const existing=state.drafts[`${server.id}:${destination}`] ?? '';
      const note=question.trim() || (side ? 'Can you explain this quote?' : '');
      if(note) state.setDraft(server.id,destination,existing ? existing+'\n'+note : note);
      state.setReplyTo(server.id,destination,quoteRef(anchor));
      if(side){state.select(server.id,destination);router.push(`/chat/${server.id}/${destination}`);}
      onClose();focusComposer(server.id,destination);
    }catch(e){if(mounted.current)setError((e as Error).message);}
    finally{if(mounted.current)setBusy(false);}
  };
  return <Sheet visible={visible} title="Quote" onClose={()=>{if(!busy)onClose();}} scrollable>
    <View style={s.content}>
      {!sourceValid ? <Text style={s.error}>Reply unavailable or changed. Select it again.</Text> : <>
        <Footnote>Select from the source, or paste an exact passage.</Footnote>
        <SourceSelection text={message!.text} colors={t.colors} fontFamily={t.fonts.regular}
          onSelect={(start,end)=>{
            if(end>start && end-start<=MAX_QUOTE){
              setRange({start,end});setTyped(message!.text.slice(start,end));setMatch(0);setError('');
            }
          }} />
        <Field label="Quote text" value={typed} onChangeText={text=>{setTyped(text);setRange(null);setMatch(0);setError('');}}
          multiline maxLength={MAX_QUOTE} placeholder="Exact words from the original reply" autoCorrect={false} />
        {!range && matches.length>1 ? <View style={s.matches}>
          <Text style={s.note}>Match {match+1} of {matches.length}</Text>
          <Button size="sm" variant="tonal" title="Next match" onPress={()=>setMatch(n=>(n+1)%matches.length)} />
        </View> : null}
        {typed && !anchor ? <Text style={s.error}>Choose an exact passage of up to 4,000 complete characters.</Text> : null}
        {anchor ? <Card style={s.preview}><SectionHeader title="Selected quote" right={<Text style={s.note}>{anchor.start+1}–{anchor.end}</Text>} style={{paddingTop:0,paddingHorizontal:0}}/>
          <Text selectable style={s.quote}>{anchor.text}</Text></Card> : null}
        <Field label="Your question (optional)" value={question} onChangeText={setQuestion} multiline maxLength={4000}
          placeholder="What would you like to know?" />
        <Footnote>Review in the composer before sending. Side questions include only the quote, not this conversation.</Footnote>
        {!supported ? <Text style={s.error}>Update this server to use exact quotes. Your text has not been sent.</Text> : null}
        <Button title="Use in this chat" disabled={!anchor || busy || !supported} loading={busy} onPress={()=>prepare(false)} />
        <Button title="Start a side question" variant="tonal" disabled={!anchor || busy || !supported || !online} onPress={()=>prepare(true)} />
        {onBranch ? <Button title="Branch conversation" variant="ghost" onPress={onBranch} disabled={busy || !online} /> : null}
        <Button title="Show original reply" variant="ghost" onPress={()=>{onClose();requestFocus(server.id,chatId,message!.id);}} />
      </>}
      {error ? <Text style={s.error} accessibilityLiveRegion="polite">{error}</Text> : null}
    </View>
  </Sheet>;
}
const useStyles=makeStyles(t=>({
  content:{gap:t.space.md,paddingBottom:t.space.sm},
  note:{...t.type.callout,color:t.colors.textSecondary},
  caption:{...t.type.caption,color:t.colors.accent},
  source:{height:180,padding:12,borderRadius:t.radius.md,borderWidth:1,borderColor:t.colors.border,backgroundColor:t.colors.surface,color:t.colors.text,...t.type.callout},
  matches:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:8,flexWrap:'wrap'},
  preview:{gap:t.space.sm,borderLeftWidth:3,borderLeftColor:t.colors.accent},
  quote:{...t.type.callout,color:t.colors.text},
  error:{...t.type.callout,color:t.colors.danger},
}));

