import {useCallback,useState} from 'react';
import {AppState,Text,View} from 'react-native';
import {useFocusEffect} from 'expo-router';
import {Screen} from '../components/Screen';
import {Button,Card,LoadError} from '../components/ui';
import {makeStyles} from '../lib/themeContext';
import {assistantNative} from '../features/android-assistant/native';
export default function AssistantSettings(){
  const s=useStyles();
  const [status,setStatus]=useState<{supported:boolean;held:boolean}|null>(null);
  const [error,setError]=useState('');
  const refresh=useCallback(async()=>{try{setStatus(await assistantNative?.capabilities() ?? {supported:false,held:false});setError('');}catch(e){setError((e as Error).message);}},[]);
  useFocusEffect(useCallback(()=>{
    void refresh();
    const sub=AppState.addEventListener('change',state=>{if(state==='active')void refresh();});
    return ()=>sub.remove();
  },[refresh]));
  return <Screen title="Android assistant" subtitle="An optional shortcut to your agents, chosen through Android.">
    <Card style={{marginTop:16,gap:14}}>
      <Text style={s.title}>{status?.held?'Winglet is your assistant':status?.supported?'Choose Winglet as your assistant':'Assistant role is unavailable'}</Text>
      <Text style={s.note}>Use your phone's assistant gesture to type a question. Winglet opens a focused panel, then lets you review the bot, conversation and any screen text before sending.</Text>
      <Text style={s.note}>Screen text is temporary and optional. Password/input fields and screenshots are excluded. Nothing is sent on invocation, and Winglet does not listen for a wake word.</Text>
      <Button title={status?.held?'Review Android assistant choice':'Choose in Android'} disabled={!status?.supported}
        onPress={async()=>{try{await assistantNative?.requestRole();}catch(e){setError((e as Error).message);}}} />
      {status?.held?<Text style={s.note}>To choose another assistant, open Android Settings → Apps → Default apps → Digital assistant.</Text>:null}
    </Card>
    {error?<LoadError message={error} onRetry={refresh}/>:null}
  </Screen>;
}
const useStyles=makeStyles(t=>({title:{...t.type.heading,color:t.colors.text},note:{...t.type.callout,color:t.colors.textSecondary}}));

