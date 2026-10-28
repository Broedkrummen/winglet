import { router, usePathname } from 'expo-router';
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { BackHandler, Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useShallow } from 'zustand/react/shallow';
import { startNewChat } from '../lib/actions';
import { simpleBotChat, simpleSidebarWidth } from '../lib/simpleView';
import { useLock } from '../lib/appLock';
import { chatKey } from '../lib/chatOrganization';
import { chatActivity, chatActivityLabel, draftPreview, matchesChatFilter, type ChatFilter } from '../lib/chatActivity';
import { haptic } from '../lib/haptics';
import { spring, useReducedMotion } from '../lib/motion';
import { navigationWidth, sidebarChats, sidebarDrawerWidth } from '../lib/navigation';
import { usePrefs } from '../lib/prefs';
import { homeChat, isOwner, useApp } from '../lib/store';
import { useActivityClock } from '../lib/useActivityClock';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { Chat, Server } from '../lib/types';
import { ChatMenu } from './ChatMenu';
import { ChatFilters } from './ChatFilters';
import { ProjectSection } from '../features/projects/ProjectSection';
import { useBotSheet } from './BotSwitcher';
import { useAddBot } from './AddBot';
import { KeyboardViewport } from './KeyboardViewport';
import { Bot, CalendarClock, ChevronsUpDown, House, Inbox, MessageCircle, MessagesSquare, MoreHorizontal, PanelLeft, Pin, Settings, SquarePen, Users } from './icons';
import { AgentFace } from './AgentFace';
import { MenuMark } from './MenuMark';
import { Badge, IconButton, SearchField, Tap } from './ui';
import { ago } from '../lib/agent';
import { connectionView } from '../lib/connection';

/** A mouse can't long-press: rows get a visible options button only where there's hover. */
const HOVER = Platform.OS === 'web' && !globalThis.matchMedia?.('(hover: none)').matches;
const Navigation = createContext({ open: () => {}, close: () => {}, home: () => {}, homeRevision: 0, reserved: 0 });
const NO_CHATS = {};
const NO_TYPING = {};
const NO_INBOX = {};
export const useAppNavigation = () => useContext(Navigation);
export function useContentWidth() { return useWindowDimensions().width - useAppNavigation().reserved; }

/** One navigation shell for the landing chat, conversations and every settings screen. */
export function AppNavigation({ children }: { children: ReactNode }) {
  const t = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const mode = usePrefs((s) => s.prefs.sidebar);
  const simple = usePrefs((s) => s.prefs.view === 'simple');
  const paired = useApp((s) => s.servers.length > 0);
  const locked = useLock((s) => s.locked);
  const pathname = usePathname();
  const [opened, setOpened] = useState(false);
  const [homeRevision, setHomeRevision] = useState(0);
  const reserved = paired && !locked && pathname !== '/pair' ? simple ? simpleSidebarWidth(width, fontScale) : navigationWidth(width, mode) : 0;
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
  useEffect(close, [pathname, mode, simple, close]);
  useEffect(() => { if (locked) close(); }, [locked, close]);
  useEffect(() => {
    if (Platform.OS !== 'web' || !opened) return;
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [opened, close]);
  return <Navigation.Provider value={value}>
    <View style={{ flex: 1, flexDirection: 'row', backgroundColor: t.colors.bg }}>
      {reserved >= 280 ? simple ? <SimpleSidebar onClose={close} /> : <Sidebar onClose={() => usePrefs.getState().update({ sidebar: 'drawer' })} /> : reserved ? <NavigationRail /> : null}
      <View style={{ flex: 1, minWidth: 0 }} pointerEvents={locked ? 'none' : 'auto'} aria-hidden={opened || locked} importantForAccessibility={opened || locked ? 'no-hide-descendants' : 'auto'}>{children}</View>
      {locked ? null : <SidebarDrawer visible={opened} onClose={close} />}
    </View>
  </Navigation.Provider>;
}

export function NavigationToggle() {
  const t = useTheme();
  const nav = useAppNavigation();
  const pinned = nav.reserved >= 280;
  const simple = usePrefs((s) => s.prefs.view === 'simple');
  if (simple && pinned) return <View style={{ width: 44 }} />;
  return <IconButton label={pinned ? 'Collapse sidebar' : 'Open sidebar'} onPress={pinned ? () => usePrefs.getState().update({ sidebar: 'drawer' }) : nav.open}>
    {pinned ? <PanelLeft size={22} color={t.colors.text} /> : <MenuMark size={24} color={t.colors.text} />}
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
  const s = useStyles();
  const reduced = useReducedMotion();
  const { width } = useWindowDimensions();
  const simple = usePrefs((s) => s.prefs.view === 'simple');
  const drawerWidth = simple ? Math.min(360, width - 24) : sidebarDrawerWidth(width);
  const x = useSharedValue(-drawerWidth);
  useEffect(() => {
    // Closing releases the overlay immediately; interaction must never depend on an animation callback.
    x.value = visible ? reduced ? 0 : withSpring(0, spring.soft) : -drawerWidth;
  }, [visible, drawerWidth, reduced, x]);
  useEffect(() => {
    if (!visible || Platform.OS === 'web') return;
    const back = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => back.remove();
  }, [visible, onClose]);
  const panel = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  // The scrim follows the panel, so dragging it shut lifts the dim with your finger.
  const dim = useAnimatedStyle(() => ({ opacity: Math.min(1, Math.max(0, 1 + x.value / drawerWidth)) }));
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
        <Animated.View accessibilityViewIsModal style={[{ width: drawerWidth, flex: 1 }, s.drawerPanel, panel]}>
          <View style={s.drawerClip}>{simple ? <SimpleSidebar onClose={onClose} drawer /> : <Sidebar onClose={onClose} drawer />}</View>
        </Animated.View>
      </GestureDetector>}</KeyboardViewport>
      </View>
    </GestureHandlerRootView>
  </View>;
}

