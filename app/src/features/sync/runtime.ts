import { create } from 'zustand';
import { api, ApiError, signedApi } from '../../lib/api';
import { cacheGetStrict, cacheSetStrict } from '../../lib/cache';
import { idempotencyKey } from '../../lib/control';
import { useLock } from '../../lib/appLock';
import { usePrefs } from '../../lib/prefs';
import { draftKey, useApp } from '../../lib/store';
import type { Server } from '../../lib/types';
import { changedValues, portablePreferences, preferencePatch } from './preferences';
import { emptyReplica, receive, recordKey, stage, SyncReplica, visibleValues, type Candidate, type Kind, type RecordState,
  type Pending, type Replica, type Value } from './model';

type Home = { serverId: string; deviceId: string; groupId: string };
type SyncPage = { records: (RecordState & { kind: Kind; id: string })[]; next: { kind: string; id: string } | null };
export type Conflict = { kind: Kind; id: string; field: string; revision: number; candidates: Candidate[] };
type SyncState = { home?: Home; status: 'off' | 'ready' | 'syncing' | 'error' | 'offline' | 'locked';
  error?: string; pending: number; conflicts: Conflict[]; deferredDrafts: number; lastSync?: number };
export const usePersonalSync = create<SyncState>(() => ({ status: 'off', pending: 0, conflicts: [], deferredDrafts: 0 }));
const CONFIG = 'user-sync:home:v1';
let replica: SyncReplica | undefined;
let home: Home | undefined;
let epoch = 0;
let applying = false;
let refreshing: Promise<void> | undefined;
let booting: Promise<void> | undefined;
const uncaptured = new Map<string, { kind: Kind; id: string; changes: Record<string, Value>; operation: string }>();
const path = (suffix = '') => `/api/user-sync/${encodeURIComponent(home!.groupId)}${suffix}`;
const journalKey = (config: Home) => `user-sync:journal:${config.serverId}:${config.deviceId}:${config.groupId}`;
const serverFor = () => useApp.getState().servers.find(s => s.id === home?.serverId && s.deviceId === home.deviceId && !s.parent);

function publish() {
  const conflicts: Conflict[] = [];
  if (replica) for (const [key, record] of Object.entries(replica.state.records)) {
    const [kind, id] = JSON.parse(key) as [Kind, string];
    for (const [field, value] of Object.entries(record.fields)) if (value.candidates.length > 1)
      conflicts.push({ kind, id, field, revision: record.revision, candidates: value.candidates });
  }
  usePersonalSync.setState({ home, conflicts, pending: replica?.state.pending.length ?? 0 });
}

function fail(error: unknown) {
  usePersonalSync.setState({ status: 'error', error: error instanceof Error ? error.message : 'Sync could not finish. Your local changes are kept.' });
}

function allowed() {
  return !!home && useApp.getState().ready && useApp.getState().foreground && useApp.getState().network && !useLock.getState().locked;
}

async function attach(config: Home) {
  const saved = await cacheGetStrict<Replica>(journalKey(config), { ...emptyReplica(), observed: {} });
  if (saved.version !== 1 || !saved.records || !Array.isArray(saved.pending) || !saved.receipts)
    throw new Error('This sync journal cannot be read. Keep it and update Winglet before reconnecting.');
  const next = new SyncReplica({ ...saved, observed: saved.observed ?? {} }, value => cacheSetStrict(journalKey(config), value), publish);
  epoch++;
  home = config;
  replica = next;
  publish();
}

export async function bootPersonalSync() {
  if (!booting) booting = (async () => {
    try {
      const config = await cacheGetStrict<Home | null>(CONFIG, null);
      if (config && !home) { await attach(config); await reconcileLocal(); }
    } catch (error) { fail(error); }
  })();
  await booting;
}

/** Enrollment is explicit; local differences are offered to the server as unobserved edits. */
export async function connectPersonalSync(server: Server, token?: string) {
  if (useLock.getState().locked) throw new Error('Unlock Winglet before linking a device.');
  if (home) throw new Error('Disconnect the current sync home before selecting another.');
  const result = await signedApi<{ group_id: string }>(server, 'POST', token ? '/api/user-sync/join' : '/api/user-sync', token ? { token } : {});
  const config: Home = { serverId: server.id, deviceId: server.deviceId, groupId: result.group_id };
  await attach(config);
  await cacheSetStrict(CONFIG, config);
  await capture('preferences', 'app', portablePreferences(usePrefs.getState().prefs));
  for (const [key, text] of Object.entries(useApp.getState().drafts)) await captureDraft(key, text);
  await refreshPersonalSync();
}

export async function disconnectPersonalSync() {
  // Retain the journal and local content for recovery; no server membership is silently deleted.
  epoch++;
  home = undefined;
  replica = undefined;
  uncaptured.clear();
  usePersonalSync.setState({ home: undefined, status: 'off', error: undefined, pending: 0, conflicts: [], deferredDrafts: 0, lastSync: undefined });
  try { await cacheSetStrict(CONFIG, null); }
  catch {
    const error = new Error('Sync stopped for this session, but the disconnection could not be saved. '
      + 'Before restarting Winglet, unlink this device from another linked device or restore local storage and disconnect again.');
    fail(error);
    throw error;
  }
}

