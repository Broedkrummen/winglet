import {useEffect,useLayoutEffect} from 'react';
import {useApp} from '../../lib/store';
import {useLock} from '../../lib/appLock';
import {usePrefs} from '../../lib/prefs';
import {wearNative} from './native';
export function WearSecurityBridge(){
  const ready=useApp(s=>s.ready),foreground=useApp(s=>s.foreground);
  const pairs=useApp(s=>JSON.stringify(s.servers.filter(server=>s.runtime[server.id]?.status!=='unauthorized').map(server=>server.id+'\0'+server.deviceId).sort()));
  const loaded=usePrefs(s=>s.loaded),appLock=usePrefs(s=>s.prefs.appLock);
  const locked=useLock(s=>s.locked),hiddenAt=useLock(s=>s.hiddenAt);
  useLayoutEffect(()=>{
    if(!wearNative)return;
    const state=useLock.getState();const grace=appLock && !!state.hiddenAt && Date.now()-state.hiddenAt>60000;
    wearNative.security(state.locked||grace||!loaded||!ready,foreground,ready&&loaded?JSON.parse(pairs):[]);
  },[locked,hiddenAt,ready,loaded,appLock,foreground,pairs]);
  useEffect(()=>{if(ready && loaded)void wearNative?.retain().catch(()=>undefined);},[ready,loaded,pairs]);
  return null;
}