type RowTone = 'draft' | 'pending' | 'running';

function SimpleSidebar({ onClose, drawer = false }: { onClose: () => void; drawer?: boolean }) {
  const t = useTheme();
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const servers = useApp((st) => st.servers);
  const runtime = useApp((st) => st.runtime);
  const selection = useApp((st) => st.selection);
  const drafts = useApp((st) => st.drafts);
  const files = useApp((st) => st.draftFiles);
  const replies = useApp((st) => st.replyTo);
  const prefs = usePrefs((st) => st.prefs);
  const [query, setQuery] = useState('');
  const add = useAddBot();
  const now = useActivityClock(Object.fromEntries(servers.map((bot) => [bot.id, runtime[bot.id]?.typing ?? NO_TYPING])));
  const openBot = (bot: Server) => {
    const rt = runtime[bot.id];
    const chat = simpleBotChat(bot.id, homeChat(rt), rt?.chats, prefs.lastChatByBot[bot.id], prefs.botOpening, prefs.archivedChats);
    useApp.getState().select(bot.id, chat);
    onClose();
    router.navigate(chat ? `/chat/${bot.id}/${chat}` : '/chats');
  };
  const selected = servers.find((bot) => bot.id === selection.serverId) ?? servers[0];
  return <View style={[s.sidebar, { width: drawer ? '100%' : 280, paddingTop: insets.top + 10,
    paddingBottom: Math.max(insets.bottom, 12), backgroundColor: t.colors.surfaceSunken }]}>
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 6 }}>
      <SearchField value={query} onChangeText={setQuery} placeholder="Search bots" style={{ flex: 1 }} />
      <IconButton label="New conversation" onPress={() => {
        if (selected) void startNewChat(selected.id, (id) => { useApp.getState().select(selected.id, id); onClose(); router.navigate(`/chat/${selected.id}/${id}`); });
      }}><SquarePen size={20} color={t.colors.textSecondary} /></IconButton>
    </View>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 12, gap: 4 }}>
      {servers.filter((bot) => bot.bot.title.toLowerCase().includes(query.trim().toLowerCase())).map((bot) => {
        const rt = runtime[bot.id];
        const remembered = simpleBotChat(bot.id, homeChat(rt), rt?.chats, prefs.lastChatByBot[bot.id], 'last', prefs.archivedChats)!;
        const last = rt?.chats[remembered];
        const key = `${bot.id}:${remembered}`;
        const draft = draftPreview(drafts[key], files[key], !!replies[key]);
        const working = Object.values(rt?.typing ?? {}).some((until) => until > now);
        const pending = rt?.pending ?? 0;
        const state = pending ? `${pending} waiting` : working ? 'Working' : rt?.status === 'online' ? '' : 'Offline';
        const preview = draft ?? last?.preview ?? 'Start a conversation';
        return <Tap key={bot.id} onPress={() => openBot(bot)}
          accessibilityLabel={`${bot.bot.title}${state ? `, ${state}` : ''}. ${preview}`}
          accessibilityState={{ selected: selected?.id === bot.id }}
          style={({ hovered, pressed }) => [s.chatRow, { minHeight: 64, paddingHorizontal: 10, gap: 10 },
            selected?.id === bot.id ? { backgroundColor: t.colors.pressed } : (hovered || pressed) && { backgroundColor: t.colors.pressed }]}>
          <AgentFace server={bot} size={36} still />
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <Text style={s.accountName} numberOfLines={1}>{bot.bot.title}</Text>
            <Text style={[s.chatDetail, { color: t.colors.textSecondary }]} numberOfLines={1}>{preview || 'Start a conversation'}</Text>
            {state ? <Text style={[s.chatDetail, { color: pending ? t.colors.warning : t.colors.textSecondary }]}>{state}</Text> : null}
          </View>
          <Badge count={pending} />
        </Tap>;
      })}
      {!servers.some((bot) => bot.bot.title.toLowerCase().includes(query.trim().toLowerCase())) ? <Text style={[s.chatDetail, { color: t.colors.textSecondary }]}>No matching bots.</Text> : null}
    </ScrollView>
    <View style={{ paddingHorizontal: 12, gap: 2 }}>
      {drawer ? <ListAction label="Close bot list" onPress={onClose} /> : null}
      <ListAction label="Add a bot" onPress={add.open} />
      <ListAction label="Settings" onPress={() => { onClose(); router.navigate('/settings'); }} />
      <ListAction label="Full view" onPress={() => { onClose(); usePrefs.getState().update({ view: 'full' }); }} />
    </View>
    {add.sheet}
  </View>;
}

