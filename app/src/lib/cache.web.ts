// Browser version of cache.ts, on IndexedDB (localStorage is too small for message history).
const DB = 'winglet-cache';
const STORE = 'kv';
let opening: Promise<IDBDatabase | null> | null = null;

// The browser cache has no keychain key and does not need native recovery.
export function getCacheStatus(): 'ready' | 'unavailable' { return 'ready'; }
export function subscribeCacheStatus(_listener: () => void) { return () => {}; }
export async function checkCacheStatus(): Promise<void> {}
export async function resetCache(): Promise<void> {}

function open(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    try {
      const req = globalThis.indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null); // private mode or storage disabled: the app works, just without offline reading
    }
  });
  return opening;
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return open().then((db) => new Promise<T | undefined>((resolve) => {
    if (!db) return resolve(undefined);
    try {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  }));
}

export async function cacheGet<T>(key: string, fallback: T): Promise<T> {
  const value = await run<T>('readonly', (s) => s.get(key));
  return value === undefined ? fallback : value;
}

export async function cacheSet(key: string, value: unknown): Promise<void> {
  await run('readwrite', (s) => s.put(value, key));
}

export async function cacheRemove(prefix: string): Promise<void> {
  await run('readwrite', (s) => s.delete(IDBKeyRange.bound(prefix, `${prefix}￿`)));
}

/** Resolve on transaction COMMIT, never on the earlier request success. */
export async function cacheSetStrict(key: string, value: unknown): Promise<void> {
  const db = await open();
  if (!db) throw new Error('Offline storage unavailable');
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(new Error('Offline storage unavailable'));
    tx.objectStore(STORE).put(value, key);
  });
}
