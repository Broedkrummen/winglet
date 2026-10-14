import { Redirect, router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Platform, RefreshControl, ScrollView, Text, TextInput, useWindowDimensions, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { AgentFace } from '../../components/AgentFace';
import { BotAvatar, botColor } from '../../components/BotAvatar';
import { BotSwitcher } from '../../components/BotSwitcher';
import { ConnectionBanner } from '../../components/ConnectionBanner';
import { GoalRing, goalStatus } from '../../components/Goal';
import { ArrowUp, Hash, MessageSquarePlus, Plus, Sparkles, Square } from '../../components/icons';
import { InboxCard } from '../../components/InboxCards';
import { useTabBarSpace } from '../../components/TabBar';
import { Chip, IconButton, SectionHeader, Tap } from '../../components/ui';
import { ago, chatName, greeting, headline, pendingItems, workingChats } from '../../lib/agent';
import { api } from '../../lib/api';
import { haptic } from '../../lib/haptics';
import { plainText } from '../../lib/text';
import { easeOut, useReducedMotion } from '../../lib/motion';
import { homeChat, useApp, useServerState } from '../../lib/store';
import { WIDE_BREAKPOINT } from '../../lib/theme';
import { makeStyles, useTheme } from '../../lib/themeContext';
import type { Chat, GoalEntry, InboxItem, Server } from '../../lib/types';

const SUGGESTIONS = ['What can you do?', 'Plan my day', 'What did you get done today?'];

function pairFromHash(): { code: string; fp?: string } | null {
  if (Platform.OS !== 'web') return null;
  const hash = globalThis.location?.hash ?? '';
  const m = hash.match(/pair=([A-Za-z0-9-]+)/);
  const fp = hash.match(/[&#]fp=([A-Za-z0-9_-]{16,64})/);
  return m ? { code: m[1], ...(fp ? { fp: fp[1] } : {}) } : null;
}

/**
 * Home: what your agent is doing and what it needs from you, before anything else. The face up top
 * reacts to its state; the cards below are ordered by urgency.
 */
export default function Home() {
  const servers = useApp((s) => s.servers);
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const hashLink = pairFromHash();
  useEffect(() => {
    if (!selection.serverId && servers[0]) select(servers[0].id, homeChat(useApp.getState().runtime[servers[0].id]));
  }, [selection.serverId, servers, select]);

  if (hashLink) {
    globalThis.history?.replaceState(null, '', '/');
    return <Redirect href={{ pathname: '/pair', params: { ...hashLink, url: globalThis.location.origin } }} />;
  }
  if (!servers.length) return <Redirect href="/pair" />;
  const server = servers.find((s) => s.id === selection.serverId) ?? servers[0];
  return <HomeFor server={server} />;
}

function HomeFor({ server }: { server: Server }) {
  const t = useTheme();
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const tabSpace = useTabBarSpace();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_BREAKPOINT;
  const rt = useServerState(server.id);
  // Waiting on other bots: a number, so their chats streaming don't re-render this one.
  const elsewhere = useApp((st) => st.servers.reduce((n, x) => n + (x.id === server.id ? 0 : st.runtime[x.id]?.pending ?? 0), 0));
  const loadInbox = useApp((st) => st.loadInbox);
  const retryNow = useApp((st) => st.retryNow);
  const [refreshing, setRefreshing] = useState(false);
  const [, tick] = useState(0);

  // Typing indicators and the "just finished" smile expire on their own; re-render to notice.
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 2500);
    return () => clearInterval(id);
  }, []);

  const head = headline(rt, server.bot.title);
  const pending = pendingItems(rt);
  const working = workingChats(rt);
  const chats = useMemo(() => Object.values(rt?.chats ?? {}).filter((c) => c.kind === 'chat').sort((a, b) => b.updated_at - a.updated_at).slice(0, 8), [rt?.chats]);
  const updates = useMemo(() => Object.values(rt?.inbox ?? {}).filter((i) => i.kind === 'result').sort((a, b) => b.created_at - a.created_at).slice(0, 3), [rt?.inbox]);

  const refresh = async () => {
    haptic.soft();
    setRefreshing(true);
    retryNow(server.id);
    await loadInbox(server.id);
    setRefreshing(false);
  };

  return (
    <View style={s.root}>
      <ScrollView
        contentContainerStyle={[s.scroll, { paddingTop: insets.top + 8, paddingBottom: tabSpace + 16 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={t.colors.accent} colors={[t.colors.accentFill]} progressBackgroundColor={t.colors.surfaceRaised} />}
        keyboardShouldPersistTaps="handled"
      >
        <Aurora color={botColor(server.bot.name)} />
        <View style={[s.column, wide && s.columnWide]}>
          <View style={s.topRow}>
            {wide ? <View /> : <BotSwitcher />}
            <IconButton label="New chat" variant="filled" onPress={() => newChat(server.id)}>
              <MessageSquarePlus size={20} color={t.colors.text} />
            </IconButton>
          </View>

          <View style={s.presence}>
            <AgentFace server={server} size={108} animated glow />
            <Text style={s.greeting}>{greeting()}</Text>
            <Text style={s.headline} accessibilityRole="header" accessibilityLiveRegion="polite">{head.title}</Text>
            <Text style={s.detail}>{head.detail}</Text>
          </View>

          <QuickAsk server={server} />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.suggestions}>
            {SUGGESTIONS.map((q) => <Chip key={q} label={q} icon={<Sparkles size={14} color={t.colors.accent} />} onPress={() => ask(server.id, q)} />)}
          </ScrollView>

          <ConnectionBanner server={server} />

          {pending.length ? (
            <Section title={`Needs you · ${pending.length}`} action={pending.length > 2 || elsewhere ? 'See all' : undefined} onAction={() => router.navigate('/inbox')}>
              <View style={{ gap: 12 }}>
                {pending.slice(0, 2).map((item) => <InboxCard key={item.id} serverId={server.id} item={item} compact />)}
              </View>
            </Section>
          ) : null}
          {elsewhere ? (
            <Tap feedback="selection" onPress={() => router.navigate('/inbox')} style={s.elsewhere} accessibilityLabel={`${elsewhere} waiting on other bots. Open inbox`}>
              <View style={s.elsewhereDot} />
              <Text style={s.elsewhereText}>{elsewhere} waiting on {elsewhere === 1 ? 'another bot' : 'other bots'}</Text>
              <Text style={s.link}>Open inbox</Text>
            </Tap>
          ) : null}

          {working.length ? (
            <Section title="Working now">
              <View style={{ gap: 10 }}>
                {working.map((chat) => <WorkingRow key={chat.id} server={server} chat={chat} />)}
              </View>
            </Section>
          ) : null}

          <Goals server={server} />

          <Section title="Continue" action="All chats" onAction={() => router.navigate('/chats')}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12, paddingRight: 4 }}>
              {chats.map((chat, i) => <ChatCard key={chat.id} server={server} chat={chat} index={i} />)}
              <Tap feedback="selection" accessibilityLabel="New chat" onPress={() => newChat(server.id)} style={[s.chatCard, s.newCard]}>
                <View style={s.newIcon}><Plus size={22} color={t.colors.onAccentSoft} /></View>
                <Text style={s.newText}>New chat</Text>
              </Tap>
            </ScrollView>
          </Section>

          {updates.length ? (
            <Section title="Recent updates" action="Open" onAction={() => router.push(`/chat/${server.id}/home`)}>
              <View style={s.group}>
                {updates.map((item, i) => <UpdateRow key={item.id} server={server} item={item} first={i === 0} />)}
              </View>
            </Section>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

async function newChat(serverId: string) {
  try {
    const chat = await useApp.getState().createChat(serverId);
    if (chat) router.push(`/chat/${serverId}/${chat.id}`);
  } catch {
    useApp.getState().toast({ serverId, title: "Couldn't start a chat", body: 'Your bot is out of reach right now. Try again when it’s back.' });
  }
}

/** Send a question to the main chat and go there to watch the answer arrive. */
function ask(serverId: string, text: string) {
  haptic.light();
  const main = homeChat(useApp.getState().runtime[serverId]);
  useApp.getState().sendMessage(serverId, main, text);
  router.push(`/chat/${serverId}/${main}`);
}

function QuickAsk({ server }: { server: Server }) {
  const t = useTheme();
  const s = useStyles();
  const [text, setText] = useState('');
  const send = () => {
    const v = text.trim();
    if (!v) return;
    setText('');
    ask(server.id, v);
  };
  return (
    <View style={s.ask}>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder={`Ask ${server.bot.title} anything…`}
        placeholderTextColor={t.colors.textTertiary}
        style={s.askInput}
        returnKeyType="send"
        onSubmitEditing={send}
        accessibilityLabel={`Ask ${server.bot.title}`}
      />
      <Tap feedback="light" accessibilityLabel="Send" disabled={!text.trim()} onPress={send}
        style={[s.askSend, { backgroundColor: text.trim() ? t.colors.accentFill : t.colors.surfaceSunken }]}>
        <ArrowUp size={20} color={text.trim() ? t.colors.onAccent : t.colors.textTertiary} strokeWidth={2.5} />
      </Tap>
    </View>
  );
}

/** What each chat is working toward (/goal), active ones first. Hidden when there are none. */
function Goals({ server }: { server: Server }) {
  const t = useTheme();
  const s = useStyles();
  const supported = useApp((st) => !!st.runtime[server.id]?.info?.features?.goals);
  const online = useApp((st) => st.runtime[server.id]?.status === 'online');
  const lastReply = useApp((st) => st.runtime[server.id]?.lastReplyAt);
  const mainId = useApp((st) => homeChat(st.runtime[server.id]));
  const [goals, setGoals] = useState<GoalEntry[]>([]);
  useEffect(() => {
    if (!supported || !online) return;
    api<{ goals: GoalEntry[] }>(server, '/api/goals').then((d) => setGoals(d.goals)).catch(() => undefined);
  }, [server, supported, online, lastReply]);
  const shown = goals.filter((g) => g.goal.status !== 'done').slice(0, 3);
  if (!shown.length) return null;
  return (
    <Section title="Working toward">
      <View style={s.group}>
        {shown.map((g, i) => (
          <Tap key={g.chat_id} feedback="selection" onPress={() => router.push(`/chat/${server.id}/${g.chat_id}`)}
            accessibilityLabel={`Goal: ${g.goal.goal}. ${goalStatus(g.goal)}. In ${g.chat_id === mainId ? 'the main chat' : g.title}`}
            style={({ hovered }) => [s.goalRow, i > 0 && s.goalDivider, hovered && { backgroundColor: t.colors.surfaceRaised }]}>
            <GoalRing goal={g.goal} size={40} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.goalText} numberOfLines={2}>{g.goal.goal}</Text>
              <Text style={s.goalMeta} numberOfLines={1}>
                {g.chat_id === mainId ? server.bot.title : `#${g.title}`} · {goalStatus(g.goal)}
              </Text>
            </View>
          </Tap>
        ))}
      </View>
    </Section>
  );
}

function Section({ title, action, onAction, children }: { title: string; action?: string; onAction?: () => void; children: React.ReactNode }) {
  const s = useStyles();
  return (
    <View>
      <SectionHeader title={title} right={action ? (
        <Text accessibilityRole="button" style={s.link} onPress={onAction} suppressHighlighting>{action}</Text>
      ) : undefined} />
      {children}
    </View>
  );
}

function WorkingRow({ server, chat }: { server: Server; chat: Chat }) {
  const t = useTheme();
  const s = useStyles();
  const sendMessage = useApp((st) => st.sendMessage);
  return (
    <Tap feedback="selection" scaleTo={0.98} accessibilityLabel={`${chatName(chat)}, working. Open`} onPress={() => router.push(`/chat/${server.id}/${chat.id}`)} style={s.working}>
      <PulseDot />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={s.cardTitle} numberOfLines={1}>{chatName(chat)}</Text>
        <Text style={s.cardBody} numberOfLines={2}>{plainText(chat.preview) || 'Thinking…'}</Text>
      </View>
      <Tap feedback="light" accessibilityLabel={`Stop the task in ${chatName(chat)}`} onPress={() => sendMessage(server.id, chat.id, '/stop')} style={s.stop}>
        <Square size={12} color={t.colors.text} fill={t.colors.text} />
        <Text style={s.stopText}>Stop</Text>
      </Tap>
    </Tap>
  );
}

function PulseDot() {
  const t = useTheme();
  const reduced = useReducedMotion();
  return (
    <View style={{ width: 14, height: 14, alignItems: 'center', justifyContent: 'center' }}>
      {reduced ? null : <View style={{ position: 'absolute', width: 14, height: 14, borderRadius: 7, backgroundColor: t.colors.warningSoft }} />}
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: t.colors.warning }} />
    </View>
  );
}