function ListAction({ label, onPress }: { label: string; onPress: () => void }) {
  const t = useTheme();
  return <Tap accessibilityLabel={label} onPress={onPress} style={({ hovered, pressed }) => ({ minHeight: 44,
    justifyContent: 'center', paddingHorizontal: 10, borderRadius: t.radius.md, backgroundColor: hovered || pressed ? t.colors.pressed : 'transparent' })}>
    <Text style={{ ...t.type.callout, color: t.colors.textSecondary }}>{label}</Text>
  </Tap>;
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
  const waiting = useApp((st) => Object.values(st.runtime).reduce((n, rt) => n + (rt?.pending ?? 0), 0));
  const drafts = useApp((st) => st.drafts);
  const draftFiles = useApp((st) => st.draftFiles);
  const replyTo = useApp((st) => st.replyTo);
  const network = useApp((st) => st.network);
  const now = useActivityClock(typing);
  const [menu, setMenu] = useState<{ server: Server; chat: Chat } | null>(null);
  const server = servers.find((bot) => bot.id === selected.serverId) ?? servers[0];
  // Switching bots here also leaves any open conversation, so you land on the new bot rather than typing to the old one.
  const bots = useBotSheet(server, () => go('/'));
  const rt = useApp((st) => server ? st.runtime[server.id] : undefined);
  const view = connectionView(network, rt, server?.bot.title ?? '');
  const canSchedule = !!rt?.info?.features?.control && isOwner(rt);
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
  // Rows are memoized; they reach the latest navigation through a ref rather than a fresh callback every render.
  const goRef = useRef(go);
  goRef.current = go;
  const openChat = useCallback((bot: Server, chat: Chat) => {
    haptic.selection();
    useApp.getState().select(bot.id, chat.id);
    goRef.current(`/chat/${bot.id}/${chat.id}`);
  }, []);
  const openMenu = useCallback((bot: Server, chat: Chat) => { Keyboard.dismiss(); setMenu({ server: bot, chat }); }, []);
  const newChat = async () => {
    if (!server || creating) return;
    setCreating(true);
    await startNewChat(server.id, (id) => {
      useApp.getState().select(server.id, id);
      go(`/chat/${server.id}/${id}`);
    });
    setCreating(false);
  };
  const nav = (label: string, Icon: typeof Bot, path: string | null, onPress: () => void, badge = 0) => {
    const on = !!path && pathname === path;
    return <Tap key={label} accessibilityLabel={badge ? `${label}, ${badge} waiting` : label} feedback="selection" scaleTo={0.99}
      accessibilityState={path ? { selected: on } : undefined} onPress={onPress}
      style={({ pressed, hovered }) => [s.navRow, on ? s.rowOn : (pressed || hovered) && s.rowHover]}>
      <Icon size={18} color={on ? t.colors.text : t.colors.textSecondary} />
      <Text style={[s.navText, on && { color: t.colors.text }]} numberOfLines={1}>{label}</Text>
      {badge ? <Text style={s.count}>{badge}</Text> : null}
    </Tap>;
  };
  const multiBot = servers.length > 1;
  return <View style={[s.sidebar, drawer ? null : s.sidebarPinned, { width: drawer ? '100%' : 288 }]}>
    <View style={[s.top, { paddingTop: insets.top + 10 }]}>
      <SearchField value={query} onChangeText={setQuery} placeholder="Search" style={{ flex: 1 }} />
      {drawer ? null : <IconButton label="Collapse sidebar" onPress={onClose}><PanelLeft size={20} color={t.colors.textSecondary} /></IconButton>}
    </View>
    <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={s.scroll}>
      {query ? null : <View style={s.navList}>
        {nav('Home', House, '/', () => go('/'))}
        {nav(creating ? 'Starting…' : 'New chat', SquarePen, null, () => void newChat())}
        {nav('Inbox', Inbox, '/inbox', () => go('/inbox'), waiting)}
        {nav('All chats', MessagesSquare, '/chats', () => go('/chats'))}
        {canSchedule ? nav('Schedule', CalendarClock, '/schedule', () => go('/schedule')) : null}
        {nav('Rooms', Users, '/rooms', () => go('/rooms'))}
      </View>}
      {server && !query ? <ProjectSection server={server} onNavigate={navigation.close} /> : null}
      <View style={s.filterRow}>
        <ChatFilters value={filter} counts={counts} onChange={(value) => { if (value !== 'archived') setFilter(value); }} />
      </View>
      {rows.length ? rows.slice(0, query || filter !== 'all' ? 100 : 40).map(({ server: bot, chat, pinned }, index) => {
        const previous = rows[index - 1];
        const group = index === 0 || pinned !== previous?.pinned;
        const active = pathname.startsWith('/chat/') && selected.serverId === bot.id && selected.chatId === chat.id;
        const state = stateOf(bot.id, chat.id);
        const home = chat.id === homeChat(useApp.getState().runtime[bot.id]);
        const title = home ? bot.bot.title : chat.title;
        const draft = draftPreview(drafts[`${bot.id}:${chat.id}`], draftFiles[`${bot.id}:${chat.id}`], !!replyTo[`${bot.id}:${chat.id}`]);
        const status = chatActivityLabel(state);
        const label = `${home ? `${bot.bot.title} main chat` : chat.title}${multiBot && !home ? `, ${bot.bot.title}` : ''}${pinned ? ', pinned' : ''}${status ? `, ${status}` : ''}${draft ? `, ${draft}` : ''}`;
        return <View key={chatKey(bot.id, chat.id)}>
          {group && !query ? <Text style={s.section} accessibilityRole="header">{filter === 'running' ? 'Running' : filter === 'needs-you' ? 'Needs you' : pinned ? 'Pinned' : 'Recent'}</Text> : null}
          <SidebarChatRow bot={bot} chat={chat} title={title} label={label} pinned={pinned} active={active} showFace={multiBot}
            detail={draft ?? status} tone={draft ? 'draft' : state.pending ? 'pending' : 'running'}
            onOpen={openChat} onMenu={openMenu} />
        </View>;
      }) : <Text style={s.noChats}>{query ? 'No matching chats' : filter === 'running' ? 'Nothing running.' : filter === 'needs-you' ? 'Nothing waiting on you.' : 'Your chats will appear here.'}</Text>}
    </ScrollView>
    {server ? <View style={[s.footer, { paddingBottom: Math.max(insets.bottom, 10) }]}>
      <Tap accessibilityLabel={`${server.bot.title}, ${view.kind === 'online' ? 'online' : view.title}. Switch bot`} feedback="selection" scaleTo={0.99}
        onPress={bots.open} style={({ pressed, hovered }) => [s.account, (pressed || hovered) && s.rowHover]}>
        <AgentFace server={server} size={32} still />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.accountName} numberOfLines={1}>{server.bot.title}</Text>
          <View style={s.accountStatus}>
            <View style={[s.dot, { backgroundColor: view.tone === 'ok' ? t.colors.success : view.tone === 'error' ? t.colors.danger : t.colors.warning }]} />
            <Text style={s.accountStatusText} numberOfLines={1}>{view.kind === 'online' ? 'Online' : view.title}{multiBot ? ` · ${servers.length} bots` : ''}</Text>
          </View>
        </View>
        <ChevronsUpDown size={16} color={t.colors.textTertiary} />
      </Tap>
      <IconButton label="Settings" onPress={() => go('/settings')}><Settings size={20} color={t.colors.textSecondary} /></IconButton>
    </View> : null}
    {bots.sheet}
    {menu ? <ChatMenu server={menu.server} chatId={menu.chat.id} title={menu.chat.title} visible onClose={() => setMenu(null)} /> : null}
  </View>;
}

