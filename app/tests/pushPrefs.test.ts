import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import { createStore } from 'zustand/vanilla';

function harness(request: (...args: any[]) => Promise<any>) {
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/pushPrefs.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (id: string) => id === 'zustand' ? { create: createStore } : { api: request } });
  return { store: exports.usePushPrefs, key: exports.pushPrefsKey, tick: () => new Promise((r) => setImmediate(r)) };
}

test('rapid changes from sibling bots preserve both chat mutes on their shared device', async () => {
  let saved: any = { muted: { existing: 0 } };
  const bodies: any[] = [];
  const h = harness(async (_server, _path, init) => {
    if (init) { saved = JSON.parse(init.body).prefs; bodies.push(saved); }
    return { prefs: saved };
  });
  const a = { id: 'server' }, b = { id: 'server~researcher', parent: 'server' };
  await Promise.all([
    h.store.getState().save(a, (p: any) => ({ ...p, muted: { ...p.muted, first: 0 } })),
    h.store.getState().save(b, (p: any) => ({ ...p, muted: { ...p.muted, second: 0 } })),
  ]);
  assert.equal(h.key(a), h.key(b));
  assert.deepEqual(saved.muted, { existing: 0, first: 0, second: 0 });
  assert.equal(bodies.length, 2);
});

test('an older read cannot undo a completed notification setting', async () => {
  let resolve!: (v: any) => void;
  let reads = 0;
  const h = harness(async (_server, _path, init) => {
    if (init) return { prefs: JSON.parse(init.body).prefs };
    if (++reads === 1) return { prefs: { muted: {} } };
    return new Promise((r) => { resolve = r; });
  });
  const server = { id: 's' };
  await h.store.getState().load(server);
  const stale = h.store.getState().load(server);
  await h.store.getState().save(server, (p: any) => ({ ...p, muted: { chat: 0 } }));
  resolve({ prefs: { muted: {} } });
  await stale;
  assert.equal(h.store.getState().byServer.s.muted.chat, 0);
});

test('a failed save rolls back and later queued changes still succeed', async () => {
  let writes = 0;
  const h = harness(async (_server, _path, init) => {
    if (!init) return { prefs: { muted: { existing: 0 } } };
    if (++writes === 1) throw new Error('Offline');
    return { prefs: JSON.parse(init.body).prefs };
  });
  const server = { id: 's' };
  const first = h.store.getState().save(server, (p: any) => ({ ...p, muted: { ...p.muted, failed: 0 } }));
  const second = h.store.getState().save(server, (p: any) => ({ ...p, muted: { ...p.muted, next: 0 } }));
  await assert.rejects(first, /Offline/);
  await second;
  assert.equal(h.store.getState().byServer.s.muted.failed, undefined);
  assert.equal(h.store.getState().byServer.s.muted.existing, 0);
  assert.equal(h.store.getState().byServer.s.muted.next, 0);
});