function ChatCard({ server, chat, index }: { server: Server; chat: Chat; index: number }) {
  const t = useTheme();
  const s = useStyles();
  const general = useApp((st) => homeChat(st.runtime[server.id])) === chat.id;
  return (
    <Animated.View entering={FadeInDown.delay(40 * index).duration(260).easing(easeOut)}>
      <Tap feedback="selection" scaleTo={0.97} accessibilityLabel={`${chat.title}. ${plainText(chat.preview)}`} onPress={() => router.push(`/chat/${server.id}/${chat.id}`)}
        style={({ hovered }) => [s.chatCard, hovered && { borderColor: t.colors.borderStrong }]}>
        <View style={s.cardTop}>
          {general ? <BotAvatar name={server.bot.name} size={30} /> : <View style={s.hash}><Hash size={16} color={t.colors.onAccentSoft} /></View>}
          <Text style={s.time}>{ago(chat.updated_at)}</Text>
        </View>
        <Text style={s.cardTitle} numberOfLines={1}>{general ? 'Main chat' : chat.title}</Text>
        <Text style={s.cardBody} numberOfLines={2}>{plainText(chat.preview) || 'No messages yet'}</Text>
      </Tap>
    </Animated.View>
  );
}

function UpdateRow({ server, item, first }: { server: Server; item: InboxItem; first: boolean }) {
  const t = useTheme();
  const s = useStyles();
  return (
    <Tap feedback="selection" scaleTo={0.99} accessibilityLabel={`${item.title}. Open`} onPress={() => router.push(`/chat/${server.id}/${item.chat_id}`)}
      style={({ pressed }) => [s.update, !first && s.updateBorder, pressed && { backgroundColor: t.colors.pressed }]}>
      <View style={[s.updateIcon, { backgroundColor: t.colors.successSoft }]}><Sparkles size={16} color={t.colors.success} /></View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={s.cardTitle} numberOfLines={1}>{item.title}</Text>
        <Text style={s.cardBody} numberOfLines={1}>{item.body}</Text>
      </View>
      <Text style={s.time}>{ago(item.created_at)}</Text>
    </Tap>
  );
}

