import { PhoneRequestSheet } from '../features/phone-tools/RequestSheet';
import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular';
import { Inter_500Medium } from '@expo-google-fonts/inter/500Medium';
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold';
import { Inter_700Bold } from '@expo-google-fonts/inter/700Bold';
import { Inter_800ExtraBold } from '@expo-google-fonts/inter/800ExtraBold';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { AppState, Platform, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { UpdatePrompt } from '../components/AppUpdate';
import { AppNavigation } from '../components/AppNavigation';
import { LockScreen } from '../components/LockScreen';
import { ShareListener } from '../components/ShareListener';
import { Toasts } from '../components/Toasts';
import { VerifySheet } from '../components/VerifyPhone';
import { clearUpdateDownloads } from '../lib/appInstall';
import { lockOnStart, onAppVisibility } from '../lib/appLock';
import { resolveMainBot } from '../lib/bots';
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
  const [opened, setOpened] = useState(false);

  // Every time the app starts it opens on the main bot, not on whichever one was open last. Its chats aren't
  // loaded yet, so no chat is picked here: the screens fall back to its main chat once they know it.
  useEffect(() => {
    if (!ready || !prefsLoaded || opened) return;
    const { servers, select, selection } = useApp.getState();
    const main = resolveMainBot(servers, usePrefs.getState().prefs.mainBot);
    if (main && main.id !== selection.serverId) select(main.id);
    setOpened(true);
  }, [ready, prefsLoaded, opened]);

  useEffect(() => {
    const detach = attachPersistence();
    loadPrefs();
    init();
    registerServiceWorker();
    if (Platform.OS === 'android') clearUpdateDownloads();
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
      onVis();
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
        {(!fontsLoaded && !fontError) || !ready || !prefsLoaded || !opened ? <Splash /> : <Navigator />}
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
      <AppNavigation>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.colors.bg }, animation: 'slide_from_right' }}>
        {/* Under an open chat or screen, the tabs don't re-render; they catch up when you come back. */}
        <Stack.Screen name="(tabs)" options={{ animation: 'fade', freezeOnBlur: true }} />
        <Stack.Screen name="pair" options={{ animation: 'fade_from_bottom' }} />
        <Stack.Screen name="scan" options={{ animation: 'fade', presentation: 'fullScreenModal' }} />
      </Stack>
      <ShareListener />
      <Toasts />
      <UpdatePrompt />
      <VerifySheet />
      <PhoneRequestSheet />
      </AppNavigation>
      <LockScreen />
    </SafeAreaProvider>
  );
}
