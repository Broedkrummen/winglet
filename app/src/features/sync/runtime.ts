import { create } from 'zustand';
import { api, ApiError, encodeApiComponent, signedApi } from '../../lib/api';
import { cacheGetStrict, cacheSetStrict } from '../../lib/cache';
import { idempotencyKey } from '../../lib/control';
import { useLock } from '../../lib/appLock';
import { usePrefs } from '../../lib/prefs';
import { draftKey, useApp } from '../../lib/store';
import type { DraftFile, ReplyRef, Server, Upload } from '../../lib/types';
import { materializeSyncFile, readSyncFile, stageSyncFile, stagingHoldId, validateSyncFile, type SyncFile } from './fileTransfer';
import { changedValues, portablePreferences, preferencePatch } from './preferences';
import { retireConfirmedHolds } from './localRetention';
import { emptyReplica, receive, recordKey, stage, SyncReplica, visibleValues, type Candidate, type Kind, type RecordState,
  type Json, type Pending, type Replica, type Value } from './model';

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
let bootFailure: unknown;
let incoming: Promise<void> | undefined;
const uncaptured = new Map<string, { kind: Kind; id: string; changes: Record<string, Value>; operation: string }>();
const fileCaptures = new Map<string, Promise<void>>();
const sendBarriers = new Set<string>();
const cacheKey = (record: string, slot: string) => JSON.stringify([record, slot]);
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
  bootFailure = undefined;
  replica = next;
  publish();
}

