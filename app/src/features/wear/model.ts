/** Length framing matches Python struct !I and Kotlin DataOutputStream. */
export function wearAad(server:string,device:string,nonce:string,purpose='link'):Uint8Array{
  const parts=['winglet.wear.'+purpose,'1',server,device,nonce].map(value=>new TextEncoder().encode(value));
  const result=new Uint8Array(parts.reduce((size,value)=>size+4+value.length,0));let at=0;
  for(const part of parts){if(part.length>4096)throw new Error('Invalid watch response context.');new DataView(result.buffer).setUint32(at,part.length);at+=4;result.set(part,at);at+=part.length;}
  return result;
}
export type WatchScope={association:string;name:string;chat_ids:string[];can_reply:boolean};
export function watchScope(association:string,name:string,chats:string[],canReply:boolean):WatchScope{
  if(!/^[a-f0-9]{32}$/.test(association) || !name.trim() || name.length>80 || /[\x00-\x1f]/.test(name) ||
    !chats.length || chats.length>12 || new Set(chats).size!==chats.length || chats.some(id=>!id || id.length>160))throw new Error('Choose a watch and one to twelve conversations.');
  return {association,name:name.trim(),chat_ids:[...chats].sort(),can_reply:canReply};
}
export function validateWatchGrant(value:unknown,serverId:string,now=Date.now()/1000){
  const data=value as {v?:unknown;id?:unknown;token?:unknown;expires?:unknown;server_id?:unknown};
  if(!data || data.v!==1 || typeof data.id!=='string' || !/^[a-f0-9]{32}$/.test(data.id) ||
    typeof data.token!=='string' || !/^wr1_[A-Za-z0-9_-]{43}$/.test(data.token) || data.server_id!==serverId ||
    typeof data.expires!=='number' || !Number.isSafeInteger(data.expires) || data.expires<=now || data.expires>now+31*86400)
    throw new Error('The server did not confirm this watch grant. Refresh and pair again.');
  return {id:data.id,token:data.token,expires:data.expires};
}
