import { Redirect, router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Platform, ScrollView, Text, TextInput, View } from 'react-native';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AgentFace } from '../../components/AgentFace';
import { NavigationToggle, useContentWidth } from '../../components/AppNavigation';
import { ChatView } from '../../components/ChatView';
import { ChatMenu } from '../../components/ChatMenu';
import { ChatFilters } from '../../components/ChatFilters';
import { ConnectionBanner } from '../../components/ConnectionBanner';
import { Archive, Hash, MessageSquarePlus, MoreHorizontal, Pin, Search, Sparkles, X } from '../../components/icons';
import { useTabBarSpace } from '../../components/TabBar';
import { Button, IconButton, SectionHeader, Skeleton, Tap } from '../../components/ui';
import { ago } from '../../lib/agent';
import { api } from '../../lib/api';
import { startNewChat } from '../../lib/actions';
import { requestFocus } from '../../lib/focus';
import { organizeChats } from '../../lib/chatOrganization';
import { chatActivity, chatActivityLabel, draftPreview, matchesChatFilter, type ChatFilter } from '../../lib/chatActivity';
import { useActivityClock } from '../../lib/useActivityClock';
import { usePrefs } from '../../lib/prefs';
import { plainText } from '../../lib/text';
import { homeChat, useApp, useServerState } from '../../lib/store';
import { WIDE_BREAKPOINT } from '../../lib/theme';
import { makeStyles, useTheme } from '../../lib/themeContext';
import type { Chat, SearchResult, Server } from '../../lib/types';
import { easeOut } from '../../lib/motion';

/** The main chat, the Updates feed, and side chats for separate topics. Wide screens show the chat alongside. */
export default function ChatsTab() {
  const servers = useApp((s) => s.servers);
  const selection = useApp((s) => s.selection);
  const width = useContentWidth();
  const s = useStyles();
  if (!servers.length) return <Redirect href="/pair" />;
  const server = servers.find((x) => x.id === selection.serverId) ?? servers[0];
  if (width < WIDE_BREAKPOINT) return <ChatList server={server} />;
  const chatId = selection.chatId ?? homeChat(useApp.getState().runtime[server.id]);
  return (
    <View style={s.split}>
      <View style={s.listPane}><ChatList server={server} activeChatId={chatId} /></View>
      <View style={{ flex: 1 }}><ChatView key={`${server.id}:${chatId}`} server={server} chatId={chatId} embedded /></View>
    </View>
  );
}

