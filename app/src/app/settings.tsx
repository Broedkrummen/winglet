import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, Text, useWindowDimensions, View, StyleSheet } from 'react-native';
import { useAddBot } from '../components/AddBot';
import { AgentFace } from '../components/AgentFace';
import { NavigationToggle } from '../components/AppNavigation';
import { Bell, ChevronRight, Fingerprint, Info, Palette, Plus, Smartphone } from '../components/icons';
import { Screen } from '../components/Screen';
import { Footnote, ListGroup, ListRow, SectionHeader, Segmented, Tap, Toggle } from '../components/ui';
import { lockAvailable, unlock } from '../lib/appLock';
import { useAppUpdate } from '../lib/appUpdateCheck';
import { connectionView } from '../lib/connection';
import { isOwner, useApp, useServerState } from '../lib/store';
import { usePrefs } from '../lib/prefs';
import { ACCENTS, WIDE_BREAKPOINT } from '../lib/theme';
import { makeStyles, useTheme } from '../lib/themeContext';
import { usePersonalSync } from '../features/sync/runtime';

export default function SettingsScreen() {
  const t = useTheme();
  const s = useStyles();
  const { width } = useWindowDimensions();
  const servers = useApp((st) => st.servers);
  const selection = useApp((st) => st.selection);
  const network = useApp((st) => st.network);
  const server = servers.find((x) => x.id === selection.serverId) ?? servers[0];
  const rt = useServerState(server?.id);
  const prefs = usePrefs((st) => st.prefs);
  const update = usePrefs((st) => st.update);
  const appUpdate = useAppUpdate((st) => st.update);
  const sync = usePersonalSync();
  const addBot = useAddBot();
  const [canLock, setCanLock] = useState<boolean | null>(null);
  useEffect(() => {
    if (Platform.OS === 'android') lockAvailable().then(setCanLock);
  }, []);
  const view = connectionView(network, rt, server?.bot.title ?? 'Bot');
  const themeLabel = prefs.theme === 'system' ? 'System' : prefs.theme === 'dark' ? 'Dark' : 'Light';

  return <Screen title="Settings" right={width >= WIDE_BREAKPOINT ? <NavigationToggle /> : undefined}>
    {server ? <Tap feedback="selection" scaleTo={0.98} onPress={() => router.push('/agent')} accessibilityLabel={`Manage ${server.bot.title}`}
      style={({ hovered }) => [s.botCard, hovered && { borderColor: t.colors.borderStrong }]}>
      <AgentFace server={server} size={44} still />
      <View style={s.botText}>
        <Text style={s.botName} numberOfLines={1}>{server.bot.title}</Text>
        <View style={s.status}>
          <View style={[s.dot, { backgroundColor: view.tone === 'ok' ? t.colors.success : view.tone === 'error' ? t.colors.danger : t.colors.warning }]} />
          <Text style={s.statusText} numberOfLines={1}>{view.kind === 'online' ? 'Online' : view.title}</Text>
        </View>
      </View>
      <ChevronRight size={18} color={t.colors.textTertiary} />
    </Tap> : null}

    <SectionHeader title="App" />
    <ListGroup>
      <View style={s.sidebar}>
        <Text style={s.label}>View</Text>
        <Segmented label="View" value={prefs.view} onChange={(view) => update({ view })}
          options={[{ value: 'full', label: 'Full' }, { value: 'simple', label: 'Simple' }]} />
      </View>
      <View style={s.sidebar}>
        <Text style={s.label}>When opening a bot in Simple view</Text>
        <Segmented label="When opening a bot" value={prefs.botOpening} onChange={(botOpening) => update({ botOpening })}
          options={[{ value: 'last', label: 'Last chat' }, { value: 'main', label: 'Main chat' }, { value: 'list', label: 'Chat list' }]} />
      </View>
      <View style={s.sidebar}>
        <Text style={s.label}>Messages sent while a bot works</Text>
        <Segmented label="Messages sent while a bot works" value={prefs.busyMode} onChange={(busyMode) => update({ busyMode })}
          options={[{ value: 'steer', label: 'Guide' }, { value: 'queue', label: 'Queue' }, { value: 'interrupt', label: 'Interrupt' }]} />
      </View>
      <ListRow title="Appearance" value={`${themeLabel} · ${ACCENTS[prefs.accent].label}`} icon={<Palette />} onPress={() => router.push('/appearance')} />
      <ListRow title="Notifications" icon={<Bell />} onPress={() => router.push('/notifications')} />
      <ListRow title="Commands and shortcuts" subtitle="Find actions and keyboard shortcuts" onPress={() => router.push('/commands')} />
      <ListRow title="Sync" subtitle={sync.conflicts.length ? `${sync.conflicts.length} choices needed` : sync.home ? 'Devices linked to your Hermes home' : 'Connect your devices'} onPress={() => router.push('/sync-settings')} />
      {Platform.OS === 'android' ? <ListRow title="App lock" icon={<Fingerprint />}
        right={<Toggle label="App lock" value={prefs.appLock} onValueChange={async (on) => {
          if (!canLock) return;
          // Prove the phone's unlock works before enabling the lock.
          if (on && !(await unlock('Turn on app lock'))) return;
          update({ appLock: on });
        }} />} /> : null}
      <View style={s.sidebar}>
        <Text style={s.label}>Sidebar</Text>
        <Segmented label="Sidebar" value={prefs.sidebar} onChange={(sidebar) => update({ sidebar })} options={[
          { value: 'auto', label: 'Automatic' }, { value: 'drawer', label: 'Drawer' }, { value: 'pinned', label: 'Pinned' },
        ]} />
      </View>
    </ListGroup>
    {Platform.OS === 'android' ? <Footnote>{canLock === false ? 'Set up a fingerprint, face or screen lock in Android first.' : 'App lock asks for your fingerprint or PIN after a minute away.'}</Footnote> : null}

    {Platform.OS === 'android' ? <>
      <SectionHeader title="On this phone" />
      <ListGroup>
        {rt?.info?.features.phone_tools ? <ListRow title="Phone tools" icon={<Smartphone />} onPress={() => router.push('/phone-tools')} /> : null}
        <ListRow title="Android assistant" icon={<Smartphone />} onPress={() => router.push('/assistant-settings')} />
        <ListRow title="Wear OS" icon={<Smartphone />} onPress={() => router.push('/wear-settings')} />
      </ListGroup>
    </> : null}

    {rt?.info?.features?.abilities && isOwner(rt) ? <>
      <SectionHeader title="Agent abilities" />
      <ListGroup>
        <ListRow title="Skills" subtitle="Manage and add custom skills" onPress={() => router.push('/skills')} />
        <ListRow title="MCP" subtitle="Connect apps and custom servers" onPress={() => router.push('/mcp')} />
        <ListRow title="Tools" subtitle="Manage toolsets and add custom tools" onPress={() => router.push('/tools')} />
        <ListRow title="Memory" subtitle="Notes, providers and pending changes" onPress={() => router.push('/memory')} />
      </ListGroup>
    </> : null}
    <SectionHeader title="Bots" />
    <ListGroup>
      <ListRow title="Your bots" value={String(servers.length)} icon={<Smartphone />} onPress={() => router.push('/bots')} />
      <ListRow title="Add a bot" icon={<Plus />} onPress={addBot.open} />
    </ListGroup>
    {addBot.sheet}

    <SectionHeader title="About" />
    <ListGroup>
      <ListRow title="About & storage" value={appUpdate ? `Update to ${appUpdate.version}` : undefined} icon={<Info />}
        iconColor={appUpdate ? t.colors.success : undefined} onPress={() => router.push('/about')} />
    </ListGroup>
  </Screen>;
}

const useStyles = makeStyles((t) => ({
  botCard: {
    flexDirection: 'row', alignItems: 'center', gap: t.space.md, marginTop: t.space.lg, paddingHorizontal: t.space.lg, paddingVertical: t.space.md,
    backgroundColor: t.colors.surface, borderRadius: t.radius.lg, borderWidth: StyleSheet.hairlineWidth * 2, borderColor: t.colors.border,
  },
  botText: { flex: 1, minWidth: 0, gap: 2 },
  botName: { ...t.type.heading, color: t.colors.text },
  status: { flexDirection: 'row', alignItems: 'center', gap: t.space.sm },
  statusText: { ...t.type.footnote, color: t.colors.textSecondary, flexShrink: 1 },
  dot: { width: 7, height: 7, borderRadius: t.radius.pill },
  sidebar: { gap: t.space.sm, padding: t.space.lg },
  label: { ...t.type.body, fontSize: 15.5, color: t.colors.text },
}));
