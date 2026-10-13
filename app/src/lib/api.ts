import { Platform } from 'react-native';
import { fetch } from 'expo/fetch';
import { addressConfirmed, checkServerKey, newSigningKey, seal, signedHeaders, type ServerKeyInfo } from './crypto';
import { getItem, setItem } from './storage';
import type { Bot, Server } from './types';
import { NEEDS_VERIFY, useVerify } from './verify';

export class ApiError extends Error {
  constructor(message: string, public status: number, public data?: any) {
    super(message);
  }
}

export function normalizeUrl(input: string): string {
  let url = input.trim();
  if (!url) return url;
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/+$/, '');
}

export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Pull `{url, code, fp}` out of a pairing link like `https://box.ts.net/#pair=ABCD2345&fp=…`. The
 * fingerprint is the server key's: with it, the phone can tell it's really talking to that server. */
export function parsePairLink(text: string): { url: string; code: string; fp?: string } | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^(https?:\/\/[^\s#?]+?)\/?(?:\?[^#]*)?#pair=([A-Za-z0-9-]+)(?:&fp=([A-Za-z0-9_-]{16,64}))?/);
  if (!match) return null;
  return { url: normalizeUrl(match[1]), code: normalizeCode(match[2]), ...(match[3] ? { fp: match[3] } : {}) };
}

async function request<T>(url: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init.body) headers['Content-Type'] = 'application/json';
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  let resp: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    resp = await fetch(url, { ...init, signal: init.signal ?? controller.signal, redirect: 'error',
      headers: { ...headers, ...(init.headers as Record<string, string>) } });
  } catch {
    clearTimeout(timer);
    throw new ApiError("Can't reach your Hermes server. Check that the gateway is running and the address is accessible from your phone. If you use Tailscale, connect it on this phone.", 0);
  }
  let data: any = null;
  try {
    data = await resp.json();
  } catch {
    // non-JSON body
  } finally { clearTimeout(timer); }
  if (!resp.ok) throw new ApiError(data?.error || `Server returned ${resp.status}`, resp.status, data);
  return data as T;
}

/** A path for this bot: another bot on the same server is picked with `bot=` (inside the signed path). */
export function botPath(server: Server, path: string): string {
  if (!server.profile) return path;
  return `${path}${path.includes('?') ? '&' : '?'}bot=${encodeURIComponent(server.profile)}`;
}

export function api<T>(server: Server, path: string, init: RequestInit = {}): Promise<T> {
  return request<T>(`${server.url}${botPath(server, path)}`, { ...init, token: server.token });
}

export async function fetchInfo(url: string): Promise<{ server_id: string; bot: Bot; version: string }> {
  const info = await request<any>(`${url}/api/info`);
  if (info?.app !== 'winglet') throw new ApiError("That address answered, but it isn't a Winglet server.", 0);
  return info;
}

/** The server's public keys, checked against the pairing code's fingerprint (or the one pinned at
 * pairing). Null from a server too old to have keys, which is only acceptable without a fingerprint. */
export async function serverKey(base: string, fp?: string): Promise<ServerKeyInfo | null> {
  let info: ServerKeyInfo;
  try {
    info = await request<ServerKeyInfo>(`${base}/api/server-key`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404 && !fp) return null;
    if (e instanceof ApiError && e.status === 404) {
      throw new ApiError("This pairing code expects a newer Winglet on the server than the one that answered. Don't continue on this network; update the server and pair again.", 0);
    }
    throw e;
  }
  checkServerKey(info, fp);
  return info;
}

const signKeyName = (serverId: string) => `winglet.sign.${serverId}`;
/** A server's other bots sign with the server's key: it's one pairing. */
const keyOf = (server: Pick<Server, 'id' | 'parent'>) => signKeyName(server.parent ?? server.id);

export async function pair(url: string, code: string, deviceName: string, fp?: string): Promise<Server> {
  const base = normalizeUrl(url);
  await fetchInfo(base);
  const key = await serverKey(base, fp);
  const details = { code: normalizeCode(code), device_name: deviceName, platform: Platform.OS };
  let body: object = details;
  let signing: { secret: string; public: string } | undefined;
  if (key) {
    // Sealed to the server's key, with this phone's signing key inside: nobody in between can swap it.
    signing = newSigningKey();
    body = { sealed: seal(key, 'pair', '', { ...details, sign_key: signing.public, pinned: !!fp }) };
  }
  const data = await request<any>(`${base}/api/pair`, { method: 'POST', body: JSON.stringify(body) });
  if (signing) await setItem(signKeyName(data.server_id), signing.secret);
  return { id: data.server_id, url: base, token: data.token, deviceId: data.device.id, bot: data.bot,
    addedAt: Date.now(), ...(key ? { fingerprint: key.fingerprint, wsAuth: true } : {}),
    ...(Platform.OS === 'android' && data.recovery ? { recovery: data.recovery } : {}) };
}