function ChatList({ server, activeChatId }: { server: Server; activeChatId?: string }) {
  const t = useTheme();
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const tabSpace = useTabBarSpace();
  const width = useContentWidth();
  const wide = width >= WIDE_BREAKPOINT;
  const rt = useServerState(server.id);
  const select = useApp((st) => st.select);
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<Chat | null>(null);
  const [filter, setFilter] = useState<ChatFilter | 'archived'>('all');
  const archived = filter === 'archived';
  const activeFilter = filter === 'running' || filter === 'needs-you';
  const now = useActivityClock({ [server.id]: rt?.typing ?? {} });
  const drafts = useApp((st) => st.drafts);
  const draftFiles = useApp((st) => st.draftFiles);
  const replyTo = useApp((st) => st.replyTo);
  const pinnedChats = usePrefs((st) => st.prefs.pinnedChats);
  const archivedChats = usePrefs((st) => st.prefs.archivedChats);

  const q = query.trim().toLowerCase();
  const draftOf = (c: Chat) => draftPreview(drafts[`${server.id}:${c.id}`], draftFiles[`${server.id}:${c.id}`], !!replyTo[`${server.id}:${c.id}`]);
  const match = (c: Chat) => !q || `${c.title} ${c.preview} ${draftOf(c) ?? ''}`.toLowerCase().includes(q);
  const mainId = homeChat(rt);
  const groups = useMemo(() => organizeChats(Object.values(rt?.chats ?? {}), server.id, mainId, pinnedChats, archivedChats), [rt?.chats, server.id, mainId, pinnedChats, archivedChats]);
  const actionable = Object.values(rt?.chats ?? {}).filter((chat) => chat.kind === 'chat');
  const states = new Map(actionable.map((chat) => [chat.id, chatActivity(rt, chat.id, now)]));
  const counts = { running: actionable.filter((c) => states.get(c.id)?.running).length,
    pending: actionable.filter((c) => (states.get(c.id)?.pending ?? 0) > 0).length };
  const filtered = activeFilter ? actionable.filter((c) => matchesChatFilter(filter, states.get(c.id)!)).sort((a, b) => b.updated_at - a.updated_at) : [];
  const side = archived ? groups.archived : activeFilter ? filtered : [...groups.pinned, ...groups.recent];
  const general = rt?.chats[mainId];
  const recents = useMemo(() => [...groups.recent, ...(general ? [general] : [])].sort((a, b) => b.updated_at - a.updated_at), [groups.recent, general]);
  const resume = recents[0];
  const updates = rt?.chats.home;
  const loading = !rt || (rt.status !== 'online' && !Object.keys(rt.chats).length);
  const found = useMessageSearch(server, rt?.info?.features?.search ? query : '');
  const scopedIds = new Set(side.map((c) => c.id));
  const results = found.results.filter((r) => scopedIds.has(r.chat.id) || (!archived && !activeFilter && (r.chat.id === mainId || r.chat.id === 'home')));
  useEffect(() => { setMenu(null); setQuery(''); setFilter('all'); }, [server.id]);

  const open = (id: string) => {
    if (wide) select(server.id, id);
    else router.push(`/chat/${server.id}/${id}`);
  };
  const newChat = () => startNewChat(server.id, open);
  const row = (c: Chat, pinned = false) => (
    <Animated.View key={c.id} entering={FadeIn.duration(200)} layout={LinearTransition.duration(220).easing(easeOut)}>
      <ChatRow icon={c.id === mainId ? <AgentFace server={server} size={32} still /> : pinned ? <Pin size={17} color={t.colors.onAccentSoft} /> : archived ? <Archive size={17} color={t.colors.textSecondary} /> : <Hash size={17} color={t.colors.onAccentSoft} />}
        tint={c.id === mainId ? 'transparent' : archived ? t.colors.surfaceSunken : t.colors.accentSoft} title={c.id === mainId ? 'Main chat' : c.title}
        subtitle={draftOf(c) ?? chatActivityLabel(chatActivity(rt, c.id, now)) ?? plainText(c.preview)} time={c.updated_at}
        subtitleColor={states.get(c.id)?.pending ? t.colors.warning : draftOf(c) || states.get(c.id)?.running ? t.colors.onAccentSoft : undefined}
        active={activeChatId === c.id} onPress={() => open(c.id)} onMenu={() => setMenu(c)} />
    </Animated.View>
  );

  return (
    <View style={s.root}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: wide ? 24 : tabSpace + 8, paddingHorizontal: 16 }} keyboardShouldPersistTaps="handled">
        <View style={s.topRow}>
          <NavigationToggle />
          <IconButton label="New chat" variant="filled" onPress={newChat}><MessageSquarePlus size={20} color={t.colors.text} /></IconButton>
        </View>
        <Text style={s.title} accessibilityRole="header">Chats</Text>
        <View style={s.search}>
          <Search size={18} color={t.colors.textTertiary} />
          <TextInput value={query} onChangeText={setQuery} placeholder="Search" placeholderTextColor={t.colors.textTertiary}
            style={s.searchInput} accessibilityLabel="Search chats" returnKeyType="search" />
          {query ? <IconButton label="Clear search" size={32} onPress={() => setQuery('')}><X size={16} color={t.colors.textSecondary} /></IconButton> : null}
        </View>
        <ConnectionBanner server={server} compact />
        <ChatFilters value={filter} onChange={setFilter} counts={counts} archived={groups.archived.length} />
        <View style={s.filters}>
          <Text style={s.filterText}>{archived ? 'On this device' : activeFilter ? `${filtered.length} ${filtered.length === 1 ? 'chat' : 'chats'}` : `${actionable.length} chats`}</Text>
          <View style={{ flex: 1 }} />
          {updates ? <Tap accessibilityLabel="Open updates" onPress={() => open('home')} feedback="selection" style={s.updates}>
            <Sparkles size={16} color={t.colors.textSecondary} /><Text style={s.updateLabel} numberOfLines={1}>Updates</Text>
          </Tap> : null}
        </View>

        {loading ? (
          <View style={{ gap: 12, marginTop: 16 }}>
            {[0, 1, 2].map((i) => <Skeleton key={i} height={72} radius={20} />)}
          </View>
        ) : (
          <>
            {!archived && !activeFilter && groups.pinned.some(match) ? <><SectionHeader title="Pinned" style={s.section} />{groups.pinned.filter(match).map((c) => row(c, true))}</> : null}
            {!archived && !activeFilter && resume && match(resume) ? <><SectionHeader title="Continue" style={s.section} />{row(resume)}</> : null}
            {(archived || activeFilter ? side : recents.slice(1)).some(match) ? <SectionHeader title={archived ? 'Archived chats' : filter === 'running' ? 'Running' : filter === 'needs-you' ? 'Needs you' : 'Recent'} style={s.section} /> : null}
            {(archived || activeFilter ? side : recents.slice(1)).filter(match).map((c) => row(c))}
            {q && !archived && !activeFilter && updates && match(updates) ? <ChatRow icon={<Sparkles size={17} color={t.colors.textSecondary} />} tint={t.colors.surfaceSunken} title="Updates" subtitle={plainText(updates.preview)} time={updates.updated_at} onPress={() => open('home')} /> : null}
            {!(archived || activeFilter ? side.length : recents.length || groups.pinned.length) && !q ? (
              <View style={s.empty}>
                <Text style={s.emptyText}>{archived ? 'No archived chats' : filter === 'running' ? 'No tasks running.' : filter === 'needs-you' ? 'Nothing waiting on you.' : 'No chats yet'}</Text>
                {!archived && !activeFilter ? <Button title="New chat" variant="tonal" icon={<Hash size={16} color={t.colors.onAccentSoft} />} onPress={newChat} /> : null}
              </View>
            ) : null}
            {results.length ? (
              <>
                <SectionHeader title="In messages" style={s.section} />
                {results.map((r) => (
                  <ResultRow key={r.message.id} server={server} result={r} query={query.trim()}
                    onPress={() => { requestFocus(server.id, r.chat.id, r.message.id); open(r.chat.id); }} />
                ))}
              </>
            ) : null}
            {q && !side.some(match) && !(!archived && !activeFilter && ((general && match(general)) || (updates && match(updates)))) && !results.length && !found.busy
              ? <Text style={s.emptyText}>Nothing matches “{query}”.</Text> : null}
          </>
        )}
      </ScrollView>
      <ChatMenu server={server} chatId={menu?.id ?? ''} title={menu ? `#${menu.title}` : ''} visible={!!menu} onClose={() => setMenu(null)} />
    </View>
  );
}

