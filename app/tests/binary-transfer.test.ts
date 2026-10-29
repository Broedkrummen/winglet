import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import { sha256 } from '@noble/hashes/sha2.js';

function compile(file: string, modules: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const exports: any = {};
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { exports, require: (name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected module: ${name}`);
    return modules[name];
  }, setTimeout, clearTimeout, AbortController, FormData, TextEncoder, Uint8Array, ArrayBuffer, ...globals });
  return exports;
}

function apiHarness() {
  const calls: any[] = [];
  const signatures: any[] = [];
  const api = compile('../src/lib/api.ts', {
    'react-native': { Platform: { OS: 'web' } }, 'expo/fetch': { fetch: async (url: string, options: any) => {
      calls.push({ url, options });
      return new Response(options.method === 'PUT' ? JSON.stringify({ ok: true }) : new Uint8Array([0, 255, 3]));
    } }, './crypto': { signedHeaders: (...args: any[]) => { signatures.push(args); return { 'X-Signature': 'fixture' }; } },
    './storage': { getItem: async () => 'device-local-signing', setItem: async () => {} },
    './verify': { NEEDS_VERIFY: 'verify', useVerify: { getState: () => ({ ask: () => {} }) } },
  });
  return { api, calls, signatures };
}

test('signed binary requests send only view bytes and bind the selected bot inside the signed path', async () => {
  const { api, calls, signatures } = apiHarness();
  const server = { id: 'root~work', parent: 'root', profile: 'work notes', url: 'https://target.test', deviceId: 'device', token: 'target-local-token' };
  await api.signedBytesApi(server, '/api/file?name=draft.pdf', new Uint8Array([9, 0, 255, 3, 9]).subarray(1, 4));
  assert.equal(calls[0].url, 'https://target.test/api/file?name=draft.pdf&bot=work%20notes');
  assert.equal(signatures[0][3], '/api/file?name=draft.pdf&bot=work%20notes');
  assert.deepEqual([...new Uint8Array(calls[0].options.body)], [0, 255, 3]);
  assert.deepEqual([...signatures[0][4]], [0, 255, 3]);
  assert.equal(calls[0].options.headers['Content-Type'], 'application/octet-stream');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer target-local-token');
});

test('private downloads use local authentication, refuse external paths and prohibit redirects', async () => {
  const { api, calls } = apiHarness();
  const server = { id: 'home', url: 'https://home.test', token: 'home-local-token' };
  await assert.rejects(api.apiBytes(server, 'https://other.test/file'), /relative server/);
  assert.equal(calls.length, 0);
  assert.deepEqual([...await api.apiBytes(server, '/api/user-sync/g/blobs/id')], [0, 255, 3]);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer home-local-token');
  assert.equal(calls[0].options.redirect, 'error');
});

test('signed profile and file names cannot be rewritten by URL query serialization', () => {
  const { api } = apiHarness();
  const path = api.botPath({ profile: "Kasper's (work)" }, `/api/file?name=${api.encodeApiComponent("Kasper's notes.pdf")}`);
  assert.equal(path, '/api/file?name=Kasper%27s%20notes.pdf&bot=Kasper%27s%20%28work%29');
  const actual = new URL(path, 'https://target.test');
  assert.equal(actual.pathname + actual.search, path);
});

test('ordinary upload helper preserves child-profile scope', async () => {
  const { api } = apiHarness();
  let destination = '';
  class Xhr {
    upload = {}; status = 200; responseText = '{"upload":{"id":"file"}}'; onload!: () => void;
    open(_method: string, url: string) { destination = url; }
    setRequestHeader() {}
    send() { this.onload(); }
    abort() {}
  }
  const media = compile('../src/lib/media.ts', {
    'expo-document-picker': {}, 'expo-image-manipulator': {}, 'expo-image-picker': {},
    'react-native': { Platform: { OS: 'web' } }, './api': api,
  }, { XMLHttpRequest: Xhr });
  await media.uploadFile({ url: 'https://target.test', profile: 'work notes', token: 'local' }, 'chat /1',
    { name: 'file', file: new Blob(['fixture']) }, () => {}).promise;
  assert.equal(destination, 'https://target.test/api/chats/chat%20%2F1/uploads?bot=work%20notes');
});

test('receiving bytes are verified before a copy uses the independently paired target', async () => {
  const bytes = new TextEncoder().encode('private file');
  const hash = Array.from(sha256(bytes), b => b.toString(16).padStart(2, '0')).join('');
  const home = { id: 'home', token: 'home-only' }, target = { id: 'target', token: 'target-only' };
  const calls: any[] = [];
  let corrupt = true;
  const file = { id: 'a'.repeat(64), sha256: hash, name: 'file.txt', mime: 'text/plain', kind: 'file', size: bytes.length, slot: 'slot-1' };
  const transfer = compile('../src/features/sync/fileTransfer.ts', { '@noble/hashes/sha2.js': { sha256 }, '../../lib/api': {
    encodeApiComponent: apiHarness().api.encodeApiComponent,
    apiBytes: async (server: unknown, path: string) => { calls.push({ server, path }); return corrupt ? new Uint8Array([0]) : bytes; },
    signedBytesApi: async (server: unknown, path: string) => { calls.push({ server, path }); return { upload: { ...file, id: 'target-copy', hold_id: 'retained' } }; },
  } });
  await assert.rejects(transfer.materializeSyncFile(home, 'group', target, 'chat', file), /integrity check/);
  assert.equal(calls.length, 1);
  corrupt = false;
  await transfer.materializeSyncFile(home, 'group', target, 'chat', file);
  assert.equal(calls[1].server, home);
  assert.equal(calls[2].server, target);
  assert.ok(!calls[2].path.includes('home-only'));
});

test('staging retains the source first and publishes only immutable metadata, never auto-send flags or source URLs', async () => {
  const bytes = new TextEncoder().encode('source bytes');
  const hash = Array.from(sha256(bytes), b => b.toString(16).padStart(2, '0')).join('');
  const home = { id: 'home', token: 'home-only' }, target = { id: 'target', token: 'target-only' };
  const calls: any[] = [];
  const descriptor = { id: 'b'.repeat(64), sha256: hash, name: 'file.pdf', mime: 'application/pdf', kind: 'file', size: bytes.length };
  const file = { localId: 'slot-1', status: 'ready', kind: 'file', upload: {
    id: 'source-id', name: 'file.pdf', size: bytes.length, url: '/api/media/source-id/file.pdf?sig=source-capability',
  } };
  const transfer = compile('../src/features/sync/fileTransfer.ts', { '@noble/hashes/sha2.js': { sha256 }, '../../lib/api': {
    encodeApiComponent: apiHarness().api.encodeApiComponent,
    signedApi: async (server: unknown) => { calls.push({ step: 'retain', server }); },
    apiBytes: async (server: unknown) => { calls.push({ step: 'read', server }); return bytes; },
    signedBytesApi: async (server: unknown) => { calls.push({ step: 'stage', server }); return { blob: descriptor }; },
  } });
  const result = await transfer.stageSyncFile(home, 'group', target, 'chat', file);
  assert.deepEqual(calls.map(call => call.step), ['retain', 'read', 'stage']);
  assert.equal(calls[0].server, target);
  assert.equal(calls[2].server, home);
  assert.ok(!JSON.stringify(result).includes('source-capability'));
  assert.ok(!JSON.stringify(result).includes('target-only'));
  assert.equal(result.slot, 'slot-1');
  await assert.rejects(transfer.stageSyncFile(home, 'group', target, 'chat', { ...file, autoSend: true }), /upload to finish/);
  assert.equal(calls.length, 3);
});

test('a saved sent-file source uses an explicit owner-checked message-backed fallback after strict retention refuses', async () => {
  const bytes = new TextEncoder().encode('sent source');
  const hash = Array.from(sha256(bytes), b => b.toString(16).padStart(2, '0')).join('');
  class ApiError extends Error { status = 409; }
  const bodies: any[] = [];
  const transfer = compile('../src/features/sync/fileTransfer.ts', { '@noble/hashes/sha2.js': { sha256 }, '../../lib/api': {
    ApiError, encodeApiComponent: encodeURIComponent,
    signedApi: async (_s: any, _m: any, _p: any, body: any) => { bodies.push(body); if (!body.allow_message_backed) throw new ApiError('already sent'); return { message_backed: ['sent'] }; },
    apiBytes: async () => bytes,
    signedBytesApi: async () => ({ blob: { id: 'a'.repeat(64), sha256: hash, name: 'sent.txt', size: bytes.length, mime: 'text/plain', kind: 'file' } }),
  } });
  const result = await transfer.stageSyncFile({ id: 'home' }, 'group', { id: 'target' }, 'chat', {
    status: 'ready', localId: 'saved', kind: 'file', upload: { id: 'sent', url: '/api/media/sent/sent.txt', name: 'sent.txt', size: bytes.length },
  });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].allow_message_backed, true);
  assert.equal(result.sha256, hash);
});
