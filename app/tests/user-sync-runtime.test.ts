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

function harness(initialCache?: Map<string, any>) {
  const cache = initialCache ?? new Map<string, any>();
  const records = new Map<string, model.RecordState>();
  const requests: { path: string; body?: any }[] = [];
  const server = { id: 'home', deviceId: 'desktop', fingerprint: 'fixture-fingerprint', url: 'https://home.test', token: 'local-secret', bot: { title: 'Hermes' } };
  const useApp = create<any>((set: any) => ({ servers: [server], ready: true, foreground: true, network: true,
    selection: { serverId: 'home' }, drafts: {}, draftFiles: {}, replyTo: {}, runtime: {}, visibleChat: undefined,
    setDraft: (serverId: string, chatId: string, text: string) => set((state: any) => ({ drafts: { ...state.drafts, [`${serverId}:${chatId}`]: text } })),
    updateDraftFiles: (serverId: string, chatId: string, fn: (files: any[]) => any[]) => set((state: any) => ({ draftFiles: {
      ...state.draftFiles, [`${serverId}:${chatId}`]: fn(state.draftFiles[`${serverId}:${chatId}`] ?? []),
    } })),
    setReplyTo: (serverId: string, chatId: string, reply: any) => set((state: any) => ({ replyTo: { ...state.replyTo, [`${serverId}:${chatId}`]: reply } })),
  }));
  const usePrefs = create<any>((set: any) => ({ prefs: { ...defaults }, update: (patch: any) => set((state: any) => ({ prefs: { ...state.prefs, ...patch } })) }));
  const useLock = create<any>(() => ({ locked: false }));
  class ApiError extends Error { status: number; constructor(status: number) { super('stale'); this.status = status; } }
  let rejectResolution = false;
  let failStorage = false;
  let resolutionGate: (() => Promise<void>) | undefined;
  let claimGate: (() => Promise<void>) | undefined;
  let materializeGate: (() => Promise<void>) | undefined;
  let submissionsGate: (() => Promise<void>) | undefined;
  let invalidClaim = false;
  const transfers: any[] = [];
  let retirementResult = true;
  let retirementCalls = 0;
  let nonce = 0;
  const transport = async (_server: unknown, path: string) => {
    requests.push({ path });
    if (path.endsWith('/members')) return { members: [] };
    if (path.includes('/submissions')) {
      if (submissionsGate) await submissionsGate();
      return { submissions: [], next: null };
    }
    if (/\/records\//.test(path)) return records.get(decodeURIComponent(path.split('/records/')[1]));
    return { records: [...records].map(([key, value]) => {
      const slash = key.indexOf('/');
      return { ...copy(value), kind: key.slice(0, slash), id: key.slice(slash + 1) };
    }), next: null };
  };
  const signed = async (_server: unknown, _method: unknown, path: string, body: any) => {
    requests.push({ path, body: copy(body) });
    if (path === '/api/user-sync' || path.endsWith('/join')) return { group_id: 'private' };
    if (path.endsWith('/submit')) {
      if (claimGate) await claimGate();
      const id = decodeURIComponent(path.split('/drafts/')[1].split('/submit')[0]);
      return invalidClaim ? {} : { submission_id: 'shared-claim-id', revision: records.get(`draft/${id}`)!.revision };
    }
    if (!path.includes('/records/')) return {};
    if (body.resolve && resolutionGate) await resolutionGate();
    if (body.resolve && rejectResolution) throw new ApiError(409);
    const key = decodeURIComponent(path.split('/records/')[1]);
    const old = records.get(key) ?? { revision: 0, fields: {} };
    const next: model.RecordState = { revision: old.revision + 1, fields: { ...old.fields } };
    for (const [field, value] of Object.entries(body.changes)) next.fields[field] = {
      revision: next.revision, candidates: [{ ...value as model.Value, device_id: 'desktop', operation_id: body.operation_id, at: 1 }],
    };
    if (key.startsWith('draft/') && !next.fields.generation) next.fields.generation = {
      revision: next.revision, candidates: [{ deleted: false, value: 'generation-one', device_id: 'desktop', operation_id: body.operation_id, at: 1 }],
    };
    records.set(key, copy(next));
    return next;
  };
  const modules: Record<string, unknown> = {
    zustand: { create }, '../../lib/api': { api: transport, signedApi: signed, ApiError, encodeApiComponent: encodeURIComponent },
    './fileTransfer': {
      validateSyncFile: () => {}, stagingHoldId: () => 'source-hold',
      stageSyncFile: async (_home: any, _group: any, _target: any, _chat: any, file: any, check: () => void) => {
        check(); transfers.push({ kind: 'stage', slot: file.localId });
        return { id: 'a'.repeat(64), sha256: 'b'.repeat(64), name: file.name, mime: file.mime, kind: file.kind, size: file.size, slot: file.localId };
      },
      materializeSyncFile: async (_home: any, _group: any, _target: any, _chat: any, file: any, check: () => void) => {
        check(); transfers.push({ kind: 'materialize', slot: file.slot });
        if (materializeGate) await materializeGate();
        check();
        return { id: `target-${file.slot}`, url: '/api/media/fixture/file', name: file.name, mime: file.mime, kind: file.kind,
          size: file.size, hold_id: `target-hold-${file.slot}` };
      },
    },
    './localRetention': { retireConfirmedHolds: async () => { retirementCalls++; return retirementResult; } },
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
  const gate = (assign: (value: () => Promise<void>) => void) => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    assign(async () => { entered(); await wait; });
    return { started, release };
  };
  return { runtime: exports, useApp, usePrefs, useLock, cache, records, requests, server, transfers,
    retirementCalls: () => retirementCalls, setRetirementResult: (value: boolean) => { retirementResult = value; },
    deferClaim: () => gate(value => { claimGate = value; }),
    deferMaterialize: () => gate(value => { materializeGate = value; }), invalidClaim: () => { invalidClaim = true; },
    deferSubmissions: () => gate(value => { submissionsGate = value; }),
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

test('submission recovery refuses a listing that arrives after the home is disconnected', async () => {
  const h = harness();
  await h.runtime.connectPersonalSync(h.server);
  const gate = h.deferSubmissions();
  const listing = h.runtime.personalSubmissions();
  await gate.started;
  await h.runtime.disconnectPersonalSync();
  gate.release();
  await assert.rejects(listing, /connection changed/);
});

test('explicit shared source release uses the existing claim and cannot enqueue or cancel work', async () => {
  const h = harness();
  await h.runtime.connectPersonalSync(h.server);
  await h.runtime.releaseSharedSubmissionFiles({ id: 'claimed-id', record_id: 'home:chat' });
  const request = h.requests.at(-1)!;
  assert.ok(request.path.endsWith('/drafts/home%3Achat/submissions/claimed-id/release-files'));
  assert.equal(request.body.confirmation, 'release-retained-files-without-confirmed-delivery');
  assert.ok(!h.requests.some(item => item.path.endsWith('/messages') || item.path.endsWith('/stop')));
});

test('confirmed delivery retries local cleanup after protected files become unused without resending the receipt', async () => {
  const h = harness();
  await h.runtime.connectPersonalSync(h.server);
  await h.runtime.prepareSyncedDraft('home', 'chat', 'confirmed body', '', [{
    localId: 'file-slot', name: 'file.txt', mime: 'text/plain', kind: 'file', size: 1, status: 'ready', progress: 1,
    upload: { id: 'source-file', url: '/api/media/source-file/file.txt', name: 'file.txt', mime: 'text/plain', kind: 'file', size: 1 },
  }]);
  h.useApp.setState({ runtime: { home: { messages: { chat: [{ id: 'server-message', role: 'user', status: 'final', meta: { client_id: 'shared-claim-id' } }] } } } });
  h.setRetirementResult(false);
  await h.runtime.refreshPersonalSync();
  assert.equal(h.retirementCalls(), 1);
  h.setRetirementResult(true);
  await h.runtime.refreshPersonalSync();
  assert.equal(h.retirementCalls(), 2);
  await h.runtime.refreshPersonalSync();
  assert.equal(h.retirementCalls(), 2);
  assert.equal(h.requests.filter(request => request.path.endsWith('/delivered')).length, 1);
});

test('explicit Send freezes reply and steering prefix under the shared submission ID', async () => {
  const h = harness();
  await h.runtime.connectPersonalSync(h.server);
  const reply = { id: 'message-1', text: 'quoted', role: 'bot' };
  const result = await h.runtime.prepareSyncedDraft('home', 'chat', 'continue', '/steer ', [], reply);
  assert.equal(result.clientId, 'shared-claim-id');
  const fields = h.records.get('draft/home:chat')!.fields;
  assert.equal(fields.send_prefix.candidates[0].value, '/steer ');
  assert.equal(fields.text.candidates[0].value, 'continue');
  assert.deepEqual(fields.reply.candidates[0].value, reply);
  assert.ok(!h.requests.some(request => request.path.endsWith('/messages')));
});

test('typing during a shared claim is kept behind the frozen submission and replayed afterward', async () => {
  const h = harness();
  const stop = h.runtime.subscribePersonalSync();
  h.useApp.getState().setDraft('home', 'chat', 'original');
  await h.runtime.connectPersonalSync(h.server);
  const gate = h.deferClaim();
  const preparation = h.runtime.prepareSyncedDraft('home', 'chat', 'original', '', []);
  await gate.started;
  h.useApp.getState().setDraft('home', 'chat', 'next thought');
  await tick();
  assert.equal(h.records.get('draft/home:chat')!.fields.text.candidates[0].value, 'original');
  const journal = [...h.cache].find(([key]) => key.startsWith('user-sync:journal:'))![1];
  assert.equal(journal.deferredDrafts['home:chat'].text.value, 'next thought');
  gate.release();
  assert.equal((await preparation).clientId, 'shared-claim-id');
  await h.runtime.refreshPersonalSync();
  assert.equal(h.records.get('draft/home:chat')!.fields.text.candidates[0].value, 'next thought');
  assert.equal(h.useApp.getState().drafts['home:chat'], 'next thought');
  stop();
});

test('an unverifiable submission response refuses Send without inventing another ID', async () => {
  const h = harness();
  await h.runtime.connectPersonalSync(h.server);
  h.invalidClaim();
  await assert.rejects(h.runtime.prepareSyncedDraft('home', 'chat', 'keep me', '', []), /exact draft revision/);
  const journal = [...h.cache].find(([key]) => key.startsWith('user-sync:journal:'))![1];
  assert.equal(Object.keys(journal.claims ?? {}).length, 0);
  assert.equal(h.requests.filter(request => request.path.endsWith('/submit')).length, 1);
});

function sharedDraft(h: ReturnType<typeof harness>) {
  const file = { id: 'a'.repeat(64), sha256: 'b'.repeat(64), name: 'notes.txt', mime: 'text/plain', kind: 'file', size: 5, slot: 'slot-one' };
  const fields = Object.fromEntries(Object.entries({ text: 'from phone', files: [file], files_ready: true,
    server_id: 'home', chat_id: 'chat', server_fingerprint: h.server.fingerprint,
    reply: { id: 'message-1', text: 'quote', role: 'bot' }, generation: 'remote-generation',
  }).map(([key, value]) => [key, remoteField(value as model.Json, 1)]));
  h.records.set('draft/home:chat', { revision: 1, fields });
}

test('incoming attachments wait for the active composer, then materialize with reply and without auto-send', async () => {
  const h = harness();
  await h.runtime.connectPersonalSync(h.server);
  sharedDraft(h);
  h.useApp.setState({ visibleChat: { serverId: 'home', chatId: 'chat' } });
  await h.runtime.refreshPersonalSync();
  assert.equal(h.transfers.length, 0);
  assert.equal(h.runtime.usePersonalSync.getState().deferredDrafts, 1);
  h.useApp.setState({ visibleChat: undefined });
  await h.runtime.applyDeferredDrafts();
  assert.equal(h.useApp.getState().drafts['home:chat'], 'from phone');
  const file = h.useApp.getState().draftFiles['home:chat'][0];
  assert.equal(file.upload.id, 'target-slot-one');
  assert.equal(file.autoSend, undefined);
  assert.equal(h.useApp.getState().replyTo['home:chat'].id, 'message-1');
});

test('typing during attachment download keeps the local draft instead of applying the older snapshot', async () => {
  const h = harness();
  await h.runtime.connectPersonalSync(h.server);
  sharedDraft(h);
  const gate = h.deferMaterialize();
  const refresh = h.runtime.refreshPersonalSync();
  await gate.started;
  h.useApp.getState().setDraft('home', 'chat', 'typed during transfer');
  gate.release();
  await refresh;
  assert.equal(h.useApp.getState().drafts['home:chat'], 'typed during transfer');
  assert.equal(h.useApp.getState().draftFiles['home:chat'], undefined);
});

test('restart disagreement preserves both durable snapshots without rebasing one over the other', async () => {
  const first = harness();
  const stop = first.runtime.subscribePersonalSync();
  first.useApp.getState().setDraft('home', 'chat', 'initial');
  await first.runtime.connectPersonalSync(first.server);
  first.useApp.setState({ network: false });
  first.useApp.getState().setDraft('home', 'chat', 'journal version');
  await tick();
  stop();
  const restarted = harness(first.cache);
  restarted.useApp.getState().setDraft('home', 'chat', 'core cache version');
  await restarted.runtime.bootPersonalSync();
  const journal = [...restarted.cache].find(([key]) => key.startsWith('user-sync:journal:'))![1];
  const edits = journal.pending.filter((p: model.Pending) => p.kind === 'draft' && p.id === 'home:chat');
  assert.equal(edits[0].mutation.changes.text.value, 'journal version');
  const recovery = edits.at(-1);
  assert.equal(recovery.mutation.changes.text.value, 'core cache version');
  assert.equal(recovery.mutation.base_fields.text, 0);
  assert.equal(recovery.prepared, true);
  assert.deepEqual(recovery.predecessors, {});
});

test('a changed target pairing during a download cannot receive its stale draft result', async () => {
  const h = harness();
  await h.runtime.connectPersonalSync(h.server);
  sharedDraft(h);
  const gate = h.deferMaterialize();
  const refresh = h.runtime.refreshPersonalSync();
  await gate.started;
  h.useApp.setState({ servers: [{ ...h.server, fingerprint: 'replacement-installation' }] });
  gate.release();
  await refresh;
  assert.equal(h.useApp.getState().draftFiles['home:chat'], undefined);
  assert.equal(h.useApp.getState().drafts['home:chat'], undefined);
  assert.equal(h.runtime.usePersonalSync.getState().status, 'error');
});

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