/** Verify a phone that was paired without a fingerprint: it scans a fresh code from the server (or
 * another owner's phone) and registers a signing key. Returns the server with the pinned fingerprint. */
export async function verifyDevice(server: Server, code: string, fp: string): Promise<Server> {
  if (server.fingerprint && server.fingerprint !== fp) {
    throw new ApiError("This code is for a different server key than the one this phone paired with. Don't continue on this network; pair again from the server.", 0);
  }
  const key = await serverKey(server.url, fp);
  if (!key) throw new ApiError('Update Winglet on the server first.', 0);
  const signing = newSigningKey();
  await api(server, '/api/devices/verify', {
    method: 'POST',
    body: JSON.stringify({ sealed: seal(key, 'verify', server.deviceId, { code: normalizeCode(code), sign_key: signing.public, pinned: true }) }),
  });
  await setItem(keyOf(server), signing.secret);
  return { ...server, fingerprint: key.fingerprint };
}

/**
 * Point this phone at another address of the same server. The token goes there only after the server's
 * pinned identity key has signed that this exact address is its own. Proving the server is reachable
 * through an address isn't enough: a relay can forward any question to the real server.
 */
export async function moveServer(server: Server, url: string): Promise<Server> {
  if (!server.fingerprint) {
    throw new ApiError("Verify this phone first: scan a new pairing code from your server or another owner's phone.", 0);
  }
  const info = await fetchInfo(url);
  if (info.server_id !== server.id) throw new ApiError(`That address is a different Winglet server, not ${server.bot.title}.`, 0);
  const key = await serverKey(url, server.fingerprint);
  if (!key) throw new ApiError('Update Winglet on the server first.', 0);
  const answer = await request<{ statement?: string; sig?: string }>(`${url}/api/address-check?url=${encodeURIComponent(url)}`).catch(() => null);
  if (!answer || !addressConfirmed(key, answer, server.id, url)) {
    throw new ApiError(`${server.bot.title} doesn't list that address as its own. Set it on the server first ` +
      '(hermes winglet setup --public-url …, then restart), or use the automatic HTTPS address.', 0);
  }
  const moved = { ...server, url };
  const me = await api<{ server_id: string; device: { id: string } }>(moved, '/api/me');
  if (me.server_id !== server.id || me.device.id !== server.deviceId) throw new ApiError("That address didn't recognise this phone.", 0);
  return moved;
}

/** Whether this phone holds the key it signs owner actions with for this server. */
export async function hasSigningKey(server: Pick<Server, 'id' | 'parent'>): Promise<boolean> {
  return !!(await getItem(keyOf(server)).catch(() => null));
}

/** The phone can't sign for this server (never verified, or its key was lost): offer to verify it. */
function needsVerify(server: Server, status: number, data?: any): ApiError {
  useVerify.getState().ask(server.id);
  return new ApiError(NEEDS_VERIFY, status, { ...data, needs: 'verify' });
}

/** An owner action: signed with this phone's key, so a leaked token alone can't do it. */
export async function signedApi<T>(server: Server, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, data?: unknown): Promise<T> {
  const secret = await getItem(keyOf(server));
  if (!secret) throw needsVerify(server, 403);
  const body = data === undefined ? '' : JSON.stringify(data);
  const full = botPath(server, path);
  try {
    return await request<T>(`${server.url}${full}`, {
      method, ...(body ? { body } : {}), token: server.token,
      headers: signedHeaders(secret, server.deviceId, method, full, body),
    });
  } catch (e) {
    if (e instanceof ApiError && e.data?.needs === 'verify') throw needsVerify(server, e.status, e.data);
    throw e;
  }
}

/** The socket URL. Current servers take the token in the first frame instead, so it isn't in a URL. */
export function wsUrl(server: Server): string {
  const base = botPath(server, `${server.url.replace(/^http/, 'ws')}/api/ws`);
  return server.wsAuth ? base : `${base}${base.includes('?') ? '&' : '?'}token=${encodeURIComponent(server.token)}`;
}

export function mediaUrl(server: Server, path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  // Current servers sign each media link; only older links need the device token.
  if (/[?&]sig=/.test(path)) return `${server.url}${path}`;
  const sep = path.includes('?') ? '&' : '?';
  return `${server.url}${path}${sep}token=${encodeURIComponent(server.token)}`;
}

export function defaultDeviceName(): string {
  if (Platform.OS === 'web') {
    const ua = globalThis.navigator?.userAgent ?? '';
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return 'Android browser';
    if (/Mac/.test(ua)) return 'Mac';
    if (/Windows/.test(ua)) return 'Windows PC';
    return 'Browser';
  }
  return Platform.OS === 'android' ? 'Android phone' : 'iPhone';
}
