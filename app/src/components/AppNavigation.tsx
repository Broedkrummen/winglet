import { router, usePathname } from 'expo-router';
import { BlurTargetView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BackHandler, Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useShallow } from 'zustand/react/shallow';
import { startNewChat } from '../lib/actions';
import { useLock } from '../lib/appLock';
import { chatKey } from '../lib/chatOrganization';
import { chatActivity, chatActivityLabel, draftPreview, matchesChatFilter, type ChatFilter } from '../lib/chatActivity';
import { haptic } from '../lib/haptics';
import { spring, useReducedMotion, useReducedTransparency } from '../lib/motion';
import { navigationWidth, sidebarChats, sidebarDrawerWidth } from '../lib/navigation';
import { usePrefs } from '../lib/prefs';
import { homeChat, useApp } from '../lib/store';
import { useActivityClock } from '../lib/useActivityClock';
import { makeStyles, useTheme } from '../lib/themeContext';
import { alpha } from '../lib/theme';
import type { Chat, Server } from '../lib/types';
import { ChatMenu } from './ChatMenu';
import { ChatFilters } from './ChatFilters';
import { Glass } from './Glass';
import { KeyboardViewport } from './KeyboardViewport';
import { Bot, Inbox, MessageCircle, MessageSquarePlus, MessagesSquare, MoreHorizontal, PanelLeft, Pin, Settings } from './icons';
import { Badge, IconButton, SearchField, Tap } from './ui';

const Navigation = createContext({ open: () => {}, close: () => {}, home: () => {}, homeRevision: 0, reserved: 0 });
const NO_CHATS = {};
const NO_TYPING = {};
const NO_INBOX = {};
export const useAppNavigation = () => useContext(Navigation);
export function useContentWidth() { return useWindowDimensions().width - useAppNavigation().reserved; }

