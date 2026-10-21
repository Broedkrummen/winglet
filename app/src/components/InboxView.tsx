import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useShallow } from 'zustand/react/shallow';
import { ago } from '../lib/agent';
import { useApp, useServerState } from '../lib/store';
import { WIDE_BREAKPOINT } from '../lib/theme';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { InboxItem, Server } from '../lib/types';
import { AgentFace } from './AgentFace';
import { NavigationToggle } from './AppNavigation';
import { CheckCheck } from './icons';
import { InboxCard } from './InboxCards';
import { useTabBarSpace } from './TabBar';
import { Chip, Segmented } from './ui';
import { easeOut } from '../lib/motion';

type Entry = { server: Server; item: InboxItem };

/** Everything that needs you, across every paired bot, with a filter per bot. */
export function InboxView() {
  const t = useTheme();
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const tabSpace = useTabBarSpace();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams<{ item?: string; server?: string }>();
  const servers = useApp((st) => st.servers);
  // Each bot's inbox and count, not its messages: a reply streaming in doesn't re-render the inbox.
  const inboxes = useApp(useShallow((st) => st.servers.map((x) => st.runtime[x.id]?.inbox)));
  const pendings = useApp(useShallow((st) => st.servers.map((x) => st.runtime[x.id]?.pending ?? 0)));
  const loadInbox = useApp((st) => st.loadInbox);
  const [view, setView] = useState<'pending' | 'all'>('pending');
  const [only, setOnly] = useState<string | null>(null);
  const list = useRef<FlatList<Entry>>(null);

  useEffect(() => {
    servers.forEach((srv) => loadInbox(srv.id));
  }, [servers, loadInbox]);

  const entries = useMemo(() => {
    const all: Entry[] = [];
    servers.forEach((server, i) => {
      if (only && server.id !== only) return;
      for (const item of Object.values(inboxes[i] ?? {})) all.push({ server, item });
    });
    all.sort((a, b) => b.item.created_at - a.item.created_at);
    const pending = all.filter((e) => e.item.status === 'pending');
    return view === 'pending' ? pending : [...pending, ...all.filter((e) => e.item.status !== 'pending').slice(0, 60)];
  }, [servers, inboxes, only, view]);

  const pendingCount = servers.reduce((n, x, i) => n + (only && x.id !== only ? 0 : pendings[i] ?? 0), 0);

  // A notification opens the exact card it was about, once: scrolling away afterwards isn't undone.
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    if (!params.item || scrolledTo.current === params.item) return;
    const target = entries.findIndex((e) => e.item.id === params.item);
    if (target < 0) {
      if (view === 'pending') setView('all');
      return;
    }
    scrolledTo.current = params.item;
    setTimeout(() => list.current?.scrollToIndex({ index: target, animated: true, viewPosition: 0.1 }), 300);
  }, [params.item, entries, view]);

  return (
    <View style={s.root}>
      <FlatList
        ref={list}
        data={entries}
        keyExtractor={(e) => `${e.server.id}:${e.item.id}`}
        onScrollToIndexFailed={() => undefined}
        contentContainerStyle={[s.content, { paddingTop: insets.top + 8, paddingBottom: (width >= WIDE_BREAKPOINT ? 24 : tabSpace) + 8 }]}
        ListHeaderComponent={
          <View style={{ gap: 14, marginBottom: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><NavigationToggle /><Text style={s.title} accessibilityRole="header">Inbox</Text></View>
            <Segmented
              label="Show"
              value={view}
              onChange={setView}
              options={[{ value: 'pending', label: pendingCount ? `Needs you · ${pendingCount}` : 'Needs you' }, { value: 'all', label: 'Everything' }]}
            />
            {servers.length > 1 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                <Chip label="All bots" selected={!only} onPress={() => setOnly(null)} />
                {servers.map((srv, i) => (
                  <Chip key={srv.id} label={`${srv.bot.title}${pendings[i] ? ` · ${pendings[i]}` : ''}`}
                    icon={<AgentFace server={srv} size={20} still />} selected={only === srv.id} onPress={() => setOnly(only === srv.id ? null : srv.id)} />
                ))}
              </ScrollView>
            ) : null}
          </View>
        }
        ItemSeparatorComponent={() => <View style={{ height: 14 }} />}
        ListEmptyComponent={
          <View style={s.empty}>
            <View style={s.emptyIcon}><CheckCheck size={34} color={t.colors.onAccentSoft} /></View>
            <Text style={s.emptyTitle}>{view === 'pending' ? "You're all caught up" : 'Nothing here yet'}</Text>
            <Text style={s.emptyText}>Approvals, questions and routine results from your bots land here. You'll get a notification when something needs you.</Text>
          </View>
        }
        renderItem={({ item: e, index }) => (
          <Animated.View entering={FadeInDown.delay(Math.min(index, 6) * 40).duration(260).easing(easeOut)}
            style={[{ gap: 8 }, params.item === e.item.id && s.highlight]}>
            <EntryMeta server={e.server} item={e.item} />
            <InboxCard serverId={e.server.id} item={e.item} />
          </Animated.View>
        )}
      />
    </View>
  );
}

/** Which bot and chat a card is from. */
function EntryMeta({ server, item }: { server: Server; item: InboxItem }) {
  const s = useStyles();
  const rt = useServerState(server.id);
  const chat = rt?.chats[item.chat_id];
  return (
    <View style={s.meta}>
      <AgentFace server={server} size={24} still />
      <Text style={s.metaText} numberOfLines={1}>
        <Text style={s.metaBot}>{server.bot.title}</Text>
        {'  ·  '}{chat?.kind === 'home' ? 'Updates' : `#${chat?.title ?? item.chat_id}`}
        {'  ·  '}{ago(item.created_at)}
      </Text>
      <Text accessibilityRole="link" style={s.open} onPress={() => router.push(`/chat/${server.id}/${item.chat_id}`)}>Open chat</Text>
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  root: { flex: 1, backgroundColor: t.colors.bg },
  content: { paddingHorizontal: 16, flexGrow: 1, maxWidth: 760, width: '100%', alignSelf: 'center' },
  title: { ...t.type.display, color: t.colors.text },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 2 },
  metaText: { flex: 1, ...t.type.caption, color: t.colors.textSecondary },
  metaBot: { color: t.colors.text, fontFamily: t.fonts.semibold },
  open: { ...t.type.caption, fontFamily: t.fonts.semibold, color: t.colors.accent, paddingVertical: 8, paddingLeft: 8 },
  highlight: { borderRadius: t.radius.lg, padding: 6, margin: -6, backgroundColor: t.colors.accentSoft },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 10, minHeight: 360 },
  emptyIcon: { width: 76, height: 76, borderRadius: 26, backgroundColor: t.colors.accentSoft, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  emptyTitle: { ...t.type.title, color: t.colors.text },
  emptyText: { ...t.type.callout, color: t.colors.textSecondary, textAlign: 'center', maxWidth: 360 },
}));