function ChatRow({ icon, tint, title, subtitle, time, subtitleColor, active, onPress, onMenu }: {
  icon: React.ReactNode; tint: string; title: string; subtitle: string; time: number; subtitleColor?: string; active?: boolean;
  onPress: () => void; onMenu?: () => void;
}) {
  const t = useTheme();
  const s = useStyles();
  return (
    <Tap feedback="selection" scaleTo={0.99} accessibilityLabel={`${title}. ${subtitle}`} accessibilityHint={onMenu ? 'Long-press for options' : undefined}
      onPress={onPress} onLongPress={onMenu} delayLongPress={350}
      style={({ pressed, hovered }) => [s.row, active && s.active, (pressed || hovered) && !active && { backgroundColor: t.colors.pressed }]}>
      <View style={[s.rowIcon, { backgroundColor: tint }]}>{icon}</View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={s.rowHead}>
          <Text style={s.rowTitle} numberOfLines={1}>{title}</Text>
          <Text style={s.time}>{ago(time)}</Text>
        </View>
        {subtitle ? <Text style={[s.preview, subtitleColor ? { color: subtitleColor } : null]} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      {onMenu ? <IconButton label={`Options for ${title}`} size={40} onPress={(e) => { e.stopPropagation(); onMenu(); }}><MoreHorizontal size={18} color={t.colors.textSecondary} /></IconButton> : null}
    </Tap>
  );
}

/** Messages containing the search words, from the server, a moment after typing stops. */
function useMessageSearch(server: Server, query: string) {
  const [state, setState] = useState<{ results: SearchResult[]; busy: boolean }>({ results: [], busy: false });
  const q = query.trim();
  useEffect(() => {
    if (q.length < 2) { setState({ results: [], busy: false }); return; }
    setState((st) => ({ ...st, busy: true }));
    let live = true;
    const id = setTimeout(() => {
      api<{ results: SearchResult[] }>(server, `/api/search?q=${encodeURIComponent(q)}`)
        .then((d) => live && setState({ results: d.results, busy: false }))
        .catch(() => live && setState({ results: [], busy: false }));
    }, 300);
    return () => { live = false; clearTimeout(id); };
  }, [server, q]);
  return state;
}

/** A found message: where it is, when, and the words around the match with the match in bold. */
function ResultRow({ server, result, query, onPress }: { server: Server; result: SearchResult; query: string; onPress: () => void }) {
  const t = useTheme();
  const s = useStyles();
  const rt = useApp((st) => st.runtime[server.id]);
  const where = result.chat.id === homeChat(rt) ? server.bot.title : result.chat.kind === 'home' ? 'Updates' : `#${result.chat.title}`;
  const who = result.message.role === 'bot' ? server.bot.title : 'You';
  const parts = splitMatch(result.snippet, query);
  return (
    <Tap feedback="selection" scaleTo={0.99} onPress={onPress} accessibilityLabel={`${who} in ${where}: ${result.snippet}. Open`}
      style={({ pressed, hovered }) => [s.row, (pressed || hovered) && { backgroundColor: t.colors.pressed }]}>
      <View style={[s.rowIcon, { backgroundColor: t.colors.surfaceSunken }]}><Search size={17} color={t.colors.textSecondary} /></View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={s.rowHead}>
          <Text style={s.rowTitle} numberOfLines={1}>{where}</Text>
          <Text style={s.time}>{ago(result.message.created_at)}</Text>
        </View>
        <Text style={s.preview} numberOfLines={2}>
          <Text style={{ color: t.colors.textTertiary }}>{who}: </Text>
          {parts.map((p, i) => (p.hit ? <Text key={i} style={s.hit}>{p.text}</Text> : p.text))}
        </Text>
      </View>
    </Tap>
  );
}

/** The snippet split around every search word (the server matches each word, in any order). */
function splitMatch(text: string, query: string): { text: string; hit: boolean }[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!words.length) return [{ text, hit: false }];
  const out: { text: string; hit: boolean }[] = [];
  const lower = text.toLowerCase();
  let from = 0;
  while (from < text.length) {
    let at = -1;
    let size = 0;
    for (const w of words) {
      const i = lower.indexOf(w, from);
      if (i >= 0 && (at < 0 || i < at)) { at = i; size = w.length; }
    }
    if (at < 0) break;
    if (at > from) out.push({ text: text.slice(from, at), hit: false });
    out.push({ text: text.slice(at, at + size), hit: true });
    from = at + size;
  }
  if (from < text.length) out.push({ text: text.slice(from), hit: false });
  return out;
}

