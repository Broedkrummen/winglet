import { router, usePathname } from 'expo-router';
import { useEffect, useState, type RefObject } from 'react';
import { Keyboard, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { mainFirst } from '../lib/bots';
import { haptic } from '../lib/haptics';
import { spring, useReducedMotion } from '../lib/motion';
import { usePrefs } from '../lib/prefs';
import { homeChat, useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import { formatDuration } from '../lib/media';
import { useMainBot } from '../lib/mainBot';
import { useVoiceNote } from '../lib/voiceNote';
import { useAddBot } from './AddBot';
import { AgentFace } from './AgentFace';
import { Glass } from './Glass';
import { LivePet } from './LivePet';
import { QuickAsk } from './QuickAsk';
import { Bot, House, Inbox, MessagesSquare, Plus } from './icons';
import { Logo } from './Logo';
import { Badge, Tap } from './ui';

export const TABS = [
  { path: '/', label: 'Home', Icon: House },
  { path: '/chats', label: 'Chats', Icon: MessagesSquare },
  { path: '/inbox', label: 'Inbox', Icon: Inbox },
  { path: '/agent', label: 'Agent', Icon: Bot },
] as const;

const BAR_HEIGHT = 64;

/** Room to leave at the bottom of a tab screen so content can scroll clear of the floating bar. */
export function useTabBarSpace(): number {
  const insets = useSafeAreaInsets();
  return BAR_HEIGHT + 16 + Math.max(insets.bottom, 12);
}

function useTotalPending() {
  return useApp((s) => Object.values(s.runtime).reduce((n, r) => n + (r?.pending ?? 0), 0));
}

function activeIndex(pathname: string) {
  const i = TABS.findIndex((t) => t.path !== '/' && pathname.startsWith(t.path));
  return i >= 0 ? i : 0;
}

/** Phone navigation: a floating glass capsule whose highlight slides between tabs. */
export function FloatingTabBar({ target }: { target?: RefObject<View | null> }) {
  const t = useTheme();
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const pending = useTotalPending();
  const reduced = useReducedMotion();
  const [width, setWidth] = useState(0);
  const [keyboard, setKeyboard] = useState(false);
  const index = activeIndex(pathname);
  // Five slots: two tabs, the main bot in the middle, two tabs.
  const each = width ? (width - 12) / (TABS.length + 1) : 0;
  const slot = index < 2 ? index : index + 1;
  const x = useSharedValue(0);

  useEffect(() => {
    x.value = reduced || !each ? slot * each : withSpring(slot * each, spring.snappy);
  }, [slot, each, reduced, x]);

  // The keyboard pushes the bar up over what you're typing; step aside while it's open.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboard(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboard(false));
    return () => { show.remove(); hide.remove(); };
  }, []);

  const pill = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  if (keyboard) return null;

  return (
    <View pointerEvents="box-none" style={[s.wrap, { bottom: Math.max(insets.bottom, 12) }]}>
      <Glass target={target} style={s.bar} intensity={60}>
        <View accessibilityRole="tablist" style={s.row} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
          {each ? <Animated.View style={[s.pill, { width: each }, pill]} /> : null}
          {TABS.flatMap((tab, i) => {
            const on = i === index;
            const color = on ? t.colors.onAccentSoft : t.colors.textSecondary;
            const item = (
              <Pressable
                key={tab.path}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                accessibilityLabel={tab.path === '/inbox' && pending ? `${tab.label}, ${pending} waiting` : tab.label}
                style={s.item}
                onPress={() => {
                  if (on) return;
                  haptic.selection();
                  router.navigate(tab.path);
                }}
              >
                <View>
                  <tab.Icon size={22} color={color} strokeWidth={on ? 2.3 : 2} />
                  {tab.path === '/inbox' ? <Badge count={pending} style={s.badge} /> : null}
                </View>
                <Text style={[s.label, { color }]} numberOfLines={1}>{tab.label}</Text>
              </Pressable>
            );
            return i === 2 ? [<View key="main" style={s.item} />, item] : [item];
          })}
        </View>
      </Glass>
      <MainBotSlot />
    </View>
  );
}

/**
 * The main bot, always in reach, raised over the middle of the bar (the glass clips, so it sits on top of it):
 * tap to ask it anything, hold to talk to it.
 */
function MainBotSlot() {
  const s = useStyles();
  const t = useTheme();
  const main = useMainBot();
  const pending = useApp((st) => (main ? st.runtime[main.id]?.pending ?? 0 : 0));
  const [open, setOpen] = useState(false);
  const voice = useVoiceNote(main?.id ?? '', () => homeChat(useApp.getState().runtime[main?.id ?? '']));
  if (!main) return null;
  return (
    <View pointerEvents="box-none" style={s.mainWrap}>
      {voice.recording ? <Text style={s.mainRec}>● {formatDuration(voice.durationMs)} · let go to send</Text> : null}
      <View style={[s.mainSlot, { backgroundColor: t.colors.surfaceRaised }]}>
        <LivePet server={main} size={46} accessibilityLabel={`${main.bot.title}. Tap to ask, hold to talk`}
          onTap={() => setOpen(true)} onHoldStart={() => voice.start()} onHoldEnd={(cancelled) => voice.finish(cancelled)} />
        <Badge count={pending} style={s.mainBadge} />
      </View>
      <QuickAsk server={main} visible={open} onClose={() => setOpen(false)} />
    </View>
  );
}

