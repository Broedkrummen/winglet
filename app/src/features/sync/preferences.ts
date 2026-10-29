import type { Prefs } from '../../lib/prefs';
import type { Json, Value } from './model';

/** App lock and physical device permissions must never follow a synced preference. */
const ENUMS = {
  view: ['full', 'simple'], botOpening: ['last', 'main', 'list'],
  voiceListenWith: ['server', 'device'], voiceSpeakWith: ['server', 'device'],
  theme: ['system', 'light', 'dark'], accent: ['iris', 'ocean', 'mint', 'sunset', 'rose', 'mono'],
  darkTone: ['charcoal', 'graphite', 'black'], layout: ['bubbles', 'compact'],
  motion: ['system', 'reduce', 'full'], transparency: ['system', 'reduce', 'full'],
  busyMode: ['steer', 'queue', 'interrupt'], sidebar: ['auto', 'drawer', 'pinned'],
} as const;
const BOOLEANS = ['haptics', 'sounds', 'updateCheck'] as const;
const ARRAYS = ['pinnedChats', 'archivedChats'] as const;
const MODELS = ['favoriteModels', 'recentModels'] as const;
const KEYS = [...Object.keys(ENUMS), ...BOOLEANS, ...ARRAYS, ...MODELS, 'mainBot', 'lastChatByBot'] as (keyof Prefs)[];

export function portablePreferences(prefs: Prefs): Record<string, Value> {
  return Object.fromEntries(KEYS.map(key => [key, { deleted: false, value: prefs[key] as Json }]));
}

export function preferencePatch(values: Record<string, Value>): Partial<Prefs> {
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(values)) {
    if (field.deleted) continue;
    const value = field.value;
    if (Object.hasOwn(ENUMS, key) && (ENUMS[key as keyof typeof ENUMS] as readonly unknown[]).includes(value)) result[key] = value;
    else if ((BOOLEANS as readonly string[]).includes(key) && typeof value === 'boolean') result[key] = value;
    else if (key === 'mainBot' && typeof value === 'string' && value.length <= 200) result[key] = value;
    else if ((ARRAYS as readonly string[]).includes(key) && Array.isArray(value) && value.length <= 5000
      && value.every(item => typeof item === 'string' && item.length <= 500)) result[key] = value;
    else if (key === 'lastChatByBot' && value && !Array.isArray(value) && typeof value === 'object'
      && Object.keys(value).length <= 1000 && Object.entries(value).every(([k, v]) => k.length <= 200 && typeof v === 'string' && v.length <= 200)) result[key] = value;
    else if ((MODELS as readonly string[]).includes(key) && Array.isArray(value) && value.length <= 1000
      && value.every(item => item && typeof item === 'object' && !Array.isArray(item)
        && typeof item.provider === 'string' && typeof item.model === 'string')) result[key] = value;
  }
  return result as Partial<Prefs>;
}

export function changedValues(before: Record<string, Value>, after: Record<string, Value>): Record<string, Value> {
  const canonical = (field: Value | undefined) => field === undefined ? '' : JSON.stringify(
    field.deleted ? { deleted: true } : { deleted: false, value: field.value },
    (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
  return Object.fromEntries(Object.entries(after).filter(([key, value]) => canonical(before[key]) !== canonical(value)));
}
