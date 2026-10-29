import { BlurTargetView } from 'expo-blur';
import * as Clipboard from 'expo-clipboard';
import { router, useFocusEffect } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, FlatList, Keyboard, Platform, Pressable, Share as SystemShare, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector, ScrollView } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation, FadeIn, FadeInDown, FadeOut, runOnJS, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence,
  withSpring, withTiming, ZoomIn,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BranchSheet, type BranchTarget } from '../features/branching/BranchSheet';
import { BranchStrip } from '../features/branching/BranchStrip';
import { actionHint, canBranch, canEdit, canRegenerate, laterCount, type BranchMode } from '../features/branching/plan';
import { useBranching } from '../features/branching/useBranching';
import { routineHref } from '../features/routine-history/model';
import { mediaUrl } from '../lib/api';
import { useLock } from '../lib/appLock';
import { readingKey, visibleReading } from '../features/sync/reading';
import { startNewChat } from '../lib/actions';
import { projectOf } from '../features/projects/logic';
import { connectionView } from '../lib/connection';
import { chatKey } from '../lib/chatOrganization';
import { clearFocus, requestFocus, useFocusRequest } from '../lib/focus';
import { haptic } from '../lib/haptics';
import { afterOlderPage, atStart, canLoadOlder, newPaging } from '../lib/history';
import { chatMessages, groupActivity, isActivity, type Entry } from '../lib/messages';
import { useModelSheet } from '../lib/modelSheet';
import { easeOut, spring, useReducedMotion } from '../lib/motion';
import { usePrefs } from '../lib/prefs';
import { homeChat, isOwner, isTyping, useApp, useServerState } from '../lib/store';
import { plainText } from '../lib/text';
import { statusNoticeText } from '../lib/statusNotice';
import { FIXED } from '../lib/theme';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { BranchState, DraftFile, InboxItem, Message, ReplyRef, Server, Upload } from '../lib/types';
import { AgentFace, useAvatarColor } from './AgentFace';
import { InboxButton, NavigationToggle } from './AppNavigation';
import { UserAvatar } from './BotAvatar';
import { Composer, focusComposer } from './Composer';
import { ModelButton } from './ModelSheet';
import { ChatMenu } from './ChatMenu';
import { ChatPet } from './ChatPet';
import type { DockPetFrame } from './ChatPet';
import { SyncStatus } from '../features/event-replay/SyncStatus';
import { ConnectionBanner } from './ConnectionBanner';
import { FilesSheet } from './FilesSheet';
import { ProcessesSheet } from '../features/processes/ProcessesSheet';
import { ContextSheet } from '../features/context-insights/ContextSheet';
import { GoalSheet, GoalStrip, useChatGoal } from './Goal';
import { PausedBanner } from './PausedBanner';
import { Glass } from './Glass';
import {
  ArrowDown, CalendarClock, Check, ChevronDown, Clock, Copy, FileText, Folder, GitBranch, MoreHorizontal, Pencil, Reply, RotateCcw, Share, X,
} from './icons';
import { InboxCard } from './InboxCards';
import { Markdown } from './Markdown';
import { PickerCard } from './PickerCard';
import { MessageAttachments } from './MessageAttachments';
import { KeyboardViewport } from './KeyboardViewport';
import { Sheet, SheetAction } from './Sheet';
import { Badge, Button, IconButton, Tap } from './ui';

import { QuoteSheet } from '../features/transcript-tools/QuoteSheet';
import { canQuote } from '../features/transcript-tools/model';

const GROUP_WINDOW_S = 7 * 60;
/** Scrolled further up than this, the jump-to-latest button appears. */
const AWAY_PX = 480;

/**
 * Touch screens get the phone gestures: long-press for the message menu (text isn't selectable in
 * place, "Select text" opens it in a sheet) and swipe right to reply. A mouse gets selectable text
 * and a small toolbar on hover.
 */
const TOUCH = Platform.OS !== 'web' || !!globalThis.matchMedia?.('(hover: none)').matches;

type Row =
  | { kind: 'msg'; key: string; m: Message; first: boolean; last: boolean; live: boolean; fresh: boolean; latestReply: boolean }
  | { kind: 'activity'; key: string; items: Message[]; working: boolean }
  | { kind: 'day'; key: string; label: string };

type Actions = {
  open: (m: Message) => void;
  reply: (m: Message) => void;
  quote?: (m: Message) => void;
  jump: (id: string) => void;
};

type Landing = { dock: (props: { focused: boolean; onPetLayout: (frame: DockPetFrame) => void }) => ReactNode;
  title: string; prepareChat?: () => Promise<string | null>; action?: ReactNode;
  /** Makes the header title a button (the bot picker), with a chevron. */
  onTitlePress?: () => void;
  /** Extra header buttons, before the inbox. */
  actions?: ReactNode };