async function capture(kind: Kind, id: string, changes: Record<string, Value>, unobserved = false) {
  const engine = replica;
  if (!engine || !Object.keys(changes).length) return;
  const key = recordKey(kind, id);
  const operation = idempotencyKey();
  changes = { ...uncaptured.get(key)?.changes, ...changes };
  uncaptured.set(key, { kind, id, changes, operation });
  await engine.edit(state => {
    const base = unobserved ? { ...state, observed: { ...state.observed, [recordKey(kind, id)]: {} } } : state;
    const next = stage(base, kind, id, operation, changes, false, true);
    return { ...next, observed: state.observed };
  });
  if (uncaptured.get(key)?.operation === operation) uncaptured.delete(key);
}

async function reconcileLocal() {
  const engine = replica;
  if (!engine) return;
  const preserve = async (kind: Kind, id: string, local: Record<string, Value>) => {
    const current = visibleValues(engine.state, kind, id);
    const changes = changedValues(current, local);
    const record = engine.state.records[recordKey(kind, id)];
    for (const field of Object.keys(changes)) if ((record?.fields[field]?.candidates.length ?? 0) > 1
      || engine.state.pending.some(p => p.kind === kind && p.id === id && field in p.mutation.changes)) delete changes[field];
    await capture(kind, id, changes, true);
  };
  await preserve('preferences', 'app', portablePreferences(usePrefs.getState().prefs));
  for (const [key, text] of Object.entries(useApp.getState().drafts)) await preserve('draft', key, { text: { deleted: false, value: text } });
}

function draftLocation(key: string) {
  const server = useApp.getState().servers.filter(s => key.startsWith(`${s.id}:`)).sort((a, b) => b.id.length - a.id.length)[0];
  return server ? { serverId: server.id, chatId: key.slice(server.id.length + 1) } : undefined;
}

async function captureDraft(key: string, text: string) {
  const location = draftLocation(key);
  if (!location) return;
  await capture('draft', key, { text: { deleted: false, value: text },
    server_id: { deleted: false, value: location.serverId }, chat_id: { deleted: false, value: location.chatId } });
}

/** Apply only values the user can actually see; an active composer keeps its current text. */
async function applyIncoming() {
  const engine = replica;
  if (!engine || !allowed()) return;
  await engine.settle();
  if (engine !== replica || engine.unsaved || uncaptured.size || !allowed()) return;
  const observations: Record<string, Record<string, number>> = {};
  let deferredDrafts = 0;
  applying = true;
  try {
    for (const [key, record] of Object.entries(engine.state.records)) {
      const [kind, id] = JSON.parse(key) as [Kind, string];
      const values: Record<string, Value> = {};
      const observed: Record<string, number> = {};
      for (const [field, value] of Object.entries(record.fields)) {
        if (value.candidates.length !== 1 || engine.state.pending.some(p => p.kind === kind && p.id === id && field in p.mutation.changes)) continue;
        values[field] = value.candidates[0];
        observed[field] = value.revision;
      }
      if (kind === 'preferences' && id === 'app') {
        const patch = preferencePatch(values);
        if (Object.keys(patch).length) usePrefs.getState().update(patch);
        observations[key] = Object.fromEntries(Object.entries(observed).filter(([field]) => field in patch));
      } else if (kind === 'draft') {
        const location = draftLocation(id);
        const text = values.text;
        if (!location || !text || text.deleted || typeof text.value !== 'string') continue;
        const state = useApp.getState();
        const active = state.visibleChat?.serverId === location.serverId && state.visibleChat.chatId === location.chatId;
        if (active && (state.drafts[id] ?? '') !== text.value) { deferredDrafts++; continue; }
        state.setDraft(location.serverId, location.chatId, text.value);
        observations[key] = observed;
      }
    }
  } finally { applying = false; }
  usePersonalSync.setState({ deferredDrafts });
  if (Object.keys(observations).length) await engine.edit(state => ({ ...state, observed: {
    ...state.observed, ...Object.fromEntries(Object.entries(observations).map(([key, fields]) => [key, { ...state.observed?.[key], ...fields }])),
  } }));
}

export function refreshPersonalSync(): Promise<void> {
  if (refreshing) return refreshing;
  const currentEpoch = epoch;
  refreshing = refresh().catch(error => { if (epoch === currentEpoch) fail(error); }).finally(() => { refreshing = undefined; });
  return refreshing;
}

