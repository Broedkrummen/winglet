import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Platform, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';
import { useContentWidth } from '../../../components/AppNavigation';
import { AgentFace } from '../../../components/AgentFace';
import { ChatMenu } from '../../../components/ChatMenu';
import { ChatView } from '../../../components/ChatView';
import { ConnectionBanner } from '../../../components/ConnectionBanner';
import { ArrowLeft, CircleAlert, Hash, MessageSquarePlus, MoreHorizontal, Pin, Search } from '../../../components/icons';
import { Button, IconButton, SearchField, SectionHeader, Skeleton, Tap } from '../../../components/ui';
import { ago } from '../../../lib/agent';
import { api } from '../../../lib/api';
import { chatKey } from '../../../lib/chatOrganization';
import { requestFocus } from '../../../lib/focus';
import { usePrefs } from '../../../lib/prefs';
import { useActivityClock } from '../../../lib/useActivityClock';
import { chatActivity, chatActivityLabel, draftPreview } from '../../../lib/chatActivity';
import { homeChat, useApp } from '../../../lib/store';
import { WIDE_BREAKPOINT } from '../../../lib/theme';
import { easeOut, spring, useReducedMotion } from '../../../lib/motion';
import { makeStyles, useTheme } from '../../../lib/themeContext';
import type { Chat, SearchResult, Server } from '../../../lib/types';
import { matchesProjectSearch, projectChats, projectCountLabel, projectTitle } from '../../../features/projects/logic';
import { ProjectMenuSheet } from '../../../features/projects/ProjectSheets';

/** One project: its chats, a scoped search, and a new chat that starts inside it. */
export default function ProjectScreen() {
  const { serverId, projectId } = useLocalSearchParams<{ serverId?: string; projectId?: string }>();
  const selected = useApp((st) => st.selection.serverId);
  const servers = useApp((st) => st.servers);
  const width = useContentWidth();
  const server = servers.find((s) => s.id === serverId) ?? servers.find((s) => s.id === selected) ?? servers[0];
  if (!servers.length) return <Redirect href="/pair" />;
  if (!server || !projectId) return <Redirect href="/projects" />;
  return <ProjectView key={`${server.id}:${projectId}`} server={server} projectId={projectId} wide={width >= WIDE_BREAKPOINT} />;
}

