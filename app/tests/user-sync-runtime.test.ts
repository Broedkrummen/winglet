import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { create } from 'zustand';
import ts from 'typescript';
import * as model from '../src/features/sync/model.ts';
import * as preferences from '../src/features/sync/preferences.ts';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const defaults = { view: 'simple', botOpening: 'last', lastChatByBot: {}, voiceListenWith: 'server', voiceSpeakWith: 'server',
  theme: 'light', accent: 'iris', darkTone: 'charcoal', layout: 'bubbles', motion: 'system', transparency: 'system',
  haptics: true, sounds: true, busyMode: 'steer', appLock: true, updateCheck: true, mainBot: '', sidebar: 'auto',
  pinnedChats: [], archivedChats: [], favoriteModels: [], recentModels: [] };

function harness() {
  const cache = new Map<string, any>();
  const records = new Map<string, model.RecordState>();
  const requests: { path: string; body?: any }[] = [];
  const server = { id: 'home', deviceId: 'desktop', url: 'https://home.test', token: 'local-secret', bot: { title: 'Hermes' } };
  const useApp = create<any>((set: any) => ({ servers: [server], ready: true, foreground: true, network: true,
    selection: { serverId: 'home' }, drafts: {}, visibleChat: undefined,
    setDraft: (serverId: string, chatId: string, text: string) => set((state: any) => ({ drafts: { ...state.drafts, [`${serverId}:${chatId}`]: text } })),
  }));
  const usePrefs = create<any>((set: any) => ({ prefs: { ...defaults }, update: (patch: any) => set((state: any) => ({ prefs: { ...state.prefs, ...patch } })) }));
  const useLock = create<any>(() => ({ locked: false }));
  class ApiError extends Error { status: number; constructor(status: number) { super('stale'); this.status = status; } }
  let rejectResolution = false;
  let failStorage = false;
  let resolutionGate: (() => Promise<void>) | undefined;
  let nonce = 0;
  const transport = async (_server: unknown, path: string) => {
    requests.push({ path });
    if (path.endsWith('/members')) return { members: [] };
    if (/\/records\//.test(path)) return records.get(decodeURIComponent(path.split('/records/')[1]));
    return { records: [...records].map(([key, value]) => {
      const slash = key.indexOf('/');
      return { ...copy(value), kind: key.slice(0, slash), id: key.slice(slash + 1) };
    }), next: null };
  };
  const signed = async (_server: unknown, _method: unknown, path: string, body: any) => {
    requests.push({ path, body: copy(body) });
    if (path === '/api/user-sync' || path.endsWith('/join')) return { group_id: 'private' };
    if (!path.includes('/records/')) return {};
    if (body.resolve && resolutionGate) await resolutionGate();
    if (body.resolve && rejectResolution) throw new ApiError(409);
    const key = decodeURIComponent(path.split('/records/')[1]);
    const old = records.get(key) ?? { revision: 0, fields: {} };
    const next: model.RecordState = { revision: old.revision + 1, fields: { ...old.fields } };
    for (const [field, value] of Object.entries(body.changes)) next.fields[field] = {
      revision: next.revision, candidates: [{ ...value as model.Value, device_id: 'desktop', operation_id: body.operation_id, at: 1 }],
    };
    records.set(key, copy(next));
    return next;
  };
  const modules: Record<string, unknown> = {
    zustand: { create }, '../../lib/api': { api: transport, signedApi: signed, ApiError },
    '../../lib/cache': { cacheGetStrict: async (key: string, fallback: any) => cache.has(key) ? copy(cache.get(key)) : fallback,
      cacheSetStrict: async (key: string, value: any) => { if (failStorage) throw new Error('disk full'); cache.set(key, copy(value)); } },
    '../../lib/control': { idempotencyKey: () => `operation-${++nonce}` },
    '../../lib/appLock': { useLock }, '../../lib/prefs': { usePrefs },
    '../../lib/store': { useApp, draftKey: (s: string, c: string) => `${s}:${c}` }, './model': model, './preferences': preferences,
  };
  const exports: any = {};
  const code = ts.transpileModule(readFileSync(new URL('../src/features/sync/runtime.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { exports, require: (name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected module ${name}`);
    return modules[name];
  }, console, setTimeout, clearTimeout }, { filename: 'user-sync-runtime.js' });
  return { runtime: exports, useApp, usePrefs, useLock, cache, records, requests, server,
    rejectResolution: () => { rejectResolution = true; }, failStorage: (value: boolean) => { failStorage = value; },
    deferResolution: () => {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const wait = new Promise<void>(resolve => { release = resolve; });
      resolutionGate = async () => { entered(); await wait; };
      return { started, release };
    } };
}

function remoteField(value: model.Json, revision: number): model.RecordState['fields'][string] {
  return { revision, candidates: [{ deleted: false, value, device_id: 'phone', operation_id: `remote-${revision}`, at: 2 }] };
}

test('incoming portable settings apply without synchronizing biometric configuration or leaking pairing credentials', async () => {
  const h = harness();
  const stop = h.runtime.subscribePersonalSync();
  await h.runtime.connectPersonalSync(h.server);
  const old = h.records.get('preferences/app')!;
  h.records.set('preferences/app', { revision: old.revision + 1, fields: {
    ...old.fields, theme: remoteField('dark', old.revision + 1), appLock: remoteField(false, old.revision + 1),
  } });
  await h.runtime.refreshPersonalSync();
  assert.equal(h.usePrefs.getState().prefs.theme, 'dark');
  assert.equal(h.usePrefs.getState().prefs.appLock, true);
  assert.ok(!JSON.stringify([...h.cache.values()]).includes('local-secret'));
  assert.ok(!h.requests.some(request => request.body?.changes?.appLock));
  stop();
});

test('active draft text is deferred and a subsequent local edit retains the last actually observed field base', async () => {
  const h = harness();
  const stop = h.runtime.subscribePersonalSync();
  h.useApp.getState().setDraft('home', 'chat', 'original');
  await h.runtime.connectPersonalSync(h.server);
  const old = h.records.get('draft/home:chat')!;
  h.useApp.setState({ visibleChat: { serverId: 'home', chatId: 'chat' } });
  h.records.set('draft/home:chat', { ...old, revision: old.revision + 1,
    fields: { ...old.fields, text: remoteField('incoming remote text', old.revision + 1) } });
  await h.runtime.refreshPersonalSync();
  assert.equal(h.useApp.getState().drafts['home:chat'], 'original');
  assert.equal(h.runtime.usePersonalSync.getState().deferredDrafts, 1);
  h.useApp.getState().setDraft('home', 'chat', 'my continued typing');
  await tick();
  const mutation = h.requests.filter(request => request.body?.changes?.text).at(-1)!.body;
  assert.equal(mutation.base_fields.text, old.fields.text.revision);
  assert.notEqual(mutation.base_fields.text, old.revision + 1);
  stop();
});

test('locked and offline clients retain local changes and issue no sync requests', async () => {
  const h = harness();
  const stop = h.runtime.subscribePersonalSync();
  await h.runtime.connectPersonalSync(h.server);
  h.useLock.setState({ locked: true });
  const before = h.requests.length;
  h.usePrefs.getState().update({ theme: 'dark' });
  await tick();
  await h.runtime.refreshPersonalSync();
  assert.equal(h.requests.length, before);
  assert.equal(h.runtime.usePersonalSync.getState().pending, 1);
  assert.equal(h.runtime.usePersonalSync.getState().status, 'locked');
  h.useLock.setState({ locked: false });
  h.useApp.setState({ network: false });
  await h.runtime.refreshPersonalSync();
  assert.equal(h.requests.length, before);
  h.useApp.setState({ network: true });
  await h.runtime.refreshPersonalSync();
  assert.equal(h.runtime.usePersonalSync.getState().pending, 0);
  stop();
});

test('a definitely rejected stale resolution refreshes candidates and retains the previous choice for recovery', async () => {
  const h = harness();
  await h.runtime.connectPersonalSync(h.server);
  const old = h.records.get('preferences/app')!;
  h.records.set('preferences/app', { revision: old.revision + 1, fields: { ...old.fields,
    theme: { revision: old.revision + 1, candidates: [...remoteField('dark', 1).candidates, ...remoteField('light', 2).candidates] },
  } });
  await h.runtime.refreshPersonalSync();
  const conflict = h.runtime.usePersonalSync.getState().conflicts[0];
  h.rejectResolution();
  await h.runtime.resolvePersonalConflict(conflict, { deleted: false, value: 'dark' });
  assert.equal(h.runtime.usePersonalSync.getState().pending, 0);
  assert.match(h.runtime.usePersonalSync.getState().error, /changed before/);
  const journal = [...h.cache].find(([key]) => key.startsWith('user-sync:journal:'))![1];
  assert.equal(journal.rejectedResolutions[0].mutation.changes.theme.value, 'dark');
});

test('a failed local journal write cannot make incoming values overwrite unsaved intent', async () => {
  const h = harness();
  const stop = h.runtime.subscribePersonalSync();
  await h.runtime.connectPersonalSync(h.server);
  h.failStorage(true);
  const requests = h.requests.length;
  h.usePrefs.getState().update({ theme: 'dark' });
  await tick();
  assert.equal(h.runtime.usePersonalSync.getState().pending, 1);
  await h.runtime.applyDeferredDrafts();
  await h.runtime.refreshPersonalSync();
  assert.equal(h.requests.length, requests);
  assert.equal(h.usePrefs.getState().prefs.theme, 'dark');
  h.failStorage(false);
  await h.runtime.refreshPersonalSync();
  assert.equal(h.runtime.usePersonalSync.getState().pending, 0);
  assert.equal(h.usePrefs.getState().prefs.theme, 'dark');
  stop();
});

test('typing while a stale resolution is in flight does not strand its successor operation', async () => {
  const h = harness();
  const stop = h.runtime.subscribePersonalSync();
  await h.runtime.connectPersonalSync(h.server);
  const old = h.records.get('preferences/app')!;
  h.records.set('preferences/app', { revision: old.revision + 1, fields: { ...old.fields,
    theme: { revision: old.revision + 1, candidates: [...remoteField('dark', 1).candidates, ...remoteField('light', 2).candidates] },
  } });
  await h.runtime.refreshPersonalSync();
  const gate = h.deferResolution();
  h.rejectResolution();
  const resolution = h.runtime.resolvePersonalConflict(h.runtime.usePersonalSync.getState().conflicts[0], { deleted: false, value: 'dark' });
  await gate.started;
  h.usePrefs.getState().update({ theme: 'system' });
  await tick();
  gate.release();
  await resolution;
  assert.equal(h.runtime.usePersonalSync.getState().pending, 1);
  await h.runtime.refreshPersonalSync();
  assert.equal(h.runtime.usePersonalSync.getState().pending, 0);
  assert.equal(h.usePrefs.getState().prefs.theme, 'system');
  stop();
});

test('canonical preference comparisons ignore source metadata and map insertion order', () => {
  assert.deepEqual(preferences.changedValues({
    lastChatByBot: { deleted: false, value: { z: 'last', a: 'first' }, device_id: 'phone' } as any,
  }, { lastChatByBot: { deleted: false, value: { a: 'first', z: 'last' } } }), {});
});

test('disconnect stops this session even when its durable configuration cannot be cleared', async () => {
  const h = harness();
  const stop = h.runtime.subscribePersonalSync();
  await h.runtime.connectPersonalSync(h.server);
  h.failStorage(true);
  const before = h.requests.length;
  await assert.rejects(h.runtime.disconnectPersonalSync(), /stopped for this session/);
  h.usePrefs.getState().update({ theme: 'dark' });
  await h.runtime.refreshPersonalSync();
  assert.equal(h.runtime.usePersonalSync.getState().home, undefined);
  assert.equal(h.requests.length, before);
  stop();
});
