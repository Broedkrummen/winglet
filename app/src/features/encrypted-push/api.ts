import {api,serverKey,signedApi} from '../../lib/api';
import {seal} from '../../lib/crypto';
import {useLock} from '../../lib/appLock';
import {useApp} from '../../lib/store';
import type {Server} from '../../lib/types';
import {pushNative} from './native';
import {syncPushRegistration,type RemotePushStatus} from './registration';
export const pushStatus=(server:Server)=>api<RemotePushStatus>(server,'/api/push/encrypted');
export function currentPairing(server:Server,signal?:AbortSignal){
  const state=useApp.getState();const current=state.servers.find(s=>s.id===server.id);
  if(signal?.aborted || !state.foreground || !state.network || useLock.getState().locked || !current ||
    current.token!==server.token || current.deviceId!==server.deviceId || current.fingerprint!==server.fingerprint)
    throw new Error('Push setup paused. Reconnect and unlock Winglet, then retry.');
}
export async function syncEncryptedPush(server:Server,signal?:AbortSignal){
  if(!pushNative || !server.fingerprint || server.parent)throw new Error('Verify this pairing in the current Android app before setting up encrypted push.');
  const native=pushNative;
  currentPairing(server,signal);
  const pinned=await serverKey(server.url,server.fingerprint);currentPairing(server,signal);
  if(!pinned)throw new Error('Update Winglet on the server first.');
  return syncPushRegistration({
    assertActive:()=>currentPairing(server,signal),status:()=>pushStatus(server),
    credentials:()=>native.credentials(server.id,server.deviceId),
    post:data=>signedApi<RemotePushStatus>(server,'POST','/api/push/encrypted',{sealed:seal(pinned,'push-key',server.deviceId,data)}),
    activate:(kid,revision)=>native.activate(server.id,server.deviceId,kid,revision),
  });
}