export function ChatView({ server, chatId, showBack, embedded, landing }: { server: Server; chatId: string; showBack?: boolean; embedded?: boolean; landing?: Landing }) {
  const t = useTheme();
  const s = useStyles();
  const simple = usePrefs((st) => st.prefs.view === 'simple');
  const [simpleOptions, setSimpleOptions] = useState(false);
  const resumePoint = useApp(state => state.reading[readingKey(server.id, server.fingerprint ?? '', chatId)]?.resume);
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  // Not the messages of every chat: only this one's, below. Another chat streaming doesn't re-render this one.
  const runtime = useServerState(server.id);
  const network = useApp((st) => st.network);
  const loadMessages = useApp((st) => st.loadMessages);
  const hydrateChat = useApp((st) => st.hydrateChat);
  const setVisibleChat = useApp((st) => st.setVisibleChat);
  const setReplyTo = useApp((st) => st.setReplyTo);
  const chat = runtime?.chats[chatId];
  const messages = useApp((st) => st.runtime[server.id]?.messages[chatId]);
  const loaded = runtime?.loaded[chatId];
  const [, forceTick] = useState(0);
  const [headerH, setHeaderH] = useState(insets.top + 64);
  const [composerH, setComposerH] = useState(80);
  const [menu, setMenu] = useState(false);
  const [selected, setSelected] = useState<Message | null>(null);
  const [quoteSource, setQuoteSource] = useState<string | null>(null);
  const quoteMessage = useCallback((m: Message) => setQuoteSource(m.id), []);
  const [selectText, setSelectText] = useState<string | null>(null);
  const [goalOpen, setGoalOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [processesOpen, setProcessesOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [branchTarget, setBranchTarget] = useState<BranchTarget | null>(null);
  const target = useRef<View>(null);
  const typing = isTyping(runtime, chatId);
  const { goal, refresh: refreshGoal, supported: goalsSupported } = useChatGoal(server, chatId, !landing?.prepareChat);
  const branching = useBranching(server, chatId, !landing?.prepareChat);
  const focus = useFocusRequest(server.id, chatId);
  const [revealed, setRevealed] = useState<Record<string, true>>({});
  const [inputFocused, setInputFocused] = useState(false);
  const [sendCount, setSendCount] = useState(0);
  const [width, setWidth] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const [dockHeight, setDockHeight] = useState(224);
  const [petFrame, setPetFrame] = useState<DockPetFrame>({ centerY: 68, size: 74 });
  const petLayout = useCallback((frame: DockPetFrame) => setPetFrame((current) =>
    current.centerY === frame.centerY && current.size === frame.size ? current : frame), []);
  const turnKey = chatKey(server.id, chatId);
  const beginTurn = (destination: string) => {
    const key = chatKey(server.id, destination);
    setRevealed((current) => current[key] ? current : { ...current, [key]: true });
    setSendCount((n) => n + 1);
  };
  const composing = !!landing && (!!landing.action || (!simple && !revealed[turnKey]));
  useEffect(() => {
    if (simple && landing && !landing.action) setRevealed((current) => current[turnKey] ? current : { ...current, [turnKey]: true });
  }, [simple, turnKey, !!landing, !!landing?.action]);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setInputFocused(false));
    return () => hide.remove();
  }, []);
  useEffect(() => { setMenu(false); setSelected(null); setQuoteSource(null); setGoalOpen(false); setFilesOpen(false); setProcessesOpen(false); setBranchTarget(null); }, [server.id, chatId]);
  // The More sheet is the moment these gates matter: a reply may have settled since the last load.
  useEffect(() => { if (selected && branching.supported && branching.online) void branching.refresh(); }, [selected, branching.supported, branching.online, branching.refresh]);

  useFocusEffect(useCallback(() => {
    if (landing?.prepareChat) return;
    const visible = { serverId: server.id, chatId };
    setVisibleChat(visible);
    return () => { if (useApp.getState().visibleChat === visible) setVisibleChat(undefined); };
  }, [server.id, chatId, setVisibleChat, landing?.prepareChat]));

  // Show what this phone remembers straight away; the server's copy replaces it when it arrives.
  useEffect(() => {
    if (!landing?.prepareChat) hydrateChat(server.id, chatId);
  }, [server.id, chatId, hydrateChat, landing?.prepareChat]);

  useEffect(() => {
    if (!landing?.prepareChat && runtime?.status === 'online' && !loaded) loadMessages(server.id, chatId);
  }, [runtime?.status, loaded, server.id, chatId, loadMessages, landing?.prepareChat]);

  // Typing indicators expire client-side: re-render once, when this one runs out.
  const typingUntil = runtime?.typing[chatId];
  useEffect(() => {
    const left = (typingUntil ?? 0) - Date.now();
    if (left <= 0) return;
    const id = setTimeout(() => forceTick((n) => n + 1), left + 50);
    return () => clearTimeout(id);
  }, [typingUntil]);

  // Commands the app sent for a control (/model, /reasoning) stay out of the conversation, and so do the cards
  // Hermes answers them with: those are in the model sheet beside the message box.
  const sheetSlot = useModelSheet((st) => st.slots[`${server.id}:${chatId}`]);
  const shown = useMemo(() => chatMessages(messages ?? [], sheetSlot), [messages, sheetSlot]);

  const reply = useCallback((m: Message) => {
    haptic.selection();
    setReplyTo(server.id, chatId, toReplyRef(m));
  }, [server.id, chatId, setReplyTo]);

  if (runtime?.status === 'online' && !chat && !landing?.prepareChat) {
    return (
      <View style={[s.root, s.center, { paddingTop: insets.top }]}>
        <Text style={s.emptyTitle}>This chat was deleted</Text>
        {showBack ? <Button title="Back to chats" variant="secondary" onPress={() => router.replace('/chats')} /> : null}
      </View>
    );
  }

  const view = connectionView(network, runtime, server.bot.title);
  const main = chatId === homeChat(runtime);
  useEffect(() => {
    if (!chat || chat.kind !== 'chat') return;
    const prefs = usePrefs.getState().prefs;
    if (prefs.lastChatByBot[server.id] !== chatId) usePrefs.getState().update({ lastChatByBot: { ...prefs.lastChatByBot, [server.id]: chatId } });
  }, [server.id, chatId, chat?.kind]);
  const title = composing ? landing!.title : main ? server.bot.title : chat?.kind === 'home' ? 'Updates' : chat?.title ?? 'Chat';
  const project = runtime?.projects ? projectOf(runtime.projects, chatId) : undefined;
  const status = view.kind === 'online' ? (typing ? 'Working…' : 'Online') : view.kind === 'connecting' ? 'Connecting…'
    : view.kind === 'recovering' ? 'Finding new address…' : view.kind === 'unreachable' ? 'Offline' : view.title;
  const topPad = embedded ? 0 : insets.top;
  const dockOffset = Math.max(0, (viewportH - headerH - composerH - 8 - dockHeight) / 2);

  return (
    <KeyboardViewport>{(keyboardVisible) => {
      const committed = !landing?.action && (inputFocused || keyboardVisible || !composing);
      return <View style={s.root} onLayout={(e) => { setWidth(e.nativeEvent.layout.width); setViewportH(e.nativeEvent.layout.height ?? 0); }}>
      <BlurTargetView ref={target} style={{ flex: 1 }}>
        {!composing ? <Animated.View entering={landing ? FadeIn.duration(reduced ? 0 : 180) : undefined} style={{ flex: 1 }}><MessageList key={turnKey} server={server} chatId={chatId} messages={shown} loaded={!!loaded || !!messages?.length}
          typing={typing} top={headerH} bottom={composerH + (committed ? 48 : 0)} onOpen={setSelected} onReply={reply} onQuote={runtime?.info?.features?.quoted_comments ? quoteMessage : undefined} focus={focus}
          offline={view.kind !== 'online' && view.kind !== 'connecting'} /></Animated.View> : null}
        {landing && composing ? <View pointerEvents={committed ? 'none' : 'box-none'}
          style={[s.landingStage, { top: headerH, bottom: composerH + 8, display: committed ? 'none' : 'flex' }]}>
          <View style={{ flex: 1 }} onLayout={(e) => { if (e.nativeEvent.layout.height > 0) setDockHeight(e.nativeEvent.layout.height); }}>
            {landing.dock({ focused: committed, onPetLayout: petLayout })}
          </View>
        </View> : null}
      </BlurTargetView>
      <View style={s.headerWrap} onLayout={(e) => setHeaderH(e.nativeEvent.layout.height)} pointerEvents="box-none">
        {composing ? null : <Glass target={target} borderless style={StyleSheet.absoluteFill} />}
        <View style={[s.header, { paddingTop: topPad + 8 }]}>
          {simple ? <>
            <View style={{ width: 96, flexDirection: 'row' }}><NavigationToggle /></View>
            <View style={{ flex: 1, minWidth: 0, alignItems: 'center' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: '100%' }}>
                <AgentFace server={server} size={26} still />
                <Text style={s.headerTitle} accessibilityRole="header" numberOfLines={1}>{server.bot.title}</Text>
              </View>
              {status !== 'Online' ? <Text style={s.headerSub} accessibilityLiveRegion="polite">{status}</Text> : null}
            </View>
            <View style={{ width: 96, flexDirection: 'row', justifyContent: 'flex-end' }}>
              <IconButton size={48} label="Conversation options" onPress={() => setSimpleOptions(true)}><MoreHorizontal size={22} color={t.colors.text} /></IconButton>
              <InboxButton />
            </View>
          </> : <>
          <NavigationToggle />
          {composing && landing?.onTitlePress ? (
            <View style={s.headerFill}>
              <Tap feedback="selection" scaleTo={0.98} onPress={landing.onTitlePress} accessibilityLabel={`${title}, ${status}. Switch bot`}
                style={({ pressed, hovered }) => [s.titleButton, (pressed || hovered) && { backgroundColor: t.colors.pressed }]}>
                <View style={[s.statusDot, { backgroundColor: view.kind !== 'online' ? t.colors.warning : t.colors.success }]} />
                <Text style={s.headerTitle} numberOfLines={1} accessibilityRole="header">{title}</Text>
                <ChevronDown size={16} color={t.colors.textSecondary} />
              </Tap>
            </View>
          ) : <>
            {!composing ? <AgentFace server={server} size={30} still /> : null}
            <View style={s.headerFill}>
              <Text style={s.headerTitle} numberOfLines={1} accessibilityRole="header">{title}</Text>
              <View style={s.headerIdentity}>
                <View style={[s.statusDot, { backgroundColor: view.kind !== 'online' ? t.colors.warning : typing ? t.colors.accent : t.colors.success }]} />
                <Text style={[s.headerSub, { flexShrink: 0 }]} numberOfLines={1}>{status}</Text>
                {!composing && project ? (
                  <Tap feedback="selection" accessibilityLabel={`In project ${project.name}. Open project`} hitSlop={8}
                    onPress={() => router.push(`/project/${server.id}/${project.id}`)} style={s.projectChip}>
                    <Folder size={11} color={t.colors.textSecondary} />
                    <Text style={s.projectChipText} numberOfLines={1}>{project.name}</Text>
                  </Tap>
                ) : null}
              </View>
            </View>
          </>}
          {composing ? landing?.actions : null}
          {!landing?.prepareChat && !landing?.action && !composing ? <IconButton label="Chat options" onPress={() => setMenu(true)}><MoreHorizontal size={22} color={t.colors.text} /></IconButton> : null}
          <InboxButton />
          </>}
        </View>
        {composing ? null : <View style={s.hairline} />}
        <ConnectionBanner server={server} compact />
        <SyncStatus serverId={server.id} />
        <PausedBanner server={server} />
        {!simple && !composing ? <BranchStrip server={server} chatId={chatId} state={branching.state} /> : null}
        {!simple && !composing && goal ? <GoalStrip goal={goal} onPress={() => setGoalOpen(true)} /> : null}
      </View>
      {landing?.action ? <View style={{ position: 'absolute', bottom: 0, left: 16, right: 16, paddingTop: 12, paddingBottom: Math.max(insets.bottom, 12) }}
        onLayout={(e) => setComposerH(e.nativeEvent.layout.height)}>{landing.action}</View> : <Composer server={server} chatId={chatId} busy={typing} bottomInset={keyboardVisible ? 0 : embedded ? 12 : insets.bottom} target={target}
        onHeight={setComposerH} placeholder={`Message ${server.bot.title}`}
        prepareChat={landing?.prepareChat} onFocusChange={setInputFocused} onBeforeSend={beginTurn} />}
      {!simple && !landing?.action && width > 0 ? <ChatPet key={server.id} server={server} active={committed} width={width} composerHeight={composerH}
        dockHeight={dockHeight} dockOffset={dockOffset} frame={petFrame} sent={sendCount} perched={!landing} /> : null}
      <ChatMenu server={server} chatId={chatId} title={title} visible={menu} onClose={() => setMenu(false)}
        onGoal={goalsSupported && chat?.kind !== 'home' ? () => setGoalOpen(true) : undefined} hasGoal={!!goal && goal.status !== 'done'}
        onFiles={runtime?.info?.features?.files ? () => setFilesOpen(true) : undefined}
        onCheckpoints={runtime?.info?.features?.checkpoints && isOwner(runtime) ? () => router.push('/checkpoints') : undefined}
        onContext={runtime?.info?.features?.session_context && isOwner(runtime) ? () => setContextOpen(true) : undefined}
        onProcesses={runtime?.info?.features?.processes && isOwner(runtime) ? () => setProcessesOpen(true) : undefined}
        onDeleted={() => router.replace('/chats')} onArchived={() => router.replace('/chats')} />
      <Sheet visible={simpleOptions} onClose={() => setSimpleOptions(false)} title="Conversation options" scrollable>
        {resumePoint ? <>
          <SheetAction icon={<Clock />} label="Resume reading" onPress={() => { setSimpleOptions(false); requestFocus(server.id, chatId, resumePoint.message_id); }} />
          <SheetAction icon={<X />} label="Clear saved reading position" onPress={() => { setSimpleOptions(false); useApp.getState().observeReading(server.id, chatId, 0, null); }} />
        </> : null}
        <Text style={{ ...t.type.footnote, color: t.colors.textSecondary, paddingHorizontal: 16, paddingBottom: 12 }}>{chat?.title ?? 'Main conversation'}</Text>
        <ModelButton server={server} chatId={chatId} variant="header" prepareChat={landing?.prepareChat} />
        <SheetAction icon={<MoreHorizontal />} label="Chat settings and tools" onPress={() => { setSimpleOptions(false); setMenu(true); }} />
        {goalsSupported && chat?.kind !== 'home' ? <SheetAction icon={<Check />} label={goal ? 'Goal' : 'Set a goal'} onPress={() => { setSimpleOptions(false); setGoalOpen(true); }} /> : null}
        <SheetAction icon={<FileText />} label="Conversations and search" onPress={() => { setSimpleOptions(false); useApp.getState().select(server.id, chatId); router.navigate('/chats'); }} />
        <SheetAction icon={<Pencil />} label="New conversation" onPress={() => { setSimpleOptions(false); void startNewChat(server.id); }} />
        <SheetAction icon={<MoreHorizontal />} label="Full view" onPress={() => { setSimpleOptions(false); usePrefs.getState().update({ view: 'full' }); }} />
      </Sheet>
      <GoalSheet server={server} chatId={chatId} goal={goal} visible={goalOpen} onClose={() => setGoalOpen(false)} onChanged={refreshGoal} />
      <ContextSheet key={`context:${server.id}:${chatId}`} server={server} chatId={chatId} visible={contextOpen} onClose={() => setContextOpen(false)} />
      <ProcessesSheet key={`processes:${server.id}:${chatId}`} server={server} chatId={chatId}
        visible={processesOpen} onClose={() => setProcessesOpen(false)} />
      <FilesSheet server={server} chatId={chatId} visible={filesOpen} onClose={() => setFilesOpen(false)}
        onJump={(id) => requestFocus(server.id, chatId, id)} />
      <MessageMenu server={server} message={selected} busy={typing} onClose={() => setSelected(null)}
        onReply={reply} onQuote={runtime?.info?.features?.quoted_comments ? quoteMessage : undefined} onSelectText={setSelectText} messages={shown}
        branchingState={branching.state} branchingSupported={branching.supported} branchingOnline={branching.online}
        onBranch={(m, mode) => { setSelected(null); setBranchTarget({ message: m, mode }); }} />
      <QuoteSheet key={`quote:${server.id}:${chatId}:${quoteSource ?? ''}`} server={server} chatId={chatId}
        message={shown.find(m => m.id === quoteSource) ?? null} visible={quoteSource !== null} onClose={() => setQuoteSource(null)}
        onBranch={quoteSource && canBranch(branching.state, quoteSource) ? () => {
          const message = shown.find(m => m.id === quoteSource);
          setQuoteSource(null); if (message) setBranchTarget({message, mode: 'branch'});
        } : undefined} />
      <BranchSheet server={server} chatId={chatId} chatTitle={chat?.title || server.bot.title} messages={shown} state={branching.state}
        online={branching.online} target={branchTarget} onClose={() => setBranchTarget(null)} onRefresh={branching.refresh} />
      <Sheet visible={selectText !== null} onClose={() => setSelectText(null)} title="Select text">
        <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 8 }}>
          <Text selectable style={s.selectText}>{selectText}</Text>
        </ScrollView>
      </Sheet>
    </View>; }}</KeyboardViewport>
  );
}

