import {useCallback,useEffect,useRef,useState} from 'react';
import {AppState,Text,View} from 'react-native';
import {useFocusEffect} from 'expo-router';
import {api,signedApi} from '../../lib/api';
import {useLock} from '../../lib/appLock';
import {useApp} from '../../lib/store';
import type {Server} from '../../lib/types';
import {describeTestPush,sendTestPush} from '../../lib/push';
import {makeStyles,useTheme} from '../../lib/themeContext';
import {Sheet} from '../../components/Sheet';
import {Button,Footnote,ListGroup,ListRow,SectionHeader,Toggle} from '../../components/ui';
import {currentPairing,pushStatus,syncEncryptedPush} from './api';
import {pushNative as defaultPushNative,type LocalPushStatus,type PushCapabilities,type PushNative} from './native';
import type {RemotePushStatus} from './registration';

const errors:Record<string,string>={
  key_lost:'The device key is unavailable. Rotate the key to repair delivery.',
  registration_failed:'The distributor could not register Winglet. Open ntfy and retry.',
  distributor_unavailable:'The push distributor is temporarily unavailable. Open ntfy, check its network and retry.',
  unregistered:'The distributor removed this registration. Repair delivery to register again.',
  notifications_blocked:'Android blocked display. Allow Winglet notifications in Android settings.',
  unsupported_endpoint:'Use an ntfy distributor that supports encrypted Web Push.',
  invalid_or_unavailable_key:'A payload could not be verified. If delivery keeps failing, rotate the key.',
  transport_decryption_failed:'The distributor could not decrypt the transport payload. Repair delivery to resync its endpoint.',
  oversized_payload:'An oversized payload was refused. Update the server before testing again.',
};
const when=(value?:number)=>value?new Date(value*1000).toLocaleString():'Not observed yet';
export function EncryptedPushSettings({server,nativeClient=defaultPushNative}:{server:Server;nativeClient?:PushNative|null}){
  const pushNative=nativeClient;
  const s=useStyles(),t=useTheme();
  const supported=useApp(st=>!!st.runtime[server.id]?.info?.features?.encrypted_push);
  const online=useApp(st=>st.network && st.runtime[server.id]?.status==='online');
  const foreground=useApp(st=>st.foreground),locked=useLock(st=>st.locked);
  const [cap,setCap]=useState<PushCapabilities|null>(null);
  const [local,setLocal]=useState<LocalPushStatus|null>(null);
  const [remote,setRemote]=useState<RemotePushStatus|null>(null);
  const [error,setError]=useState(''),[message,setMessage]=useState('');
  const [busy,setBusy]=useState(false),[choose,setChoose]=useState(false),[rotate,setRotate]=useState(false);
  const [diagnostics,setDiagnostics]=useState(false);
  const action=useRef<AbortController|null>(null),alive=useRef(false);
  const refresh=useCallback(async()=>{
    if(!pushNative)return;
    try{
      const [capability,status]=await Promise.all([pushNative.capabilities(),pushNative.status(server.id,server.deviceId)]);
      if(alive.current){setCap(capability);setLocal(status);}
      if(supported){const status=await pushStatus(server);if(alive.current)setRemote(status);}
    }catch(e){if(alive.current)setError((e as Error).message);}
  },[server,supported,pushNative]);
  useFocusEffect(useCallback(()=>{
    alive.current=true;void refresh();
    const sub=AppState.addEventListener('change',state=>{if(state==='active')void refresh();});
    return ()=>{alive.current=false;action.current?.abort();sub.remove();};
  },[refresh]));
  useEffect(()=>{if(!foreground || locked){action.current?.abort();setChoose(false);}},[foreground,locked]);
  const run=async(work:(signal:AbortSignal)=>Promise<void>)=>{
    if(action.current)return;
    const controller=new AbortController();action.current=controller;setBusy(true);setError('');setMessage('');
    try{await work(controller.signal);}
    catch(e){if(alive.current)setError((e as Error).message);}
    finally{action.current=null;if(alive.current){setBusy(false);void refresh();}}
  };
  const setup=(distributor:string)=>{
    setChoose(false);
    void run(async signal=>{
      if(!pushNative)return;const native=pushNative;
      currentPairing(server,signal);
      const permission=await native.requestPermission();currentPairing(server,signal);
      if(!permission.granted)throw new Error('Allow Winglet notifications in Android settings, then retry setup.');
      const {public_key}=await api<{public_key:string}>(server,'/api/push/vapid');currentPairing(server,signal);
      await native.prepare(server.id,server.deviceId,distributor,public_key,rotate);currentPairing(server,signal);
      if(alive.current)setMessage('Waiting for your push distributor…');
      let registered=false;
      for(let attempt=0;attempt<24;attempt++){
        currentPairing(server,signal);
        const state=await native.status(server.id,server.deviceId);currentPairing(server,signal);
        if(state.error && ['registration_failed','distributor_unavailable','unregistered','unsupported_endpoint','key_lost'].includes(state.error))
          throw new Error(errors[state.error] ?? 'The distributor could not register. Open ntfy and retry.');
        if(state.registered){registered=true;break;}
        await new Promise(resolve=>setTimeout(resolve,750));
      }
      if(!registered)throw new Error('Still waiting for the distributor. Open ntfy, keep it running and choose Repair delivery.');
      const status=await syncEncryptedPush(server,signal);currentPairing(server,signal);
      if(alive.current){setRemote(status);setMessage('Encrypted delivery registered. A test can check relay acceptance; receipt and display are shown in diagnostics.');}
    });
  };
  const active=!!local?.active && !!remote?.enrolled && local.kid===remote.kid;
  const needsRepair=!!local?.keyLost || (!!remote?.enrolled && !active) || local?.needsSync;
  const status=needsRepair?'Delivery needs repair':active?'Encrypted notifications on':!supported?'Encrypted delivery unavailable':'Encrypted notifications off';
  return <>
    <SectionHeader title={server.bot.title}/>
    <ListGroup><ListRow title={status} icon={<View style={[s.dot,{backgroundColor:needsRepair?t.colors.warning:active?t.colors.success:t.colors.textTertiary}]} />}/></ListGroup>
    {!supported?<Footnote>{online?'Update this server to enable encrypted delivery.':'Connect to check encrypted delivery support.'}</Footnote>:null}
    {cap && !cap.distributors.length?<Footnote>Install and open ntfy, enable UnifiedPush, then refresh.</Footnote>:null}
    {cap && !cap.notificationsAllowed?<Footnote>Allow Winglet notifications in Android settings.</Footnote>:null}
    {needsRepair?<Footnote>Resync this phone and server. There is no plaintext fallback.</Footnote>:null}
    {local?.error && errors[local.error]?<Text style={s.error}>{errors[local.error]}</Text>:null}
    <SectionHeader title="Delivery"/>
    <View style={s.buttons}>
      <Button title={active?'Repair delivery':'Set up encrypted delivery'} loading={busy} disabled={!supported||!online||!cap?.distributors.length||busy}
        onPress={()=>{setRotate(false);setChoose(true);}}/>
      {active?<Button title="Send a test" variant="secondary" disabled={!online||busy} onPress={()=>void run(async signal=>{
        currentPairing(server,signal);const result=await sendTestPush(server);currentPairing(server,signal);
        if(alive.current)setMessage(describeTestPush(result)+' Acceptance does not prove receipt or display.');
      })}/>:null}
    </View>
    <ListGroup style={s.group}>
      {local?.registered?<ListRow title="Show details when unlocked" right={<Toggle label="Show details when unlocked" value={!!local.previews} onValueChange={enabled=>{
        if(busy)return;void run(async signal=>{currentPairing(server,signal);await pushNative?.previews(server.id,server.deviceId,enabled);});
      }}/>}/>:null}
      <ListRow title="Details" onPress={()=>setDiagnostics(true)}/>
      <ListRow title="Refresh status" disabled={busy} onPress={()=>{setError('');void refresh();}} chevron={false}/>
    </ListGroup>
    <Footnote>Lock screen and app lock always hide message details.</Footnote>
    {local?.kid || remote?.enrolled || local?.keyLost?<>
      <SectionHeader title="Security"/>
      <ListGroup>
        <ListRow title="Rotate key" disabled={!online||busy||!cap?.distributors.length} onPress={()=>{setRotate(true);setChoose(true);}}/>
        <ListRow title="Turn off" destructive disabled={busy} chevron={false} onPress={()=>void run(async signal=>{
          await pushNative?.remove(server.id,server.deviceId);
          try{currentPairing(server,signal);await signedApi(server,'DELETE','/api/push/encrypted');if(alive.current)setMessage('Encrypted notifications are off. Plaintext fallback stays blocked.');}
          catch{throw new Error('Disabled on this phone. Reconnect and tap Turn off again to stop server delivery too.');}
        })}/>
      </ListGroup>
    </>:null}
    {message?<Text style={s.note} accessibilityLiveRegion="polite">{message}</Text>:null}
    {error?<Text style={s.error} accessibilityLiveRegion="polite">{error}</Text>:null}
    <Sheet visible={choose} onClose={()=>setChoose(false)} title={rotate?'Rotate key':'Push distributor'}>
      <ListGroup>{cap?.distributors.map(item=><ListRow key={item.id} title={item.name} value={item.id} onPress={()=>setup(item.id)}/>)}</ListGroup>
      <Footnote>{rotate?'The old local key retires immediately; delivery resumes after server confirmation.':'Only encrypted payloads pass through this distributor, never your credentials or delivery key.'}</Footnote>
    </Sheet>
    <Sheet visible={diagnostics} onClose={()=>setDiagnostics(false)} title="Delivery details" scrollable>
      <ListGroup>
        <ListRow title="Device registration" value={local?.registered?'Registered':'Not registered'}/>
        <ListRow title="Server registration" value={remote?.enrolled?'Enrolled':'Not enrolled'}/>
        <ListRow title="Relay acceptance" value={remote?.acceptance?remote.acceptance.ok?'Accepted':'Rejected':'Not observed yet'} subtitle={remote?.acceptance?when(remote.acceptance.at):undefined}/>
        <ListRow title="Received on phone" value={when(local?.received)}/>
        <ListRow title="Decrypted and authenticated" value={when(local?.decrypted)}/>
        <ListRow title="Display requested from Android" value={when(local?.displayed)}/>
        <ListRow title="Suppressed while connected in Winglet" value={when(local?.suppressed)}/>
      </ListGroup>
      <Footnote>Android may still hide a requested notification due to Focus, lock-screen or battery settings.</Footnote>
      <Footnote>Open ntfy to check connectivity and allow Winglet's notification channel before testing.</Footnote>
      <Footnote>Content stays encrypted; relay addresses, timing and payload sizes remain visible to the relay.</Footnote>
      <Footnote>Use the HTTPS ntfy relay configured on this server.</Footnote>
    </Sheet>
  </>;
}
const useStyles=makeStyles(t=>({
  dot:{width:t.space.sm,height:t.space.sm,borderRadius:t.radius.pill},group:{marginTop:t.space.md},
  note:{...t.type.footnote,color:t.colors.textSecondary,marginTop:t.space.sm},
  error:{...t.type.footnote,color:t.colors.danger,marginTop:t.space.sm},
  buttons:{flexDirection:'row',flexWrap:'wrap',gap:t.space.sm},
}));
