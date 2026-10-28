import { create } from 'zustand';
import { getJSON, setJSON } from './storage';
import type { AccentName, DarkTone } from './theme';
import type { SavedModel } from './modelOptions';

export type Prefs = {
  voiceListenWith: 'server' | 'device';
  voiceSpeakWith: 'server' | 'device';
  theme: 'system' | 'light' | 'dark';
  accent: AccentName;
  /** How dark the dark theme is: charcoal (default), graphite, or true black for OLED screens. */
  darkTone: DarkTone;
  /** Bubbles: your messages in accent bubbles, replies unboxed. Compact: everything left-aligned. */
  layout: 'bubbles' | 'compact';
  /** "system" follows the phone's accessibility setting. */
  motion: 'system' | 'reduce' | 'full';
  transparency: 'system' | 'reduce' | 'full';
  haptics: boolean;
  /** Soft interface sounds: poking the pet, sending, a reply landing, something needing you. */
  sounds: boolean;
  /** What a message sent while the agent works does: guide it, wait for it, or interrupt it. */
  busyMode: 'steer' | 'queue' | 'interrupt';
  /** Ask for the phone's fingerprint, face or PIN when opening Winglet (Android app only). */
  appLock: boolean;
  /** Look on GitHub for a newer app (Android app only). */
  updateCheck: boolean;
  /** The bot Home puts first and opens to: its id, or empty to use the first one paired. */
  mainBot: string;
  /** Drawer on phones by default; pinned uses a compact rail on narrow screens. */
  sidebar: 'auto' | 'drawer' | 'pinned';
  /** Chat organization is private to this device, keyed by bot and chat. */
  pinnedChats: string[];
  archivedChats: string[];
  /** Exact provider/model pairs, available only where the current server offers that provider. */
  favoriteModels: SavedModel[];
  recentModels: SavedModel[];
};

export const DEFAULT_PREFS: Prefs = {
  voiceListenWith: 'server', voiceSpeakWith: 'server',
  theme: 'system', accent: 'iris', darkTone: 'charcoal', layout: 'bubbles', motion: 'system', transparency: 'system', haptics: true, sounds: true, busyMode: 'steer', appLock: false, updateCheck: true, mainBot: '', sidebar: 'auto', pinnedChats: [], archivedChats: [], favoriteModels: [], recentModels: [],
};

const KEY = 'winglet.prefs';

type PrefsState = { prefs: Prefs; loaded: boolean; load: () => Promise<void>; update: (patch: Partial<Prefs>) => void };

/** Appearance and feel, stored on this device only. */
export const usePrefs = create<PrefsState>((set, get) => ({
  prefs: DEFAULT_PREFS,
  loaded: false,
  load: async () => {
    const { pureBlack, ...saved } = await getJSON<Partial<Prefs> & { pureBlack?: boolean }>(KEY, {});
    // The old "Pure black" switch becomes the black tone.
    if (pureBlack && !saved.darkTone) saved.darkTone = 'black';
    set({ prefs: { ...DEFAULT_PREFS, ...saved }, loaded: true });
  },
  update: (patch) => {
    const prefs = { ...get().prefs, ...patch };
    set({ prefs });
    setJSON(KEY, prefs);
  },
}));