function ProjectView({ server, projectId, wide }: { server: Server; projectId: string; wide: boolean }) {
  const t = useTheme();
  const s = useStyles();
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();
  const snapshot = useApp((st) => st.runtime[server.id]?.projects);
  const chats = useApp((st) => st.runtime[server.id]?.chats);
  const runtime = useApp((st) => st.runtime[server.id] ?? undefined);
  const drafts = useApp((st) => st.drafts);
  const draftFiles = useApp((st) => st.draftFiles);
  const replyTo = useApp((st) => st.replyTo);
  const selection = useApp((st) => st.selection);
  const pinnedChats = usePrefs((st) => st.prefs.pinnedChats);
  const archivedChats = usePrefs((st) => st.prefs.archivedChats);
  const now = useActivityClock({ [server.id]: runtime?.typing ?? {} });
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState(false);
  const [chatMenu, setChatMenu] = useState<Chat | null>(null);
  const [creating, setCreating] = useState(false);
  const [activeId, setActiveId] = useState<string | undefined>();
  const [showArchived, setShowArchived] = useState(false);
  const project = snapshot?.projects.find((p) => p.id === projectId);
  const allChats = useMemo(() => projectChats(snapshot, projectId, chats), [snapshot, projectId, chats]);
  const archivedSet = useMemo(() => new Set(archivedChats), [archivedChats]);
  const hiddenArchived = allChats.filter((c) => archivedSet.has(chatKey(server.id, c.id))).length;
  const list = showArchived ? allChats : allChats.filter((c) => !archivedSet.has(chatKey(server.id, c.id)));
  const feature = !!runtime?.info?.features?.projects;
  const online = feature && runtime?.status === 'online';
  const q = query.trim();
  const draftOf = (chat: Chat) => draftPreview(drafts[`${server.id}:${chat.id}`], draftFiles[`${server.id}:${chat.id}`], !!replyTo[`${server.id}:${chat.id}`]);
  const visible = list.filter((chat) => matchesProjectSearch(chat, q, draftOf(chat)));
  const found = useProjectSearch(server, projectId, online ? q : '');
  const scoped = new Set(list.map((c) => c.id));
  const results = found.results.filter((r) => scoped.has(r.chat.id));

  // On a wide screen, keep a chat beside the project list; on a phone the list leads to a pushed chat.
  useEffect(() => {
    if (!wide) { setActiveId(undefined); return; }
    const preferred = selection.serverId === server.id && selection.chatId && scoped.has(selection.chatId) ? selection.chatId : list[0]?.id;
    setActiveId((current) => (current && scoped.has(current) ? current : preferred));
  }, [wide, server.id, selection.serverId, selection.chatId, list.map((c) => c.id).join(':'), snapshot?.threads.length]);
  useEffect(() => { if (online && !snapshot) useApp.getState().loadProjects(server.id); }, [online, snapshot, server.id]);

  const openChat = (chat: Chat) => {
    useApp.getState().select(server.id, chat.id);
    if (wide) setActiveId(chat.id);
    else router.push(`/chat/${server.id}/${chat.id}`);
  };
  const newChat = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const chat = await useApp.getState().createChatInProject(server.id, projectId);
      if (chat) openChat(chat);
    } catch (e) {
      useApp.getState().toast({ serverId: server.id, title: "Couldn't start a chat", body: (e as Error).message });
    } finally {
      setCreating(false);
    }
  };
  const back = () => (router.canGoBack() ? router.back() : router.replace('/projects'));

  if (!feature && runtime?.info) {
    return (
      <View style={[s.root, { paddingTop: insets.top + 8 }]}>
        <PageHeader onBack={back} title="Project" />
        <View style={s.notice}>
          <CircleAlert size={21} color={t.colors.warning} />
          <Text style={s.noticeText}>Update Winglet on the server to use projects.</Text>
        </View>
      </View>
    );
  }
  if (!snapshot) {
    return (
      <View style={[s.root, { paddingTop: insets.top + 8 }]}>
        <PageHeader onBack={back} title="Project" />
        {online ? (
          <View style={s.loading}>
            <Skeleton height={72} radius={t.radius.lg} />
            <Skeleton height={64} radius={t.radius.lg} />
            <Skeleton height={64} radius={t.radius.lg} />
          </View>
        ) : (
          <View style={s.empty}>
            <CircleAlert size={26} color={t.colors.warning} />
            <Text style={s.emptyText}>Connect to your bot to load this project.</Text>
            <Button title="Open chats" variant="secondary" onPress={() => router.replace('/chats')} />
          </View>
        )}
      </View>
    );
  }
  if (!project) {
    return (
      <View style={[s.root, { paddingTop: insets.top + 8 }]}>
        <PageHeader onBack={back} title="Project" />
        <View style={s.empty}>
          <Text style={s.emptyText}>Project deleted. Its chats and drafts are still in All chats.</Text>
          <Button title="Open chats" variant="secondary" onPress={() => router.replace('/chats')} />
        </View>
      </View>
    );
  }

  const listPane = (
    <View style={[s.listPane, wide && s.listPaneWide, { paddingTop: wide ? 14 : insets.top + 6 }]}>
      <PageHeader onBack={back} title={project.name} onMenu={() => setMenu(true)} wide={wide} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: Math.max(insets.bottom, 20) + 12 }}
        keyboardShouldPersistTaps="handled">
        <Text style={s.heroTitle} accessibilityRole="header">{projectTitle(project)}</Text>
        <SectionHeader title={project.private ? 'Only you' : 'Shared'} right={<Text style={s.time}>{projectCountLabel(project)}</Text>} />
        <ConnectionBanner server={server} compact />
        {project.archived ? (
          <View style={s.archive}>
            <Text style={s.archiveText}>Archived project. Chats remain available.</Text>
            {project.can_manage && online ? <Button title="Restore" size="sm" variant="secondary"
              onPress={() => useApp.getState().setProjectArchived(server.id, projectId, false)
                .catch((e) => useApp.getState().toast({ serverId: server.id, title: "Couldn't restore", body: (e as Error).message }))} /> : null}
          </View>
        ) : null}
        <View style={s.searchRow}>
          <SearchField value={query} onChangeText={setQuery} placeholder="Search this project" style={{ flex: 1 }} />
          {!project.archived && online ? <IconButton label={creating ? 'Starting a chat' : 'New chat in this project'} variant="filled" onPress={newChat}>
            <MessageSquarePlus size={20} color={t.colors.text} />
          </IconButton> : null}
        </View>
        <SectionHeader title={q ? 'Matching chats' : 'Chats'} right={<Text style={s.time}>{q ? visible.length : list.length}</Text>} />
        {hiddenArchived ? (
          <Button title={`${showArchived ? 'Hide' : 'Show'} archived chats (${hiddenArchived})`} variant="ghost" size="sm"
            accessibilityLabel={showArchived ? 'Hide chats archived on this device' : `Show ${hiddenArchived} chats archived on this device`}
            onPress={() => setShowArchived((v) => !v)} />
        ) : null}
        {visible.length ? (
          <View style={s.list}>
            {visible.map((chat, index) => (
              <Animated.View key={chat.id} entering={reduced ? undefined
                : FadeIn.duration(180)}
                layout={reduced ? undefined : LinearTransition.duration(180).easing(easeOut)}>
                <ProjectChatRow server={server} chat={chat} active={wide && activeId === chat.id} first={index === 0}
                  pinned={pinnedChats.includes(chatKey(server.id, chat.id))}
                  subtitle={draftOf(chat) ?? chatActivityLabel(chatActivity(runtime, chat.id, now)) ?? undefined}
                  subtitleColor={draftOf(chat) ? t.colors.textSecondary : t.colors.accent}
                  pending={!!chatActivity(runtime, chat.id, now).pending}
                  onPress={() => openChat(chat)} onMenu={() => setChatMenu(chat)} />
              </Animated.View>
            ))}
          </View>
        ) : null}
        {q && !visible.length && !results.length && !found.busy ? (
          <View style={s.empty}>
            <Text style={s.emptyTitle}>Nothing in {project.name} matches “{q}”</Text>
            <Button title="Clear search" variant="secondary" onPress={() => setQuery('')} />
          </View>
        ) : null}
        {!q && !list.length ? (
          <View style={s.empty}>
            <Text style={s.emptyTitle}>{hiddenArchived ? `${hiddenArchived} archived on this device` : `No chats in ${project.name} yet`}</Text>
            {!project.archived && online ? <Button title="New chat" icon={<Hash size={16} color={t.colors.onAccent} />} onPress={newChat} loading={creating} /> : null}
            {hiddenArchived ? <Button title="Show archived chats" variant="secondary" onPress={() => setShowArchived(true)} /> : null}
            <Button title="Open chats" variant="secondary" onPress={() => router.push('/chats')} />
          </View>
        ) : null}
        {results.length ? (
          <>
            <SectionHeader title="In messages" />
            <View style={s.list}>
              {results.map((result) => {
                const chat = chats?.[result.chat.id];
                return chat ? <ResultRow key={result.message.id} result={result}
                  onPress={() => { requestFocus(server.id, chat.id, result.message.id); openChat(chat); }} /> : null;
              })}
            </View>
          </>
        ) : null}
        {q && found.busy ? <Text style={s.searching}>Searching this project…</Text> : null}
      </ScrollView>
    </View>
  );

  if (!wide) return <View style={s.root}>{listPane}
    <ChatMenu server={server} chatId={chatMenu?.id ?? ''} title={chatMenu ? `#${chatMenu.title}` : ''} visible={!!chatMenu} onClose={() => setChatMenu(null)} />
    <ProjectMenuSheet server={server} projectId={projectId} visible={menu} onClose={() => setMenu(false)} onDeleted={() => router.replace('/projects')} />
  </View>;

  return (
    <View style={s.split}>
      <View style={s.paneWidth}>{listPane}</View>
      <View style={{ flex: 1, minWidth: 0 }}>
        {activeId ? <ChatView key={`${server.id}:${activeId}`} server={server} chatId={activeId} embedded /> : (
          <View style={[s.empty, { flex: 1, justifyContent: 'center' }]}>
            <Text style={s.emptyText}>Choose a chat or start one here.</Text>
            {!project.archived && online ? <Button title="New chat" onPress={newChat} loading={creating} /> : null}
          </View>
        )}
      </View>
      <ChatMenu server={server} chatId={chatMenu?.id ?? ''} title={chatMenu ? `#${chatMenu.title}` : ''} visible={!!chatMenu} onClose={() => setChatMenu(null)} />
      <ProjectMenuSheet server={server} projectId={projectId} visible={menu} onClose={() => setMenu(false)} onDeleted={() => router.replace('/projects')} />
    </View>
  );
}

