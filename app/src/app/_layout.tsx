import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular';
import { Inter_500Medium } from '@expo-google-fonts/inter/500Medium';
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold';
import { Inter_700Bold } from '@expo-google-fonts/inter/700Bold';
import { Inter_800ExtraBold } from '@expo-google-fonts/inter/800ExtraBold';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { useEffect } from 'react';
import { AppState, Platform, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { LockScreen } from '../components/LockScreen';
import { ShareListener } from '../components/ShareListener';
import { Toasts } from '../components/Toasts';
import { lockOnStart, onAppVisibility } from '../lib/appLock';
import { useAppUpdate } from '../lib/appUpdateCheck';
import { watchNetwork } from '../lib/network';
import { attachPersistence } from '../lib/persist';
import { usePrefs } from '../lib/prefs';
import { registerServiceWorker } from '../lib/push';
import { useApp } from '../lib/store';
import { ThemeProvider, useTheme } from '../lib/themeContext';

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, Inter_800ExtraBold });
  const ready = useApp((s) => s.ready);
  const init = useApp((s) => s.init);
  const setForeground = useApp((s) => s.setForeground);
  const setNetwork = useApp((s) => s.setNetwork);
  const prefsLoaded = usePrefs((s) => s.loaded);
  const loadPrefs = usePrefs((s) => s.load);
  const updateCheck = usePrefs((s) => s.loaded && s.prefs.updateCheck);
  const checkForUpdate = useAppUpdate((s) => s.check);

  useEffect(() => {
    const detach = attachPersistence();
    loadPrefs();
    init();
    registerServiceWorker();
    return detach;
  }, [init, loadPrefs]);

  useEffect(() => watchNetwork(setNetwork), [setNetwork]);

  useEffect(() => {
    if (prefsLoaded) lockOnStart();
  }, [prefsLoaded]);

  useEffect(() => {
    if (updateCheck) checkForUpdate();
  }, [updateCheck, checkForUpdate]);

  useEffect(() => {
    if (Platform.OS === 'web') {
      const onVis = () => setForeground(document.visibilityState === 'visible');
      document.addEventListener('visibilitychange', onVis);
      return () => document.removeEventListener('visibilitychange', onVis);
    }
    const sub = AppState.addEventListener('change', (s) => {
      setForeground(s === 'active');
      onAppVisibility(s === 'active');
      // Phones keep the app open for days; the check itself only goes to GitHub twice a day.
      if (s === 'active' && usePrefs.getState().prefs.updateCheck) useAppUpdate.getState().check();
    });
    return () => sub.remove();
  }, [setForeground]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider>
        {/* A font that fails to load falls back to the system font rather than a blank screen. */}
        {(!fontsLoaded && !fontError) || !ready || !prefsLoaded ? <Splash /> : <Navigator />}
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

function Splash() {
  const t = useTheme();
  return <View style={{ flex: 1, backgroundColor: t.colors.bg }} />;
}

function Navigator() {
  const t = useTheme();
  return (
    <SafeAreaProvider style={{ backgroundColor: t.colors.bg }}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.colors.bg }, animation: 'slide_from_right' }}>
        <Stack.Screen name="(tabs)" options={{ animation: 'fade' }} />
        <Stack.Screen name="pair" options={{ animation: 'fade_from_bottom' }} />
        <Stack.Screen name="scan" options={{ animation: 'fade', presentation: 'fullScreenModal' }} />
      </Stack>
      <ShareListener />
      <Toasts />
      <LockScreen />
    </SafeAreaProvider>
  );
}
