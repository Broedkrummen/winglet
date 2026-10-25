import { SQLiteStorage } from 'expo-sqlite/kv-store';
import { gcm } from '@noble/ciphers/aes.js';
import { getRandomBytes } from 'expo-crypto';
import { b64d, b64e } from './crypto';
import { getItem, setItem } from './storage';

// Native chats, drafts and unsent messages are sealed before reaching SQLite. The device key lives
// beside the pairing credentials in the OS keychain; the browser has its own IndexedDB adapter.
const db = new SQLiteStorage('winglet-cache');
const KEY = 'winglet.cache-key.v1';
const PREFIX = 'winglet-cache:v1:';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let deviceKey: Uint8Array | undefined;
let migrated = false;
let queue: Promise<unknown> = Promise.resolve();

// Migration, saves and removal share one queue, so an older migration/read can never replace a
// newer draft or resurrect a removed bot. A rejected operation must not block subsequent saves.
function ordered<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work);
  queue = next.catch(() => undefined);
  return next;
}

function seal(key: string, raw: string): string {
  const nonce = getRandomBytes(12);
  const ciphertext = gcm(deviceKey!, nonce, encoder.encode(`${PREFIX}${key}`)).encrypt(encoder.encode(raw));
  return `${PREFIX}${b64e(nonce)}:${b64e(ciphertext)}`;
}

function open(key: string, raw: string): string {
  if (!raw.startsWith(PREFIX)) throw new Error('Unsealed cache entry');
  const [nonce, ciphertext] = raw.slice(PREFIX.length).split(':');
  return decoder.decode(gcm(deviceKey!, b64d(nonce), encoder.encode(`${PREFIX}${key}`)).decrypt(b64d(ciphertext)));
}

async function ready(): Promise<void> {
  if (migrated) return;
  const keys = await db.getAllKeysAsync();
  if (!deviceKey) {
    const saved = await getItem(KEY);
    if (saved) {
      const bytes = b64d(saved);
      if (bytes.length !== 32) throw new Error('Invalid cache key');
      deviceKey = bytes;
    } else {
      // A restored database can outlive its keychain entry. Do not replace that key or overwrite
      // unreadable encrypted outbox entries; clearing the cache can recover this condition.
      for (const key of keys) {
        if ((await db.getItemAsync(key))?.startsWith(PREFIX)) throw new Error('Cache key unavailable');
      }
      const bytes = getRandomBytes(32);
      await setItem(KEY, b64e(bytes));
      deviceKey = bytes;
    }
  }
  // Existing installations keep their drafts and outbox. Interrupted migrations resume safely;
  // already sealed entries stay untouched, and malformed legacy rows remain unreadable.
  for (const key of keys) {
    const raw = await db.getItemAsync(key);
    if (raw === null || raw.startsWith(PREFIX)) continue;
    try { JSON.parse(raw); } catch { await db.removeItemAsync(key); continue; }
    await db.setItemAsync(key, seal(key, raw));
  }
  migrated = true;
}

export async function cacheGet<T>(key: string, fallback: T): Promise<T> {
  try {
    return await ordered(async () => {
      await ready();
      const raw = await db.getItemAsync(key);
      return raw ? (JSON.parse(open(key, raw)) as T) : fallback;
    });
  } catch {
    return fallback;
  }
}

export async function cacheSet(key: string, value: unknown): Promise<void> {
  try {
    const raw = JSON.stringify(value);
    await ordered(async () => {
      await ready();
      await db.setItemAsync(key, seal(key, raw));
    });
  } catch { /* a full or unavailable cache cannot prevent live use */ }
}

export async function cacheRemove(prefix: string): Promise<void> {
  try {
    await ordered(async () => {
      const keys = await db.getAllKeysAsync();
      for (const key of keys) if (key.startsWith(prefix)) await db.removeItemAsync(key);
    });
  } catch { /* ignore */ }
}

/** Durable replay checkpoints must learn when storage failed. */
export async function cacheSetStrict(key: string, value: unknown): Promise<void> {
  const raw = JSON.stringify(value);
  await ordered(async () => { await ready(); await db.setItemAsync(key, seal(key, raw)); });
}