/** One conversation in the sidebar: title and time, a line of status or draft only when there is one. */
const SidebarChatRow = memo(function SidebarChatRow({ bot, chat, title, label, pinned, active, showFace, detail, tone, onOpen, onMenu }: {
  bot: Server; chat: Chat; title: string; label: string; pinned: boolean; active: boolean; showFace: boolean;
  detail: string | null; tone: RowTone;
  onOpen: (bot: Server, chat: Chat) => void; onMenu: (bot: Server, chat: Chat) => void;
}) {
  const t = useTheme();
  const s = useStyles();
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const color = tone === 'draft' ? t.colors.textSecondary : tone === 'pending' ? t.colors.warning : t.colors.accent;
  const showMore = hover || focus;
  return <View {...(HOVER ? { onPointerEnter: () => setHover(true), onPointerLeave: () => setHover(false) } : {})}>
    <Tap accessibilityLabel={label} accessibilityHint="Long-press for chat options" scaleTo={0.99}
      onLongPress={() => onMenu(bot, chat)} delayLongPress={350}
      accessibilityState={{ selected: active }} onPress={() => onOpen(bot, chat)}
      style={({ pressed, hovered }) => [s.chatRow, active ? s.rowOn : (pressed || hovered) && s.rowHover]}>
      {showFace ? <AgentFace server={bot} size={22} still /> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={s.chatTop}>
          {pinned ? <Pin size={12} color={t.colors.textTertiary} /> : null}
          <Text style={[s.chatTitle, active && { color: t.colors.text }]} numberOfLines={1}>{title}</Text>
          <Text style={[s.chatTime, HOVER && showMore && { opacity: 0 }]}>{ago(chat.updated_at)}</Text>
        </View>
        {detail ? <Text numberOfLines={1} style={[s.chatDetail, { color }]}>{detail}</Text> : null}
      </View>
      {HOVER ? <View onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} style={[s.rowMore, { opacity: showMore ? 1 : 0 }]}>
        <IconButton label={`Options for ${title}`} size={28} onPress={(e) => { e.stopPropagation(); onMenu(bot, chat); }}>
          <MoreHorizontal size={16} color={t.colors.textSecondary} />
        </IconButton>
      </View> : null}
    </Tap>
  </View>;
});

