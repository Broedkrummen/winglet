import { Redirect, router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Platform, RefreshControl, ScrollView, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { useAddBot } from '../../components/AddBot';
import { AgentFace, useAvatarColor } from '../../components/AgentFace';
import { BotSwitcher } from '../../components/BotSwitcher';
import { ConnectionBanner } from '../../components/ConnectionBanner';
import { GoalRing, goalStatus } from '../../components/Goal';
import { ArrowUp, ChevronLeft, ChevronRight, Hash, MessageSquarePlus, Plus, Sparkles, Square } from '../../components/icons';
import { InboxCard } from '../../components/InboxCards';
import { LivePet } from '../../components/LivePet';
import { useTabBarSpace } from '../../components/TabBar';
import { Badge, IconButton, SectionHeader, Tap } from '../../components/ui';
import { ago, chatName, headline, pendingItems, workingChats } from '../../lib/agent';
import { api } from '../../lib/api';
import { askMainChat, startNewChat } from '../../lib/actions';
import { mainFirst } from '../../lib/bots';
import { connectionView } from '../../lib/connection';
import { haptic } from '../../lib/haptics';
import { setMainBot, useMainBot } from '../../lib/mainBot';
import { plainText } from '../../lib/text';
import { useReducedMotion } from '../../lib/motion';
import { usePrefs } from '../../lib/prefs';
import { homeChat, useApp, useServerState } from '../../lib/store';
import { WIDE_BREAKPOINT } from '../../lib/theme';
import { makeStyles, useTheme } from '../../lib/themeContext';
import type { Chat, GoalEntry, InboxItem, Server } from '../../lib/types';

function pairFromHash(): { code: string; fp?: string } | null {
  if (Platform.OS !== 'web') return null;
  const hash = globalThis.location?.hash ?? '';
  const m = hash.match(/pair=([A-Za-z0-9-]+)/);
  const fp = hash.match(/[&#]fp=([A-Za-z0-9_-]{16,64})/);
  return m ? { code: m[1], ...(fp ? { fp: fp[1] } : {}) } : null;
}

/**
 * Home: one bot up front (the main one to begin with) and the rest a tap away. Its face reacts to what it's
 * doing; below it, what it needs from you and where you left off, ordered by urgency.
 */
export default function Home() {
  const servers = useApp((s) => s.servers);
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const main = useMainBot();
  const hashLink = pairFromHash();
  useEffect(() => {
    if (!selection.serverId && main) select(main.id, homeChat(useApp.getState().runtime[main.id]));
  }, [selection.serverId, main, select]);

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
  const main = useMainBot();
  const loadInbox = useApp((st) => st.loadInbox);
  const select = useApp((st) => st.select);
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
        <Aurora server={server} />
        <View style={[s.column, wide && s.columnWide]}>
          <View style={s.topRow}>
            {wide ? <View /> : <BotSwitcher />}
            <IconButton label="New chat" variant="filled" onPress={() => startNewChat(server.id)}>
              <MessageSquarePlus size={20} color={t.colors.text} />
            </IconButton>
          </View>
          {main && main.id !== server.id ? (
            <Tap feedback="selection" onPress={() => select(main.id, homeChat(useApp.getState().runtime[main.id]))}
              accessibilityLabel={`Back to ${main.bot.title}, your main bot`} style={s.back}>
              <ChevronLeft size={16} color={t.colors.onAccentSoft} />
              <Text style={s.backText}>Back to {main.bot.title}</Text>
            </Tap>
          ) : null}

          <View style={s.presence}>
            <LivePet server={server} size={116} glow />
            <Text style={s.name} accessibilityRole="header">{server.bot.title}</Text>
            <Text style={s.status} accessibilityLiveRegion="polite">{head.title}</Text>
            {main?.id === server.id ? null : (
              <Text accessibilityRole="button" style={s.makeMain} onPress={() => { haptic.selection(); setMainBot(server.id); }} suppressHighlighting>
                Make {server.bot.title} my main bot
              </Text>
            )}
          </View>

          <QuickAsk server={server} />
          <BotStrip current={server} />

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

          <Continue server={server} />

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

function QuickAsk({ server }: { server: Server }) {
  const t = useTheme();
  const s = useStyles();
  const [text, setText] = useState('');
  const send = () => {
    const v = text.trim();
    if (!v) return;
    setText('');
    haptic.light();
    askMainChat(server.id, v);
  };
  return (
    <View style={s.ask}>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder={`Message ${server.bot.title}`}
        placeholderTextColor={t.colors.textTertiary}
        style={s.askInput}
        returnKeyType="send"
        onSubmitEditing={send}
        accessibilityLabel={`Message ${server.bot.title}`}
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

/** Where you left off: the last chat you touched, one tap to pick it up. */
function Continue({ server }: { server: Server }) {
  const t = useTheme();
  const s = useStyles();
  const rt = useServerState(server.id);
  const mainId = homeChat(rt);
  // Chats it's working in show above as "Working now", so this is the latest one that isn't.
  const last = useMemo(() => {
    const busy = new Set(workingChats(rt).map((c) => c.id));
    return Object.values(rt?.chats ?? {}).filter((c) => c.kind === 'chat' && !busy.has(c.id)).sort((x, y) => y.updated_at - x.updated_at)[0];
  }, [rt]);
  if (!last) return null;
  const general = last.id === mainId;
  return (
    <Section title="Continue" action="All chats" onAction={() => router.navigate('/chats')}>
      <Tap feedback="selection" scaleTo={0.98} accessibilityLabel={`Continue ${general ? 'the main chat' : last.title}. ${plainText(last.preview)}`}
        onPress={() => router.push(`/chat/${server.id}/${last.id}`)}
        style={({ hovered }) => [s.continue, hovered && { borderColor: t.colors.borderStrong }]}>
        {general ? <AgentFace server={server} size={40} still /> : <View style={s.hash}><Hash size={18} color={t.colors.onAccentSoft} /></View>}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.cardTitle} numberOfLines={1}>{general ? 'Main chat' : last.title}</Text>
          <Text style={s.cardBody} numberOfLines={1}>{plainText(last.preview) || 'No messages yet'}</Text>
        </View>
        <Text style={s.time}>{ago(last.updated_at)}</Text>
        <ChevronRight size={18} color={t.colors.textTertiary} />
      </Tap>
    </Section>
  );
}

/** Your other bots as a compact row: tap one to bring it up front. The main bot stays easy to get back to. */
function BotStrip({ current }: { current: Server }) {
  const t = useTheme();
  const s = useStyles();
  const servers = useApp((st) => st.servers);
  const runtime = useApp((st) => st.runtime);
  const network = useApp((st) => st.network);
  const select = useApp((st) => st.select);
  const chosen = usePrefs((st) => st.prefs.mainBot);
  const addBot = useAddBot();
  const ordered = mainFirst(servers, chosen);
  const others = ordered.filter((x) => x.id !== current.id);
  return (
    <>
      {others.length ? <Text style={s.crew}>Crew</Text> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.strip}>
        {others.map((x) => {
          const rt = runtime[x.id];
          const view = connectionView(network, rt, x.bot.title);
          const status = view.kind === 'online' ? (rt?.pending ? 'busy' : 'online') : view.kind === 'connecting' ? 'connecting' : 'offline';
          return (
            <Tap key={x.id} feedback="selection" scaleTo={0.95} onPress={() => select(x.id, homeChat(useApp.getState().runtime[x.id]))}
              accessibilityLabel={`${x.bot.title}${x === ordered[0] ? ', main bot' : ''}${rt?.pending ? `, ${rt.pending} waiting` : ''}. Switch to it`} style={s.botTile}>
              <View>
                <AgentFace server={x} size={44} status={status} still />
                {rt?.pending ? <Badge count={rt.pending} style={{ position: 'absolute', top: -4, right: -6 }} /> : null}
              </View>
              <Text style={s.botTileName} numberOfLines={1}>{x.bot.title}</Text>
              {x === ordered[0] ? <Text style={s.botTileTag}>Main</Text> : null}
            </Tap>
          );
        })}
        <Tap feedback="selection" scaleTo={0.95} accessibilityLabel="Add a bot" onPress={addBot.open} style={s.botTile}>
          <View style={s.addTile}><Plus size={22} color={t.colors.success} /></View>
          <Text style={s.botTileName}>Add</Text>
        </Tap>
      </ScrollView>
      {addBot.sheet}
    </>
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
function Aurora({ server }: { server: Server }) {
  const t = useTheme();
  const color = useAvatarColor(server);
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
  presence: { alignItems: 'center', paddingTop: 12, paddingBottom: 20, gap: 4 },
  name: { ...t.type.display, color: t.colors.text, textAlign: 'center', marginTop: 14 },
  status: { ...t.type.callout, color: t.colors.textSecondary, textAlign: 'center' },
  back: {
    flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'center', paddingLeft: 8, paddingRight: 12, minHeight: 32,
    borderRadius: t.radius.pill, backgroundColor: t.colors.accentSoft,
  },
  backText: { ...t.type.caption, fontFamily: t.fonts.semibold, color: t.colors.onAccentSoft },
  crew: { ...t.type.caption, fontFamily: t.fonts.semibold, color: t.colors.textTertiary, marginTop: 18 },
  makeMain: { ...t.type.caption, fontFamily: t.fonts.semibold, color: t.colors.accent, paddingVertical: 8 },
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
  strip: { gap: 14, paddingVertical: 14, paddingHorizontal: 2 },
  botTile: { width: 64, alignItems: 'center', gap: 4 },
  botTileName: { ...t.type.caption, fontFamily: t.fonts.semibold, color: t.colors.text, textAlign: 'center', maxWidth: 64 },
  botTileTag: { ...t.type.caption, fontSize: 11, color: t.colors.textTertiary, marginTop: -3 },
  addTile: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderStyle: 'dashed', borderColor: t.colors.borderStrong },
  continue: {
    flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12, minHeight: 64, borderRadius: t.radius.lg,
    backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border,
  },
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
  hash: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.accentSoft },
  time: { ...t.type.caption, color: t.colors.textTertiary },
  cardTitle: { ...t.type.bodyStrong, fontSize: 15.5, color: t.colors.text },
  cardBody: { ...t.type.callout, color: t.colors.textSecondary },
  group: { backgroundColor: t.colors.surface, borderRadius: t.radius.lg, borderWidth: 1, borderColor: t.colors.border, overflow: 'hidden' },
  update: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12, minHeight: 60 },
  goalRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 14, paddingVertical: 14 },
  goalDivider: { borderTopWidth: 1, borderTopColor: t.colors.border },
  goalText: { ...t.type.callout, fontFamily: t.fonts.semibold, color: t.colors.text },
  goalMeta: { ...t.type.caption, color: t.colors.textSecondary, marginTop: 3 },
  updateBorder: { borderTopWidth: 1, borderTopColor: t.colors.border },
  updateIcon: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
}));
