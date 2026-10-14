import { Redirect, router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Platform, ScrollView, Text, TextInput, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AgentFace } from '../../components/AgentFace';
import { BotSwitcher } from '../../components/BotSwitcher';
import { ChatView } from '../../components/ChatView';
import { ConnectionBanner } from '../../components/ConnectionBanner';
import { Hash, MessageSquarePlus, Pencil, Search, Sparkles, Trash2, X } from '../../components/icons';
import { Sheet, SheetAction } from '../../components/Sheet';
import { useTabBarSpace } from '../../components/TabBar';
import { Button, Field, IconButton, SectionHeader, Skeleton, Tap } from '../../components/ui';
import { ago } from '../../lib/agent';
import { api } from '../../lib/api';
import { startNewChat } from '../../lib/actions';
import { requestFocus } from '../../lib/focus';
import { plainText } from '../../lib/text';
import { homeChat, isTyping, useApp } from '../../lib/store';
import { WIDE_BREAKPOINT } from '../../lib/theme';
import { makeStyles, useTheme } from '../../lib/themeContext';
import type { Chat, SearchResult, Server } from '../../lib/types';
import { easeOut } from '../../lib/motion';

/** The main chat, the Updates feed, and side chats for separate topics. Wide screens show the chat alongside. */
export default function ChatsTab() {
  const servers = useApp((s) => s.servers);
  const selection = useApp((s) => s.selection);
  const { width } = useWindowDimensions();
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
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_BREAKPOINT;
  const rt = useApp((st) => st.runtime[server.id]);
  const select = useApp((st) => st.select);
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<Chat | null>(null);

  const q = query.trim().toLowerCase();
  const match = (c: Chat) => !q || c.title.toLowerCase().includes(q) || c.preview.toLowerCase().includes(q);
  const side = useMemo(() => Object.values(rt?.chats ?? {})
    .filter((c) => c.kind === 'chat' && c.id !== homeChat(rt)).sort((a, b) => b.updated_at - a.updated_at), [rt]);
  const mainId = homeChat(rt);
  const general = rt?.chats[mainId];
  const updates = rt?.chats.home;
  const loading = !rt || (rt.status !== 'online' && !Object.keys(rt.chats).length);
  const found = useMessageSearch(server, rt?.info?.features?.search ? query : '');

  const open = (id: string) => {
    if (wide) select(server.id, id);
    else router.push(`/chat/${server.id}/${id}`);
  };
  const newChat = () => startNewChat(server.id, open);

  return (
    <View style={s.root}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: wide ? 24 : tabSpace + 8, paddingHorizontal: 16 }} keyboardShouldPersistTaps="handled">
        <View style={s.topRow}>
          {wide ? <View /> : <BotSwitcher />}
          <IconButton label="New chat" variant="filled" onPress={newChat}><MessageSquarePlus size={20} color={t.colors.text} /></IconButton>
        </View>
        <Text style={s.title} accessibilityRole="header">Chats</Text>
        <View style={s.search}>
          <Search size={18} color={t.colors.textTertiary} />
          <TextInput value={query} onChangeText={setQuery} placeholder={rt?.info?.features?.search ? 'Search chats and messages' : 'Search chats'} placeholderTextColor={t.colors.textTertiary}
            style={s.searchInput} accessibilityLabel="Search chats" returnKeyType="search" />
          {query ? <IconButton label="Clear search" size={32} onPress={() => setQuery('')}><X size={16} color={t.colors.textSecondary} /></IconButton> : null}
        </View>
        <ConnectionBanner server={server} compact />

        {loading ? (
          <View style={{ gap: 12, marginTop: 16 }}>
            {[0, 1, 2].map((i) => <Skeleton key={i} height={72} radius={20} />)}
          </View>
        ) : (
          <>
            {general && match(general) ? (
              <Tap feedback="selection" scaleTo={0.98} accessibilityLabel={`Main chat. ${plainText(general.preview)}`} onPress={() => open(mainId)}
                style={({ hovered }) => [s.main, activeChatId === mainId && s.active, hovered && { borderColor: t.colors.borderStrong }]}>
                <AgentFace server={server} size={52} animated={isTyping(rt, mainId)} still={!isTyping(rt, mainId)} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={s.rowHead}>
                    <Text style={s.mainTitle} numberOfLines={1}>{server.bot.title}</Text>
                    <Text style={s.time}>{ago(general.updated_at)}</Text>
                  </View>
                  <Text style={s.preview} numberOfLines={2}>{isTyping(rt, mainId) ? 'Working…' : plainText(general.preview) || 'Your main conversation'}</Text>
                </View>
              </Tap>
            ) : null}
            {updates && match(updates) ? (
              <ChatRow icon={<Sparkles size={17} color={t.colors.success} />} tint={t.colors.successSoft} title="Updates"
                subtitle={plainText(updates.preview) || 'Results from your routines land here'} time={updates.updated_at}
                active={activeChatId === 'home'} onPress={() => open('home')} />
            ) : null}
            {!q || side.some(match) ? <SectionHeader title="Side chats" /> : null}
            {side.filter(match).map((c) => (
              <Animated.View key={c.id} entering={FadeIn.duration(200)} layout={LinearTransition.duration(220).easing(easeOut)}>
                <ChatRow icon={<Hash size={17} color={t.colors.onAccentSoft} />} tint={t.colors.accentSoft} title={c.title}
                  subtitle={isTyping(rt, c.id) ? 'Working…' : plainText(c.preview) || 'No messages yet'} time={c.updated_at} working={isTyping(rt, c.id)}
                  active={activeChatId === c.id} onPress={() => open(c.id)} onMenu={() => setMenu(c)} />
              </Animated.View>
            ))}
            {!side.length && !q ? (
              <View style={s.empty}>
                <Text style={s.emptyText}>Side chats keep separate topics apart, each with its own memory of the conversation.</Text>
                <Button title="Start a side chat" variant="tonal" icon={<Hash size={16} color={t.colors.onAccentSoft} />} onPress={newChat} />
              </View>
            ) : null}
            {found.results.length ? (
              <>
                <SectionHeader title="In messages" />
                {found.results.map((r) => (
                  <ResultRow key={r.message.id} server={server} result={r} query={query.trim()}
                    onPress={() => { requestFocus(server.id, r.chat.id, r.message.id); open(r.chat.id); }} />
                ))}
              </>
            ) : null}
            {q && !side.some(match) && !(general && match(general)) && !found.results.length && !found.busy
              ? <Text style={s.emptyText}>Nothing matches “{query}”.</Text> : null}
          </>
        )}
      </ScrollView>
      <ChatMenu server={server} chat={menu} onClose={() => setMenu(null)} />
    </View>
  );
}

