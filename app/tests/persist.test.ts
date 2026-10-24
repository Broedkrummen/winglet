import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { createStore } from 'zustand/vanilla';

function harness() {
  const store = createStore(() => ({ drafts: {}, draftFiles: {}, replyTo: {}, runtime: {}, foreground: true }));
  const saved = new Map<string, any>();
  const timers = new Map<number, () => void>();
  const events = new Map<string, () => void>();
  let next = 0;
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/persist.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports,
    require: (id: string) => id === './store' ? { useApp: store } : {
      cacheSet: (key: string, value: unknown) => { saved.set(key, structuredClone(value)); },
    },
    setTimeout: (fn: () => void) => { timers.set(++next, fn); return next; },
    clearTimeout: (id: number) => timers.delete(id),
    addEventListener: (name: string, fn: () => void) => events.set(name, fn),
    removeEventListener: (name: string) => events.delete(name),
  });
  return { store, saved, timers, events, detach: exports.attachPersistence() };
}

test('backgrounding immediately saves the latest text, ready files and reply before the debounce', () => {
  const h = harness();
  const ready = { localId: 'file', status: 'ready', upload: { id: 'upload' } };
  h.store.setState({ drafts: { 'bot:chat': 'Unsent question' }, replyTo: { 'bot:chat': { id: 'reply', text: 'Context' } },
    draftFiles: { 'bot:chat': [ready, { status: 'uploading' }, { status: 'failed' }, { ...ready, autoSend: true }] } });
  assert.equal(h.saved.size, 0);
  h.store.setState({ foreground: false });
  assert.equal(h.saved.get('drafts')['bot:chat'], 'Unsent question');
  assert.equal(h.saved.get('replyTo')['bot:chat'].id, 'reply');
  assert.deepEqual(h.saved.get('draftFiles')['bot:chat'], [ready]);
  assert.equal(h.timers.size, 0);
  h.detach();
});

test('browser pagehide and cleanup flush pending edits and detach all listeners and timers', () => {
  const h = harness();
  h.store.setState({ drafts: { 'bot:chat': 'First' } });
  h.events.get('pagehide')!();
  assert.equal(h.saved.get('drafts')['bot:chat'], 'First');
  h.store.setState({ drafts: { 'bot:chat': 'Latest' } });
  h.detach();
  assert.equal(h.saved.get('drafts')['bot:chat'], 'Latest');
  assert.equal(h.events.size, 0);
  assert.equal(h.timers.size, 0);
  h.store.setState({ drafts: {} });
  assert.equal(h.timers.size, 0);
});

test('edits received while backgrounded are persisted without another visibility transition', () => {
  const h = harness();
  h.store.setState({ foreground: false });
  h.store.setState({ drafts: { 'bot:chat': 'Shared from another app' } });
  assert.equal(h.saved.get('drafts')['bot:chat'], 'Shared from another app');
  assert.equal(h.timers.size, 0);
  h.detach();
});