/** One navigation shell for the landing chat, conversations and every settings screen. */
export function AppNavigation({ children }: { children: ReactNode }) {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const mode = usePrefs((s) => s.prefs.sidebar);
  const paired = useApp((s) => s.servers.length > 0);
  const locked = useLock((s) => s.locked);
  const pathname = usePathname();
  const [opened, setOpened] = useState(false);
  const [homeRevision, setHomeRevision] = useState(0);
  const reserved = paired && !locked && pathname !== '/pair' ? navigationWidth(width, mode) : 0;
  const close = useCallback(() => setOpened(false), []);
  const open = useCallback(() => { if (useLock.getState().locked) return; Keyboard.dismiss(); setOpened(true); }, []);
  const home = useCallback(() => {
    if (useLock.getState().locked) return;
    Keyboard.dismiss();
    close();
    setHomeRevision((n) => n + 1);
    router.navigate('/');
  }, [close]);
  const value = useMemo(() => ({ open, close, home, homeRevision, reserved }), [open, close, home, homeRevision, reserved]);
  useEffect(close, [pathname, mode, close]);
  useEffect(() => { if (locked) close(); }, [locked, close]);
  useEffect(() => {
    if (Platform.OS !== 'web' || !opened) return;
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [opened, close]);
  return <Navigation.Provider value={value}>
    <View style={{ flex: 1, flexDirection: 'row', backgroundColor: t.colors.bg }}>
      {reserved >= 280 ? <Sidebar onClose={() => usePrefs.getState().update({ sidebar: 'drawer' })} /> : reserved ? <NavigationRail /> : null}
      <View style={{ flex: 1, minWidth: 0 }} pointerEvents={locked ? 'none' : 'auto'} aria-hidden={opened || locked} importantForAccessibility={opened || locked ? 'no-hide-descendants' : 'auto'}>{children}</View>
      {locked ? null : <SidebarDrawer visible={opened} onClose={close} />}
    </View>
  </Navigation.Provider>;
}

export function NavigationToggle() {
  const t = useTheme();
  const nav = useAppNavigation();
  return <IconButton label={nav.reserved >= 280 ? 'Collapse sidebar' : 'Open sidebar'} onPress={nav.reserved >= 280 ? () => usePrefs.getState().update({ sidebar: 'drawer' }) : nav.open}>
    <MoreHorizontal size={24} color={t.colors.text} />
  </IconButton>;
}

export function InboxButton() {
  const t = useTheme();
  const count = useApp((s) => Object.values(s.runtime).reduce((n, rt) => n + (rt?.pending ?? 0), 0));
  return <IconButton label={count ? `Inbox, ${count} waiting` : 'Inbox'} onPress={() => router.navigate('/inbox')}>
    <View><Inbox size={22} color={t.colors.text} /><Badge count={count} style={{ position: 'absolute', top: -9, right: -10 }} /></View>
  </IconButton>;
}

export function NavigationHeader({ title, inbox = false, right }: { title?: string; inbox?: boolean; right?: ReactNode }) {
  const s = useStyles();
  const insets = useSafeAreaInsets();
  return <View style={[s.header, { paddingTop: insets.top + 6 }]}>
    <NavigationToggle />
    <Text numberOfLines={1} accessibilityRole="header" style={s.headerTitle}>{title}</Text>
    {right}{inbox ? <InboxButton /> : null}
  </View>;
}

function SidebarDrawer({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const t = useTheme();
  const reduced = useReducedMotion();
  const { width } = useWindowDimensions();
  const drawerWidth = sidebarDrawerWidth(width);
  const x = useSharedValue(-drawerWidth);
  const opacity = useSharedValue(0);
  useEffect(() => {
    // Closing releases the overlay immediately; interaction must never depend on an animation callback.
    opacity.value = visible ? withTiming(1, { duration: reduced ? 0 : 180 }) : 0;
    x.value = visible ? reduced ? 0 : withSpring(0, spring.snappy) : -drawerWidth;
  }, [visible, drawerWidth, reduced, x, opacity]);
  useEffect(() => {
    if (!visible || Platform.OS === 'web') return;
    const back = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => back.remove();
  }, [visible, onClose]);
  const panel = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const dim = useAnimatedStyle(() => ({ opacity: opacity.value }));
  const pan = Gesture.Pan().activeOffsetX(-12).failOffsetY([-16, 16])
    .onUpdate((e) => { x.value = Math.min(0, e.translationX); })
    .onEnd((e, success) => {
      if (success && (e.translationX < -drawerWidth * 0.25 || e.velocityX < -650)) runOnJS(onClose)();
      else x.value = reduced ? 0 : withSpring(0, spring.snappy);
    }).onFinalize((_e, success) => { if (!success) x.value = reduced ? 0 : withSpring(0, spring.snappy); });
  if (!visible) return null;
  return <View accessibilityViewIsModal style={[StyleSheet.absoluteFill, { zIndex: 100, elevation: 30 }]}>
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Animated.View style={[{ position: 'absolute', inset: 0, backgroundColor: t.colors.overlay }, dim]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close sidebar" onPress={onClose} style={{ flex: 1 }} />
      </Animated.View>
      <View style={{ width: drawerWidth, flex: 1 }}>
      <KeyboardViewport>{() => <GestureDetector gesture={pan} touchAction="pan-y">
        <Animated.View accessibilityViewIsModal style={[{ width: drawerWidth, flex: 1 }, panel]}>
          <Sidebar onClose={onClose} drawer />
        </Animated.View>
      </GestureDetector>}</KeyboardViewport>
      </View>
    </GestureHandlerRootView>
  </View>;
}

function Sidebar({ onClose, drawer = false }: { onClose: () => void; drawer?: boolean }) {
  const t = useTheme();
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const navigation = useAppNavigation();
  const servers = useApp((st) => st.servers);
  const selected = useApp((st) => st.selection);
  const chats = useApp(useShallow((st) => Object.fromEntries(st.servers.map((bot) => [bot.id, st.runtime[bot.id]?.chats ?? NO_CHATS]))));
  const prefs = usePrefs((st) => st.prefs);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ChatFilter>('all');
  const typing = useApp(useShallow((st) => Object.fromEntries(st.servers.map((bot) => [bot.id, st.runtime[bot.id]?.typing ?? NO_TYPING]))));
  const inbox = useApp(useShallow((st) => Object.fromEntries(st.servers.map((bot) => [bot.id, st.runtime[bot.id]?.inbox ?? NO_INBOX]))));
  const roles = useApp(useShallow((st) => Object.fromEntries(st.servers.map((bot) => [bot.id, st.runtime[bot.id]?.me?.role ?? 'owner']))));
  const drafts = useApp((st) => st.drafts);
  const draftFiles = useApp((st) => st.draftFiles);
  const replyTo = useApp((st) => st.replyTo);
  const now = useActivityClock(typing);
  const [menu, setMenu] = useState<{ server: Server; chat: Chat } | null>(null);
  const glassTarget = useRef<View>(null);
  const reducedTransparency = useReducedTransparency();
  // Actionable chats remain findable even if they were archived on this device.
  const all = useMemo(() => {
    const previews = Object.fromEntries(servers.flatMap((bot) => Object.values(chats[bot.id] ?? {}).map((chat) => {
      const key = `${bot.id}:${chat.id}`;
      return [chatKey(bot.id, chat.id), draftPreview(drafts[key], draftFiles[key], !!replyTo[key])];
    })));
    return sidebarChats(servers, chats, prefs.pinnedChats, filter === 'all' ? prefs.archivedChats : [], query, previews);
  }, [servers, chats, prefs.pinnedChats, prefs.archivedChats, query, filter, drafts, draftFiles, replyTo]);
  const stateOf = (botId: string, chatId: string) => chatActivity({ typing: typing[botId], inbox: inbox[botId], me: { role: roles[botId] } }, chatId, now);
  const rows = all.filter(({ server: bot, chat }) => matchesChatFilter(filter, stateOf(bot.id, chat.id)));
  const counts = servers.reduce((total, bot) => {
    for (const chat of Object.values(chats[bot.id] ?? {})) {
      if (chat.kind !== 'chat') continue;
      const state = stateOf(bot.id, chat.id);
      total.running += Number(state.running);
      total.pending += Number(state.pending > 0);
    }
    return total;
  }, { running: 0, pending: 0 });
  const [creating, setCreating] = useState(false);
  const go = (path: string) => { Keyboard.dismiss(); if (drawer) onClose(); if (path === '/') navigation.home(); else router.navigate(path); };
  const server = servers.find((bot) => bot.id === selected.serverId) ?? servers[0];
  const newChat = async () => {
    if (!server || creating) return;
    setCreating(true);
    await startNewChat(server.id, (id) => {
      useApp.getState().select(server.id, id);
      go(`/chat/${server.id}/${id}`);
    });
    setCreating(false);
  };
  const nav = (label: string, Icon: typeof Bot, path: string) => <Tap key={path} accessibilityLabel={label} onPress={() => go(path)}
    style={[s.navRow, pathname === path && s.active]}>
    <Icon size={19} color={t.colors.textSecondary} /><Text style={s.navText}>{label}</Text>
  </Tap>;
  return <View style={[s.sidebar, { width: drawer ? '100%' : 280, paddingTop: insets.top + 8, paddingBottom: Math.max(insets.bottom, 12) }]}>
    {!reducedTransparency ? <BlurTargetView ref={glassTarget} pointerEvents="none" style={StyleSheet.absoluteFill}>
      <LinearGradient colors={[alpha(t.colors.accent, t.scheme === 'dark' ? 0.12 : 0.09), 'transparent', alpha(t.colors.accent, 0.04)]}
        start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
    </BlurTargetView> : null}
    <Glass target={glassTarget} intensity={24} borderless style={StyleSheet.absoluteFill} />
    <View style={s.brandRow}><Text style={s.brand}>Winglet</Text><IconButton label="Close sidebar" onPress={onClose}><PanelLeft size={21} color={t.colors.textSecondary} /></IconButton></View>
    <View style={s.mainLinks}>
      <View style={s.groupCard}>
      <Text style={s.groupTitle}>Conversations</Text>
      {nav('Chat', MessageCircle, '/')}
      <Tap accessibilityLabel="New chat" disabled={creating} accessibilityState={{ disabled: creating }} onPress={newChat} style={s.navRow}>
        <MessageSquarePlus size={19} color={t.colors.textSecondary} /><Text style={s.navText}>{creating ? 'Creating…' : 'New chat'}</Text>
      </Tap>
      </View>
    </View>
    <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 16 }}>
      <View style={s.groupCard}>
      <SearchField value={query} onChangeText={setQuery} placeholder="Search chats" style={s.historySearch} />
      <ChatFilters value={filter} counts={counts} onChange={(value) => { if (value !== 'archived') setFilter(value); }} />
      {rows.length ? rows.slice(0, query || filter !== 'all' ? 100 : 40).map(({ server: bot, chat, pinned }, index) => {
        const previous = rows[index - 1];
        const group = index === 0 || pinned !== previous?.pinned;
        const active = pathname.startsWith('/chat/') && selected.serverId === bot.id && selected.chatId === chat.id;
        const state = stateOf(bot.id, chat.id);
        const draft = draftPreview(drafts[`${bot.id}:${chat.id}`], draftFiles[`${bot.id}:${chat.id}`], !!replyTo[`${bot.id}:${chat.id}`]);
        const status = chatActivityLabel(state);
        return <View key={chatKey(bot.id, chat.id)}>
          {group ? <Text style={s.section}>{filter === 'running' ? 'Running' : filter === 'needs-you' ? 'Needs you' : pinned ? 'Pinned' : 'Recent chats'}</Text> : null}
          <Tap accessibilityLabel={`${chat.id === homeChat(useApp.getState().runtime[bot.id]) ? `${bot.bot.title} main chat` : chat.title}${pinned ? ', pinned' : ''}${status ? `, ${status}` : ''}${draft ? `, ${draft}` : ''}`}
            accessibilityHint="Long-press for chat options" onLongPress={() => { Keyboard.dismiss(); setMenu({ server: bot, chat }); }} delayLongPress={350}
            accessibilityState={{ selected: active }} onPress={() => { haptic.selection(); useApp.getState().select(bot.id, chat.id); go(`/chat/${bot.id}/${chat.id}`); }}
            style={[s.chatRow, active && s.active]}>
            {pinned ? <Pin size={14} color={t.colors.textSecondary} /> : null}
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.chatTitle} numberOfLines={1}>{chat.id === homeChat(useApp.getState().runtime[bot.id]) ? `${bot.bot.title}` : chat.title}</Text>
              {draft || status ? <Text numberOfLines={1} style={[s.chatBot, { color: state.pending ? t.colors.warning : t.colors.onAccentSoft }]}>{draft ?? status}</Text> : null}
              {servers.length > 1 && chat.id !== homeChat(useApp.getState().runtime[bot.id]) ? <Text style={s.chatBot} numberOfLines={1}>{bot.bot.title}</Text> : null}
            </View>
            {status ? <View accessibilityLabel={status} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: state.pending ? t.colors.warning : t.colors.accent }} /> : null}
            <IconButton label={`Options for ${chat.title}`} size={36} onPress={(e) => { e.stopPropagation(); Keyboard.dismiss(); setMenu({ server: bot, chat }); }}>
              <MoreHorizontal size={17} color={t.colors.textSecondary} />
            </IconButton>
          </Tap>
        </View>;
      }) : <Text style={s.noChats}>{query ? 'No matching chats' : filter === 'running' ? 'No tasks running.' : filter === 'needs-you' ? 'Nothing waiting on you.' : 'Your conversations will appear here.'}</Text>}
      <Tap accessibilityLabel="All chats and archived chats" onPress={() => go('/chats')} style={s.navRow}>
        <MessagesSquare size={17} color={t.colors.textSecondary} /><Text style={s.more}>All chats & archived</Text>
      </Tap>
      </View>
    </ScrollView>
    <View style={s.footer}>
      <View style={s.groupCard}>
      <Text style={s.groupTitle}>Workspace</Text>
      {nav('Agent', Bot, '/agent')}
      {nav('Settings', Settings, '/settings')}
      </View>
    </View>
    {menu ? <ChatMenu server={menu.server} chatId={menu.chat.id} title={menu.chat.title} visible onClose={() => setMenu(null)} /> : null}
  </View>;
}

