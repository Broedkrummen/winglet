import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { gcm } from '@noble/ciphers/aes.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import ts from 'typescript';

// The real api.ts and crypto.ts, with fetch routed to a simulated server and a relay in front of it.
const load = (file: string, modules: Record<string, unknown>) => {
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/lib/${file}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (m: string) => modules[m], TextEncoder, Uint8Array, btoa, atob, Date, Math, JSON, String,
    Array, Number, AbortController, setTimeout, clearTimeout, URL, encodeURIComponent });
  return exports;
};
const crypto_ = load('crypto.ts', { '@noble/ciphers/aes.js': { gcm }, '@noble/curves/ed25519.js': { ed25519, x25519 },
  '@noble/hashes/hkdf.js': { hkdf }, '@noble/hashes/sha2.js': { sha256 },
  'expo-crypto': { getRandomBytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)) } });

const te = new TextEncoder();
const join = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
const GENUINE = 'https://hermes.example.ts.net', OLD = 'https://old.trycloudflare.com', RELAY = 'https://relay.example';
const identity = ed25519.utils.randomSecretKey();
const identityPublic = ed25519.getPublicKey(identity);
const sealing = x25519.getPublicKey(x25519.utils.randomSecretKey());
const keyInfo = { v: 1, identity: crypto_.b64e(identityPublic), fingerprint: crypto_.fingerprint(identityPublic),
  sealing: crypto_.b64e(sealing), sealing_sig: crypto_.b64e(ed25519.sign(join(te.encode('winglet-sealing-key-v1'), sealing), identity)) };
const TOKEN = 'device-token';
const seen: { origin: string; path: string; auth: boolean }[] = [];

/** The real server: it answers at GENUINE (and the old address), and signs only those as its own. */
function genuine(path: string, auth?: string) {
  const url = new URL(`https://x${path}`);
  if (url.pathname === '/api/info') return { app: 'winglet', server_id: 'srv' };
  if (url.pathname === '/api/server-key') return keyInfo;
  if (url.pathname === '/api/address-check') {
    const asked = url.searchParams.get('url')!;
    const statement = JSON.stringify({ v: 1, server_id: 'srv', url: asked, listed: [GENUINE, OLD].includes(asked),
      issued_at: Math.floor(Date.now() / 1000) });
    return { statement, sig: crypto_.b64e(ed25519.sign(join(te.encode('winglet-address-v1'), te.encode(statement)), identity)) };
  }
  if (url.pathname === '/api/me' && auth === `Bearer ${TOKEN}`) return { server_id: 'srv', device: { id: 'dev' } };
  return null;
}

function makeFetch(rewrite?: (path: string) => string) {
  return async (target: string, init: any) => {
    const url = new URL(target);
    const auth = init?.headers?.Authorization;
    seen.push({ origin: url.origin, path: url.pathname, auth: !!auth });
    // The relay forwards everything to the real server, optionally rewriting the question it passes on.
    const path = url.pathname + url.search;
    const body = genuine(url.origin === RELAY && rewrite ? rewrite(path) : path, auth);
    return new Response(JSON.stringify(body ?? { error: 'nope' }), { status: body ? 200 : 404 });
  };
}

function api(fetchImpl: any) {
  return load('api.ts', { 'react-native': { Platform: { OS: 'android' } }, 'expo/fetch': { fetch: fetchImpl }, './crypto': crypto_,
    './storage': { getItem: async () => null, setItem: async () => undefined } });
}

const server = { id: 'srv', url: OLD, token: TOKEN, deviceId: 'dev', bot: { name: 'hermes', title: 'Hermes' }, addedAt: 0,
  fingerprint: keyInfo.fingerprint, wsAuth: true };

test('a phone moves to an address its server signed as its own', async () => {
  const moved = await api(makeFetch()).moveServer(server, GENUINE);
  assert.equal(moved.url, GENUINE);
});

test("a relay to the real server never gets the phone's token", async () => {
  // Forwarding everything as is: the server signs "no" for the relay's address.
  // Rewriting the question to ask about the genuine address: the signed yes names a different address.
  for (const rewrite of [undefined, (p: string) => p.replace(encodeURIComponent(RELAY), encodeURIComponent(GENUINE))]) {
    seen.length = 0;
    await assert.rejects(api(makeFetch(rewrite)).moveServer(server, RELAY), /doesn't list that address/);
    assert.ok(seen.some((r) => r.path === '/api/address-check'), 'it asked');
    assert.deepEqual(seen.filter((r) => r.auth), [], 'no request carried the token');
  }
});

test('a statement only counts for its server, its address, and while it is fresh', () => {
  const sign = (s: object) => {
    const statement = JSON.stringify(s);
    return { statement, sig: crypto_.b64e(ed25519.sign(join(te.encode('winglet-address-v1'), te.encode(statement)), identity)) };
  };
  const now = Date.now(), base = { v: 1, server_id: 'srv', url: GENUINE, listed: true, issued_at: Math.floor(now / 1000) };
  assert.ok(crypto_.addressConfirmed(keyInfo, sign(base), 'srv', GENUINE, now));
  assert.ok(!crypto_.addressConfirmed(keyInfo, sign({ ...base, listed: false }), 'srv', GENUINE, now));
  assert.ok(!crypto_.addressConfirmed(keyInfo, sign(base), 'other', GENUINE, now));
  assert.ok(!crypto_.addressConfirmed(keyInfo, sign(base), 'srv', RELAY, now));
  assert.ok(!crypto_.addressConfirmed(keyInfo, sign(base), 'srv', GENUINE, now + 2 * 3600_000));
  const forged = { ...sign(base), statement: JSON.stringify({ ...base, url: RELAY }) };
  assert.ok(!crypto_.addressConfirmed(keyInfo, forged, 'srv', RELAY, now));
  assert.ok(!crypto_.addressConfirmed(keyInfo, { statement: 'x', sig: 'junk' }, 'srv', GENUINE, now));
});

test("an owner action this phone can't sign offers to verify it, whether the key is missing here or unknown there", async () => {
  const asked: string[] = [];
  const verify = { NEEDS_VERIFY: 'Verify this phone to do that.', useVerify: { getState: () => ({ ask: (id: string) => asked.push(id) }) } };
  const refuse = async () => new Response(JSON.stringify({ error: 'Verify this device first…', needs: 'verify' }), { status: 403 });
  const load_ = (key: string | null, fetchImpl: any) => load('api.ts', { 'react-native': { Platform: { OS: 'android' } },
    'expo/fetch': { fetch: fetchImpl }, './crypto': crypto_, './verify': verify,
    './storage': { getItem: async () => key, setItem: async () => undefined } });
  await assert.rejects(load_(null, refuse).signedApi(server, 'POST', '/api/system/restart', {}),
    (e: any) => e.message === 'Verify this phone to do that.' && e.data.needs === 'verify');
  const secret = crypto_.newSigningKey().secret;
  await assert.rejects(load_(secret, refuse).signedApi(server, 'POST', '/api/system/restart', {}), (e: any) => e.status === 403);
  assert.deepEqual(asked, ['srv', 'srv']);
  // Any other refusal is passed on as it is, without the sheet.
  const other = async () => new Response(JSON.stringify({ error: 'Only an owner can do that.' }), { status: 403 });
  await assert.rejects(load_(secret, other).signedApi(server, 'POST', '/api/system/restart', {}), /Only an owner/);
  assert.equal(asked.length, 2);
});