/**
 * Put a message back in the box to change and send again, with what it replied to. A send that failed also
 * brings back its photos and files (already uploaded, so nothing is picked again).
 */
function editAgain(server: Server, m: Message, failed: boolean) {
  const st = useApp.getState();
  const key = `${server.id}:${m.chat_id}`;
  if ((st.drafts[key]?.trim() && st.drafts[key] !== m.text)
    || (st.replyTo[key] && st.replyTo[key].id !== m.meta?.reply_to?.id)) {
    st.toast({ serverId: server.id, title: 'You have an unsent draft', body: 'Send or clear your current draft before editing this message.' });
    focusComposer(server.id, m.chat_id);
    return false;
  }
  st.setDraft(server.id, m.chat_id, m.text);
  const uploads = failed ? ((m.meta?.attachments ?? []) as Upload[]).filter((u) => u.id) : [];
  if (uploads.length) {
    st.updateDraftFiles(server.id, m.chat_id, (files) => [
      ...files.filter((f) => !uploads.some((u) => u.id === f.upload?.id || u.id === f.localId)),
      ...uploads.map((u): DraftFile => ({
        localId: u.id, name: u.name, mime: u.mime, kind: u.kind, size: u.size, progress: 1, status: 'ready', upload: u,
        previewUri: u.kind === 'image' ? mediaUrl(server, u.url) : undefined,
      })),
    ]);
  }
  if (m.meta?.reply_to) st.setReplyTo(server.id, m.chat_id, m.meta.reply_to);
  focusComposer(server.id, m.chat_id);
  return true;
}

/** What a screen reader says for a message: who, when, and what it says. */
function describe(m: Message, who: string, files: number) {
  const body = m.text ? plainText(m.text) : '';
  const extra = files ? `${body ? '. ' : ''}${files === 1 ? 'One attachment' : `${files} attachments`}` : '';
  return `${who}, ${timeOf(m.created_at)}: ${body}${extra}`;
}

function toReplyRef(m: Message): ReplyRef {
  const first = m.meta?.attachments?.[0];
  const text = m.text ? plainText(m.text).slice(0, 240)
    : first ? (first.kind === 'voice' ? 'Voice note' : first.kind === 'image' ? 'Photo' : first.name) : '';
  return { id: m.id, role: m.role, text };
}

