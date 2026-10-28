import { NavigationBar } from 'expo-navigation-bar';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { Platform, StyleSheet, useColorScheme } from 'react-native';
import { ReducedMotionConfig, ReduceMotion } from 'react-native-reanimated';
import { usePrefs } from './prefs';
import { buildTheme, type AccentName, type DarkTone, type Scheme, type Theme } from './theme';

const themes = new Map<string, Theme>();
/** One theme object per scheme, accent and dark tone, so styles can be cached by identity. */
export function themeFor(scheme: Scheme, accent: AccentName, tone: DarkTone = 'charcoal'): Theme {
  const key = `${scheme}:${accent}:${scheme === 'dark' ? tone : ''}`;
  let t = themes.get(key);
  if (!t) {
    t = buildTheme(scheme, accent, tone);
    themes.set(key, t);
  }
  return t;
}

const ThemeContext = createContext<Theme>(themeFor('dark', 'iris'));

export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const { theme: mode, accent, motion, darkTone } = usePrefs((s) => s.prefs);
  const scheme: Scheme = mode === 'system' ? (system === 'light' ? 'light' : 'dark') : mode;
  const theme = useMemo(() => themeFor(scheme, accent, darkTone), [scheme, accent, darkTone]);

  // Keep the system chrome (status bar, navigation bar, browser UI) in step with the theme.
  useEffect(() => {
    SystemUI.setBackgroundColorAsync(theme.colors.bg).catch(() => undefined);
    if (Platform.OS === 'web') {
      const doc = globalThis.document;
      if (doc) {
        doc.body.style.backgroundColor = theme.colors.bg;
        doc.documentElement.style.colorScheme = scheme;
        let meta = doc.querySelector('meta[name="theme-color"]');
        if (!meta) {
          meta = doc.createElement('meta');
          meta.setAttribute('name', 'theme-color');
          doc.head.appendChild(meta);
        }
        meta.setAttribute('content', theme.colors.bg);
      }
    }
  }, [theme, scheme]);

  return (
    <ThemeContext.Provider value={theme}>
      <ReducedMotionConfig mode={motion === 'reduce' ? ReduceMotion.Always : motion === 'full' ? ReduceMotion.Never : ReduceMotion.System} />
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      {Platform.OS === 'android' ? <NavigationBar style={scheme === 'dark' ? 'dark' : 'light'} /> : null}
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

/** Theme-aware StyleSheet: `const useStyles = makeStyles((t) => ({...}))`, then `const s = useStyles()`. */
export function makeStyles<T extends StyleSheet.NamedStyles<T>>(fn: (t: Theme) => T): () => T {
  const cache = new WeakMap<Theme, T>();
  return function useStyles() {
    const theme = useTheme();
    let styles = cache.get(theme);
    if (!styles) {
      styles = StyleSheet.create(fn(theme));
      cache.set(theme, styles);
    }
    return styles;
  };
}