function NavigationRail() {
  const t = useTheme();
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const nav = useAppNavigation();
  const pathname = usePathname();
  const count = useApp((st) => Object.values(st.runtime).reduce((n, rt) => n + (rt?.pending ?? 0), 0));
  const item = (label: string, Icon: typeof Bot, path?: string, action?: () => void) => {
    const active = path === '/' ? pathname === '/' || pathname.startsWith('/chat/') : !!path && pathname === path;
    return <View key={label} style={s.railSlot}>
      {active ? <View style={s.railIndicator} /> : null}
      <Tap accessibilityLabel={label} accessibilityState={{ selected: active }} feedback="selection"
        onPress={action ?? (() => router.navigate(path!))} style={({ pressed, hovered }) => [s.railButton, active && s.railButtonActive,
          (pressed || hovered) && !active && { backgroundColor: t.colors.pressed, borderRadius: 16 }]}>
        <Icon size={22} color={active ? t.colors.onAccent : t.colors.textSecondary} />
        {path === '/inbox' ? <Badge count={count} style={{ position: 'absolute', right: -2, top: -3 }} /> : null}
      </Tap>
    </View>;
  };
  return <View style={[s.rail, { paddingTop: insets.top + 8, paddingBottom: Math.max(12, insets.bottom) }]}>
    {item('Open sidebar', PanelLeft, undefined, nav.open)}
    <View style={s.railDivider} />
    {item('Chat', MessageCircle, '/', nav.home)}
    {item('All chats', MessagesSquare, '/chats')}
    {item('Inbox', Inbox, '/inbox')}
    <View style={{ flex: 1 }} />
    <View style={s.railDivider} />
    {item('Agent', Bot, '/agent')}
    {item('Settings', Settings, '/settings')}
  </View>;
}

