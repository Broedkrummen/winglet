import { Linking, Platform } from 'react-native';
import { api } from './api';
import type { Server } from './types';

/** Web Push only works for the server that served this web app (the service worker's origin). */
export function webPushServer(servers: Server[]): Server | undefined {
  if (Platform.OS !== 'web') return undefined;
  const origin = globalThis.location?.origin;
  return servers.find((s) => !s.parent && s.url.replace(/\/+$/, '') === origin);
}

export type PushState = 'unsupported' | 'needs-install' | 'insecure' | 'default' | 'denied' | 'granted';

export function isIOS() {
  return Platform.OS === 'web' && /iPhone|iPad|iPod/.test(globalThis.navigator?.userAgent ?? '');
}

export function isStandalone() {
  if (Platform.OS !== 'web') return true;
  const nav = globalThis.navigator as Navigator & { standalone?: boolean };
  return !!nav?.standalone || !!globalThis.matchMedia?.('(display-mode: standalone)').matches;
}

export function webPushState(): PushState {
  if (Platform.OS !== 'web') return 'unsupported';
  if (!globalThis.isSecureContext) return 'insecure';
  if (isIOS() && !isStandalone()) return 'needs-install';
  if (!('serviceWorker' in navigator) || !('PushManager' in globalThis) || !('Notification' in globalThis)) return 'unsupported';
  return Notification.permission as PushState;
}

export async function registerServiceWorker() {
  if (Platform.OS !== 'web' || !globalThis.isSecureContext || !('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    // push just stays unavailable
  }
}

function keyToBytes(base64url: string): Uint8Array {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function enableWebPush(server: Server): Promise<PushState> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission as PushState;
  const reg = await navigator.serviceWorker.ready;
  const { public_key } = await api<{ public_key: string }>(server, '/api/push/vapid');
  let sub = await reg.pushManager.getSubscription();
  const wanted = keyToBytes(public_key);
  const current = sub?.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
  if (sub && current && (current.length !== wanted.length || current.some((b, i) => b !== wanted[i]))) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wanted as BufferSource });
  }
  await api(server, '/api/push/webpush', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) });
  return 'granted';
}

export type TestPushResult = { ok: boolean; accepted: number; failed: number; expired: number };

export async function sendTestPush(server: Server): Promise<TestPushResult> {
  return api<TestPushResult>(server, '/api/push/test', { method: 'POST' });
}

/** What to tell the user after a test push. "Accepted" means the push service took it, not that it showed. */
export function describeTestPush(r: TestPushResult): string {
  if (!r.accepted && !r.failed && !r.expired) return 'No devices are set up for notifications yet.';
  const parts = [];
  if (r.accepted) parts.push(`Sent to ${r.accepted} device${r.accepted === 1 ? '' : 's'}. It should arrive in a moment.`);
  if (r.failed) parts.push(`${r.failed} couldn't be delivered (check the server logs).`);
  if (r.expired) parts.push(`${r.expired} registration${r.expired === 1 ? ' had' : 's had'} expired; turn notifications on again on that device.`);
  return parts.join(' ');
}

/** Android: notifications arrive through the free ntfy app, subscribed to this server's private topic. */
export async function enableNtfy(server: Server): Promise<{ server: string; topic: string }> {
  const res = await api<{ server: string; topic: string }>(server, '/api/push/ntfy');
  return res;
}

export async function openNtfySubscribe(ntfyServer: string, topic: string) {
  const host = ntfyServer.replace(/^https?:\/\//, '');
  const deep = `ntfy://${host}/${topic}`;
  const store = 'https://play.google.com/store/apps/details?id=io.heckel.ntfy';
  try {
    if (await Linking.canOpenURL(deep)) return Linking.openURL(deep);
  } catch {
    // fall through
  }
  return Linking.openURL(store);
}
