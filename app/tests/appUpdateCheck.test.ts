import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

function harness(over: Record<string, any> = {}) {
  let state: any;
  let calls = 0;
  let timeout: () => void = () => {};
  let cleared = false;
  const update = { version: '0.2.1', page: 'https://github.com/VIKASRP24/winglet/releases/tag/v0.2.1' };
  const exports: any = {};
  const modules: Record<string, unknown> = {
    'expo-constants': { expoConfig: { version: '0.2.0' } },
    'react-native': { Platform: { OS: over.platform ?? 'android' } },
    'expo-device': { supportedCpuArchitectures: ['arm64-v8a', 'armeabi-v7a'] },
    zustand: { create: (init: any) => {
      state = init((patch: any) => Object.assign(state, patch), () => state);
      return { getState: () => state };
    } },
    './appUpdate': { RELEASES_URL: 'https://api.github.com/repos/VIKASRP24/winglet/releases',
      checkIsFresh: () => over.fresh ?? false, newestUpdate: () => update },
    './storage': { getJSON: over.read ?? (async () => null), setJSON: over.write ?? (async () => {}) },
  };
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/appUpdateCheck.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (name: string) => modules[name], AbortController, __DEV__: over.development ?? false,
    setTimeout: (fn: () => void, ms: number) => { assert.equal(ms, 15_000); timeout = fn; return 1; },
    clearTimeout: () => { cleared = true; },
    fetch: (...args: any[]) => { calls++; return over.fetch ? over.fetch(...args) : Promise.resolve({ ok: true, json: async () => [] }); },
  });
  return { state: exports.useAppUpdate.getState(), update, expire: () => timeout(),
    calls: () => calls, cleared: () => cleared };
}

test('a cache read failure still checks GitHub and permits future checks', async () => {
  const h = harness({ read: async () => { throw new Error('secure storage unavailable'); } });
  await h.state.check();
  assert.equal(h.state.update, h.update);
  assert.equal(h.state.checking, false);
  assert.equal(h.state.failed, false);
  await h.state.check(true);
  assert.equal(h.calls(), 2);
});

test('a cache write failure keeps the successful update result', async () => {
  const h = harness({ write: async () => { throw new Error('secure storage unavailable'); } });
  await h.state.check();
  assert.equal(h.state.update, h.update);
  assert.equal(h.state.failed, false);
  assert.equal(h.state.checking, false);
  assert.equal(h.cleared(), true);
});

test('a stalled request times out, retains the known update, and can be retried', async () => {
  const h = harness({ fetch: (_url: string, options: any) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }) });
  h.state.update = h.update;
  const pending = h.state.check();
  await new Promise((resolve) => setImmediate(resolve));
  await h.state.check();
  assert.equal(h.calls(), 1);
  h.expire();
  await pending;
  assert.equal(h.state.checking, false);
  assert.equal(h.state.failed, true);
  assert.equal(h.state.update, h.update);
  assert.equal(h.cleared(), true);
  const retry = h.state.check(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls(), 2);
  h.expire();
  await retry;
});

test('a fresh cache avoids GitHub unless the check is forced', async () => {
  const cached = { checkedAt: 123, current: '0.2.0', update: null };
  const h = harness({ fresh: true, read: async () => cached });
  await h.state.check();
  assert.equal(h.calls(), 0);
  assert.equal(h.state.checkedAt, 123);
  await h.state.check(true);
  assert.equal(h.calls(), 1);
});

test('the web app never checks GitHub', async () => {
  const h = harness({ platform: 'web' });
  await h.state.check(true);
  assert.equal(h.calls(), 0);
});

test('a development build never offers a public release as an in-place update', async () => {
  const h = harness({ development: true });
  await h.state.check(true);
  assert.equal(h.calls(), 0);
  assert.equal(h.state.update, null);
});