function PageHeader({ onBack, title, onMenu, wide }: { onBack: () => void; title: string; onMenu?: () => void; wide?: boolean }) {
  const t = useTheme();
  const s = useStyles();
  return (
    <View style={s.header}>
      <IconButton label="Back to projects" onPress={onBack}><ArrowLeft size={22} color={t.colors.text} /></IconButton>
      <Text style={s.headerTitle} numberOfLines={1} accessibilityRole="header">{title}</Text>
      {onMenu ? <IconButton label="Project options" onPress={onMenu}><MoreHorizontal size={21} color={t.colors.text} /></IconButton> : null}
      {wide ? <View style={{ width: 4 }} /> : null}
    </View>
  );
}

function ProjectChatRow({ server, chat, subtitle, subtitleColor, pending, active, first, pinned, onPress, onMenu }: {
  server: Server; chat: Chat; subtitle?: string; subtitleColor?: string; pending?: boolean; active?: boolean; first?: boolean; pinned?: boolean;
  onPress: () => void; onMenu: () => void;
}) {
  const t = useTheme();
  const s = useStyles();
  const main = chat.id === homeChat(useApp.getState().runtime[server.id]);
  const multiBot = useApp((st) => st.servers.length > 1);
  const mouse = Platform.OS === 'web' && typeof window !== 'undefined' && window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;
  return (
    <Tap feedback="selection" scaleTo={0.99} onPress={onPress} onLongPress={onMenu} delayLongPress={350}
      accessibilityLabel={`${chat.title}${subtitle ? `. ${subtitle}` : ''}${pending ? ', waiting for you' : ''}`}
      accessibilityHint="Long-press for chat options" accessibilityState={{ selected: !!active }}
      style={({ pressed, hovered }) => [s.row, first && { borderTopWidth: 0 }, active && { backgroundColor: t.colors.pressed },
        (pressed || hovered) && !active && { backgroundColor: t.colors.pressed }]}>
      {multiBot ? <AgentFace server={server} size={26} still /> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={s.rowHead}>
          {pinned ? <Pin size={12} color={t.colors.textTertiary} accessibilityLabel="Pinned" /> : null}
          <Text style={s.rowTitle} numberOfLines={1}>{main ? server.bot.title : chat.title}</Text>
          <Text style={s.time}>{ago(chat.updated_at)}</Text>
        </View>
        {subtitle ? <Text style={[s.sub, { color: pending ? t.colors.warning : subtitleColor ?? t.colors.textSecondary }]} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      {mouse ? <IconButton label={`Options for ${chat.title}`} size={32} onPress={(e) => { e.stopPropagation(); onMenu(); }}>
        <MoreHorizontal size={16} color={t.colors.textTertiary} /></IconButton> : null}
    </Tap>
  );
}

function ResultRow({ result, onPress }: { result: SearchResult; onPress: () => void }) {
  const t = useTheme();
  const s = useStyles();
  return (
    <Tap feedback="selection" scaleTo={0.99} onPress={onPress} accessibilityLabel={`Message in ${result.chat.title}: ${result.snippet}. Open`}
      style={({ pressed, hovered }) => [s.row, (pressed || hovered) && { backgroundColor: t.colors.pressed }]}>
      <View style={s.resultIcon}><Search size={15} color={t.colors.textSecondary} /></View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={s.rowTitle} numberOfLines={1}>{result.chat.title}</Text>
        <Text style={s.sub} numberOfLines={2}>{result.snippet}</Text>
      </View>
    </Tap>
  );
}

/** Messages in this project only, after a short pause; a stale answer is ignored. */
function useProjectSearch(server: Server, projectId: string, query: string) {
  const [state, setState] = useState<{ results: SearchResult[]; busy: boolean }>({ results: [], busy: false });
  const q = query.trim();
  useEffect(() => {
    if (q.length < 2) { setState({ results: [], busy: false }); return; }
    setState((st) => ({ ...st, busy: true }));
    let live = true;
    const id = setTimeout(() => {
      api<{ results: SearchResult[] }>(server, `/api/search?q=${encodeURIComponent(q)}&project_id=${encodeURIComponent(projectId)}`)
        .then((d) => live && setState({ results: d.results, busy: false }))
        .catch(() => live && setState({ results: [], busy: false }));
    }, 300);
    return () => { live = false; clearTimeout(id); };
  }, [server, projectId, q]);
  return state;
}

const useStyles = makeStyles((t) => ({
  root: { flex: 1, backgroundColor: t.colors.bg },
  split: { flex: 1, flexDirection: 'row', backgroundColor: t.colors.bg },
  paneWidth: { width: 360, minWidth: 0, borderRightWidth: 1, borderRightColor: t.colors.border },
  listPane: { flex: 1, minWidth: 0, backgroundColor: t.colors.bg },
  listPaneWide: { width: '100%' },
  loading: { padding: 16, gap: 10 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 48, paddingHorizontal: 8 },
  headerTitle: { ...t.type.heading, color: t.colors.text, flex: 1, minWidth: 0 },
  heroTitle: { ...t.type.display, color: t.colors.text, marginTop: t.space.xs },
  archive: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12, padding: 14, borderRadius: t.radius.lg, backgroundColor: t.colors.warningSoft },
  archiveText: { ...t.type.callout, color: t.colors.textSecondary, flex: 1 },
  searchRow: { flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: t.space.md, paddingVertical: 7, borderRadius: t.radius.sm, minHeight: 50 },
  list: {
    backgroundColor: t.colors.surface, borderRadius: t.radius.lg, borderWidth: 1, borderColor: t.colors.border, padding: t.space.xs,
    overflow: 'hidden',
  },
  resultIcon: { width: 30, height: 30, borderRadius: t.radius.pill, backgroundColor: t.colors.surfaceSunken, alignItems: 'center', justifyContent: 'center' },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowTitle: { ...t.type.callout, color: t.colors.text, flex: 1, minWidth: 0 },
  sub: { ...t.type.caption, color: t.colors.textSecondary, marginTop: 2 },
  time: { ...t.type.caption, color: t.colors.textTertiary },
  empty: { alignItems: 'center', gap: 12, paddingVertical: 34, paddingHorizontal: 18 },
  emptyIcon: { width: 62, height: 62, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.surfaceSunken },
  emptyTitle: { ...t.type.callout, color: t.colors.text, textAlign: 'center' },
  emptyText: { ...t.type.callout, color: t.colors.textSecondary, textAlign: 'center', maxWidth: 420 },
  notice: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', margin: 16, padding: 16, borderRadius: t.radius.lg, backgroundColor: t.colors.warningSoft },
  noticeText: { ...t.type.callout, color: t.colors.textSecondary, flex: 1 },
  searching: { ...t.type.caption, color: t.colors.textTertiary, paddingVertical: 10 },
}));