function NavigationRail() {
  const t = useTheme();
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const nav = useAppNavigation();
  const pathname = usePathname();
  const count = useApp((st) => Object.values(st.runtime).reduce((n, rt) => n + (rt?.pending ?? 0), 0));
  const item = (label: string, Icon: ComponentType<{ size?: number; color?: string }>, path?: string, action?: () => void) => {
    const active = path === '/' ? pathname === '/' || pathname.startsWith('/chat/') : !!path && pathname === path;
    return <View key={label} style={s.railSlot}>
      <Tap accessibilityLabel={label} accessibilityState={{ selected: active }} feedback="selection"
        onPress={action ?? (() => router.navigate(path!))} style={({ pressed, hovered }) => [s.railButton, active && s.rowOn,
          (pressed || hovered) && !active && s.rowHover]}>
        <Icon size={20} color={active ? t.colors.text : t.colors.textSecondary} />
        {path === '/inbox' ? <Badge count={count} style={{ position: 'absolute', right: -2, top: -3 }} /> : null}
      </Tap>
    </View>;
  };
  return <View style={[s.rail, { paddingTop: insets.top + 8, paddingBottom: Math.max(12, insets.bottom) }]}>
    {item('Open sidebar', MenuMark, undefined, nav.open)}
    <View style={s.railDivider} />
    {item('Chat', MessageCircle, '/', nav.home)}
    {item('All chats', MessagesSquare, '/chats')}
    {item('Inbox', Inbox, '/inbox')}
    <View style={{ flex: 1 }} />
    <View style={s.railDivider} />
    {item('Rooms', Users, '/rooms')}
    {item('Agent', Bot, '/agent')}
    {item('Settings', Settings, '/settings')}
  </View>;
}