/** A soft glow in the bot's colour behind the top of Home. On true black it reads like light. */
function Aurora({ color }: { color: string }) {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const strength = t.scheme === 'dark' ? 0.42 : 0.2;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 520 }}>
      <Svg width={width} height={520}>
        <Defs>
          <RadialGradient id="aurora" cx="50%" cy="22%" rx="70%" ry="55%">
            <Stop offset="0" stopColor={color} stopOpacity={strength} />
            <Stop offset="0.55" stopColor={color} stopOpacity={strength * 0.25} />
            <Stop offset="1" stopColor={color} stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id="aurora2" cx="15%" cy="8%" rx="45%" ry="30%">
            <Stop offset="0" stopColor={t.colors.accent} stopOpacity={strength * 0.6} />
            <Stop offset="1" stopColor={t.colors.accent} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x={0} y={0} width={width} height={520} fill="url(#aurora)" />
        <Rect x={0} y={0} width={width} height={520} fill="url(#aurora2)" />
      </Svg>
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  root: { flex: 1, backgroundColor: t.colors.bg },
  scroll: { flexGrow: 1 },
  column: { paddingHorizontal: 16, width: '100%' },
  columnWide: { maxWidth: 760, alignSelf: 'center', paddingHorizontal: 28 },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48 },
  presence: { alignItems: 'center', paddingTop: 18, paddingBottom: 20, gap: 4 },
  greeting: { ...t.type.caption, fontSize: 13.5, color: t.colors.textSecondary, marginTop: 16, letterSpacing: 0.2 },
  headline: { ...t.type.display, color: t.colors.text, textAlign: 'center' },
  detail: { ...t.type.callout, color: t.colors.textSecondary, textAlign: 'center', maxWidth: 340, marginTop: 2 },
  ask: {
    flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 56, paddingLeft: 20, paddingRight: 7, borderRadius: t.radius.pill,
    backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.borderStrong,
    shadowColor: t.colors.shadow, shadowOpacity: t.scheme === 'light' ? 0.08 : 0, shadowRadius: 18, shadowOffset: { width: 0, height: 6 },
  },
  askInput: {
    flex: 1, ...t.type.body, color: t.colors.text, paddingVertical: 12,
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}),
  },
  askSend: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  suggestions: { gap: 8, paddingVertical: 12, paddingHorizontal: 2 },
  link: { ...t.type.callout, fontFamily: t.fonts.semibold, color: t.colors.accent, paddingVertical: 6 },
  elsewhere: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12, paddingHorizontal: 14, paddingVertical: 12,
    borderRadius: t.radius.md, backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border,
  },
  elsewhereDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: t.colors.danger },
  elsewhereText: { ...t.type.callout, color: t.colors.text, flex: 1 },
  working: {
    flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: t.radius.lg,
    backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border,
  },
  stop: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, minHeight: 36, borderRadius: t.radius.pill,
    backgroundColor: t.colors.surfaceSunken,
  },
  stopText: { fontFamily: t.fonts.semibold, fontSize: 13.5, color: t.colors.text },
  chatCard: {
    width: 200, minHeight: 132, padding: 14, gap: 6, borderRadius: t.radius.lg,
    backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  hash: { width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.accentSoft },
  time: { ...t.type.caption, color: t.colors.textTertiary },
  cardTitle: { ...t.type.bodyStrong, fontSize: 15.5, color: t.colors.text },
  cardBody: { ...t.type.callout, color: t.colors.textSecondary },
  newCard: { alignItems: 'center', justifyContent: 'center', width: 132, borderStyle: 'dashed', borderColor: t.colors.borderStrong, backgroundColor: 'transparent' },
  newIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.accentSoft },
  newText: { ...t.type.callout, fontFamily: t.fonts.semibold, color: t.colors.text, marginTop: 6 },
  group: { backgroundColor: t.colors.surface, borderRadius: t.radius.lg, borderWidth: 1, borderColor: t.colors.border, overflow: 'hidden' },
  update: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12, minHeight: 60 },
  goalRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 14, paddingVertical: 14 },
  goalDivider: { borderTopWidth: 1, borderTopColor: t.colors.border },
  goalText: { ...t.type.callout, fontFamily: t.fonts.semibold, color: t.colors.text },
  goalMeta: { ...t.type.caption, color: t.colors.textSecondary, marginTop: 3 },
  updateBorder: { borderTopWidth: 1, borderTopColor: t.colors.border },
  updateIcon: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
}));
