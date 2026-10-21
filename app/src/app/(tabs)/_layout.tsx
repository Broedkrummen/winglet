import { Tabs } from 'expo-router';
import { useTheme } from '../../lib/themeContext';

/**
 * Retain section state while the app-wide sidebar owns navigation. No bottom navigation.
 */
export default function TabsLayout() {
  const t = useTheme();
  return (
    <Tabs
      tabBar={() => null}
      // A tab you can't see doesn't re-render as messages stream in; it catches up when you switch to it.
      screenOptions={{ headerShown: false, animation: 'fade', sceneStyle: { backgroundColor: t.colors.bg }, freezeOnBlur: true }}
    >
      <Tabs.Screen name="index" options={{ title: 'Chat' }} />
      <Tabs.Screen name="chats" options={{ title: 'Chats' }} />
      <Tabs.Screen name="inbox" options={{ title: 'Inbox' }} />
      <Tabs.Screen name="agent" options={{ title: 'Agent' }} />
    </Tabs>
  );
}
