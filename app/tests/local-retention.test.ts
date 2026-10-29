import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import * as retirement from '../src/lib/uploadRetirement.ts';

function harness() {
  const server = { id: 'target', url: 'https://target.test', deviceId: 'device' };
  const state: any = { ready: true, foreground: true, network: true, servers: [server], draftFiles: {}, runtime: { target: { outbox: [] } } };
  const saved = new Map<string, any>();
  const requests: any[] = [];
  let locked = false;
  let read = async (key: string, fallback: any) => saved.get(key) ?? fallback;
  let listing = async () => ({ files: [], next: null, scope: 'current' });
  const imports: Record<string, any> = {
    '../../lib/api': { encodeApiComponent: encodeURIComponent, api: () => listing(), signedApi: async (...args: any[]) => { requests.push(args); } },
    '../../lib/appLock': { useLock: { getState: () => ({ locked }) } },
    '../../lib/cache': { cacheGetStrict: (key: string, fallback: any) => read(key, fallback) },
    '../../lib/store': { useApp: { getState: () => state } }, '../../lib/uploadRetirement': retirement,
  };
  const exports: any = {};
  const code = ts.transpileModule(readFileSync(new URL('../src/features/sync/localRetention.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { exports, require: (name: string) => imports[name] });
  const file = { upload: { id: 'held', name: 'file.txt' }, source_device: 'device', chat_id: 'chat', hold_id: 'hold', version: 'version-one' };
  return { service: exports, server, state, saved, requests, file,
    setRead: (value: typeof read) => { read = value; }, setListing: (value: any) => { listing = value; }, lock: () => { locked = true; } };
}

test('a live draft protects its upload before cleanup reads storage or sends a release', async () => {
  const h = harness();
  h.state.draftFiles['target:chat'] = [{ upload: { id: 'held' } }];
  h.setRead(async () => { throw new Error('should not read'); });
  await assert.rejects(h.service.releaseCurrentRetainedFile(h.server, h.file), /still in a draft or outbox/);
  assert.equal(h.requests.length, 0);
  retirement.assertUploadsAvailable('target', [{ id: 'held' }]);
});

test('a persisted outbox protects files even when the current in-memory outbox is empty', async () => {
  const h = harness();
  h.saved.set('outbox:target', [{ attachments: [{ id: 'held' }] }]);
  await assert.rejects(h.service.releaseCurrentRetainedFile(h.server, h.file), /still in a draft or outbox/);
  assert.equal(h.requests.length, 0);
});

test('unreadable persistence blocks release and always removes the admission guard', async () => {
  const h = harness();
  h.setRead(async () => { throw new Error('storage unavailable'); });
  await assert.rejects(h.service.releaseCurrentRetainedFile(h.server, h.file), /storage unavailable/);
  assert.equal(h.requests.length, 0);
  retirement.assertUploadsAvailable('target', [{ id: 'held' }]);
});

test('retirement guards admissions while checking storage and binds the exact reviewed server lease', async () => {
  const h = harness();
  let resume!: () => void;
  h.setRead(async (_key, fallback) => { await new Promise<void>(resolve => { resume = resolve; }); return fallback; });
  const release = h.service.releaseCurrentRetainedFile(h.server, h.file);
  assert.throws(() => retirement.assertUploadsAvailable('target', [{ id: 'held' }]), /being released/);
  // Both storage reads are guarded; switch the later read back to a normal committed snapshot.
  h.setRead(async (_key, fallback) => fallback);
  resume();
  await release;
  assert.equal(h.requests.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[0][3])), { hold_id: 'hold', upload_id: 'held', expected_version: 'version-one' });
  retirement.assertUploadsAvailable('target', [{ id: 'held' }]);
});

test('confirmed cleanup keeps a reused draft file while retiring an unused copy of the same hold', async () => {
  const h = harness();
  h.state.draftFiles['target:chat'] = [{ upload: { id: 'held' } }];
  h.setListing(async () => ({ files: [h.file, { ...h.file, upload: { id: 'unused' }, version: 'unused-version' }], next: null, scope: 'current' }));
  assert.equal(await h.service.retireConfirmedHolds(h.server, 'chat', new Set(['hold'])), false);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0][3].upload_id, 'unused');
});

test('a server that ignores the current-device scope cannot masquerade as an empty current listing', async () => {
  const h = harness();
  h.setListing(async () => ({ files: [], next: null }));
  await assert.rejects(h.service.currentRetainedFiles(h.server), /Update Winglet/);
  assert.equal(h.requests.length, 0);
});
