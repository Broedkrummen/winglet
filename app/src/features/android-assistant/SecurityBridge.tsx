import {useLayoutEffect} from 'react';
import {useLock} from '../../lib/appLock';
import {usePrefs} from '../../lib/prefs';
import {homeChat,useApp} from '../../lib/store';
import {assistantNative} from './native';
/** Native services receive only non-secret routing labels and the current local lock policy. */
export function AssistantSecurityBridge(){
  const locked=useLock(st=>st.locked);
  const hiddenAt=useLock(st=>st.hiddenAt);
  const prefsLoaded=usePrefs(st=>st.loaded);
  const enabled=usePrefs(st=>st.prefs.appLock);
  const ready=useApp(st=>st.ready);
  const foreground=useApp(st=>st.foreground);
  const selected=useApp(st=>st.selection.serverId);
  const chat=useApp(st=>st.selection.chatId);
  const resolvedChat=useApp(st=>{const id=st.selection.serverId;return id?homeChat(st.runtime[id]):'';});
  const servers=useApp(st=>st.servers);
  useLayoutEffect(()=>{
    if(!assistantNative)return;
    const state=useApp.getState(), server=state.servers.find(s=>s.id===selected);
    const lock=useLock.getState();
    const graceExpired=enabled && !!lock.hiddenAt && Date.now()-lock.hiddenAt>60000;
    assistantNative.security(lock.locked || graceExpired || !ready || !prefsLoaded,enabled,foreground,
      server?.id ?? '',chat ?? resolvedChat,server?.bot.title ?? 'Winglet');
  },[locked,hiddenAt,prefsLoaded,enabled,ready,foreground,selected,chat,resolvedChat,servers]);
  return null;
}

