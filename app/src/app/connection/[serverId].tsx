import Constants from 'expo-constants';
import * as Clipboard from 'expo-clipboard';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { ConnectionBanner } from '../../components/ConnectionBanner';
import { Activity, Bell, Cloud, Copy, Globe, Moon, Pencil, Route, ShieldCheck, Smartphone, SquareTerminal, TriangleAlert } from '../../components/icons';
import { Screen } from '../../components/Screen';
import { Sheet } from '../../components/Sheet';
import { Button, Card, Field, ListGroup, ListRow, SectionHeader, Skeleton } from '../../components/ui';
import { api, moveServer } from '../../lib/api';
import { addressKind, checkAddress, connectionView, deliverySummary, diagnosticReport, modeSummary, span, tunnelSummary } from '../../lib/connection';
import { haptic } from '../../lib/haptics';
import { describeTestPush, sendTestPush } from '../../lib/push';
import { APP_PROTOCOL, isOwner, useApp, useServerState } from '../../lib/store';
import { makeStyles, useTheme } from '../../lib/themeContext';
import type { ConnectionStatus, Server } from '../../lib/types';

/** Everything about how this phone reaches one bot: the route, its address, notifications, and a report for help. */
export default function ConnectionScreen() {
  const t = useTheme();
  const s = useStyles();
  const { serverId } = useLocalSearchParams<{ serverId: string }>();
  const server = useApp((st) => st.servers.find((x) => x.id === serverId));
  const rt = useServerState(serverId);
  const network = useApp((st) => st.network);
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [checkedAt, setCheckedAt] = useState(0);
  const [moving, setMoving] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [testing, setTesting] = useState(false);
  const [now, setNow] = useState(Date.now());
  const supported = !!rt?.info?.features?.connection_status;
  const online = rt?.status === 'online';

  const load = useCallback(() => {
    if (!server || !supported) return;
    api<ConnectionStatus>(server, '/api/connection/status')
      .then((next) => { setStatus(next); setCheckedAt(Date.now()); }).catch(() => undefined);
  }, [server, supported]);
  useEffect(() => {
    if (!online) return;
    load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, [online, load]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!server) return <Redirect href="/" />;
  const view = connectionView(network, rt, server.bot.title, now);
  const owner = isOwner(rt);
  const native = Platform.OS !== 'web';
  const appVersion = Constants.expoConfig?.version ?? '';
  const report = () => diagnosticReport({ bot: server.bot.title, url: server.url, recovery: !!server.recovery, network,
    appVersion, appProtocol: APP_PROTOCOL, platform: Platform.OS, rt });
  const copy = async (text: string) => {
    await Clipboard.setStringAsync(text);
    haptic.success();
    useApp.getState().toast({ serverId: server.id, title: 'Copied', body: text });
  };
  // Polling stops while the server is unreachable: what's shown is then only the last known state.
  const stale = !!status && !online;
  const offered = status?.url && status.url !== server.url && native ? status.url : null;

  const rows: [string, string][] = [
    ['Phone network', network ? 'Online' : 'Offline'],
    ['Last problem', rt?.conn.lastError ?? 'None'],
    ['Queued messages', String(rt?.outbox.filter((o) => !o.failed).length ?? 0)],
    ['This app', `${appVersion} (protocol ${APP_PROTOCOL})`],
    ['Winglet on server', rt?.info?.version ? `${rt.info.version} (protocol ${rt.info.protocol})` : 'Unknown until connected'],
    ['Hermes', rt?.info?.hermes_version || 'Unknown'],
  ];

  return (
    <Screen title="Connection" subtitle={server.bot.title}>
      <ConnectionBanner server={server} />
      <View style={s.hero}>
        <View style={[s.dot, { backgroundColor: view.kind === 'online' ? t.colors.success : view.tone === 'error' ? t.colors.danger : t.colors.warning }]} />
        <View style={{ flex: 1 }}>
          <Text style={s.heroTitle}>{view.kind === 'online' ? 'Online' : view.title}</Text>
          <Text style={s.heroDetail}>{status ? `${modeSummary(status.mode).title} · ` : ''}{addressKind(server.url)}</Text>
        </View>
      </View>

      {supported && online && !status ? (
        <View style={{ gap: 10, marginTop: 18 }}>{[0, 1].map((i) => <Skeleton key={i} height={64} radius={16} />)}</View>
      ) : null}
      {status ? (
        <Animated.View entering={FadeIn}>
          <SectionHeader title={`How phones reach ${server.bot.title}`} />
          {stale ? <Text style={[s.note, { marginTop: 0 }]}>Last known, from before this phone lost {server.bot.title}. It updates when the connection is back.</Text> : null}
          <ListGroup>
            <ListRow icon={status.mode === 'quick' ? <Cloud size={18} color={t.colors.onAccentSoft} /> : <Route size={18} color={t.colors.onAccentSoft} />}
              title={modeSummary(status.mode).title} subtitle={modeSummary(status.mode).detail} />
            {status.tunnel ? <TunnelRow tunnel={status.tunnel} now={now} checkedAt={stale ? checkedAt : null} /> : null}
            <ListRow icon={<Globe size={18} color={t.colors.onAccentSoft} />} title="Address it gives out"
              subtitle={status.url ?? (status.mode === 'quick' ? 'None right now. It gets a new one when the tunnel is back.' : 'Not set. Phones use the address they paired with.')}
              right={status.url ? <CopyButton label="Copy the server's address" onPress={() => copy(status.url!)} /> : undefined} />
          </ListGroup>
          {status.mode === 'quick' && status.address_since && !stale ? (
            <Text style={s.note}>This address has worked for {span(now - status.address_since * 1000)}
              {status.address_changes ? `. It has changed ${status.address_changes === 1 ? 'once' : `${status.address_changes} times`}` : ''}.</Text>
          ) : null}
          {offered ? (
            <Card style={[s.offer, { marginTop: 12 }]}>
              <Text style={s.body}>This phone uses a different address from the one {server.bot.title} gives out. Switch if the one above works where you are.</Text>
              <Button size="sm" variant="tonal" title="Use the server's address" onPress={() => setMoving(offered)} />
            </Card>
          ) : null}
        </Animated.View>
      ) : null}

      <SectionHeader title="This phone" />
      <ListGroup>
        <ListRow icon={<Smartphone size={18} color={t.colors.onAccentSoft} />} title="Address" subtitle={server.url}
          right={<CopyButton label="Copy this phone's address" onPress={() => copy(server.url)} />} />
        {native ? <ListRow icon={<Pencil size={18} color={t.colors.onAccentSoft} />} title="Change address"
          subtitle="Moved the server to Tailscale or a new domain? Point this phone at its new address." onPress={() => setMoving('')} /> : null}
        <ListRow icon={<ShieldCheck size={18} color={t.colors.onAccentSoft} />} title="Address recovery" subtitle={recoveryLine(server, status, now)} />
      </ListGroup>

      {status ? <Notifications server={server} status={status} now={now} testing={testing} onTest={async () => {
        setTesting(true);
        try {
          const result = await sendTestPush(server);
          useApp.getState().toast({ serverId: server.id, title: result.ok ? 'Test sent' : "Test didn't go through", body: describeTestPush(result) });
          load();
        } catch (e) {
          useApp.getState().toast({ serverId: server.id, title: "Couldn't send a test", body: (e as Error).message });
        }
        setTesting(false);
      }} /> : (
        <>
          <SectionHeader title="Notifications" />
          <ListGroup>
            <ListRow icon={<Bell size={18} color={t.colors.onAccentSoft} />} title="Notifications and quiet hours" onPress={() => router.push('/notifications')} />
          </ListGroup>
        </>
      )}

      {status && owner && status.listen ? (
        <>
          <SectionHeader title="On the server" />
          <ListGroup>
            <ListRow title="Listening on" value={status.listen} />
            <ListRow title="API keys from the web app" value={status.web_keys ? 'Allowed' : 'Off'}
              subtitle={status.web_keys ? undefined : 'Over automatic HTTPS, add keys from the Android app. WINGLET_ALLOW_WEB_SECRETS=true allows the web app.'} />
          </ListGroup>
          <Card style={{ gap: 10, marginTop: 12 }}>
            <View style={s.titleRow}>
              <SquareTerminal size={17} color={t.colors.textSecondary} />
              <Text style={s.cardTitle}>Change how phones connect</Text>
            </View>
            <Text style={s.body}>Switching changes the address every phone uses, so it's done on the server, where you can pair again if a phone can't follow.</Text>
            <Command label="Automatic HTTPS" text="hermes winglet setup --connection quick" onCopy={copy} />
            <Command label="Your own address" text="hermes winglet setup --connection direct --public-url https://…" onCopy={copy} />
          </Card>
        </>
      ) : null}

      <SectionHeader title="Details" />
      <Card style={{ paddingVertical: 6 }}>
        {rows.map(([k, v], i) => (
          <View key={k} style={[s.row, i > 0 && s.rowBorder]}>
            <Text style={s.key}>{k}</Text>
            <Text style={s.value} selectable>{v}</Text>
          </View>
        ))}
      </Card>
      <SectionHeader title="Recent events" />
      <Card style={{ paddingVertical: 6 }}>
        {(rt?.conn.history ?? []).slice().reverse().map((h, i) => (
          <View key={`${h.t}-${i}`} style={[s.row, i > 0 && s.rowBorder]}>
            <Text style={s.key}>{ago(now - h.t)}</Text>
            <Text style={s.value}>{h.status}{h.note ? ` · ${h.note}` : ''}</Text>
          </View>
        ))}
        {!rt?.conn.history.length ? <Text style={[s.value, { paddingVertical: 10 }]}>Nothing yet.</Text> : null}
      </Card>
      <Text style={s.note}>The report has no passwords, tokens, addresses or messages: only states, times and versions. Paste it when asking for help.</Text>
      <Button title={copied ? 'Copied' : 'Copy report'} icon={<Copy size={16} color={t.colors.onAccent} />} onPress={async () => {
        await Clipboard.setStringAsync(report());
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }} />

      <MoveSheet server={server} initial={moving} onClose={() => setMoving(null)} />
    </Screen>
  );
}

function recoveryLine(server: Server, status: ConnectionStatus | null, now: number): string {
  if (status?.mode === 'direct') return "Not needed: a direct address doesn't change on its own.";
  if (Platform.OS !== 'android') {
    return "The web app can't follow a new address by itself. When it changes, run hermes winglet pair on the server and open the new one.";
  }
  if (!server.recovery || status?.recovery?.enrolled === false) return 'Off for this phone. Pair it again to have it follow address changes.';
  const last = deliverySummary(status?.recovery?.last ?? null, now);
  return `On: this phone finds the server's new address by itself${last ? `. ${last.replace('Last one', 'Last update')}` : ''}.`;
}

function TunnelRow({ tunnel, now, checkedAt }: { tunnel: NonNullable<ConnectionStatus['tunnel']>; now: number; checkedAt: number | null }) {
  const t = useTheme();
  const s = useStyles();
  const line = tunnelSummary(tunnel, now, checkedAt);
  const color = { ok: t.colors.success, warn: t.colors.warning, info: t.colors.accent, unknown: t.colors.textTertiary }[line.tone];
  return (
    <ListRow icon={<Activity size={18} color={t.colors.onAccentSoft} />} title="Tunnel"
      subtitle={tunnel.error && checkedAt === null ? `${line.text}. ${tunnel.error}` : line.text}
      right={<View accessibilityLabel={line.text} style={[s.dot, { backgroundColor: color }]} />} />
  );
}

function Notifications({ server, status, now, testing, onTest }: {
  server: Server; status: ConnectionStatus; now: number; testing: boolean; onTest: () => void;
}) {
  const t = useTheme();
  const channel = status.push.ntfy ? `ntfy app (${status.push.ntfy_server})` : status.push.webpush ? 'Browser notifications' : null;
  const last = deliverySummary(status.push.last, now);
  return (
    <>
      <SectionHeader title="Notifications" />
      <ListGroup>
        <ListRow icon={channel ? <Bell size={18} color={t.colors.onAccentSoft} /> : <TriangleAlert size={18} color={t.colors.warning} />}
          iconColor={channel ? undefined : t.colors.warning} title={channel ? `On, through the ${channel}` : 'Not set up on this device'}
          subtitle={channel ? last ?? 'Nothing sent since the server started.' : `Get a nudge when ${server.bot.title} needs an approval or an answer.`}
          right={channel ? <Button size="sm" variant="tonal" title="Test" loading={testing} onPress={onTest} />
            : <Button size="sm" title="Set up" onPress={() => router.push('/notifications')} />} />
        <ListRow icon={<Moon size={18} color={t.colors.onAccentSoft} />} title="Quiet hours and muted chats" onPress={() => router.push('/notifications')} />
      </ListGroup>
    </>
  );
}

function Command({ label, text, onCopy }: { label: string; text: string; onCopy: (text: string) => void }) {
  const s = useStyles();
  return (
    <View style={{ gap: 6 }}>
      <Text style={s.key}>{label}</Text>
      <View style={s.command}>
        <Text selectable style={s.mono}>{text}</Text>
        <CopyButton label={`Copy: ${label}`} onPress={() => onCopy(text)} />
      </View>
    </View>
  );
}

function CopyButton({ label, onPress }: { label: string; onPress: () => void }) {
  const t = useTheme();
  return <Button size="sm" variant="secondary" title="" accessibilityLabel={label} icon={<Copy size={15} color={t.colors.text} />} onPress={onPress} />;
}

/** Point this phone at another address, after the address proves it's the same server. */
function MoveSheet({ server, initial, onClose }: { server: Server; initial: string | null; onClose: () => void }) {
  const t = useTheme();
  const s = useStyles();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  if (initial !== shown) {
    setShown(initial);
    if (initial !== null) { setText(initial); setError(''); }
  }
  const submit = async () => {
    const checked = checkAddress(text, server.url);
    if ('error' in checked) { setError(checked.error); return; }
    setBusy(true);
    setError('');
    try {
      const moved = await moveServer(server, checked.url);
      await useApp.getState().updateServer(server.id, { url: moved.url }, true);
      haptic.success();
      useApp.getState().toast({ serverId: server.id, title: 'Address changed', body: `This phone now reaches ${server.bot.title} at ${moved.url}.` });
      onClose();
    } catch (e) {
      haptic.error();
      setError((e as Error).message);
    }
    setBusy(false);
  };
  return (
    <Sheet visible={initial !== null} onClose={onClose} title="Change address">
      <View style={{ gap: 14, paddingHorizontal: 4 }}>
        <Text style={s.body}>
          Use an address {server.bot.title} lists as its own: its automatic HTTPS address, or the one set on the server with
          hermes winglet setup --public-url. Winglet checks the server signed it, with the key saved when you paired, before
          sending anything private there.
        </Text>
        <Field value={text} onChangeText={setText} placeholder="https://hermes.example.ts.net" autoCapitalize="none" autoCorrect={false}
          keyboardType="url" accessibilityLabel="New address" onSubmitEditing={submit} returnKeyType="go" />
        {error ? <Text style={[s.body, { color: t.colors.danger }]} accessibilityLiveRegion="polite">{error}</Text> : null}
        <Button title="Check and switch" loading={busy} onPress={submit} />
      </View>
    </Sheet>
  );
}

function ago(ms: number) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

const useStyles = makeStyles((t) => ({
  hero: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 14, padding: 16, borderRadius: t.radius.lg,
    backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border },
  heroTitle: { ...t.type.heading, color: t.colors.text },
  heroDetail: { ...t.type.caption, color: t.colors.textSecondary, marginTop: 2 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  offer: { gap: 10 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardTitle: { ...t.type.callout, fontFamily: t.fonts.semibold, color: t.colors.text },
  body: { ...t.type.callout, color: t.colors.textSecondary },
  command: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: t.radius.md, backgroundColor: t.colors.surfaceSunken },
  mono: { flex: 1, fontFamily: t.fonts.mono, fontSize: 13, color: t.colors.text },
  row: { flexDirection: 'row', gap: 12, paddingVertical: 10 },
  rowBorder: { borderTopWidth: 1, borderTopColor: t.colors.border },
  key: { ...t.type.callout, color: t.colors.textSecondary, width: 140 },
  value: { ...t.type.callout, color: t.colors.text, flex: 1 },
  note: { ...t.type.caption, fontFamily: t.fonts.regular, fontSize: 13, color: t.colors.textSecondary, marginVertical: 14, lineHeight: 18 },
}));