function ChatRow({ icon, tint, title, subtitle, time, working, active, onPress, onMenu }: {
  icon: React.ReactNode; tint: string; title: string; subtitle: string; time: number; working?: boolean; active?: boolean;
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
        <Text style={[s.preview, working && { color: t.colors.warning }]} numberOfLines={1}>{subtitle}</Text>
      </View>
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

function ChatMenu({ server, chat, onClose }: { server: Server; chat: Chat | null; onClose: () => void }) {
  const t = useTheme();
  const renameChat = useApp((s) => s.renameChat);
  const deleteChat = useApp((s) => s.deleteChat);
  const [mode, setMode] = useState<'menu' | 'rename' | 'delete'>('menu');
  const [title, setTitle] = useState('');
  const close = () => { setMode('menu'); onClose(); };
  return (
    <Sheet visible={!!chat} onClose={close} title={chat ? `#${chat.title}` : undefined}>
      {mode === 'menu' ? (
        <>
          <SheetAction icon={<Pencil size={20} color={t.colors.text} />} label="Rename" onPress={() => { setTitle(chat?.title ?? ''); setMode('rename'); }} />
          <SheetAction icon={<Trash2 size={20} color={t.colors.danger} />} label="Delete chat" destructive onPress={() => setMode('delete')} />
        </>
      ) : mode === 'rename' ? (
        <View style={{ gap: 14, paddingHorizontal: 4 }}>
          <Field value={title} onChangeText={setTitle} placeholder="Chat name" autoFocus onSubmitEditing={async () => { if (chat) await renameChat(server.id, chat.id, title); close(); }} />
          <Button title="Save" onPress={async () => { if (chat) await renameChat(server.id, chat.id, title); close(); }} />
        </View>
      ) : (
        <View style={{ gap: 14, paddingHorizontal: 4 }}>
          <Text style={{ ...t.type.callout, color: t.colors.textSecondary, textAlign: 'center' }}>
            This removes the chat from Winglet on every device. Hermes keeps its own session history.
          </Text>
          <Button title="Delete chat" variant="danger" icon={<Trash2 size={16} color={t.colors.danger} />}
            onPress={async () => { if (chat) await deleteChat(server.id, chat.id); close(); }} />
          <Button title="Cancel" variant="secondary" onPress={() => setMode('menu')} />
        </View>
      )}
    </Sheet>
  );
}

const useStyles = makeStyles((t) => ({
  split: { flex: 1, flexDirection: 'row', backgroundColor: t.colors.bg },
  listPane: { width: 360, borderRightWidth: 1, borderRightColor: t.colors.border },
  root: { flex: 1, backgroundColor: t.colors.bg },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48 },
  title: { ...t.type.display, color: t.colors.text, marginTop: 10, marginBottom: 14 },
  search: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 14, paddingRight: 6, minHeight: 46, borderRadius: t.radius.pill,
    backgroundColor: t.colors.surfaceSunken, marginBottom: 14,
  },
  searchInput: { flex: 1, ...t.type.body, color: t.colors.text, paddingVertical: 10, ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}) },
  main: {
    flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, borderRadius: t.radius.lg, marginTop: 8, marginBottom: 6,
    backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border,
  },
  mainTitle: { ...t.type.heading, color: t.colors.text, flexShrink: 1 },
  active: { backgroundColor: t.colors.accentSoft, borderColor: 'transparent' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 12, paddingVertical: 11, borderRadius: t.radius.md, minHeight: 64 },
  rowIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowTitle: { ...t.type.bodyStrong, color: t.colors.text, flex: 1 },
  preview: { ...t.type.callout, color: t.colors.textSecondary, marginTop: 1 },
  time: { ...t.type.caption, color: t.colors.textTertiary, marginLeft: 'auto' },
  empty: { alignItems: 'center', gap: 14, paddingVertical: 24, paddingHorizontal: 12 },
  emptyText: { ...t.type.callout, color: t.colors.textSecondary, textAlign: 'center' },
  hit: { fontFamily: t.fonts.semibold, color: t.colors.text, backgroundColor: t.colors.accentSoft },
}));
