import * as Crypto from 'expo-crypto';
import { create } from 'zustand';
import { api } from '../../lib/api';
import { useLock } from '../../lib/appLock';
import type { Server } from '../../lib/types';
import { PhonePolicy, permitted, type Grant, type PhoneRequest, type Tool } from './policy';
import { nativePhone, phoneSupported } from './native';
export type CatalogItem = { title: string; description: string; fields: string; sensitive: boolean };
export type Snapshot = { catalog: Record<Tool,CatalogItem>; grants: Grant[]; history: { ts: number; tool: string; event: string }[]; bot_scope: string; server_scope_allowed: boolean };
export const usePhone = create<{ requests: { serverId: string; request: PhoneRequest }[]; notes: Record<string,string> }>(() => ({ requests: [], notes: {} }));
const clients = new Map<string,{ policy: PhonePolicy; send: (event: object) => void }>();
const instance = Crypto.randomUUID();
let foreground = true;
export function phoneHello(server: Server, send: (event: object) => void) {
  phoneDisconnect(server.id);
  if (!phoneSupported) return;
  const policy = new PhonePolicy({
    ready: () => foreground && !useLock.getState().locked && clients.has(server.id), send,
    authority: async r => {
      const state = await api<Snapshot>(server,'/api/phone-tools');
      return permitted(state.grants,r,state.bot_scope,state.server_scope_allowed);
    },
    run: async r => {
      if (r.tool === 'phone_shared_note') return { note: (usePhone.getState().notes[server.id] ?? '').slice(0,2000) };
      const permission = await nativePhone!.permission(r.tool);
      if (!permission.granted || !foreground || useLock.getState().locked) throw new Error('permission');
      try { return await nativePhone!.execute(r.id,r.tool,r.args,r.expires_at*1000); }
      catch (cause) {
        const code=(cause as {code?:string})?.code;
        throw new Error(code==='E_PHONE_PERMISSION'?'permission':code==='E_PHONE_LOCKED'?'locked':code==='E_PHONE_EXPIRED'?'expired':'unavailable');
      }
    }, cancel: id => nativePhone?.cancel(id),
    changed: requests => usePhone.setState(s => ({ requests: [...s.requests.filter(p => p.serverId !== server.id),...requests.map(request => ({ serverId: server.id,request }))] })),
  });
  clients.set(server.id,{policy,send});
  send({type:'phone_tools.hello',instance_id:instance,unlocked:!useLock.getState().locked});
}
export function phoneEvent(serverId: string, event: any) {
  const client = clients.get(serverId);
  if (!client) return;
  if (event.type === 'phone_tool.request') client.policy.receive(event.request);
  if (event.type === 'phone_tool.execute') void client.policy.execute(event.id,event.nonce);
  if (event.type === 'phone_tool.cancel') client.policy.cancel(event.id);
  if (event.type === 'phone_tool.grants_changed') client.policy.clear();
}
export function phoneDisconnect(serverId: string) { clients.get(serverId)?.policy.clear(); clients.delete(serverId); }
export function phoneDecide(serverId: string,id: string,allow: boolean) { void clients.get(serverId)?.policy.decide(id,allow); }
export function phoneSuspend(serverId?: string) {
  for (const [id,c] of clients) if (!serverId || serverId === id) c.policy.clear();
}
export function phoneVisibility(visible: boolean) {
  foreground=visible;
  if (!visible) phoneSuspend();
  for (const c of clients.values()) c.send({type:'phone_tools.hello',instance_id:instance,unlocked:visible && !useLock.getState().locked});
}
useLock.subscribe((s,previous) => {
  if (s.locked === previous.locked) return;
  if (s.locked) phoneSuspend();
  for (const c of clients.values()) c.send({type:'phone_tools.hello',instance_id:instance,unlocked:foreground && !s.locked});
});
