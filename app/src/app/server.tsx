import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { JobSheet } from '../components/JobSheet';
import {
  CalendarClock, Check, CircleAlert, CircleArrowUp, CirclePause, CircleHelp, RefreshCw, RotateCw, ScrollText, ShieldCheck,
} from '../components/icons';
import { Screen } from '../components/Screen';
import { withSelectedServer } from '../components/ServerScreen';
import { Sheet } from '../components/Sheet';
import { Button, Card, ListGroup, ListRow, SectionHeader, Skeleton, Toggle } from '../components/ui';
import { VerifyNotice } from '../components/VerifyPhone';
import { agoText } from '../lib/agent';
import { api, ApiError, signedApi } from '../lib/api';
import { bytes, duration, idempotencyKey } from '../lib/control';
import { haptic } from '../lib/haptics';
import { useApp, useServerState } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { Job, PauseState, SystemInfo, UpdatesInfo } from '../lib/types';

type Confirm = 'restart' | 'hermes' | 'winglet';
const JOB_LABEL: Record<Job['kind'], string> = {
  restart: 'Restart', hermes_update: 'Hermes update', winglet_update: 'Winglet update',
  skill_install: 'Skill install', skill_uninstall: 'Skill removal', mcp_install: 'MCP server install',
  pet_install: 'Pet install',
};

/** The machine your agent runs on: how it's doing, and the few controls that keep it running. */
export default withSelectedServer(ServerScreen);