const useStyles = makeStyles((t) => ({
  sidebar: { height: '100%', backgroundColor: t.colors.surface, borderRightWidth: 1, borderRightColor: t.colors.border },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingBottom: 8 },
  headerTitle: { flex: 1, minWidth: 0, ...t.type.bodyStrong, color: t.colors.text, textAlign: 'center' },
  brandRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 22, paddingRight: 12, paddingBottom: 12 },
  brand: { ...t.type.heading, color: t.colors.text },
  mainLinks: { paddingHorizontal: 12, paddingBottom: 12 },
  groupCard: { padding: 6, borderRadius: 20, backgroundColor: alpha(t.colors.surfaceRaised, t.scheme === 'dark' ? 0.68 : 0.76), borderWidth: 1, borderColor: t.colors.borderStrong,
    shadowColor: t.colors.shadow, shadowOpacity: t.scheme === 'dark' ? 0.08 : 0.025, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } },
  historySearch: { margin: 6, marginBottom: 4, height: 40, backgroundColor: alpha(t.colors.surfaceSunken, 0.65), borderRadius: 13 },
  groupTitle: { ...t.type.caption, color: t.colors.textSecondary, fontFamily: t.fonts.semibold, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 6 },
  navRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 46, paddingHorizontal: 12, borderRadius: 12 },
  navText: { ...t.type.body, color: t.colors.text, fontSize: 15 },
  active: { backgroundColor: t.colors.pressed },
  section: { ...t.type.caption, fontFamily: t.fonts.semibold, color: t.colors.textSecondary, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8 },
  chatRow: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 48, paddingVertical: 5, paddingLeft: 12, paddingRight: 2, borderRadius: 12 },
  chatTitle: { ...t.type.callout, color: t.colors.text },
  chatBot: { ...t.type.caption, color: t.colors.textTertiary, fontSize: 11, marginTop: 3 },
  noChats: { ...t.type.callout, color: t.colors.textSecondary, padding: 14, marginTop: 12 },
  more: { ...t.type.caption, color: t.colors.textSecondary },
  footer: { paddingHorizontal: 12, paddingTop: 8 },
  rail: { width: 64, alignItems: 'center', gap: 9, backgroundColor: t.colors.surface, borderRightWidth: 1, borderRightColor: t.colors.border },
  railSlot: { width: 64, alignItems: 'center', justifyContent: 'center', minHeight: 46 },
  railButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 23, backgroundColor: t.colors.surfaceRaised },
  railButtonActive: { borderRadius: 15, backgroundColor: t.colors.accentFill },
  railIndicator: { position: 'absolute', left: 0, top: 10, bottom: 10, width: 3, borderTopRightRadius: 3, borderBottomRightRadius: 3, backgroundColor: t.colors.accent },
  railDivider: { width: 26, height: 1, backgroundColor: t.colors.borderStrong, marginVertical: 2 },
}));
