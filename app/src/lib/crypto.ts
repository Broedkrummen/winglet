import { gcm } from '@noble/ciphers/aes.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { getRandomBytes } from 'expo-crypto';

// The phone's half of plugin/keys.py: check the server's key against the QR code's fingerprint,
// seal secrets to it, and sign owner actions. tests/fixtures/crypto_vectors.json pins the format on
// both sides.

/** What GET /api/server-key returns. */
export type ServerKeyInfo = { v: number; identity: string; fingerprint: string; sealing: string; sealing_sig: string };

const te = new TextEncoder();
const SEAL = te.encode('winglet-seal-v1');
const SEALING_CONTEXT = te.encode('winglet-sealing-key-v1');
const ADDRESS_CONTEXT = te.encode('winglet-address-v1');

export type Random = (n: number) => Uint8Array;
export const randomBytes: Random = (n) => getRandomBytes(n);

export function b64e(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64d(text: string): Uint8Array {
  const s = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function fingerprint(identity: Uint8Array): string {
  return b64e(sha256(concat(te.encode('winglet-fp-v1'), identity)).slice(0, 16));
}

export class KeyMismatch extends Error {}

/**
 * Check a server's keys before trusting them: its identity must match the fingerprint from the QR
 * code (when there is one) or the one pinned at pairing, and it must have signed its sealing key.
 */
export function checkServerKey(info: ServerKeyInfo, pinned?: string): void {
  const identity = b64d(info.identity);
  const fp = fingerprint(identity);
  if (fp !== info.fingerprint) throw new KeyMismatch("The server's key doesn't match its fingerprint.");
  if (pinned && fp !== pinned) {
    throw new KeyMismatch("This server's key doesn't match the one in your pairing code. Don't continue on this network; pair again from the server.");
  }
  if (!ed25519.verify(b64d(info.sealing_sig), concat(SEALING_CONTEXT, b64d(info.sealing)), identity)) {
    throw new KeyMismatch("The server's encryption key isn't signed by its identity.");
  }
}

/**
 * Whether a server's identity (already checked against the pinned fingerprint) signed "yes, I answer at
 * exactly this address", recently. A relay can pass the question on, but only gets a no for its own address.
 */
export function addressConfirmed(info: ServerKeyInfo, answer: { statement?: unknown; sig?: unknown }, serverId: string,
  url: string, now = Date.now()): boolean {
  if (typeof answer?.statement !== 'string' || typeof answer.sig !== 'string' || answer.statement.length > 4096) return false;
  try {
    if (!ed25519.verify(b64d(answer.sig), concat(ADDRESS_CONTEXT, te.encode(answer.statement)), b64d(info.identity))) return false;
    const s = JSON.parse(answer.statement);
    return s.v === 1 && s.server_id === serverId && s.url === url && s.listed === true &&
      Number.isFinite(s.issued_at) && Math.abs(now / 1000 - s.issued_at) < 3600;
  } catch {
    return false;
  }
}

/**
 * Encrypt to the server: ephemeral X25519 (32) | nonce (12) | AES-256-GCM ciphertext, with the purpose
 * and device id bound in, so a sealed secret can't be replayed for another use or by another phone.
 */
export function seal(info: ServerKeyInfo, purpose: string, deviceId: string, data: unknown, rnd: Random = randomBytes): string {
  const recipient = b64d(info.sealing);
  const ephSecret = rnd(32);
  const ephPublic = x25519.getPublicKey(ephSecret);
  const shared = x25519.getSharedSecret(ephSecret, recipient);
  const key = hkdf(sha256, shared, concat(ephPublic, recipient), SEAL, 32);
  const nonce = rnd(12);
  const aad = concat(SEAL, te.encode(`|${purpose}|${deviceId}`));
  const ciphertext = gcm(key, nonce, aad).encrypt(te.encode(JSON.stringify(data)));
  return b64e(concat(ephPublic, nonce, ciphertext));
}

/** A new signing key for this phone, kept in the keychain; only its public half leaves the device. */
export function newSigningKey(rnd: Random = randomBytes): { secret: string; public: string } {
  const secret = rnd(32);
  return { secret: b64e(secret), public: b64e(ed25519.getPublicKey(secret)) };
}

export function signingPayload(method: string, path: string, body: string | Uint8Array, deviceId: string, time: string, nonce: string): Uint8Array {
  return te.encode(['winglet-sig-v1', method.toUpperCase(), path, hex(sha256(typeof body === 'string' ? te.encode(body) : body)), deviceId, time, nonce].join('\n'));
}

/** Headers that prove an owner action came from this phone, now, once. */
export function signedHeaders(secret: string, deviceId: string, method: string, path: string, body: string | Uint8Array,
  now = Date.now(), rnd: Random = randomBytes): Record<string, string> {
  const time = String(Math.floor(now / 1000));
  const nonce = b64e(rnd(18));
  const signature = ed25519.sign(signingPayload(method, path, body, deviceId, time, nonce), b64d(secret));
  return { 'X-Winglet-Device': deviceId, 'X-Winglet-Time': time, 'X-Winglet-Nonce': nonce, 'X-Winglet-Signature': b64e(signature) };
}
