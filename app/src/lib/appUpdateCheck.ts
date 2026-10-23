import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { create } from 'zustand';
import { type AppUpdate, checkIsFresh, newestUpdate, type Release, RELEASES_URL } from './appUpdate';
import { getJSON, setJSON } from './storage';

const KEY = 'winglet.appUpdate';

type Saved = { checkedAt: number; current: string; update: AppUpdate | null };

type State = {
  update: AppUpdate | null;
  checking: boolean;
  checkedAt?: number;
  failed: boolean;
  /** Looks on GitHub at most twice a day unless forced. Android only: the web app comes from the server. */
  check: (force?: boolean) => Promise<void>;
};

// Development builds can have a different package and signing key. A public release cannot safely
// promise an in-place upgrade of that build; it is updated through the development workflow.
export const appUpdateSupported = Platform.OS === 'android' && (typeof __DEV__ === 'undefined' || !__DEV__);

/** Whether a newer Android app is out on GitHub Releases. */
export const useAppUpdate = create<State>((set, get) => ({
  update: null,
  checking: false,
  failed: false,
  check: async (force = false) => {
    const current = Constants.expoConfig?.version ?? '';
    if (!appUpdateSupported || !current || get().checking) return;
    set({ checking: true });
    // Secure storage can be unavailable. A cache failure must not disable update checks.
    const saved = await getJSON<Saved | null>(KEY, null).catch(() => null);
    if (!force && saved && checkIsFresh(saved, current, Date.now())) {
      set({ update: saved.update, checkedAt: saved.checkedAt, checking: false, failed: false });
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' }, signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const update = newestUpdate((await res.json()) as Release[], current, Device.supportedCpuArchitectures);
      const checkedAt = Date.now();
      set({ update, checkedAt, failed: false });
      // Keep a successful result even if this device cannot save the cache.
      await setJSON(KEY, { checkedAt, current, update } satisfies Saved).catch(() => {});
    } catch {
      // Offline or rate-limited: keep what we knew and try again next time.
      set({ update: saved?.current === current ? saved.update : get().update, failed: true });
    } finally {
      clearTimeout(timeout);
      set({ checking: false });
    }
  },
}));