const useStyles = makeStyles((t) => ({
  sidebar: { height: '100%', backgroundColor: t.colors.surface, overflow: 'hidden' },
  sidebarPinned: { borderRightWidth: StyleSheet.hairlineWidth * 2, borderRightColor: t.colors.border },
  drawerPanel: {
    backgroundColor: t.colors.surface,
    shadowColor: t.colors.shadow, shadowOpacity: t.scheme === 'dark' ? 0.5 : 0.12, shadowRadius: 20, shadowOffset: { width: 4, height: 0 }, elevation: 16,
  },
  drawerClip: { flex: 1, overflow: 'hidden', borderRightWidth: StyleSheet.hairlineWidth * 2, borderRightColor: t.colors.border },
  header: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, paddingBottom: 6, minHeight: 52 },
  headerTitle: { flex: 1, minWidth: 0, ...t.type.heading, color: t.colors.text, marginLeft: 4 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingBottom: 8 },
  scroll: { paddingHorizontal: 8, paddingTop: 2, paddingBottom: 16 },
  navList: { paddingBottom: 8 },
  navRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 40, paddingHorizontal: 10, borderRadius: t.radius.md },
  navText: { ...t.type.callout, fontFamily: t.fonts.medium, color: t.colors.text, flex: 1, minWidth: 0 },
  count: { ...t.type.caption, color: t.colors.textSecondary, fontVariant: ['tabular-nums'] },
  rowOn: { backgroundColor: t.colors.surfaceHigh },
  rowHover: { backgroundColor: t.colors.pressed },
  filterRow: { paddingTop: 4, paddingBottom: 2 },
  section: { ...t.type.caption, color: t.colors.textTertiary, paddingHorizontal: 10, paddingTop: 16, paddingBottom: 6 },
  chatRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 40, paddingVertical: 8, paddingHorizontal: 10, borderRadius: t.radius.md },
  chatTop: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  chatTitle: { ...t.type.callout, color: t.colors.text, flex: 1, minWidth: 0 },
  chatTime: { ...t.type.caption, fontFamily: t.fonts.regular, color: t.colors.textTertiary },
  chatDetail: { ...t.type.caption, fontFamily: t.fonts.regular, marginTop: 1 },
  rowMore: { position: 'absolute', right: 4, top: 0, bottom: 0, justifyContent: 'center' },
  noChats: { ...t.type.callout, color: t.colors.textSecondary, padding: 10 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 8, paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth * 2, borderTopColor: t.colors.border },
  account: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingHorizontal: 8, borderRadius: t.radius.md },
  accountName: { ...t.type.callout, fontFamily: t.fonts.semibold, color: t.colors.text },
  accountStatus: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 1 },
  accountStatusText: { ...t.type.caption, fontFamily: t.fonts.regular, color: t.colors.textSecondary, flexShrink: 1 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  rail: { width: 60, alignItems: 'center', gap: 6, backgroundColor: t.colors.surface, borderRightWidth: StyleSheet.hairlineWidth * 2, borderRightColor: t.colors.border },
  railSlot: { width: 60, alignItems: 'center', justifyContent: 'center', minHeight: 44 },
  railButton: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: t.radius.md },
  railDivider: { width: 24, height: StyleSheet.hairlineWidth * 2, backgroundColor: t.colors.border, marginVertical: 2 },
}));