function ServerScreen() {
  const t = useTheme();
  const s = useStyles();
  const server = useApp((st) => st.servers.find((x) => x.id === st.selection.serverId) ?? st.servers[0]);
  const rt = useServerState(server?.id);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [updates, setUpdates] = useState<UpdatesInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [pausing, setPausing] = useState(false);

  const load = useCallback(() => {
    if (!server) return;
    api<SystemInfo>(server, '/api/system').then((d) => { setInfo(d); setError(''); }).catch((e) => setError((e as Error).message));
  }, [server]);
  const check = useCallback((force = false) => {
    if (!server) return;
    setChecking(true);
    api<UpdatesInfo>(server, `/api/system/updates${force ? '?force=1' : ''}`).then(setUpdates)
      .catch(() => undefined).finally(() => setChecking(false));
  }, [server]);

  // Health is live: refresh while the screen is open, and again when the server comes back.
  useFocusEffect(useCallback(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [load]));
  useEffect(() => { check(); }, [check]);
  const online = rt?.status === 'online';
  const wasOnline = useRef(online);
  useEffect(() => { if (online && !wasOnline.current) load(); wasOnline.current = online; }, [online, load]);

  if (!server) return null;
  const paused: PauseState = rt?.paused !== undefined ? rt.paused : info?.paused ?? null;

  const setPaused = async (on: boolean) => {
    setPausing(true);
    try {
      const r = await signedApi<{ paused: PauseState }>(server, 'POST', '/api/system/pause', { paused: on });
      useApp.setState((st) => ({ runtime: { ...st.runtime, [server.id]: { ...st.runtime[server.id], paused: r.paused } } }));
      haptic.success();
    } catch (e) {
      haptic.error();
      useApp.getState().toast({ serverId: server.id, title: on ? "Couldn't pause" : "Couldn't resume", body: (e as Error).message });
    } finally {
      setPausing(false);
    }
  };

  const start = async (what: Confirm) => {
    setConfirm(null);
    const path = what === 'restart' ? '/api/system/restart' : '/api/system/update';
    const body = { ...(what === 'restart' ? {} : { target: what }), idempotency_key: idempotencyKey() };
    const send = () => signedApi<{ job: Job }>(server, 'POST', path, body);
    try {
      // The same key on a retry returns the job the first try started, so a dropped reply is safe.
      const r = await send().catch((e) => (e instanceof ApiError && e.status === 0 ? send() : Promise.reject(e)));
      setJob(r.job);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.data?.job) { setJob(e.data.job as Job); return; }
      haptic.error();
      useApp.getState().toast({ serverId: server.id, title: "Couldn't start", body: (e as Error).message });
    }
  };

  const host = info?.host;
  return (
    <Screen title="Server" subtitle={`How the machine running ${server.bot.title} is doing, and the controls that keep it going.`}>
      {error && !info ? <Text style={s.error}>{error}</Text> : null}
      <VerifyNotice server={server} />
      <StatusCard info={info} paused={paused} online={online} />

      <SectionHeader title="Health" />
      {!host ? <Skeleton height={150} radius={20} /> : (
        <Card style={{ gap: 16 }}>
          {host.cpu_percent !== undefined ? (
            <Meter label="Processor" percent={host.cpu_percent} detail={host.cpu_count ? `${host.cpu_count} cores` : ''} />
          ) : null}
          {host.memory ? <Meter label="Memory" percent={host.memory.percent} detail={`${bytes(host.memory.used)} of ${bytes(host.memory.total)}`} /> : null}
          {host.disk ? <Meter label="Disk" percent={host.disk.percent} detail={`${bytes(host.disk.used)} of ${bytes(host.disk.total)}`} /> : null}
          {!host.memory && host.load_avg ? <Text style={s.note}>Load {host.load_avg.map((n) => n.toFixed(2)).join(' · ')}</Text> : null}
          <Text style={s.note}>
            {[host.system, host.arch].filter(Boolean).join(' · ')}{host.uptime_seconds ? ` · machine up ${duration(host.uptime_seconds)}` : ''}
          </Text>
        </Card>
      )}

      <SectionHeader title="Controls" />
      <ListGroup>
        {info?.can_pause !== false ? (
          <ListRow icon={<CirclePause size={18} color={paused ? t.colors.warning : t.colors.onAccentSoft} />}
            iconColor={paused ? t.colors.warning : undefined} title="Pause new work"
            subtitle="New chats, routines and background tasks wait. Anything already running finishes."
            right={<Toggle label="Pause new work" value={!!paused} onValueChange={(on) => !pausing && setPaused(on)} />} />
        ) : null}
        <ListRow icon={<RotateCw size={18} color={t.colors.onAccentSoft} />} title="Restart"
          subtitle="Reload Hermes and every platform. Back in about ten seconds." onPress={() => setConfirm('restart')} />
      </ListGroup>

      <SectionHeader title="Updates" right={(
        <Button size="sm" variant="ghost" title={checking ? 'Checking…' : 'Check now'} disabled={checking}
          icon={<RefreshCw size={14} color={t.colors.textSecondary} />} onPress={() => check(true)} />
      )} />
      <ListGroup>
        <UpdateRow name="Hermes" version={info?.hermes_version || updates?.hermes.current_version} {...hermesUpdate(updates)}
          onUpdate={() => setConfirm('hermes')} />
        <UpdateRow name="Winglet" version={info?.version ?? updates?.winglet.version} {...wingletUpdate(updates)}
          onUpdate={() => setConfirm('winglet')} />
      </ListGroup>

      <SectionHeader title="Tools" />
      <ListGroup>
        <ListRow icon={<CalendarClock size={18} color={t.colors.onAccentSoft} />} title="Schedule" subtitle="Routines your agent runs on its own"
          onPress={() => router.push('/schedule')} />
        <ListRow icon={<ScrollText size={18} color={t.colors.onAccentSoft} />} title="Logs" subtitle="What Hermes has been doing"
          onPress={() => router.push('/logs')} />
        <ListRow icon={<ShieldCheck size={18} color={t.colors.onAccentSoft} />} title="Activity" subtitle="Who changed what, from which phone"
          onPress={() => router.push('/activity')} />
      </ListGroup>

      {info?.jobs.length ? (
        <>
          <SectionHeader title="Recent" />
          <ListGroup>
            {info.jobs.map((j) => (
              <ListRow key={j.id} title={JOB_LABEL[j.kind]} subtitle={j.detail.message} value={agoText(j.created_at)}
                icon={j.state === 'succeeded' ? <Check size={18} color={t.colors.success} />
                  : j.state === 'failed' ? <CircleAlert size={18} color={t.colors.danger} />
                  : j.state === 'running' ? <RotateCw size={18} color={t.colors.onAccentSoft} /> : <CircleHelp size={18} color={t.colors.warning} />}
                iconColor={j.state === 'succeeded' ? t.colors.success : j.state === 'failed' ? t.colors.danger : undefined}
                onPress={() => setJob(j)} />
            ))}
          </ListGroup>
        </>
      ) : null}

      <ConfirmSheet what={confirm} bot={server.bot.title} onCancel={() => setConfirm(null)} onConfirm={start} />
      <JobSheet server={server} job={job} onClose={() => setJob(null)} onDone={() => { load(); check(); }} />
    </Screen>
  );
}