/** Wide screens: a rail with the sections on top and one face per paired bot below. */
export function SideRail() {
  const t = useTheme();
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const pending = useTotalPending();
  const servers = useApp((st) => st.servers);
  const runtime = useApp((st) => st.runtime);
  const selected = useApp((st) => st.selection.serverId);
  const select = useApp((st) => st.select);
  const addBot = useAddBot();
  const chosenMain = usePrefs((st) => st.prefs.mainBot);
  const index = activeIndex(pathname);
  return (
    <View style={[s.rail, { paddingTop: insets.top + 14, paddingBottom: insets.bottom + 14 }]} accessibilityRole="tablist">
      <Logo size={40} />
      <View style={{ gap: 6, marginTop: 14 }}>
        {TABS.map((tab, i) => {
          const on = i === index;
          const color = on ? t.colors.onAccentSoft : t.colors.textSecondary;
          return (
            <Tap key={tab.path} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={tab.label}
              feedback="selection" onPress={() => router.navigate(tab.path)}
              style={({ hovered }) => [s.railItem, on ? { backgroundColor: t.colors.accentSoft } : hovered && { backgroundColor: t.colors.pressed }]}>
              <View>
                <tab.Icon size={22} color={color} strokeWidth={on ? 2.3 : 2} />
                {tab.path === '/inbox' ? <Badge count={pending} style={s.badge} /> : null}
              </View>
              <Text style={[s.railLabel, { color }]}>{tab.label}</Text>
            </Tap>
          );
        })}
      </View>
      <View style={s.railDivider} />
      <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ alignItems: 'center', gap: 10 }} showsVerticalScrollIndicator={false}>
        {mainFirst(servers, chosenMain).map((srv) => {
          const on = srv.id === selected;
          return (
            <Tap key={srv.id} accessibilityLabel={`${srv.bot.title}${on ? ', selected' : ''}`} feedback="selection"
              onPress={() => { if (!on) select(srv.id, homeChat(useApp.getState().runtime[srv.id])); }} style={s.railBot}>
              <View style={[s.railBotMark, { opacity: on ? 1 : 0 }]} />
              <AgentFace server={srv} size={44} shape={on ? 'squircle' : 'circle'} still />
              {runtime[srv.id]?.pending ? <Badge count={runtime[srv.id]!.pending} style={s.railBotBadge} /> : null}
            </Tap>
          );
        })}
        <Tap accessibilityLabel="Add a bot" feedback="selection" onPress={addBot.open} style={s.addBot}>
          <Plus size={22} color={t.colors.success} />
        </Tap>
      </ScrollView>
      {addBot.sheet}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  wrap: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  bar: {
    width: '100%', maxWidth: 460, height: BAR_HEIGHT, borderRadius: t.radius.pill,
    shadowColor: t.colors.shadow, shadowOpacity: t.scheme === 'light' ? 0.12 : 0.5, shadowRadius: 24, shadowOffset: { width: 0, height: 10 },
    elevation: 12,
  },
  row: { flex: 1, flexDirection: 'row', padding: 6 },
  pill: { position: 'absolute', top: 6, bottom: 6, left: 6, borderRadius: t.radius.pill, backgroundColor: t.colors.accentSoft },
  item: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2 },
  label: { fontFamily: t.fonts.semibold, fontSize: 11.5 },
  badge: { position: 'absolute', top: -7, right: -12 },
  mainWrap: { position: 'absolute', bottom: BAR_HEIGHT / 2 - 6, alignItems: 'center' },
  mainSlot: {
    width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: t.colors.border,
    shadowColor: t.colors.shadow, shadowOpacity: t.scheme === 'light' ? 0.16 : 0.5, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 14,
  },
  mainBadge: { position: 'absolute', top: -2, right: -2 },
  mainRec: { marginBottom: 8, fontFamily: t.fonts.semibold, fontSize: 12.5, color: t.colors.danger },
  rail: { width: 88, alignItems: 'center', backgroundColor: t.colors.surface, borderRightWidth: 1, borderRightColor: t.colors.border },
  railItem: { width: 68, paddingVertical: 9, borderRadius: t.radius.md, alignItems: 'center', gap: 3 },
  railLabel: { fontFamily: t.fonts.semibold, fontSize: 11 },
  railDivider: { width: 32, height: 2, borderRadius: 1, backgroundColor: t.colors.border, marginVertical: 14 },
  railBot: { width: 88, alignItems: 'center' },
  railBotMark: { position: 'absolute', left: 0, top: 10, bottom: 10, width: 4, borderTopRightRadius: 4, borderBottomRightRadius: 4, backgroundColor: t.colors.text },
  railBotBadge: { position: 'absolute', right: 14, bottom: -4 },
  addBot: {
    width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center',
    backgroundColor: t.colors.surfaceSunken,
  },
}));