async function refresh() {
  const engine = replica;
  const currentEpoch = epoch;
  if (!home || !engine) return;
  if (!allowed()) { usePersonalSync.setState({ status: useLock.getState().locked ? 'locked' : 'offline' }); return; }
  const server = serverFor();
  if (!server) throw new Error('The sync home is no longer paired with this device. Reconnect it before syncing.');
  usePersonalSync.setState({ status: 'syncing', error: undefined });
  const root = path();
  const check = () => { if (epoch !== currentEpoch || !allowed()) throw new Error('Sync paused. Your pending changes are kept.'); };
  const send = async (pending: Pending): Promise<RecordState> => {
    check();
    const recordPath = `${root}/records/${pending.kind}/${encodeURIComponent(pending.id)}`;
    try { return await signedApi<RecordState>(server, 'POST', recordPath, pending.mutation); }
    catch (error) {
      if (error instanceof ApiError && error.status === 409 && pending.mutation.resolve) {
        // A definite rejected resolution may be withdrawn; ambiguous network attempts stay frozen.
        await engine.edit(state => ({ ...state, pending: state.pending.filter(p => p.mutation.operation_id !== pending.mutation.operation_id).map(p => ({
          ...p, predecessors: Object.fromEntries(Object.entries(p.predecessors).filter(([, operation]) => operation !== pending.mutation.operation_id)),
        })),
          rejectedResolutions: [...(state.rejectedResolutions ?? []), pending] }));
        const current = await api<RecordState>(server, recordPath);
        await engine.edit(state => receive(state, pending.kind, pending.id, current));
        throw new Error('The conflict changed before your choice arrived. Refresh and choose again; your previous choice is kept in the journal.');
      }
      throw error;
    }
  };
  await engine.flush(send);
  if (uncaptured.size) {
    for (const intent of [...uncaptured.values()]) await capture(intent.kind, intent.id, intent.changes);
    await engine.flush(send);
  }
  let cursor: { kind: string; id: string } | null = null;
  for (let page = 0; page < 200; page++) {
    check();
    const query: string = cursor ? `?after_kind=${encodeURIComponent(cursor.kind)}&after_id=${encodeURIComponent(cursor.id)}` : '';
    const result: SyncPage = await api<SyncPage>(server, `${root}/records${query}`);
    check();
    await engine.edit(state => result.records.reduce((value, record) => receive(value, record.kind, record.id, record), state));
    cursor = result.next;
    if (!cursor) break;
    if (page === 199) throw new Error('The sync home has too many records to fetch at once. Your pending changes are kept.');
  }
  check();
  await applyIncoming();
  usePersonalSync.setState({ status: 'ready', lastSync: Date.now(), error: undefined });
}

export async function resolvePersonalConflict(conflict: Conflict, choice: Value) {
  const engine = replica;
  if (!engine) return;
  if (engine.state.pending.length) throw new Error('Sync your pending changes before choosing a conflict value.');
  const current = engine.state.records[recordKey(conflict.kind, conflict.id)];
  if (current?.revision !== conflict.revision) throw new Error('This conflict changed. Refresh and choose again.');
  await engine.edit(state => stage(state, conflict.kind, conflict.id, idempotencyKey(), { [conflict.field]: choice }, true));
  await refreshPersonalSync();
}

export async function invitePersonalDevice() {
  if (!allowed()) throw new Error('Open and unlock Winglet while online before inviting a device.');
  const server = serverFor();
  if (!server) throw new Error('Reconnect the sync home first.');
  return signedApi<{ token: string; expires_at: number }>(server, 'POST', path('/invite'), {});
}

export type SyncMember = { id: string; name: string; platform: string; last_seen: number };
export async function personalSyncMembers(): Promise<SyncMember[]> {
  if (!allowed()) return [];
  const server = serverFor();
  if (!server) return [];
  return (await api<{ members: SyncMember[] }>(server, path('/members'))).members;
}

export async function revokePersonalDevice(deviceId: string) {
  if (!allowed()) throw new Error('Open and unlock Winglet while online before unlinking a device.');
  const server = serverFor();
  if (!server) throw new Error('Reconnect the sync home first.');
  await signedApi(server, 'POST', path('/revoke'), { device_id: deviceId });
  if (deviceId === home?.deviceId) await disconnectPersonalSync();
}

export function subscribePersonalSync(): () => void {
  let previousPrefs = portablePreferences(usePrefs.getState().prefs);
  let previousDrafts = useApp.getState().drafts;
  const prefs = usePrefs.subscribe(state => {
    const next = portablePreferences(state.prefs);
    const changes = changedValues(previousPrefs, next);
    previousPrefs = next;
    if (!applying && home) void capture('preferences', 'app', changes).then(() => refreshPersonalSync()).catch(fail);
  });
  const app = useApp.subscribe(state => {
    const before = previousDrafts;
    previousDrafts = state.drafts;
    if (!applying && home && before !== state.drafts) for (const key of new Set([...Object.keys(before), ...Object.keys(state.drafts)])) {
      if (before[key] !== state.drafts[key]) void captureDraft(key, state.drafts[key] ?? '').then(() => refreshPersonalSync()).catch(fail);
    }
  });
  return () => { prefs(); app(); };
}

export async function applyDeferredDrafts() { try { await applyIncoming(); } catch (error) { fail(error); } }
