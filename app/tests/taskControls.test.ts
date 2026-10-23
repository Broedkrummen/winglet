import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function harness() {
  const state: any = { network: true, runtime: { bot: { status: 'online' } }, toast: (value: any) => toasts.push(value),
    sendMessage: () => { throw new Error('Stop must never use the outbox'); } };
  const toasts: any[] = [];
  const sent: any[] = [];
  let request: (body: any) => Promise<any> = async () => ({});
  const exports: any = {};
  const modules: any = { 'expo-router': { router: {} }, './store': { useApp: { getState: () => state } },
    './api': { api: async (_server: any, path: string, init: any) => { const body = JSON.parse(init.body); sent.push({ path, body }); return request(body); } } };
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/actions.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (id: string) => modules[id] });
  return { state, toasts, sent, stop: () => exports.stopTask({ id: 'bot' }, 'chat/with spaces'),
    setRequest: (fn: typeof request) => { request = fn; } };
}

test('Stop sends one immediate control with an encoded chat ID, even through rapid taps', async () => {
  const h = harness();
  let resolve!: (value: any) => void;
  h.setRequest(() => new Promise((done) => { resolve = done; }));
  const first = h.stop();
  assert.equal(await h.stop(), false);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].path, '/api/chats/chat%2Fwith%20spaces/messages');
  assert.equal(h.sent[0].body.text, '/stop');
  assert.equal(h.sent[0].body.hidden, true);
  resolve({});
  assert.equal(await first, true);
});

test('Stop refuses offline use and failure never becomes a queued command', async () => {
  const h = harness();
  h.state.network = false;
  assert.equal(await h.stop(), false);
  assert.equal(h.sent.length, 0);
  assert.equal(h.toasts[0].title, 'Reconnect to stop');
  h.state.network = true;
  h.setRequest(async () => { throw new Error('Disconnected'); });
  assert.equal(await h.stop(), false);
  assert.equal(h.toasts[1].title, "Couldn't stop");
  h.setRequest(async () => ({}));
  assert.equal(await h.stop(), true, 'a failed Stop releases the tap guard');
});
