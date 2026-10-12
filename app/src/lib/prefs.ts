import { create } from 'zustand';
import { getJSON, setJSON } from './storage';
import type { AccentName } from './theme';

export type Prefs = {
  theme: 'system' | 'light' | 'dark';
  accent: AccentName;
  /** Bubbles: your messages in accent bubbles, replies unboxed. Compact: everything left-aligned. */
  layout: 'bubbles' | 'compact';
  /** "system" follows the phone's accessibility setting. */
  motion: 'system' | 'reduce' | 'full';
  transparency: 'system' | 'reduce' | 'full';
  haptics: boolean;
  /** What a message sent while the agent works does: guide it, wait for it, or interrupt it. */
  busyMode: 'steer' | 'queue' | 'interrupt';
  /** Ask for the phone's fingerprint, face or PIN when opening Winglet (Android app only). */
  appLock: boolean;
  /** Look on GitHub for a newer app (Android app only). */
  updateCheck: boolean;
};

export const DEFAULT_PREFS: Prefs = {
  theme: 'system', accent: 'iris', layout: 'bubbles', motion: 'system', transparency: 'system', haptics: true, busyMode: 'steer', appLock: false, updateCheck: true,
};

const KEY = 'winglet.prefs';

type PrefsState = { prefs: Prefs; loaded: boolean; load: () => Promise<void>; update: (patch: Partial<Prefs>) => void };

/** Appearance and feel, stored on this device only. */
export const usePrefs = create<PrefsState>((set, get) => ({
  prefs: DEFAULT_PREFS,
  loaded: false,
  load: async () => {
    const saved = await getJSON<Partial<Prefs>>(KEY, {});
    set({ prefs: { ...DEFAULT_PREFS, ...saved }, loaded: true });
  },
  update: (patch) => {
    const prefs = { ...get().prefs, ...patch };
    set({ prefs });
    setJSON(KEY, prefs);
  },
}));
