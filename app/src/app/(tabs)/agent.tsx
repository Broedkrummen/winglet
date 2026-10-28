import { useCallback, useState } from 'react';
import { Redirect, router, useFocusEffect } from 'expo-router';
import { Text, useWindowDimensions, View } from 'react-native';
import Animated, { useAnimatedScrollHandler, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ManageBot } from '../../components/ManageBot';
import { VerifyNotice } from '../../components/VerifyPhone';
import { BotSwitcher } from '../../components/BotSwitcher';
import { HUB_BAR, HubBar } from '../../components/InboxView';
import { LivePet } from '../../components/LivePet';
import {
  Activity, BarChart, Brain, CalendarClock, Check, Cpu, FileDiff, HeartPulse, Key, MessageCircle, MessageSquareText, PawPrint, Plug,
  ScrollText, ShieldCheck, Sparkles, SquareTerminal, Star, UserRoundPen,
} from '../../components/icons';
import { moodOf } from '../../lib/agent';
import { modelName } from '../../lib/modelOptions';
import { api } from '../../lib/api';
import { useTabBarSpace } from '../../components/TabBar';
import { Button, Footnote, ListGroup, ListRow, SectionHeader } from '../../components/ui';
import { connectionView } from '../../lib/connection';
import { setMainBot, useMainBot } from '../../lib/mainBot';
import { homeChat, isOwner, useApp, useServerState } from '../../lib/store';
import type { AgentInfo, Server } from '../../lib/types';
import { WIDE_BREAKPOINT } from '../../lib/theme';
import { makeStyles, useTheme } from '../../lib/themeContext';

/** This bot's management. App-wide preferences live in Settings. */
export default function AgentTab() {
  const servers = useApp((st) => st.servers);
  const selection = useApp((st) => st.selection);
  if (!servers.length) return <Redirect href="/pair" />;
  return <AgentHub server={servers.find((x) => x.id === selection.serverId) ?? servers[0]} />;
}

