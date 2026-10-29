import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { gcm } from '@noble/ciphers/aes.js';
import ts from 'typescript';

function harness(rows = new Map<string, string>(), secrets = new Map<string, string>()) {
  const exports: any = {};
  let keychainAvailable = true;
  let beforeWrite: (key: string) => Promise<void> = async () => {};
  const modules: any = {
    'expo-sqlite/kv-store': { SQLiteStorage: class {
      async getItemAsync(key: string) { return rows.get(key) ?? null; }
      async getAllKeysAsync() { return [...rows.keys()]; }
      async setItemAsync(key: string, value: string) { await beforeWrite(key); rows.set(key, value); }
      async removeItemAsync(key: string) { rows.delete(key); }
    } },
    '@noble/ciphers/aes.js': { gcm },
    'expo-crypto': { getRandomBytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)) },
    './crypto': {
      b64e: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url'),
      b64d: (text: string) => new Uint8Array(Buffer.from(text, 'base64url')),
    },
    './storage': {
      getItem: async (key: string) => {
        if (!keychainAvailable) throw new Error('Keychain unavailable');
        return secrets.get(key) ?? null;
      },
      setItem: async (key: string, value: string) => {
        if (!keychainAvailable) throw new Error('Keychain unavailable');
        secrets.set(key, value);
      },
    },
  };
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/cache.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (id: string) => modules[id], TextEncoder, TextDecoder, Uint8Array });
  return { rows, secrets, get: exports.cacheGet, set: exports.cacheSet, strict: exports.cacheSetStrict, remove: exports.cacheRemove,
    status: exports.getCacheStatus, subscribe: exports.subscribeCacheStatus, reset: exports.resetCache,
    keychain: (available: boolean) => { keychainAvailable = available; },
    writes: (fn: typeof beforeWrite) => { beforeWrite = fn; } };
}

test('native cache migrates all legacy rows without losing drafts or unsent messages', async () => {
  const draft = { 'bot:chat': 'Private draft 🔒' };
  const outbox = [{ client_id: 'keep-this-id', text: 'Unsent question', attachments: [{ id: 'file' }] }];
  const h = harness(new Map([['drafts', JSON.stringify(draft)], ['outbox:bot', JSON.stringify(outbox)]]));
  assert.deepEqual(structuredClone(await h.get('drafts', {})), draft);
  for (const value of h.rows.values()) {
    assert.ok(value.startsWith('winglet-cache:v1:'));
    assert.ok(!value.includes('Private') && !value.includes('Unsent'));
  }
  const restarted = harness(h.rows, h.secrets);
  assert.deepEqual(structuredClone(await restarted.get('outbox:bot', [])), outbox);
  assert.equal(h.secrets.size, 1);
});

test('cache uses a fresh nonce for every save and authenticates both bytes and record identity', async () => {
  const h = harness();
  await h.set('msgs:bot:one', ['A private answer']);
  const first = h.rows.get('msgs:bot:one')!;
  await h.set('msgs:bot:one', ['A private answer']);
  assert.notEqual(h.rows.get('msgs:bot:one'), first);
  h.rows.set('msgs:bot:two', first);
  assert.equal(await h.get('msgs:bot:two', 'unreadable'), 'unreadable', 'moving ciphertext between chats fails authentication');
  const parts = first.split(':');
  const bytes = Buffer.from(parts[3], 'base64url');
  bytes[0] ^= 1;
  parts[3] = bytes.toString('base64url');
  h.rows.set('msgs:bot:one', parts.join(':'));
  assert.equal(await h.get('msgs:bot:one', 'unreadable'), 'unreadable');
});

test('a keychain failure never falls back to writing plaintext and later saves can recover', async () => {
  const h = harness();
  h.keychain(false);
  await h.set('drafts', { text: 'Secret' });
  assert.equal(h.rows.size, 0);
  assert.equal(await h.get('drafts', 'offline'), 'offline');
  h.keychain(true);
  await h.set('drafts', { text: 'Recovered' });
  assert.deepEqual(structuredClone(await h.get('drafts', {})), { text: 'Recovered' });
});