const MessageList = memo(function MessageList({ server, chatId, messages, loaded, typing, top, bottom, onOpen, onReply, onQuote, focus, offline }: {
  server: Server; chatId: string; messages: Message[]; loaded: boolean; typing: boolean; top: number; bottom: number;
  onOpen: (m: Message) => void; onReply: (m: Message) => void; onQuote?: (m: Message) => void; focus: string | null; offline: boolean;
}) {
  const t = useTheme();
  const s = useStyles();
  const loadMessages = useApp((st) => st.loadMessages);
  const inbox = useApp((st) => st.runtime[server.id]?.inbox);
  const layout = usePrefs((st) => st.prefs.view === 'simple' ? 'bubbles' : st.prefs.layout);
  const list = useRef<FlatList<Row>>(null);
  const readingContext = useRef({ server, chatId });
  readingContext.current = { server, chatId };
  const focused = useRef(false);
  const userScrolled = useRef(false);
  const visibleMessages = useRef<Message[]>([]);
  const rememberVisible = useRef(() => {
    const state = useApp.getState(), context = readingContext.current;
    if (!focused.current || !state.foreground || useLock.getState().locked) return;
    const current = state.servers.find(item => item.id === context.server.id);
    if (!current || current.fingerprint !== context.server.fingerprint) return;
    const reading = visibleReading(visibleMessages.current);
    if (reading.watermark) state.observeReading(current.id, context.chatId, reading.watermark,
      userScrolled.current ? reading.anchor : undefined);
  });
  useFocusEffect(useCallback(() => {
    focused.current = true;
    const timer = setTimeout(() => rememberVisible.current(), 750);
    return () => { clearTimeout(timer); focused.current = false; userScrolled.current = false; };
  }, []));
  const viewability = useRef({ minimumViewTime: 750, viewAreaCoveragePercentThreshold: 25 }).current;
  const onViewable = useRef(({ viewableItems }: { viewableItems: { item: Row; isViewable: boolean }[] }) => {
    const messages = viewableItems.filter(item => item.isViewable && item.item.kind === 'msg')
      .map(item => (item.item as Extract<Row, { kind: 'msg' }>).m);
    visibleMessages.current = messages;
    rememberVisible.current();
  }).current;
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const element = list.current?.getNativeScrollRef?.() as unknown as HTMLElement | null;
    if (!element?.addEventListener) return;
    const interact = (event: Event) => {
      if (event.type === 'keydown' && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes((event as KeyboardEvent).key)) return;
      userScrolled.current = true;
      rememberVisible.current();
    };
    element.addEventListener('wheel', interact, { passive: true });
    element.addEventListener('pointerdown', interact, { passive: true });
    element.addEventListener('keydown', interact);
    return () => {
      element.removeEventListener('wheel', interact);
      element.removeEventListener('pointerdown', interact);
      element.removeEventListener('keydown', interact);
    };
  }, [loaded, !!messages.length, server.id, chatId]);
  // Scrolled away from the latest: the newest message then, so only later ones count as new.
  const [away, setAway] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  // Messages already here when the chat opened don't animate in; only new arrivals do (not older pages).
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null && loaded) seen.current = new Set(messages.map((m) => m.id));
  const today = dayKey(Date.now() / 1000);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    // Hermes's backend activity (tool calls, status notes) folds into one "…" entry between the replies.
    const entries = groupActivity(messages, typing);
    const latestReply = latestReplyId(entries);
    const idOf = (e: Entry) => (e.kind === 'msg' ? e.m.id : e.id);
    const timeOf = (e: Entry) => (e.kind === 'msg' ? e.m.created_at : e.items[0].created_at);
    const days = entries.map((e) => dayKey(timeOf(e)));
    const labels = new Map<number, string>();
    const dayKeys = new Set<string>();
    let lastSeen = -1;
    if (seen.current) entries.forEach((e, i) => { if (seen.current!.has(idOf(e))) lastSeen = i; });
    const grouped = (a: Entry | undefined, b: Entry | undefined) => a?.kind === 'msg' && b?.kind === 'msg' && sameGroup(a.m, b.m);
    entries.forEach((e, i) => {
      const day = days[i];
      if (day !== days[i - 1]) {
        let label = labels.get(day);
        if (label === undefined) labels.set(day, (label = dayLabel(timeOf(e))));
        // Keyed by the day, so loading older history doesn't remount every separator.
        const key = dayKeys.has(`day-${day}`) ? `day-${day}-${idOf(e)}` : `day-${day}`;
        dayKeys.add(key);
        out.push({ kind: 'day', key, label });
      }
      if (e.kind === 'activity') {
        out.push({ kind: 'activity', key: `activity-${e.id}`, items: e.items, working: typing && i === entries.length - 1 });
        return;
      }
      out.push({
        kind: 'msg', key: e.m.id, m: e.m,
        first: !grouped(entries[i - 1], e) || days[i - 1] !== day,
        last: !grouped(e, entries[i + 1]) || days[i + 1] !== day,
        live: typing && i === entries.length - 1,
        fresh: !!seen.current && i > lastSeen,
        latestReply: e.m.id === latestReply,
      });
    });
    return out.reverse(); // inverted: newest at the bottom without manual scrolling
  }, [messages, typing, today]); // eslint-disable-line react-hooks/exhaustive-deps

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const jump = useCallback((id: string) => {
    // A message folded into a run of activity is found in its "…" row, which opens to show it.
    const index = rowsRef.current.findIndex((r) => (r.kind === 'msg' && r.m.id === id) || (r.kind === 'activity' && r.items.some((m) => m.id === id)));
    if (index < 0) {
      // Not loaded yet (an older message): page history in until it's here, then show it.
      requestFocus(server.id, chatId, id);
      return;
    }
    haptic.selection();
    visibleMessages.current = [];
    list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
    setFlash(id);
    setTimeout(() => setFlash((f) => (f === id ? null : f)), 1600);
  }, [server.id, chatId]);
  const actions = useMemo<Actions>(() => ({ open: onOpen, reply: onReply, quote: onQuote, jump }), [onOpen, onReply, onQuote, jump]);

  // Older history, a page at a time as you scroll up: one request at a time, and none while the start of the
  // chat is what's loaded. That's checked against the oldest message, so after a reconnect replaces what's
  // loaded with a newer page, scrolling back loads again.
  const older = useRef(newPaging());
  const [olderBusy, setOlderBusy] = useState(false);
  useEffect(() => {
    older.current = newPaging();
    setOlderBusy(false);
  }, [server.id, chatId]);
  const loadOlder = useCallback(() => {
    const o = older.current;
    const current = () => useApp.getState().runtime[server.id]?.messages[chatId];
    if (!canLoadOlder(o, current())) return;
    const before = current()?.length ?? 0;
    o.busy = true;
    setOlderBusy(true);
    loadMessages(server.id, chatId, true).catch(() => false).then((ok) => {
      if (older.current !== o) return;
      afterOlderPage(o, ok, (current()?.length ?? 0) - before, current());
      setOlderBusy(false);
    });
  }, [server.id, chatId, loadMessages]);
  const loadedMessages = useApp((st) => st.runtime[server.id]?.messages[chatId]);
  const startShown = atStart(older.current, loadedMessages);

  // Sending from further up brings you back down to your message.
  const newest = messages[messages.length - 1];
  const newestId = useRef(newest?.id);
  useEffect(() => {
    if (newest && newest.id !== newestId.current && newest.role === 'user' && (newest.status === 'pending' || newest.status === 'queued')) {
      list.current?.scrollToOffset({ offset: 0, animated: true });
    }
    newestId.current = newest?.id;
  }, [newest]);

  // A message picked in search or the files sheet: page older history in until it's here, then
  // bring it into view. Gives up when a page adds nothing (it was deleted), a page can't be
  // fetched, or after 20 pages.
  const paging = useRef<{ id: string; pages: number; busy: boolean } | null>(null);
  const jumped = useRef<string | null>(null);
  const [paged, setPaged] = useState(0);
  useEffect(() => {
    if (focus) userScrolled.current = false;
    if (!focus) jumped.current = null; // so the same message can be asked for again
    if (!focus || !loaded) return;
    if (messages.some((m) => m.id === focus)) {
      paging.current = null;
      if (jumped.current === focus) return;
      jumped.current = focus;
      // Once, after the rows have laid out; later renders (a reply streaming in) don't restart it.
      setTimeout(() => { jump(focus); clearFocus(focus); }, 350);
      return;
    }
    if (paging.current?.id !== focus) paging.current = { id: focus, pages: 0, busy: false };
    const p = paging.current;
    if (p.busy) return;
    const giveUp = (body = 'It may have been deleted.') => {
      paging.current = null;
      clearFocus(focus);
      useApp.getState().toast({ serverId: server.id, title: "Couldn't find that message", body });
    };
    if (p.pages >= 20) return giveUp();
    const count = () => useApp.getState().runtime[server.id]?.messages[chatId]?.length ?? 0;
    const before = count();
    p.busy = true;
    p.pages += 1;
    loadMessages(server.id, chatId, true).catch(() => false).then((ok) => {
      p.busy = false;
      if (paging.current !== p) return;
      if (!ok) giveUp("Older messages didn't load. Check your connection and try again.");
      else if (count() <= before) giveUp();
      else setPaged((n) => n + 1);
    });
  }, [focus, loaded, messages, paged, jump, loadMessages, server.id, chatId]);

  if (!loaded && messages.length === 0) {
    return (
      <View style={[s.center, { flex: 1, paddingTop: top, paddingBottom: bottom, paddingHorizontal: 32, gap: 12 }]}>
        {offline ? (
          <>
            <Text style={s.emptyTitle}>Messages aren't here yet</Text>
            <Text style={s.emptyText}>They'll load when {server.bot.title} is reachable again.</Text>
            <Button title="Try again" variant="secondary" size="sm" onPress={() => useApp.getState().retryNow(server.id)} />
          </>
        ) : (
          <>
            <ActivityIndicator color={t.colors.textSecondary} />
            <Text style={s.emptyText}>Loading messages…</Text>
          </>
        )}
      </View>
    );
  }
  if (loaded && messages.length === 0) return <EmptyChat server={server} chatId={chatId} top={top} bottom={bottom} />;

  const awayAt = away === null ? -1 : messages.findIndex((m) => m.id === away);
  const newSince = awayAt < 0 ? 0 : messages.slice(awayAt + 1).filter((m) => m.role !== 'user' && !isActivity(m)).length;
  return (
    <View style={{ flex: 1 }}>
      <FlatList
        ref={list}
        inverted
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: bottom + 10, paddingBottom: top + 10 }}
        data={rows}
        viewabilityConfig={viewability}
        onViewableItemsChanged={onViewable}
        onScrollBeginDrag={() => { userScrolled.current = true; rememberVisible.current(); }}
        onTouchStart={() => { userScrolled.current = true; rememberVisible.current(); }}
        keyExtractor={(r) => r.key}
        renderItem={({ item }) => item.kind === 'day' ? <DayChip label={item.label} /> : item.kind === 'activity' ? (
          <ActivityRow items={item.items} working={item.working} flash={flash !== null && item.items.some((m) => m.id === flash)} />
        ) : (
          <MessageRow server={server} message={item.m} first={item.first} last={item.last} live={item.live} fresh={item.fresh}
            layout={layout} flash={flash === item.m.id} actions={actions} latestReply={item.latestReply}
            inboxItem={item.m.meta?.inbox_id ? inbox?.[item.m.meta.inbox_id] : undefined} />
        )}
        onScroll={(e) => {
          if (userScrolled.current) rememberVisible.current();
          const far = e.nativeEvent.contentOffset.y > AWAY_PX;
          if (far && away === null) setAway(messages[messages.length - 1]?.id ?? '');
          else if (!far && away !== null) setAway(null);
        }}
        scrollEventThrottle={100}
        onScrollToIndexFailed={(info) => {
          list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: true });
          setTimeout(() => list.current?.scrollToIndex({ index: info.index, viewPosition: 0.5, animated: true }), 300);
        }}
        onEndReached={loadOlder}
        onEndReachedThreshold={0.4}
        ListHeaderComponent={typing && rows[0]?.kind !== 'activity' ? <TypingRow server={server} /> : null}
        ListFooterComponent={olderBusy ? (
          <View style={s.olderRow}><ActivityIndicator color={t.colors.textSecondary} accessibilityLabel="Loading older messages" /></View>
        ) : startShown ? <View style={s.olderRow}><Text style={s.olderText}>Start of the conversation</Text></View> : null}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={18}
        maxToRenderPerBatch={12}
        windowSize={11}
        removeClippedSubviews={Platform.OS === 'android'}
      />
      {away !== null ? (
        <Animated.View entering={ZoomIn.duration(220).easing(easeOut)} exiting={FadeOut.duration(140)} style={[s.jump, { bottom: bottom + 12 }]}>
          <Tap feedback="light" accessibilityLabel={newSince > 0 ? `Jump to latest, ${newSince} new` : 'Jump to latest'}
            onPress={() => list.current?.scrollToOffset({ offset: 0, animated: true })} style={s.jumpBtn} scaleTo={0.9}>
            <ArrowDown size={20} color={t.colors.text} />
          </Tap>
          {newSince > 0 ? <Badge count={newSince} style={s.jumpBadge} /> : null}
        </Animated.View>
      ) : null}
    </View>
  );
});

