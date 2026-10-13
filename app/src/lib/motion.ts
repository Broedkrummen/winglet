import { useEffect, useState } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
import { Easing, useReducedMotion as useSystemReducedMotion } from 'react-native-reanimated';
import { usePrefs } from './prefs';

// Both springs are close to critically damped: they settle without bouncing past where they're going,
// which reads as wobble on a phone (a sheet that overshoots by a few percent shakes by dozens of pixels).
export const spring = {
  /** Buttons, toggles, chips. */
  snappy: { damping: 34, stiffness: 300, mass: 1 },
  /** Sheets, cards, the agent's face. */
  soft: { damping: 26, stiffness: 180, mass: 1 },
};

/** How things arrive and move in lists: quick to start, gentle to land, never past the mark. */
export const easeOut = Easing.out(Easing.cubic);

export const duration = { fast: 150, base: 250, slow: 400 };

/** True when animations should become short fades and loops should stop. */
export function useReducedMotion(): boolean {
  const system = useSystemReducedMotion();
  const pref = usePrefs((s) => s.prefs.motion);
  return pref === 'reduce' || (pref === 'system' && system);
}

/** True when glass should be replaced by solid surfaces (readability, or slow blur). */
export function useReducedTransparency(): boolean {
  const pref = usePrefs((s) => s.prefs.transparency);
  const [system, setSystem] = useState(false);
  useEffect(() => {
    if (pref !== 'system') return;
    if (Platform.OS === 'web') {
      const mq = globalThis.matchMedia?.('(prefers-reduced-transparency: reduce)');
      setSystem(!!mq?.matches);
      return;
    }
    AccessibilityInfo.isReduceTransparencyEnabled?.().then(setSystem).catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('reduceTransparencyChanged', setSystem);
    return () => sub?.remove();
  }, [pref]);
  return pref === 'reduce' || (pref === 'system' && system);
}