test('a missing device key cannot replace an encrypted outbox with new empty data', async () => {
  const h = harness();
  await h.set('outbox:bot', [{ text: 'Still unsent' }]);
  const before = h.rows.get('outbox:bot');
  const restored = harness(h.rows);
  assert.equal(await restored.get('outbox:bot', 'unreadable'), 'unreadable');
  await restored.set('outbox:bot', []);
  assert.equal(h.rows.get('outbox:bot'), before);
  assert.equal(restored.secrets.size, 0);
  await restored.remove('');
  await restored.set('drafts', { text: 'Fresh cache' });
  assert.deepEqual(structuredClone(await restored.get('drafts', {})), { text: 'Fresh cache' });
});

test('restored cache reports the missing key and resets only on explicit request', async () => {
  const original = harness();
  await original.set('drafts', { text: 'old draft' });
  await original.set('outbox:bot', [{ text: 'old unsent message' }]);
  const oldKey = [...original.secrets.values()][0];
  const before = new Map(original.rows);
  const restored = harness(original.rows);
  const changes: string[] = [];
  const unsubscribe = restored.subscribe(() => changes.push(restored.status()));
  assert.equal(await restored.get('drafts', 'unavailable'), 'unavailable');
  assert.equal(restored.status(), 'unavailable');
  await restored.set('drafts', { text: 'new draft' });
  assert.deepEqual(restored.rows, before);
  assert.equal(restored.secrets.size, 0);
  await restored.reset();
  assert.equal(restored.status(), 'ready');
  assert.deepEqual(changes, ['unavailable', 'ready']);
  unsubscribe();
  assert.equal(restored.rows.size, 0);
  assert.notEqual([...restored.secrets.values()][0], oldKey);
  await restored.set('drafts', { text: 'new draft' });
  await restored.set('outbox:bot', [{ text: 'new message' }]);
  assert.deepEqual(structuredClone(await restored.get('drafts', null)), { text: 'new draft' });
  assert.deepEqual(structuredClone(await restored.get('outbox:bot', null)), [{ text: 'new message' }]);
});

test('healthy cache remains ready and retains existing data', async () => {
  const h = harness();
  await h.set('drafts', { text: 'kept' });
  const restarted = harness(h.rows, h.secrets);
  assert.deepEqual(structuredClone(await restarted.get('drafts', null)), { text: 'kept' });
  assert.equal(restarted.status(), 'ready');
});

test('queued migration and rapid draft saves cannot overwrite newer text or revive removed rows', async () => {
  const h = harness(new Map([['drafts', JSON.stringify({ text: 'Old' })]]));
  let release!: () => void;
  let started!: () => void;
  const writing = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  h.writes(async () => { started(); await gate; });
  const reading = h.get('drafts', {});
  await writing;
  const saving = h.set('drafts', { text: 'Latest' });
  const removing = h.remove('draft');
  release();
  await Promise.all([reading, saving, removing]);
  assert.equal(h.rows.has('drafts'), false);
  await h.set('drafts', { text: 'After removal' });
  assert.deepEqual(structuredClone(await h.get('drafts', {})), { text: 'After removal' });
});

test('an interrupted legacy migration retries safely and does not block later writes', async () => {
  const h = harness(new Map([['drafts', '{"text":"Keep"}'], ['outbox:bot', '[{"text":"Keep too"}]']]));
  h.writes(async (key) => { if (key === 'outbox:bot') throw new Error('Disk full'); });
  assert.equal(await h.get('drafts', 'unavailable'), 'unavailable');
  const alreadySealed = h.rows.get('drafts');
  h.writes(async () => {});
  assert.deepEqual(structuredClone(await h.get('outbox:bot', [])), [{ text: 'Keep too' }]);
  assert.equal(h.rows.get('drafts'), alreadySealed);
});

test('durable replay writes reject on keychain or disk failure and preserve the preceding checkpoint', async () => {
  const h = harness();
  h.keychain(false); await assert.rejects(h.strict('replay:bot', { cursor: 1 }));
  assert.equal(h.rows.size, 0);
  h.keychain(true); await h.strict('replay:bot', { cursor: 1, messages: ['applied'] });
  const durable = h.rows.get('replay:bot');
  h.writes(async () => { throw new Error('Disk full'); });
  await assert.rejects(h.strict('replay:bot', { cursor: 2 }));
  assert.equal(h.rows.get('replay:bot'), durable);
  h.writes(async () => {});
  assert.deepEqual(structuredClone(await h.get('replay:bot', null)), { cursor: 1, messages: ['applied'] });
});