/** Displayed replies only: folded activity and gateway notices cannot steal response actions. */
function latestReplyId(entries: readonly Entry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.kind === 'msg' && entry.m.role === 'bot' && !entry.m.meta?.picker && !statusNoticeText(entry.m)) return entry.m.id;
  }
  return undefined;
}

/** A local calendar day as a number (20261013), cheap to compare across a whole chat. */
function dayKey(ts: number) {
  const d = new Date(ts * 1000);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

function sameGroup(a: Message | undefined, b: Message | undefined) {
  if (!a || !b || a.role !== b.role || a.role === 'system' || b.role === 'system' || statusNoticeText(a) || statusNoticeText(b)) return false;
  return Math.abs(b.created_at - a.created_at) < GROUP_WINDOW_S;
}

function dayLabel(ts: number) {
  const d = new Date(ts * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

function timeOf(ts: number) {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function DayChip({ label }: { label: string }) {
  const s = useStyles();
  return (
    <View style={s.dayWrap} accessibilityRole="header">
      <Text style={s.day}>{label}</Text>
    </View>
  );
}

const MessageRow = memo(function MessageRow({ server, message, first, last, live, fresh, layout, flash, actions, inboxItem, latestReply }: {
  server: Server; message: Message; first: boolean; last: boolean; live?: boolean; fresh: boolean; layout: 'bubbles' | 'compact'; latestReply?: boolean;
  flash: boolean; actions: Actions; inboxItem?: InboxItem;
}) {
  const t = useTheme();
  const s = useStyles();
  const simple = usePrefs((st) => st.prefs.view === 'simple');
  const resolve = useCallback((url: string) => mediaUrl(server, url), [server]);
  const entering = fresh ? FadeInDown.duration(260).easing(easeOut) : undefined;
  const [hover, setHover] = useState(false);
  const botColor = useAvatarColor(server);
  const history = useApp(st => st.runtime[server.id]?.info?.features?.routine_history === true && isOwner(st.runtime[server.id]));
  const notice = statusNoticeText(message);
  if (notice) return <Animated.View entering={entering} style={s.lane}>
    <Flash on={flash} />
    <Pressable onLongPress={() => { haptic.light(); actions.open(message); }} delayLongPress={320}
      accessibilityLabel={describe(message, server.bot.title, 0)} accessibilityActions={[{ name: 'longpress', label: 'Message options' }]}
      onAccessibilityAction={() => actions.open(message)} style={[s.statusNotice, layout === 'compact' && s.statusNoticeCompact]}>
      <Text selectable={!TOUCH} style={s.statusNoticeText}>{notice}</Text>
    </Pressable>
  </Animated.View>;

  if (message.role === 'system') {
    if (message.meta?.inbox_id && inboxItem) {
      return <Animated.View entering={entering} style={[s.lane, s.systemCard]}>
        {layout === 'compact' ? <View style={s.compact}><View style={s.gutter} /><View style={{ flex: 1, minWidth: 0 }}><InboxCard serverId={server.id} item={inboxItem} compact embedded /></View></View>
          : <View style={s.botRow}><View style={s.botBody}><InboxCard serverId={server.id} item={inboxItem} embedded /></View></View>}
      </Animated.View>;
    }
    return <View style={s.systemLine}><Text style={s.systemText}>{message.text}</Text></View>;
  }

  const isBot = message.role === 'bot';
  const mine = !isBot && layout === 'bubbles';
  const attachments = message.meta?.attachments ?? [];
  const replyTo = message.meta?.reply_to;
  const sendable = message.status === 'final';
  const quote = (onAccent: boolean) => replyTo ? <ReplyQuote server={server} reply={replyTo} onAccent={onAccent} onPress={() => {
    if (replyTo.quote && replyTo.quote.chat_id !== message.chat_id) {
      router.push(`/chat/${server.id}/${replyTo.quote.chat_id}`); requestFocus(server.id, replyTo.quote.chat_id, replyTo.id);
    } else actions.jump(replyTo.id);
  }} /> : null;
  const routine = typeof message.meta?.routine === 'string' ? message.meta.routine : '';
  const routineId = typeof message.meta?.routine_id === 'string' ? message.meta.routine_id : '';
  const runId = typeof message.meta?.run_id === 'string' ? message.meta.run_id : undefined;
  const text = (onAccent: boolean) => message.meta?.picker ? <PickerCard server={server} message={message} /> : (
    <>
      {routine ? (
        <Tap style={s.routine} disabled={!history || !routineId} accessibilityLabel={`From the routine ${routine}${history && routineId ? ", open history" : ""}`}
          onPress={() => router.push(routineHref(server.id, routineId, runId) as any)}>
          <CalendarClock size={13} color={t.colors.textSecondary} />
          <Text style={s.routineText} numberOfLines={1}>{routine}</Text>
        </Tap>
      ) : null}
      {message.text ? <Markdown text={message.text} resolveUrl={resolve} tone={onAccent ? 'onAccent' : 'default'} selectable={!TOUCH} compact={layout === 'compact'} /> : null}
      {message.status === 'streaming' && live ? <Cursor onAccent={onAccent} /> : null}
    </>
  );
  const files = attachments.length ? <MessageAttachments items={attachments} resolve={resolve} mine={mine} /> : null;
  const footer = (
    <>
      {message.status === 'queued' ? (
        <View style={[s.state, mine && s.stateRight]}>
          <Clock size={12} color={t.colors.textSecondary} />
          <Text style={s.stateText}>Queued · sends when {server.bot.title} is reachable</Text>
        </View>
      ) : null}
      {message.status === 'failed' ? <FailedActions server={server} message={message} right={mine} /> : null}
    </>
  );
  const responseActions = isBot && latestReply && sendable && !message.meta?.picker ? <HoverBar message={message} actions={actions} serverId={server.id} inline /> : null;
  const toolbar = !responseActions && !TOUCH && hover && sendable ? <HoverBar message={message} actions={actions} serverId={server.id} /> : null;

  let content;
  if (layout === 'compact') {
    content = (
      <View style={[s.compact, first ? { marginTop: 8 } : { marginTop: 2 }]}>
        <View style={s.gutter}>{first ? (isBot ? <AgentFace server={server} size={28} still /> : <UserAvatar size={28} />) : null}</View>
        <View style={{ flex: 1, minWidth: 0 }}>
          {first ? (
            <View style={s.compactHead}>
              <Text style={[s.author, { color: isBot ? botColor : t.colors.text }]}>{isBot ? server.bot.title : 'You'}</Text>
              <Text style={s.time}>{timeOf(message.created_at)}</Text>
            </View>
          ) : null}
          <View style={{ opacity: message.status === 'pending' ? 0.6 : 1 }}>{quote(false)}{text(false)}{files}</View>
          {responseActions}
          {footer}
        </View>
      </View>
    );
  } else if (isBot) {
    content = (
      <View style={[s.botRow, first ? { marginTop: 12 } : { marginTop: 4 }]}>
        {first && !simple ? (
          <View style={s.botHead}>
            <AgentFace server={server} size={26} still />
            <Text style={s.botName}>{server.bot.title}</Text>
            <Text style={s.time}>{timeOf(message.created_at)}</Text>
          </View>
        ) : null}
        <View style={[s.botBody, simple && s.simpleReply]}>{quote(false)}{text(false)}{files}{!simple ? responseActions : null}</View>
        {simple ? responseActions : null}
        {footer}
      </View>
    );
  } else {
    content = (
      <View style={[s.userRow, first ? { marginTop: 14 } : { marginTop: 3 }, { opacity: message.status === 'pending' ? 0.75 : 1 }]}>
        {!message.text ? quote(false) : null}
        {files}
        {message.text ? (
          <View style={[s.bubble, last && s.bubbleTail, files ? { marginTop: 4 } : null,
            simple && { backgroundColor: t.scheme === 'light' ? t.colors.ink : t.colors.surfaceHigh }]}>
            {quote(simple && t.scheme === 'light')}
            {text(simple && t.scheme === 'light')}
          </View>
        ) : null}
        {last && sendable && !simple ? <Text style={[s.time, { marginTop: 4, marginRight: 6 }]}>{timeOf(message.created_at)}</Text> : null}
        {footer}
      </View>
    );
  }

  return (
    <Animated.View entering={entering} style={s.lane}>
      <Flash on={flash} />
      <SwipeToReply enabled={TOUCH && Platform.OS !== 'web' && sendable && !/```|\|\s*-{3}/.test(message.text)} onReply={() => actions.reply(message)}>
        <Pressable
          onLongPress={TOUCH && sendable ? () => { haptic.light(); actions.open(message); } : undefined}
          delayLongPress={320}
          onHoverIn={() => setHover(true)}
          onHoverOut={() => setHover(false)}
          accessibilityLabel={describe(message, isBot ? server.bot.title : 'You', attachments.length)}
          accessibilityActions={sendable ? [{ name: 'longpress', label: 'Message options' }, { name: 'reply', label: 'Reply' }] : undefined}
          onAccessibilityAction={(e) => (e.nativeEvent.actionName === 'reply' ? actions.reply(message) : actions.open(message))}
          style={Platform.OS === 'web' ? ({ cursor: 'auto' } as object) : undefined}
        >
          {content}
          {toolbar}
        </Pressable>
      </SwipeToReply>
    </Animated.View>
  );
});

/** A short highlight when you jump to a message from a reply. */
function Flash({ on }: { on: boolean }) {
  const t = useTheme();
  const o = useSharedValue(0);
  useEffect(() => {
    if (on) o.value = withSequence(withTiming(1, { duration: 160 }), withDelay(500, withTiming(0, { duration: 700 })));
  }, [on, o]);
  const style = useAnimatedStyle(() => ({ opacity: o.value }));
  return <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: t.colors.accentSoft }, style]} />;
}

/** Drag a message to the right to reply to it, like every phone messenger. */
function SwipeToReply({ enabled, onReply, children }: { enabled: boolean; onReply: () => void; children: React.ReactNode }) {
  const t = useTheme();
  const s = useStyles();
  const x = useSharedValue(0);
  const armed = useSharedValue(false);
  const pan = Gesture.Pan()
    .enabled(enabled)
    .activeOffsetX(16)
    .failOffsetY([-12, 12])
    .onUpdate((e) => {
      x.value = Math.max(0, Math.min(96, e.translationX * 0.55));
      if (x.value > 58 && !armed.value) {
        armed.value = true;
        runOnJS(haptic.selection)();
      } else if (x.value <= 58 && armed.value) {
        armed.value = false;
      }
    })
    .onEnd(() => {
      if (armed.value) runOnJS(onReply)();
      armed.value = false;
      x.value = withSpring(0, spring.snappy);
    });
  const row = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const icon = useAnimatedStyle(() => ({ opacity: Math.min(1, x.value / 58), transform: [{ scale: 0.6 + Math.min(0.4, x.value / 145) }] }));
  if (!enabled) return <>{children}</>;
  return (
    <GestureDetector gesture={pan}>
      <Animated.View>
        <Animated.View style={[s.swipeIcon, icon]} pointerEvents="none"><Reply size={18} color={t.colors.accent} /></Animated.View>
        <Animated.View style={row}>{children}</Animated.View>
      </Animated.View>
    </GestureDetector>
  );
}

/** The message a reply answers, shown above it. Tap to scroll to the original. */
function ReplyQuote({ server, reply, onAccent, onPress }: { server: Server; reply: ReplyRef; onAccent: boolean; onPress: () => void }) {
  const t = useTheme();
  const s = useStyles();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Reply to: ${reply.text}. Show the original`} onPress={onPress}
      style={({ pressed }) => [s.quote, onAccent ? s.quoteOnAccent : null, pressed && { opacity: 0.7 }]}>
      <View style={[s.quoteBar, onAccent && { backgroundColor: t.colors.onAccent }]} />
      <View style={{ flexShrink: 1 }}>
        <Text style={[s.quoteWho, onAccent && { color: t.colors.onAccent }]}>{reply.quote ? 'Quoted from ' : ''}{reply.role === 'bot' ? server.bot.title : 'You'}</Text>
        <Text style={[s.quoteText, onAccent && { color: t.colors.onAccent }]} numberOfLines={2}>{plainText(reply.text) || 'Attachment'}</Text>
      </View>
    </Pressable>
  );
}

/** Visible below the latest completed reply; available on hover for older messages on desktop. */
function HoverBar({ message, actions, serverId, inline = false }: { message: Message; actions: Actions; serverId: string; inline?: boolean }) {
  const t = useTheme();
  const s = useStyles();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <View style={inline ? s.responseActions : s.hoverBar}>
      {message.text ? (
        <IconButton label={copied ? 'Copied response' : 'Copy response'} size={48} onPress={async () => {
          try { await Clipboard.setStringAsync(message.text); setCopied(true); haptic.selection(); }
          catch { useApp.getState().toast({ serverId, title: 'Couldn’t copy', body: 'Try again or use Select text from the message options.' }); }
        }}>
          {copied ? <Check size={16} color={t.colors.success} /> : <Copy size={16} color={t.colors.textTertiary} />}
        </IconButton>
      ) : null}
      <IconButton label="Reply to response" size={48} onPress={() => actions.reply(message)}><Reply size={16} color={t.colors.textTertiary} /></IconButton>
      {actions.quote && canQuote(message) ? <IconButton label="Ask about a quote" size={48} onPress={() => actions.quote?.(message)}><FileText size={16} color={t.colors.textTertiary} /></IconButton> : null}
      <IconButton label="More response options" size={48} onPress={() => actions.open(message)}><MoreHorizontal size={16} color={t.colors.textTertiary} /></IconButton>
    </View>
  );
}

/** Long-press menu for one message. */
function MessageMenu({ server, message, busy, onClose, onReply, onQuote, onSelectText, messages,
  branchingState, branchingSupported, branchingOnline, onBranch }: {
  server: Server; message: Message | null; busy: boolean; onClose: () => void; onReply: (m: Message) => void;
  onQuote?: (m: Message) => void; onSelectText: (text: string) => void; messages: readonly Message[]; branchingState: BranchState | null;
  branchingSupported: boolean; branchingOnline: boolean; onBranch: (m: Message, mode: BranchMode) => void;
}) {
  const t = useTheme();
  const s = useStyles();
  const [last, setLast] = useState(message);
  if (message && message !== last) setLast(message);
  const m = message ?? last;
  // Only while the menu is open, and without copying the chat: this runs on every store change.
  const latestBot = useApp((st) => {
    const list = message ? st.runtime[server.id]?.messages[message.chat_id] : undefined;
    for (let i = (list?.length ?? 0) - 1; i >= 0; i--) if (list![i].role === 'bot') return list![i].id;
    return undefined;
  });
  if (!m) return null;
  const run = (fn: () => void) => () => { onClose(); fn(); };
  const gate = !branchingSupported ? 'This server can’t branch conversations.'
    : !branchingOnline ? 'Reconnect to edit or branch this chat.'
      : !branchingState ? 'Loading branch options…'
        : busy ? 'Wait for the current reply to finish.'
          : branchingState.reason || branchingState.messages?.[m.id]?.reason || 'This message isn’t in the model transcript yet.';
  const editable = canEdit(branchingState, m.id);
  const branchable = canBranch(branchingState, m.id);
  const regenerable = canRegenerate(branchingState, m.id);
  return (
    <Sheet visible={!!message} onClose={onClose} title="Message options" scrollable>
      {m.text ? <Text style={s.menuPreview} numberOfLines={2}>{plainText(m.text)}</Text> : null}
      <SheetAction icon={<Reply size={20} color={t.colors.text} />} label="Reply" onPress={run(() => onReply(m))} />
      {onQuote && canQuote(m) ? <SheetAction icon={<FileText size={20} color={t.colors.text} />} label="Ask about a quote" onPress={run(() => onQuote(m))} /> : null}
      {m.text ? <SheetAction icon={<Copy size={20} color={t.colors.text} />} label="Copy text" onPress={run(async () => {
        try {
          await Clipboard.setStringAsync(m.text);
          useApp.getState().toast({ serverId: server.id, title: 'Copied', body: '' });
        } catch { useApp.getState().toast({ serverId: server.id, title: 'Couldn’t copy', body: 'Try again or use Select text.' }); }
      })} /> : null}
      {m.text && TOUCH ? <SheetAction icon={<FileText size={20} color={t.colors.text} />} label="Select text" onPress={run(() => onSelectText(m.text))} /> : null}
      {m.text ? <SheetAction icon={<Share size={20} color={t.colors.text} />} label="Share" onPress={run(() => {
        if (Platform.OS === 'web') (globalThis.navigator as Navigator).share?.({ text: m.text }).catch(() => undefined);
        else SystemShare.share({ message: m.text }).catch(() => undefined);
      })} /> : null}
      {branchingSupported ? (
        <>
          {m.role === 'user' && m.text ? <SheetAction icon={<Pencil size={20} color={t.colors.text} />}
            label="Edit in a new branch" disabled={!editable} hint={editable ? actionHint('edit', laterCount(messages, m.id, 'edit')) : gate}
            onPress={run(() => onBranch(m, 'edit'))} /> : null}
          {m.role === 'bot' ? <SheetAction icon={<RotateCcw size={20} color={t.colors.text} />}
            label="Regenerate reply" disabled={!regenerable} hint={regenerable ? actionHint('regenerate', laterCount(messages, m.id, 'regenerate')) : gate}
            onPress={run(() => onBranch(m, 'regenerate'))} /> : null}
          <SheetAction icon={<GitBranch size={20} color={t.colors.text} />}
            label={m.role === 'user' ? 'Branch from here' : 'Branch from this reply'} disabled={!branchable}
            hint={branchable ? actionHint('branch', laterCount(messages, m.id, 'branch')) : gate}
            onPress={run(() => onBranch(m, 'branch'))} />
        </>
      ) : (
        <>
          {m.role === 'user' && m.text ? <SheetAction icon={<Pencil size={20} color={t.colors.text} />} label="Edit and send again" onPress={run(() => {
            editAgain(server, m, false);
          })} /> : null}
          {m.role === 'bot' && m.id === latestBot && !busy ? <SheetAction icon={<RotateCcw size={20} color={t.colors.text} />} label="Try again" onPress={run(() => {
            haptic.light();
            useApp.getState().sendMessage(server.id, m.chat_id, '/retry');
          })} /> : null}
        </>
      )}
    </Sheet>
  );
}

/** A message the server refused: try again, take it back into the composer, or drop it. */
function FailedActions({ server, message, right }: { server: Server; message: Message; right?: boolean }) {
  const t = useTheme();
  const s = useStyles();
  const sendMessage = useApp((st) => st.sendMessage);
  const discard = useApp((st) => st.discardMessage);
  const clientId = message.meta?.client_id ?? message.id;
  return (
    <View style={[s.deliveryFailure, right && { alignItems: 'flex-end' }]} accessibilityLiveRegion="polite">
      <View style={[s.state, right && s.stateRight]}>
      <RotateCcw size={13} color={t.colors.danger} />
      <Text style={[s.stateText, { color: t.colors.danger }]}>Not delivered</Text>
      <Tap accessibilityLabel="Retry this message" style={s.stateAction} onPress={() => sendMessage(server.id, message.chat_id, message.text, clientId)}><Text style={s.stateActionText}>Retry</Text></Tap>
      <Tap accessibilityLabel="Edit this failed message" style={s.stateAction} onPress={() => { if (editAgain(server, message, true)) discard(server.id, message.chat_id, clientId); }}><Text style={s.stateActionText}>Edit</Text></Tap>
      <Tap accessibilityLabel="Delete this failed message" style={s.stateAction} onPress={() => discard(server.id, message.chat_id, clientId)}><Text style={s.stateActionText}>Delete</Text></Tap>
      </View>
      {message.meta?.delivery_error ? <Text style={[s.stateText, { maxWidth: 440 }]}>{message.meta.delivery_error}</Text> : null}
    </View>
  );
}

function Cursor({ onAccent }: { onAccent: boolean }) {
  const t = useTheme();
  const reduced = useReducedMotion();
  const o = useSharedValue(1);
  useEffect(() => {
    if (reduced) return;
    o.value = withRepeat(withSequence(withTiming(0.2, { duration: 450 }), withTiming(1, { duration: 450 })), -1);
    return () => cancelAnimation(o);
  }, [reduced, o]);
  const style = useAnimatedStyle(() => ({ opacity: o.value }));
  return <Animated.View style={[{ width: 9, height: 17, borderRadius: 3, marginTop: 4, backgroundColor: onAccent ? t.colors.onAccent : t.colors.accent }, style]} />;
}

/**
 * Everything Hermes does that isn't a reply (reading a skill, searching, running a tool) folded into one "…".
 * Tap it to see the steps; by default only the replies show.
 */
const ActivityRow = memo(function ActivityRow({ items, working, flash }: { items: Message[]; working: boolean; flash: boolean }) {
  const t = useTheme();
  const s = useStyles();
  const [open, setOpen] = useState(false);
  // Jumped to a step in here (from search or a reply): show it.
  useEffect(() => { if (flash) setOpen(true); }, [flash]);
  const n = items.length;
  return (
    <View style={[s.lane, s.activity]}>
      <Tap feedback="selection" scaleTo={0.96} onPress={() => setOpen((o) => !o)} style={s.activityPill} accessibilityState={{ expanded: open }}
        accessibilityLabel={`${working ? 'Working. ' : ''}${n} background ${n === 1 ? 'step' : 'steps'}. ${open ? 'Hide' : 'Show'}`}>
        {working ? <Dots /> : (
          <View style={s.activityDots}>{[0, 1, 2].map((i) => <View key={i} style={[s.activityDot, { backgroundColor: t.colors.textSecondary }]} />)}</View>
        )}
        <Text style={s.activityText}>{working ? 'Working' : `${n} ${n === 1 ? 'step' : 'steps'}`}</Text>
        <ChevronDown size={14} color={t.colors.textSecondary} style={open ? { transform: [{ rotate: '180deg' }] } : undefined} />
      </Tap>
      {open ? (
        <Animated.View entering={FadeIn.duration(160)} style={s.activityList}>
          {items.map((m) => <Text key={m.id} selectable style={s.activityLine}>{m.text}</Text>)}
        </Animated.View>
      ) : null}
    </View>
  );
});

function TypingRow({ server }: { server: Server }) {
  const s = useStyles();
  return (
    <Animated.View entering={FadeIn.duration(200)} style={[s.lane, s.typing]} accessibilityLiveRegion="polite" accessibilityLabel={`${server.bot.title} is working`}>
      <AgentFace server={server} size={30} mood="working" animated />
      <View style={s.typingBubble}><Dots /></View>
    </Animated.View>
  );
}

function Dots() {
  const t = useTheme();
  const reduced = useReducedMotion();
  return (
    <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center', height: 14 }}>
      {[0, 1, 2].map((i) => <Dot key={i} delay={i * 150} reduced={reduced} color={t.colors.textSecondary} />)}
    </View>
  );
}

function Dot({ delay, reduced, color }: { delay: number; reduced: boolean; color: string }) {
  const y = useSharedValue(0);
  useEffect(() => {
    if (reduced) return;
    y.value = withDelay(delay, withRepeat(withSequence(withTiming(-4, { duration: 280 }), withTiming(0, { duration: 280 }), withTiming(0, { duration: 300 })), -1));
    return () => cancelAnimation(y);
  }, [reduced, delay, y]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  return <Animated.View style={[{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }, style]} />;
}

function EmptyChat({ server, chatId, top, bottom }: { server: Server; chatId: string; top: number; bottom: number }) {
  const s = useStyles();
  const chat = useApp((st) => st.runtime[server.id]?.chats[chatId]);
  const home = chat?.kind === 'home';
  if (!home) return <View style={{ flex: 1 }} />;
  return (
    <View style={[s.center, { flex: 1, paddingTop: top, paddingBottom: bottom, paddingHorizontal: 28, gap: 12 }]}>
      <Text style={s.emptyText}>Routine results will appear here.</Text>
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  root: { flex: 1, backgroundColor: t.colors.bg },
  /** Messages keep a readable width on tablets and desktops, lined up with the composer. */
  lane: { width: '100%', maxWidth: 880, alignSelf: 'center' },
  center: { alignItems: 'center', justifyContent: 'center', gap: 12 },
  headerWrap: { position: 'absolute', top: 0, left: 0, right: 0 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 6, paddingBottom: 8, minHeight: 52 },
  headerFill: { flex: 1, minWidth: 0, marginLeft: 4 },
  titleButton: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', maxWidth: '100%', minHeight: 40,
    paddingHorizontal: 8, marginLeft: -8, borderRadius: t.radius.md },
  hairline: { height: StyleSheet.hairlineWidth * 2, backgroundColor: t.colors.border },
  landingStage: { position: 'absolute', left: 0, right: 0, justifyContent: 'center' },
  headerIdentity: { flexDirection: 'row', alignItems: 'center', gap: t.space.xs, marginTop: 2 },
  headerTitle: { ...t.type.heading, color: t.colors.text, flexShrink: 1 },
  projectChip: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1, minWidth: 0, marginLeft: t.space.xs,
    paddingHorizontal: 6, minHeight: 18, borderRadius: t.radius.xs, backgroundColor: t.colors.surfaceSunken, maxWidth: '100%' },
  projectChipText: { ...t.type.caption, color: t.colors.textSecondary, flexShrink: 1, fontSize: 11.5 },
  headerSub: { ...t.type.caption, color: t.colors.textSecondary, flexShrink: 1 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  dayWrap: { alignItems: 'center', marginTop: t.space.lg, marginBottom: t.space.xs },
  day: {
    ...t.type.caption, color: t.colors.textTertiary, paddingHorizontal: t.space.md, paddingVertical: t.space.xs, borderRadius: t.radius.pill,
    backgroundColor: t.colors.surface, borderWidth: StyleSheet.hairlineWidth * 2, borderColor: t.colors.border, overflow: 'hidden',
  },
  botRow: { paddingHorizontal: 16 },
  botHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  botName: { ...t.type.caption, fontSize: 13.5, fontFamily: t.fonts.semibold, color: t.colors.text },
  botBody: { paddingLeft: 34, paddingRight: 8 },
  simpleReply: { paddingHorizontal: 14, paddingVertical: 10, backgroundColor: t.colors.surfaceSunken, borderRadius: 16, alignSelf: 'flex-start', maxWidth: '100%' },
  userRow: { paddingHorizontal: 14, alignItems: 'flex-end' },
  bubble: { maxWidth: '84%', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, backgroundColor: t.colors.bubble },
  bubbleTail: { borderBottomRightRadius: 6 },
  time: { ...t.type.caption, fontSize: 11.5, color: t.colors.textTertiary },
  compact: { flexDirection: 'row', paddingHorizontal: 14, paddingRight: 18 },
  gutter: { width: 38 },
  compactHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 3 },
  author: { fontFamily: t.fonts.semibold, fontSize: 14 },
  routine: {
    flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: t.radius.xs, backgroundColor: t.colors.surfaceSunken, marginBottom: 6,
  },
  routineText: { ...t.type.caption, color: t.colors.textSecondary },
  systemCard: { marginTop: 8 },
  responseActions: { flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: 2, alignSelf: 'flex-start' },
  statusNotice: { paddingLeft: 50, paddingRight: t.space.xl, paddingVertical: t.space.sm },
  statusNoticeCompact: { paddingLeft: 52 },
  statusNoticeText: { ...t.type.footnote, color: t.colors.textTertiary },
  systemLine: { alignItems: 'center', marginVertical: 10, paddingHorizontal: 24 },
  systemText: { ...t.type.caption, color: t.colors.textSecondary, textAlign: 'center' },
  quote: {
    flexDirection: 'row', gap: 8, paddingVertical: 6, paddingRight: 10, paddingLeft: 8, marginBottom: 6, borderRadius: 10,
    backgroundColor: t.colors.surfaceSunken, alignSelf: 'stretch', maxWidth: 420,
  },
  quoteOnAccent: { backgroundColor: FIXED.onAccentWash },
  quoteBar: { width: 3, borderRadius: 2, backgroundColor: t.colors.accent },
  quoteWho: { ...t.type.caption, fontFamily: t.fonts.semibold, color: t.colors.accent },
  quoteText: { ...t.type.caption, color: t.colors.textSecondary },
  state: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 5, marginTop: 5 },
  stateRight: { justifyContent: 'flex-end' },
  stateText: { ...t.type.caption, color: t.colors.textSecondary },
  deliveryFailure: { gap: 2, paddingHorizontal: 4 },
  stateAction: { minHeight: 44, paddingHorizontal: 8, justifyContent: 'center' },
  stateActionText: { ...t.type.caption, fontFamily: t.fonts.semibold, color: t.colors.accent },
  activity: { paddingHorizontal: 16, marginTop: 8, alignItems: 'flex-start' },
  activityPill: {
    flexDirection: 'row', alignItems: 'center', gap: t.space.sm, paddingHorizontal: 14, minHeight: 38, borderRadius: t.radius.pill,
    backgroundColor: t.colors.surface, borderWidth: StyleSheet.hairlineWidth * 2, borderColor: t.colors.border, marginLeft: 34,
  },
  activityDots: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  activityDot: { width: 4, height: 4, borderRadius: 2 },
  activityText: { ...t.type.caption, color: t.colors.textTertiary },
  activityList: { marginLeft: 34, marginTop: 6, paddingLeft: 10, gap: 3, borderLeftWidth: 2, borderLeftColor: t.colors.border, alignSelf: 'stretch', paddingRight: 8 },
  activityLine: { ...t.type.caption, fontFamily: t.fonts.mono, fontSize: 12, color: t.colors.textSecondary },
  typing: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 14 },
  typingBubble: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: t.radius.pill, backgroundColor: t.colors.surface, borderWidth: StyleSheet.hairlineWidth * 2, borderColor: t.colors.border },
  emptyTitle: { ...t.type.title, color: t.colors.text, textAlign: 'center', marginTop: 8 },
  emptyText: { ...t.type.callout, color: t.colors.textSecondary, textAlign: 'center', maxWidth: 400 },
  suggestions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginTop: 8, maxWidth: 440 },
  swipeIcon: {
    position: 'absolute', left: 14, top: 0, bottom: 0, width: 32, alignItems: 'center', justifyContent: 'center',
  },
  hoverBar: {
    position: 'absolute', top: -14, right: 14, flexDirection: 'row', gap: 2, padding: 2, borderRadius: t.radius.pill,
    backgroundColor: t.colors.surfaceRaised, borderWidth: 1, borderColor: t.colors.border,
    shadowColor: t.colors.shadow, shadowOpacity: 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 2 },
  },
  jump: { position: 'absolute', right: 16 },
  jumpBtn: {
    width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.surfaceRaised,
    borderWidth: 1, borderColor: t.colors.borderStrong, shadowColor: t.colors.shadow, shadowOpacity: 0.18, shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 }, elevation: 4,
  },
  jumpBadge: { position: 'absolute', top: -4, right: -4 },
  olderRow: { alignItems: 'center', paddingVertical: 14 },
  olderText: { ...t.type.caption, color: t.colors.textTertiary },
  menuPreview: { ...t.type.callout, color: t.colors.textSecondary, paddingHorizontal: 12, marginBottom: 6 },
  selectText: { ...t.type.body, color: t.colors.text },
}));
