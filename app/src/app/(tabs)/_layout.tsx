import { BlurTargetView } from 'expo-blur';
import { Tabs } from 'expo-router';
import { useRef } from 'react';
import { useWindowDimensions, View } from 'react-native';
import { FloatingTabBar, SideRail } from '../../components/TabBar';
import { WIDE_BREAKPOINT } from '../../lib/theme';
import { useTheme } from '../../lib/themeContext';

/**
 * Home, Chats, Inbox and Agent. Phones get a floating glass tab bar (drawn outside the screens so
 * Android can blur what scrolls under it); wide screens get a side rail with every bot.
 */
export default function TabsLayout() {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const target = useRef<View>(null);
  const tabs = (
    <Tabs
      tabBar={() => null}
      // A tab you can't see doesn't re-render as messages stream in; it catches up when you switch to it.
      screenOptions={{ headerShown: false, animation: 'fade', sceneStyle: { backgroundColor: t.colors.bg }, freezeOnBlur: true }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home' }} />
      <Tabs.Screen name="chats" options={{ title: 'Chats' }} />
      <Tabs.Screen name="inbox" options={{ title: 'Inbox' }} />
      <Tabs.Screen name="agent" options={{ title: 'Agent' }} />
    </Tabs>
  );
  if (width >= WIDE_BREAKPOINT) {
    return (
      <View style={{ flex: 1, flexDirection: 'row', backgroundColor: t.colors.bg }}>
        <SideRail />
        <View style={{ flex: 1 }}>{tabs}</View>
      </View>
    );
  }
  return (
    <View style={{ flex: 1, backgroundColor: t.colors.bg }}>
      <BlurTargetView ref={target} style={{ flex: 1 }}>{tabs}</BlurTargetView>
      <FloatingTabBar target={target} />
    </View>
  );
}
