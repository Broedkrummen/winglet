import {gcm} from '@noble/ciphers/aes.js';
import {api,serverKey,signedApi} from '../../lib/api';
import {b64d,b64e,randomBytes,seal} from '../../lib/crypto';
import {currentPairing} from '../encrypted-push/api';
import type {Server} from '../../lib/types';
import {validateWatchGrant,wearAad,type WatchScope} from './model';
import {wearNative,type WearNative} from './native';
export type RemoteWatch={id:string;association:string;name:string;expires:number;chat_ids:string[];can_reply:boolean};
export const watchGrants=(server:Server)=>api<{links:RemoteWatch[]}>(server,'/api/wear/links');
export const revokeWatch=(server:Server,id:string)=>signedApi(server,'DELETE','/api/wear/links/'+encodeURIComponent(id));
export async function linkWatch(server:Server,scope:WatchScope,background:boolean,signal:AbortSignal,nativeClient:WearNative|null=wearNative){
  const native=nativeClient;if(!native || !server.fingerprint)throw new Error('Use the current Android app with a verified server pairing.');
  currentPairing(server,signal);
  const key=await serverKey(server.url,server.fingerprint);currentPairing(server,signal);
  if(!key)throw new Error('Update Winglet on your server first.');
  const nonce=Array.from(randomBytes(16),n=>n.toString(16).padStart(2,'0')).join('');const responseKey=randomBytes(32);
  let grant:ReturnType<typeof validateWatchGrant>|null=null;
  try{
    const reply=await signedApi<{v:number;nonce:string;ct:string}>(server,'POST','/api/wear/links',{
      sealed:seal(key,'wear-link',server.deviceId,{v:1,...scope,response_key:b64e(responseKey),nonce}),
    });
    if(reply.v!==1 || typeof reply.nonce!=='string' || typeof reply.ct!=='string' || reply.ct.length>2000)throw new Error('Invalid watch grant response.');
    const plain=gcm(responseKey,b64d(reply.nonce),wearAad(server.parent??server.id,server.deviceId,nonce)).decrypt(b64d(reply.ct));
    grant=validateWatchGrant(JSON.parse(new TextDecoder().decode(plain)),server.id);
    currentPairing(server,signal);
    await native.finish(scope.association,{url:server.url,identity:key.identity,serverId:server.id,gatewayId:server.parent??server.id,
      device:server.deviceId,token:grant.token,grantId:grant.id,expires:grant.expires,chat_ids:scope.chat_ids,background});
    currentPairing(server,signal);
  }catch(error){
    // A late response must not leave an unseen usable watch grant after setup closes.
    if(grant){await native.remove(scope.association).catch(()=>undefined);await revokeWatch(server,grant.id).catch(()=>undefined);}
    throw error;
  }finally{responseKey.fill(0);}
}