export async function bootPersonalSync() {
  if (!booting) booting = (async () => {
    try {
      const config = await cacheGetStrict<Home | null>(CONFIG, null);
      if (config && !home) {
        await attach(config);
        for (const id of Object.keys(replica?.state.deferredDrafts ?? {})) await flushDeferredDraft(id);
        await reconcileLocal();
      }
    } catch (error) { bootFailure = error; fail(error); }
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
  const local = useApp.getState();
  for (const key of new Set([...Object.keys(local.drafts), ...Object.keys(local.draftFiles ?? {}), ...Object.keys(local.replyTo ?? {})]))
    await captureDraft(key, local.drafts[key] ?? '');
  await refreshPersonalSync();
}

export async function disconnectPersonalSync() {
  // Retain the journal and local content for recovery; no server membership is silently deleted.
  epoch++;
  home = undefined;
  replica = undefined;
  bootFailure = undefined;
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

async function capture(kind: Kind, id: string, changes: Record<string, Value>, unobserved = false, frozen = false) {
  const engine = replica;
  if (!engine || !Object.keys(changes).length) return;
  if (kind === 'draft' && sendBarriers.has(id) && !frozen) {
    await engine.edit(state => ({ ...state, deferredDrafts: { ...state.deferredDrafts,
      [id]: { ...state.deferredDrafts?.[id], ...changes } } }));
    return;
  }
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

async function flushDeferredDraft(id: string) {
  const engine = replica;
  const changes = engine?.state.deferredDrafts?.[id];
  if (!engine || !changes || sendBarriers.has(id)) return;
  await capture('draft', id, changes);
  await engine.edit(state => {
    if (state.deferredDrafts?.[id] !== changes) return state;
    const deferredDrafts = { ...state.deferredDrafts };
    delete deferredDrafts[id];
    return { ...state, deferredDrafts };
  });
}

async function reconcileLocal() {
  const engine = replica;
  if (!engine) return;
  const preserve = async (kind: Kind, id: string, local: Record<string, Value>) => {
    const current = visibleValues(engine.state, kind, id);
    const changes = changedValues(current, local);
    const record = engine.state.records[recordKey(kind, id)];
    for (const field of Object.keys(changes)) if (record?.fields[field]?.candidates.some(candidate =>
      !Object.keys(changedValues({ [field]: candidate }, { [field]: changes[field] })).length)) delete changes[field];
    if (!Object.keys(changes).length) return;
    // Two durable caches can disagree after a crash. Neither proves which edit came last.
    await engine.edit(state => {
      if (state.pending.length >= 1000) throw new Error('Sync has 1,000 unsent changes. Reconnect before recovering more changes.');
      return { ...state, pending: [...state.pending, {
      kind, id, prepared: true, predecessors: {}, mutation: { operation_id: idempotencyKey(), base_revision: 0,
        base_fields: Object.fromEntries(Object.keys(changes).map(field => [field, 0])), changes,
      },
      }] };
    });
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
  const engine = replica, config = home;
  if (!location || !engine || !config) return;
  const state = useApp.getState();
  const target = state.servers.find(server => server.id === location.serverId)!;
  const files = (state.draftFiles?.[key] ?? []).filter(file => !file.autoSend);
  const manifest = files.map(file => cachedFile(key, file));
  const ready = files.every(file => file.status === 'ready') && manifest.every(Boolean);
  const reply = state.replyTo?.[key];
  const values: Record<string, Value> = { text: { deleted: false, value: text },
    server_id: { deleted: false, value: location.serverId }, chat_id: { deleted: false, value: location.chatId },
    server_fingerprint: { deleted: false, value: target.fingerprint ?? '' },
    reply: reply ? { deleted: false, value: reply as unknown as import('./model').Json } : { deleted: true },
    files_ready: { deleted: false, value: ready } };
  if (ready) values.files = { deleted: false, value: manifest as unknown as import('./model').Json };
  await capture('draft', key, changedValues(visibleValues(engine.state, 'draft', key), values));
  if (ready || !allowed()) return;
  const prior = fileCaptures.get(key) ?? Promise.resolve();
  const operation = prior.catch(() => undefined).then(async () => {
    const source = serverFor();
    if (!source || replica !== engine || home !== config || !allowed()) return;
    const check = () => {
      const currentTarget = useApp.getState().servers.find(server => server.id === target.id);
      const currentSource = serverFor();
      if (replica !== engine || home !== config || !allowed() || !currentTarget || !currentSource
        || ['url', 'token', 'deviceId', 'fingerprint', 'profile'].some(field =>
          currentTarget[field as keyof Server] !== target[field as keyof Server]
          || currentSource[field as keyof Server] !== source[field as keyof Server]))
        throw new Error('File sync paused. Your original is kept; verify the connection and retry.');
    };
    const selected = useApp.getState().draftFiles?.[key] ?? [];
    for (const file of selected.filter(item => !item.autoSend)) {
      if (file.status !== 'ready' || !file.upload) return;
      if (cachedFile(key, file)) continue;
      const shared = await stageSyncFile(source, config.groupId, target, location.chatId, file, check);
      check();
      await engine.edit(value => ({ ...value, fileCache: { ...value.fileCache,
        [cacheKey(key, file.localId)]: { homeServerId: config.serverId, groupId: config.groupId,
          sourceUploadId: file.upload!.id, manifest: shared, sourceHoldId: stagingHoldId(target, location.chatId, file) } } }));
    }
    // Read the latest composition after network awaits, not the text/files captured earlier.
    const current = useApp.getState();
    const currentFiles = (current.draftFiles?.[key] ?? []).filter(file => !file.autoSend);
    if (currentFiles.every(file => file.status === 'ready' && cachedFile(key, file))) {
      const shared = currentFiles.map(file => cachedFile(key, file)!);
      await capture('draft', key, { files: { deleted: false, value: shared as unknown as import('./model').Json },
        files_ready: { deleted: false, value: true } });
    }
  });
  fileCaptures.set(key, operation);
  try { await operation; } finally { if (fileCaptures.get(key) === operation) fileCaptures.delete(key); }
}

function cachedFile(record: string, file: DraftFile): SyncFile | undefined {
  const cached = replica?.state.fileCache?.[cacheKey(record, file.localId)];
  if (!cached || cached.homeServerId !== home?.serverId || cached.groupId !== home?.groupId
    || cached.sourceUploadId !== file.upload?.id) return undefined;
  return cached.manifest;
}

function readFiles(value?: Value): SyncFile[] | undefined {
  if (!value || value.deleted) return undefined;
  if (!Array.isArray(value.value) || value.value.length > 20) throw new Error('Invalid shared file list. Refresh before using this draft.');
  const files = value.value as unknown as SyncFile[];
  files.forEach(validateSyncFile);
  return files;
}

function readReply(value?: Value): ReplyRef | undefined {
  if (!value || value.deleted) return undefined;
  const reply = value.value as unknown as ReplyRef;
  if (!reply || typeof reply.id !== 'string' || typeof reply.text !== 'string' || !['user', 'bot', 'system'].includes(reply.role))
    throw new Error('Invalid shared reply context. Refresh before using this draft.');
  return reply;
}

/** Apply only values the user can actually see; an active composer keeps its current text. */
function applyIncoming(): Promise<void> {
  if (!incoming) incoming = applyIncomingState().finally(() => { incoming = undefined; });
  return incoming;
}

async function applyIncomingState() {
  const engine = replica;
  if (!engine || !allowed()) return;
  await engine.settle();
  if (engine !== replica || engine.unsaved || uncaptured.size || !allowed()) return;
  const config = home!;
  const source = serverFor();
  if (!source) return;
  const sameEndpoint = (current: Server | undefined, original: Server) => current &&
    ['url', 'token', 'deviceId', 'fingerprint', 'profile'].every(key => current[key as keyof Server] === original[key as keyof Server]);
  const check = () => {
    if (engine !== replica || home !== config || !allowed() || !sameEndpoint(serverFor(), source))
      throw new Error('File sync paused. Your current draft is kept.');
  };
  let deferredDrafts = 0;
  const observe = async (key: string, fields: Record<string, number>) => engine.edit(state => ({ ...state,
    observed: { ...state.observed, [key]: { ...state.observed?.[key], ...fields } } }));
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
        applying = true;
        try { if (Object.keys(patch).length) usePrefs.getState().update(patch); }
        finally { applying = false; }
        await observe(key, Object.fromEntries(Object.entries(observed).filter(([field]) => field in patch)));
      } else if (kind === 'draft') {
        const location = draftLocation(id);
        const text = values.text;
        if (!location || !text || text.deleted || typeof text.value !== 'string') continue;
        if (sendBarriers.has(id) || engine.state.deferredDrafts?.[id]
          || Object.values(record.fields).some(field => field.candidates.length !== 1)
          || engine.state.pending.some(p => p.kind === 'draft' && p.id === id)
          || (values.files_ready && !values.files_ready.deleted && values.files_ready.value === false)) { deferredDrafts++; continue; }
        if ((values.server_id && !values.server_id.deleted && values.server_id.value !== location.serverId)
          || (values.chat_id && !values.chat_id.deleted && values.chat_id.value !== location.chatId))
          throw new Error('The shared draft identifies a different target. Review it before continuing.');
        const state = useApp.getState();
        const target = state.servers.find(server => server.id === location.serverId)!;
        const checkTarget = () => {
          check();
          if (!sameEndpoint(useApp.getState().servers.find(server => server.id === target.id), target))
            throw new Error('The target connection changed. Your current draft is kept; verify the pairing and retry.');
        };
        const shared = readFiles(values.files);
        const expectedFingerprint = values.server_fingerprint && !values.server_fingerprint.deleted ? values.server_fingerprint.value : '';
        if (shared?.length && (!expectedFingerprint || expectedFingerprint !== target.fingerprint))
          throw new Error('Verify the matching target server before receiving its shared draft files.');
        const reply = readReply(values.reply);
        const originalFiles = state.draftFiles?.[id];
        const originalReply = state.replyTo?.[id];
        const localManifest = (originalFiles ?? []).filter(file => !file.autoSend).map(file => cachedFile(id, file) ?? `local:${file.localId}`);
        const fileDifference = shared !== undefined && JSON.stringify(localManifest) !== JSON.stringify(shared);
        const replyDifference = values.reply !== undefined && JSON.stringify(originalReply) !== JSON.stringify(reply);
        const active = state.visibleChat?.serverId === location.serverId && state.visibleChat.chatId === location.chatId;
        if (active && ((state.drafts[id] ?? '') !== text.value || fileDifference || replyDifference)) { deferredDrafts++; continue; }
        const files: DraftFile[] = [];
        if (shared && fileDifference) for (const file of shared) {
          const existing = originalFiles?.find(item => item.localId === file.slot && item.status === 'ready' && JSON.stringify(cachedFile(id, item)) === JSON.stringify(file));
          if (existing) { files.push(existing); continue; }
          const upload = await materializeSyncFile(source, config.groupId, target, location.chatId, file, checkTarget);
          checkTarget();
          await engine.edit(value => ({ ...value, fileCache: { ...value.fileCache, [cacheKey(id, file.slot)]: {
            homeServerId: config.serverId, groupId: config.groupId, manifest: file, sourceUploadId: upload.id, targetUpload: upload,
          } } }));
          files.push({ localId: file.slot, name: file.name, mime: file.mime, kind: file.kind, size: file.size,
            progress: 1, status: 'ready', upload });
        }
        await engine.settle();
        checkTarget();
        const latest = useApp.getState();
        if ((latest.drafts[id] ?? '') !== (state.drafts[id] ?? '') || latest.draftFiles?.[id] !== originalFiles
          || latest.replyTo?.[id] !== originalReply || engine.state.records[key]?.revision !== record.revision
          || engine.state.pending.some(p => p.kind === 'draft' && p.id === id)
          || (((state.drafts[id] ?? '') !== text.value || fileDifference || replyDifference)
            && latest.visibleChat?.serverId === location.serverId && latest.visibleChat.chatId === location.chatId)) {
          deferredDrafts++; continue;
        }
        applying = true;
        try {
          latest.setDraft(location.serverId, location.chatId, text.value);
          if (shared && fileDifference) latest.updateDraftFiles(location.serverId, location.chatId, () => files);
          if (values.reply !== undefined && replyDifference) latest.setReplyTo(location.serverId, location.chatId, reply);
        } finally { applying = false; }
        await observe(key, observed);
      }
  }
  usePersonalSync.setState({ deferredDrafts });
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
  for (const id of Object.keys(engine.state.deferredDrafts ?? {})) await flushDeferredDraft(id);
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
  await settleConfirmedClaims();
  await applyIncoming();
  usePersonalSync.setState({ status: 'ready', lastSync: Date.now(), error: undefined });
}

/** Freeze one explicit Send; newer typing is journaled separately until the claim is bound. */
export async function prepareSyncedDraft(serverId: string, chatId: string, text: string, prefix: string,
  files: DraftFile[], reply?: ReplyRef): Promise<{ clientId: string; attachments: Upload[] } | undefined> {
  const id = draftKey(serverId, chatId);
  if (sendBarriers.has(id)) throw new Error('This draft is already being prepared. Your changes are kept.');
  sendBarriers.add(id);
  try {
    await bootPersonalSync();
    if (bootFailure) throw new Error('Your sync configuration could not be verified. Your draft is kept; restore local storage before sending.');
    if (!home || !replica) return undefined;
    const engine = replica, config = home, source = serverFor();
    const target = useApp.getState().servers.find(server => server.id === serverId);
    const check = () => {
      if (!source || !target || home !== config || replica !== engine || !allowed())
        throw new Error('Reconnect and unlock your sync home before sending this shared draft. Your composition is kept.');
      const currentTarget = useApp.getState().servers.find(server => server.id === target.id);
      const currentSource = serverFor();
      if (!currentTarget || !currentSource || ['url', 'token', 'deviceId', 'fingerprint', 'profile'].some(key =>
        currentTarget[key as keyof Server] !== target[key as keyof Server] || currentSource[key as keyof Server] !== source[key as keyof Server]))
        throw new Error('A paired endpoint changed while preparing this draft. Review the connection and send again.');
    };
    check();
    if (files.length && (!source!.fingerprint || !target!.fingerprint))
      throw new Error('Verify the sync home and target server before sharing attached files. Your original files are kept.');
    await fileCaptures.get(id)?.catch(() => undefined);
    const manifest: SyncFile[] = [];
    const attachments: (Upload & { hold_id: string })[] = [];
    const sourceHolds: string[] = [];
    for (const file of files) {
      if (file.status !== 'ready' || !file.upload || file.autoSend) throw new Error('Finish or remove the pending attachment before sending.');
      let shared = cachedFile(id, file);
      if (!shared) {
        shared = await stageSyncFile(source!, config.groupId, target!, chatId, file, check);
        check();
        await engine.edit(state => ({ ...state, fileCache: { ...state.fileCache, [cacheKey(id, file.localId)]: {
          homeServerId: config.serverId, groupId: config.groupId, sourceUploadId: file.upload!.id,
          manifest: shared!, sourceHoldId: stagingHoldId(target!, chatId, file),
        } } }));
      }
      const upload = await materializeSyncFile(source!, config.groupId, target!, chatId, shared, check);
      check();
      manifest.push(shared);
      attachments.push(upload);
      const old = engine.state.fileCache?.[cacheKey(id, file.localId)];
      if (old?.sourceHoldId) sourceHolds.push(old.sourceHoldId);
      await engine.edit(state => ({ ...state, fileCache: { ...state.fileCache, [cacheKey(id, file.localId)]: {
        ...state.fileCache![cacheKey(id, file.localId)], targetUpload: upload,
      } } }));
    }
    const frozen: Record<string, Value> = {
      text: { deleted: false, value: text }, send_prefix: { deleted: false, value: prefix },
      server_id: { deleted: false, value: serverId }, chat_id: { deleted: false, value: chatId },
      server_fingerprint: { deleted: false, value: target!.fingerprint ?? '' },
      files: { deleted: false, value: manifest as unknown as Json }, files_ready: { deleted: false, value: true },
      reply: reply ? { deleted: false, value: reply as unknown as Json } : { deleted: true },
    };
    const changes = changedValues(visibleValues(engine.state, 'draft', id), frozen);
    if (!engine.state.records[recordKey('draft', id)]?.fields.generation) changes.files_ready = frozen.files_ready;
    await capture('draft', id, changes, false, true);
    for (let attempt = 0; attempt < 3; attempt++) {
      await refreshPersonalSync();
      check();
      if (usePersonalSync.getState().status === 'error') throw new Error(usePersonalSync.getState().error);
      if (engine.state.pending.length || uncaptured.size) continue;
      const record = engine.state.records[recordKey('draft', id)];
      if (!record || Object.values(record.fields).some(field => field.candidates.length !== 1))
        throw new Error('Choose the conflicting draft values in Settings → Sync before sending. Your draft is kept.');
      if (Object.keys(changedValues(visibleValues(engine.state, 'draft', id), frozen)).length)
        throw new Error('The shared draft changed before it could be claimed. Review it and send again.');
      try {
        const claim = await signedApi<{ submission_id: string; revision: number }>(source!, 'POST',
          path(`/drafts/${encodeApiComponent(id)}/submit`), { expected_revision: record.revision });
        check();
        if (typeof claim.submission_id !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(claim.submission_id) || claim.revision !== record.revision)
          throw new Error('The sync home did not confirm this exact draft revision. Your composition is kept.');
        await engine.edit(state => ({ ...state, claims: { ...state.claims, [claim.submission_id]: {
          recordId: id, serverId, chatId, fingerprint: target!.fingerprint ?? '', manifest, attachments, sourceHolds,
        } } }));
        return { clientId: claim.submission_id, attachments };
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409) throw error;
        const latest = await api<RecordState>(source!, path(`/records/draft/${encodeApiComponent(id)}`));
        await engine.edit(state => receive(state, 'draft', id, latest));
      }
    }
    throw new Error('The shared draft could not be verified yet. Your composition is kept; reconnect and retry.');
  } finally {
    sendBarriers.delete(id);
    await flushDeferredDraft(id);
  }
}

async function settleConfirmedClaims() {
  const engine = replica, config = home, source = serverFor();
  if (!engine || !config || !source || !allowed()) return;
  for (const [clientId, claim] of Object.entries(engine.state.claims ?? {})) {
    if (claim.localFilesRetired) continue;
    const state = useApp.getState();
    const target = state.servers.find(server => server.id === claim.serverId);
    const message = state.runtime?.[claim.serverId]?.messages?.[claim.chatId]?.find(item => item.role === 'user'
      && item.meta?.client_id === clientId && item.id !== clientId && item.status === 'final');
    if (!target || (!claim.settled && !message) || (target.fingerprint ?? '') !== claim.fingerprint) continue;
    if (engine !== replica || home !== config || !allowed()) return;
    if (!claim.settled) {
      await signedApi(source, 'POST', path(`/drafts/${encodeApiComponent(claim.recordId)}/submissions/${encodeApiComponent(clientId)}/delivered`),
        { server_id: claim.serverId, chat_id: claim.chatId, message_id: message!.id, client_id: clientId });
      await engine.edit(value => ({ ...value, claims: { ...value.claims, [clientId]: { ...claim, settled: true } } }));
    }
    if (engine !== replica || home !== config || !allowed()) return;
    const retired = await retireConfirmedHolds(target, claim.chatId, new Set([...claim.sourceHolds, ...claim.attachments.map(file => file.hold_id)]));
    if (retired) await engine.edit(value => ({ ...value, claims: { ...value.claims,
      [clientId]: { ...value.claims![clientId], localFilesRetired: true } } }));
  }
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

export type SharedSubmission = { id: string; record_id: string; created_at: number; server_id: string; chat_id: string;
  preview: string; files: SyncFile[]; delivery_confirmed: boolean; files_released: boolean };
export async function personalSubmissions(after?: string): Promise<{ submissions: SharedSubmission[]; next: string | null }> {
  const config = home, engine = replica, server = serverFor();
  if (!config || !engine || !server || !allowed()) throw new Error('Reconnect and unlock your sync home before reviewing retained submissions.');
  const result = await api<{ submissions: SharedSubmission[]; next: string | null }>(server,
    path(`/submissions${after ? `?after=${encodeApiComponent(after)}` : ''}`));
  if (home !== config || replica !== engine || serverFor() !== server || !allowed())
    throw new Error('Your sync connection changed. Refresh before reviewing submissions.');
  return result;
}

export async function releaseSharedSubmissionFiles(submission: SharedSubmission) {
  const config = home, engine = replica, server = serverFor();
  if (!config || !engine || !server || !allowed()) throw new Error('Reconnect and unlock your sync home before releasing shared retention.');
  await signedApi(server, 'POST', path(`/drafts/${encodeApiComponent(submission.record_id)}/submissions/${encodeApiComponent(submission.id)}/release-files`),
    { confirmation: 'release-retained-files-without-confirmed-delivery' });
  // Only home pins are released. Local draft/outbox files and the submission ID stay intact.
}

export async function sharedSubmissionFile(file: SyncFile): Promise<Uint8Array> {
  const config = home, engine = replica, server = serverFor();
  const check = () => {
    if (!config || !engine || !server || home !== config || replica !== engine || serverFor() !== server || !allowed())
      throw new Error('Reconnect and unlock the same sync home before downloading this file.');
  };
  check();
  return readSyncFile(server!, config!.groupId, file, check);
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
  let previousFiles = useApp.getState().draftFiles;
  let previousReplies = useApp.getState().replyTo;
  const prefs = usePrefs.subscribe(state => {
    const next = portablePreferences(state.prefs);
    const changes = changedValues(previousPrefs, next);
    previousPrefs = next;
    if (!applying && home) void capture('preferences', 'app', changes).then(() => refreshPersonalSync()).catch(fail);
  });
  const app = useApp.subscribe(state => {
    const before = previousDrafts;
    const beforeFiles = previousFiles, beforeReplies = previousReplies;
    previousDrafts = state.drafts;
    previousFiles = state.draftFiles;
    previousReplies = state.replyTo;
    if (!applying && home && (before !== state.drafts || beforeFiles !== state.draftFiles || beforeReplies !== state.replyTo))
      for (const key of new Set([...Object.keys(before), ...Object.keys(state.drafts), ...Object.keys(beforeFiles ?? {}),
        ...Object.keys(state.draftFiles ?? {}), ...Object.keys(beforeReplies ?? {}), ...Object.keys(state.replyTo ?? {})])) {
      if (before[key] !== state.drafts[key] || beforeFiles?.[key] !== state.draftFiles?.[key] || beforeReplies?.[key] !== state.replyTo?.[key])
        void captureDraft(key, state.drafts[key] ?? '').then(() => refreshPersonalSync()).catch(fail);
    }
  });
  return () => { prefs(); app(); };
}

export async function applyDeferredDrafts() { try { await applyIncoming(); } catch (error) { fail(error); } }
