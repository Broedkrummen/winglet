import { create } from 'zustand';
import { api } from './api';
import type { Server } from './types';

/** This device's notification settings, kept on the server so they apply even while the app is closed. */
export type PushPrefs = {
  /** Chat id (or "*" for everything) to the time the mute ends; 0 means until turned back on. */
  muted: Record<string, number>;
  quiet?: { start: string; end: string; utc_offset_min: number; allow_urgent: boolean };
};

type State = {
  byServer: Record<string, PushPrefs>;
  load: (server: Server) => Promise<PushPrefs | undefined>;
  save: (server: Server, change: (p: PushPrefs) => PushPrefs) => Promise<void>;
};

const EMPTY: PushPrefs = { muted: {} };
const localOffset = () => -new Date().getTimezoneOffset();
export const pushPrefsKey = (server: Pick<Server, 'id' | 'parent'>) => server.parent ?? server.id;
const saves = new Map<string, Promise<void>>();
const revisions = new Map<string, number>();

export const usePushPrefs = create<State>((set, get) => ({
  byServer: {},
  load: async (server) => {
    const key = pushPrefsKey(server);
    const revision = revisions.get(key) ?? 0;
    try {
      const { prefs } = await api<{ prefs: PushPrefs }>(server, '/api/push/prefs');
      if (revision !== (revisions.get(key) ?? 0) || saves.has(key)) return get().byServer[key];
      const clean = { ...EMPTY, ...prefs };
      set((st) => ({ byServer: { ...st.byServer, [key]: clean } }));
      // Quiet hours are kept in the phone's time zone; follow it when it changes (travel, daylight saving).
      if (clean.quiet && clean.quiet.utc_offset_min !== localOffset()) {
        await get().save(server, (p) => ({ ...p, quiet: p.quiet && { ...p.quiet, utc_offset_min: localOffset() } }));
      }
      return clean;
    } catch {
      return get().byServer[key];
    }
  },
  save: async (server, change) => {
    const key = pushPrefsKey(server);
    const task = (saves.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      // Serialise changes for one device: rapid toggles must build on the last saved
      // preferences, including changes made from another bot on the same server.
      let before = get().byServer[key];
      if (!before) before = { ...EMPTY, ...(await api<{ prefs: PushPrefs }>(server, '/api/push/prefs')).prefs };
      const next = change(before);
      revisions.set(key, (revisions.get(key) ?? 0) + 1);
      set((st) => ({ byServer: { ...st.byServer, [key]: next } }));
      try {
        const { prefs } = await api<{ prefs: PushPrefs }>(server, '/api/push/prefs', { method: 'PUT', body: JSON.stringify({ prefs: next }) });
        set((st) => ({ byServer: { ...st.byServer, [key]: { ...EMPTY, ...prefs } } }));
      } catch (e) {
        set((st) => ({ byServer: { ...st.byServer, [key]: before } }));
        throw e;
      }
    });
    saves.set(key, task);
    try { await task; } finally { if (saves.get(key) === task) saves.delete(key); }
  },
}));

export function quietHours(start: string, end: string, allowUrgent: boolean): PushPrefs['quiet'] {
  return { start, end, utc_offset_min: localOffset(), allow_urgent: allowUrgent };
}

/** When a chat's mute ends: 0 for "until turned back on", undefined when it isn't muted. */
export function mutedUntil(prefs: PushPrefs | undefined, chatId: string, now = Date.now() / 1000): number | undefined {
  const until = prefs?.muted?.[chatId];
  if (until === undefined) return undefined;
  return until === 0 || until > now ? until : undefined;
}