const useStyles = makeStyles((t) => ({
  split: { flex: 1, flexDirection: 'row', backgroundColor: t.colors.bg },
  listPane: { width: 360, borderRightWidth: 1, borderRightColor: t.colors.border },
  root: { flex: 1, backgroundColor: t.colors.bg },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48 },
  title: { ...t.type.display, color: t.colors.text, marginTop: 6, marginBottom: 10 },
  section: { paddingTop: 12, paddingBottom: 4 },
  filters: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 4, borderBottomWidth: 1, borderBottomColor: t.colors.border },
  filterText: { ...t.type.callout, fontFamily: t.fonts.medium, color: t.colors.textSecondary },
  updates: { flexDirection: 'row', gap: 5, alignItems: 'center', minHeight: 44, flexShrink: 1 },
  updateLabel: { ...t.type.caption, fontFamily: t.fonts.medium, color: t.colors.textSecondary, flexShrink: 1 },
  search: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 14, paddingRight: 6, minHeight: 46, borderRadius: t.radius.pill,
    backgroundColor: t.colors.surfaceSunken, marginBottom: 14,
  },
  searchInput: { flex: 1, ...t.type.body, color: t.colors.text, paddingVertical: 10, ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}) },
  active: { backgroundColor: t.colors.accentSoft, borderColor: 'transparent' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 4, paddingVertical: 10, borderRadius: t.radius.md, minHeight: 64 },
  rowIcon: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowTitle: { ...t.type.bodyStrong, color: t.colors.text, flex: 1 },
  preview: { ...t.type.callout, color: t.colors.textSecondary, marginTop: 1 },
  time: { ...t.type.caption, color: t.colors.textTertiary, marginLeft: 'auto' },
  empty: { alignItems: 'center', gap: 14, paddingVertical: 24, paddingHorizontal: 12 },
  emptyText: { ...t.type.callout, color: t.colors.textSecondary, textAlign: 'center' },
  hit: { fontFamily: t.fonts.semibold, color: t.colors.text, backgroundColor: t.colors.accentSoft },
}));