function AgentHub({ server }: { server: Server }) {
  const t = useTheme();
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const tabSpace = useTabBarSpace();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_BREAKPOINT;
  const servers = useApp((st) => st.servers);
  const rt = useServerState(server.id);
  const network = useApp((st) => st.network);
  const mood = useApp((st) => moodOf(st.runtime[server.id]));
  const mainBot = useMainBot();
  const y = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => { y.value = e.contentOffset.y; });
  const child = !!server.parent;
  const parent = child ? servers.find((x) => x.id === server.parent) : undefined;
  const view = connectionView(network, rt, server.bot.title);
  const owner = isOwner(rt);
  const control = rt?.info?.features?.control && owner;
  const brain = !!rt?.info?.features?.agent && owner;
  const info = useAgentInfo(server, brain);
  const model = info?.configured.model ? modelName(info.configured.model) : undefined;

  const online = view.kind === 'online';
  const status = !online ? view.title : mood === 'waiting' ? 'Needs you' : mood === 'working' ? 'Working' : 'Online';
  const tone = !online ? view.tone === 'error' ? t.colors.danger : t.colors.warning
    : mood === 'waiting' ? t.colors.warning : t.colors.success;

  const brainRows = brain ? [
    <ListRow key="model" icon={<Cpu />} title="Model" value={model} onPress={() => router.push('/model')} />,
    <ListRow key="providers" icon={<Key />} title="Providers" onPress={() => router.push('/providers')} />,
    <ListRow key="persona" icon={<UserRoundPen />} title="Persona" onPress={() => router.push('/persona')} />,
    ...(rt?.info?.features?.pets ? [<ListRow key="pet" icon={<PawPrint />} title="Pet" value={rt.pet?.name} onPress={() => router.push('/pets')} />] : []),
    <ListRow key="memory" icon={<Brain />} title="Memory" onPress={() => router.push('/memory')} />,
    <ListRow key="usage" icon={<BarChart />} title="Usage" onPress={() => router.push('/usage')} />,
  ] : [];
  const abilityRows = rt?.info?.features?.abilities && owner ? [
    <ListRow key="skills" icon={<Sparkles />} title="Skills" onPress={() => router.push('/skills')} />,
    <ListRow key="tools" icon={<SquareTerminal />} title="Tools" onPress={() => router.push('/tools')} />,
    <ListRow key="mcp" icon={<Plug />} title="MCP servers" onPress={() => router.push('/mcp')} />,
  ] : [];
  const historyRows = control ? [
    <ListRow key="schedule" icon={<CalendarClock />} title="Schedule" onPress={() => router.push('/schedule')} />,
    ...(rt.info?.features?.checkpoints ? [<ListRow key="checkpoints" icon={<FileDiff />} title="Checkpoints" onPress={() => router.push('/checkpoints')} />] : []),
    ...(rt.info?.features?.sessions ? [<ListRow key="sessions" icon={<MessageSquareText />} title="Sessions" onPress={() => router.push('/sessions')} />] : []),
    ...(!child ? [<ListRow key="logs" icon={<ScrollText />} title="Logs" onPress={() => router.push('/logs')} />] : []),
  ] : [];

  return (
    <View style={s.root}>
      <Animated.ScrollView onScroll={onScroll} scrollEventThrottle={16}
        contentContainerStyle={[s.content, { paddingTop: insets.top + HUB_BAR, paddingBottom: (wide ? t.space.xl : tabSpace) + t.space.sm }]}>
        <View style={s.profile}>
          <LivePet server={server} size={64} accessibilityLabel={`${server.bot.title}, ${status}. Tap to poke`} />
          <View style={s.identity}>
            <Text style={s.name} accessibilityRole="header" numberOfLines={2}>{server.bot.title}</Text>
            <View style={s.meta} accessibilityLabel={`Status: ${status}${model ? `. Model: ${model}` : ''}`}>
              <View style={[s.dot, { backgroundColor: tone }]} />
              <Text style={s.metaText} numberOfLines={1}>{status}{model ? ` · ${model}` : ''}</Text>
            </View>
          </View>
        </View>
        <View style={s.actions}>
          <Button title="Open chat" style={s.action} icon={<MessageCircle size={17} color={t.colors.onInk} />}
            onPress={() => router.push(`/chat/${server.id}/${homeChat(rt)}`)} />
          {child ? null : <Button title="Updates" variant="secondary" style={s.action} icon={<Sparkles size={17} color={t.colors.text} />}
            onPress={() => router.push(`/chat/${server.id}/home`)} />}
        </View>

        <VerifyNotice server={server} />

        {brainRows.length ? <><SectionHeader title="Agent" /><ListGroup>{brainRows}</ListGroup></> : null}
        {abilityRows.length ? <><SectionHeader title="Abilities" /><ListGroup>{abilityRows}</ListGroup></> : null}
        {historyRows.length ? <><SectionHeader title="Automation & history" /><ListGroup>{historyRows}</ListGroup></> : null}

        <SectionHeader title="Server" />
        <ListGroup>
          {control && !child ? <ListRow icon={<HeartPulse />} iconColor={rt.paused ? t.colors.warning : undefined}
            title="Status" value={rt.paused ? 'Paused' : undefined} onPress={() => router.push('/server')} /> : null}
          <ListRow icon={<Activity />} title="Connection" value={online ? 'Online' : view.title}
            onPress={() => router.push(`/connection/${server.parent ?? server.id}`)} />
          {rt?.info?.features?.config_catalog && owner ? <ListRow icon={<Cpu />} title="Agent configuration" onPress={() => router.push('/advanced-config')} /> : null}
        </ListGroup>

        <SectionHeader title="Access" />
        <ListGroup>
          {!child && rt?.info?.features?.roles ? <ListRow icon={<ShieldCheck />} title="Devices"
            value={rt.me ? rt.me.role === 'owner' ? 'Owner' : 'Member' : undefined} onPress={() => router.push('/devices')} /> : null}
          <ListRow icon={<Star />} title="Open the app on this bot" value={mainBot?.id === server.id ? 'Main' : undefined}
            right={mainBot?.id === server.id ? <Check size={20} color={t.colors.accent} /> : undefined} chevron={false}
            onPress={mainBot?.id === server.id ? undefined : () => setMainBot(server.id)} />
        </ListGroup>
        {child && parent && owner ? <ManageBot server={server} parent={parent} /> : null}

        {rt?.info?.version ? <Footnote style={s.version}>Server plugin {rt.info.version}{rt.info.hermes_version ? ` · Hermes ${rt.info.hermes_version}` : ''}</Footnote> : null}
      </Animated.ScrollView>
      <HubBar y={y} title={server.bot.title} right={<BotSwitcher />} />
    </View>
  );
}

/** The agent's configuration (owners only), refreshed when you come back from the model picker. */
function useAgentInfo(server: Server, enabled: boolean): AgentInfo | null {
  const [loaded, setLoaded] = useState<{ id: string; info: AgentInfo } | null>(null);
  const online = useApp((st) => st.runtime[server.id]?.status === 'online');
  useFocusEffect(useCallback(() => {
    if (!enabled || !online) return;
    api<AgentInfo>(server, '/api/agent').then((info) => setLoaded({ id: server.id, info })).catch(() => undefined);
  }, [server, online, enabled]));
  return enabled && loaded?.id === server.id ? loaded.info : null;
}

const useStyles = makeStyles((t) => ({
  root: { flex: 1, backgroundColor: t.colors.bg },
  content: { paddingHorizontal: t.space.lg, maxWidth: 680, width: '100%', alignSelf: 'center' },
  profile: { flexDirection: 'row', alignItems: 'center', gap: t.space.lg, paddingHorizontal: 4, marginTop: t.space.xs },
  identity: { flex: 1, minWidth: 0, gap: 4 },
  name: { ...t.type.display, color: t.colors.text },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  metaText: { ...t.type.callout, color: t.colors.textSecondary, flexShrink: 1 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  actions: { flexDirection: 'row', gap: t.space.sm, marginTop: t.space.xl },
  action: { flex: 1 },
  version: { alignItems: 'center', paddingTop: t.space.xl },
}));