function hermesUpdate(u: UpdatesInfo | null): { status: string; available: boolean } {
  const h = u?.hermes;
  if (!h) return { status: 'Checking…', available: false };
  if (h.error) return { status: h.error, available: false };
  if (h.update_available) {
    const what = h.behind && h.behind > 0 ? `${h.behind} new change${h.behind === 1 ? '' : 's'}` : 'An update is ready';
    return h.can_apply ? { status: what, available: true }
      : { status: `${what}. Update with \`${h.update_command || 'hermes update'}\` on the server.`, available: false };
  }
  return { status: h.message || 'Up to date', available: false };
}

function wingletUpdate(u: UpdatesInfo | null): { status: string; available: boolean } {
  const w = u?.winglet;
  if (!w) return { status: 'Checking…', available: false };
  if (w.update_available) return { status: 'A new version is ready', available: true };
  if (w.update_available === false) return { status: 'Up to date', available: false };
  if (/provenance|not installed from git/i.test(w.reason ?? '')) return { status: 'Installed from a copy, so update it on the server.', available: false };
  return { status: w.reason || "Couldn't tell", available: false };
}

function StatusCard({ info, paused, online }: { info: SystemInfo | null; paused: PauseState; online: boolean }) {
  const t = useTheme();
  const s = useStyles();
  const pulse = useSharedValue(1);
  useEffect(() => { pulse.value = withRepeat(withTiming(2.4, { duration: 1600 }), -1, false); }, [pulse]);
  const ring = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }], opacity: (2.4 - pulse.value) / 2.8 }));
  const tone = !online ? t.colors.textTertiary : paused ? t.colors.warning : t.colors.success;
  const label = !online ? 'Offline' : paused ? 'Paused' : 'Running';
  if (!info) return <Skeleton height={112} radius={22} style={{ marginTop: 16 }} />;
  return (
    <Card style={s.status} accessibilityLabel={`${label}. Up ${duration(info.uptime_seconds)}.`}>
      <View style={s.statusTop}>
        <View style={s.dotWrap}>
          {online ? <Animated.View style={[s.dotRing, { backgroundColor: tone }, ring]} /> : null}
          <View style={[s.dot, { backgroundColor: tone }]} />
        </View>
        <Text style={s.statusLabel}>{label}</Text>
        <Text style={s.uptime}>up {duration(info.uptime_seconds)}</Text>
      </View>
      {paused ? (
        <Text style={s.pausedNote}>{paused.reason || 'New work is on hold.'}{paused.engaged_at ? ` · since ${new Date(paused.engaged_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}</Text>
      ) : null}
      <View style={s.versions}>
        <Version label="Hermes" value={info.hermes_version || '—'} />
        <Version label="Winglet" value={info.version} />
        <Version label="Phones" value={String(info.devices)} />
      </View>
    </Card>
  );
}

function Version({ label, value }: { label: string; value: string }) {
  const s = useStyles();
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text style={s.versionLabel}>{label}</Text>
      <Text style={s.versionValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

/** One measure, one bar: accent while healthy, the warning colour (and the word) past 90%. */
function Meter({ label, percent, detail }: { label: string; percent: number; detail: string }) {
  const t = useTheme();
  const s = useStyles();
  const high = percent >= 90;
  return (
    <View style={{ gap: 7 }} accessible accessibilityLabel={`${label}: ${Math.round(percent)}%${high ? ', nearly full' : ''}. ${detail}`}>
      <View style={s.meterHead}>
        <Text style={s.meterLabel}>{label}</Text>
        <Text style={s.meterValue}>{high ? 'Nearly full · ' : ''}{Math.round(percent)}%</Text>
      </View>
      <View style={s.track}>
        <View style={[s.fill, { width: `${Math.max(2, Math.min(100, percent))}%`, backgroundColor: high ? t.colors.warning : t.colors.accent }]} />
      </View>
      {detail ? <Text style={s.note}>{detail}</Text> : null}
    </View>
  );
}

function UpdateRow({ name, version, status, available, onUpdate }: {
  name: string; version?: string; status: string; available: boolean; onUpdate: () => void;
}) {
  const t = useTheme();
  return (
    <ListRow icon={<CircleArrowUp size={18} color={available ? t.colors.success : t.colors.onAccentSoft} />}
      iconColor={available ? t.colors.success : undefined} title={version ? `${name} ${version}` : name} subtitle={status}
      right={available ? <Button size="sm" title="Update" onPress={onUpdate} /> : undefined} />
  );
}

function ConfirmSheet({ what, bot, onCancel, onConfirm }: { what: Confirm | null; bot: string; onCancel: () => void; onConfirm: (w: Confirm) => void }) {
  const s = useStyles();
  const [last, setLast] = useState<Confirm | null>(what);
  if (what && what !== last) setLast(what);
  const w = what ?? last;
  if (!w) return null;
  const copy = {
    restart: { title: 'Restart now?', body: `${bot} stops and starts again. Every platform reconnects within a few seconds, and a reply that's being written is cut off.`, action: 'Restart' },
    hermes: { title: 'Update Hermes?', body: 'Hermes downloads the update, installs it and restarts. Chats pause for a minute or two. If something goes wrong, the log shows why.', action: 'Update and restart' },
    winglet: { title: 'Update Winglet?', body: 'The server downloads the new Winglet and restarts to load it. Chats pause for a few seconds. Update this app too if it asks.', action: 'Update and restart' },
  }[w];
  return (
    <Sheet visible={!!what} onClose={onCancel} title={copy.title}>
      <View style={{ gap: 14, paddingHorizontal: 4 }}>
        <Text style={s.confirmBody}>{copy.body}</Text>
        <Button title={copy.action} onPress={() => onConfirm(w)} />
        <Button title="Cancel" variant="ghost" onPress={onCancel} />
      </View>
    </Sheet>
  );
}

const useStyles = makeStyles((t) => ({
  error: { ...t.type.callout, color: t.colors.danger, marginTop: 10 },
  note: { ...t.type.caption, color: t.colors.textSecondary },
  status: { marginTop: 16, gap: 14, paddingVertical: 18 },
  statusTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  dotWrap: { width: 14, height: 14, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 12, height: 12, borderRadius: 6 },
  dotRing: { position: 'absolute', width: 12, height: 12, borderRadius: 6 },
  statusLabel: { ...t.type.title, fontSize: 24, color: t.colors.text, flex: 1 },
  uptime: { ...t.type.callout, color: t.colors.textSecondary },
  pausedNote: { ...t.type.callout, color: t.colors.warning },
  versions: { flexDirection: 'row', gap: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: t.colors.border },
  versionLabel: { ...t.type.caption, fontSize: 11.5, color: t.colors.textTertiary },
  versionValue: { ...t.type.callout, fontFamily: t.fonts.semibold, color: t.colors.text, marginTop: 2 },
  meterHead: { flexDirection: 'row', justifyContent: 'space-between' },
  meterLabel: { ...t.type.callout, fontFamily: t.fonts.semibold, color: t.colors.text },
  meterValue: { ...t.type.callout, color: t.colors.textSecondary, fontVariant: ['tabular-nums'] },
  track: { height: 8, borderRadius: 4, backgroundColor: t.colors.surfaceSunken, overflow: 'hidden' },
  fill: { height: 8, borderRadius: 4 },
  confirmBody: { ...t.type.body, color: t.colors.textSecondary },
}));
