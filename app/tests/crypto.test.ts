import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { gcm } from '@noble/ciphers/aes.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import ts from 'typescript';

const modules: Record<string, unknown> = {
  '@noble/ciphers/aes.js': { gcm }, '@noble/curves/ed25519.js': { ed25519, x25519 },
  '@noble/hashes/hkdf.js': { hkdf }, '@noble/hashes/sha2.js': { sha256 },
  'expo-crypto': { getRandomBytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)) },
};
const exports: any = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/crypto.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, require: (m: string) => modules[m], TextEncoder, Uint8Array, btoa, atob, Date, Math, JSON, String, Array });
const c = exports;

test('binary owner signatures hash exact bytes, including non-UTF8 data and view offsets', () => {
  const bytes = new Uint8Array([99, 0, 255, 128, 1, 99]).subarray(1, 5);
  const payload = new TextDecoder().decode(c.signingPayload('PUT', '/api/file', bytes, 'device', '1', 'nonce'));
  assert.equal(payload.split('\n')[3], createHash('sha256').update(bytes).digest('hex'));
});

/** Deterministic "randomness", so the vector file is reproducible. */
function counter(seed: number) {
  let n = seed;
  return (len: number) => Uint8Array.from({ length: len }, () => (n = (n * 31 + 7) & 0xff));
}
const bytes = (start: number) => Uint8Array.from({ length: 32 }, (_, i) => (start + i) & 0xff);

const VECTORS = new URL('../../tests/fixtures/crypto_vectors.json', import.meta.url);

test('sealing and signing match the vectors the server tests open', () => {
  const sealingSecret = bytes(1);
  const info = { v: 1, identity: '', fingerprint: '', sealing: c.b64e(x25519.getPublicKey(sealingSecret)), sealing_sig: '' };
  const plaintext = { code: 'ABCD2345', device_name: 'Pixel', sign_key: 'x', pinned: true };
  const sealed = c.seal(info, 'pair', 'dev-1', plaintext, counter(3));
  const device = bytes(100);
  const body = '{"role":"member"}';
  const headers = c.signedHeaders(c.b64e(device), 'dev-1', 'POST', '/api/devices/pairing-code', body, 1_800_000_000_000, counter(9));
  const vector = {
    server_sealing_private: c.b64e(sealingSecret), purpose: 'pair', device_id: 'dev-1', plaintext, sealed,
    device_public: c.b64e(ed25519.getPublicKey(device)), method: 'POST', path: '/api/devices/pairing-code', body,
    time: headers['X-Winglet-Time'], nonce: headers['X-Winglet-Nonce'], signature: headers['X-Winglet-Signature'],
  };
  if (process.env.UPDATE_VECTORS) writeFileSync(VECTORS, JSON.stringify(vector, null, 2) + '\n');
  assert.deepEqual(JSON.parse(JSON.stringify(vector)), JSON.parse(readFileSync(VECTORS, 'utf8')));
});

test('a server key is trusted only with the right fingerprint and a signed sealing key', () => {
  const identity = bytes(50);
  const sealing = x25519.getPublicKey(bytes(70));
  const ctx = new TextEncoder().encode('winglet-sealing-key-v1');
  const signed = ed25519.sign(new Uint8Array([...ctx, ...sealing]), identity);
  const pub = ed25519.getPublicKey(identity);
  const info = { v: 1, identity: c.b64e(pub), fingerprint: c.fingerprint(pub), sealing: c.b64e(sealing), sealing_sig: c.b64e(signed) };
  c.checkServerKey(info);
  c.checkServerKey(info, info.fingerprint);
  assert.throws(() => c.checkServerKey(info, 'AAAAAAAAAAAAAAAAAAAAAA'), /doesn't match the one in your pairing code/);
  assert.throws(() => c.checkServerKey({ ...info, sealing: c.b64e(x25519.getPublicKey(bytes(90))) }), /isn't signed/);
  assert.throws(() => c.checkServerKey({ ...info, fingerprint: 'AAAAAAAAAAAAAAAAAAAAAA' }), /fingerprint/);
});

test('base64url round-trips every byte value', () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual(Array.from(c.b64d(c.b64e(all))), Array.from(all));
  assert.ok(!/[+/=]/.test(c.b64e(all)));
});
