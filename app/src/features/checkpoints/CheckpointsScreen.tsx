import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { ChevronRight, FileDiff, RefreshCw, ShieldCheck, TriangleAlert } from '../../components/icons';
import { Screen } from '../../components/Screen';
import { withSelectedServer } from '../../components/ServerScreen';
import { Card, Footnote, IconButton, ListGroup, ListRow, LoadError, SectionHeader, Skeleton, Tap } from '../../components/ui';
import { haptic } from '../../lib/haptics';
import { isOwner, useApp, useServerState } from '../../lib/store';
import { makeStyles, useTheme } from '../../lib/themeContext';
import { listCheckpoints } from './api';
import { CheckpointSheet } from './CheckpointSheet';
import { clockTime, countsLabel, dayLabel } from './format';
import type { CheckpointList, CheckpointSummary } from './types';

/** Hermes's snapshots of the folder this bot works in: files only, never the chat. */
export default withSelectedServer(CheckpointsScreen);

function CheckpointsScreen() {
  const t = useTheme();
  const s = useStyles();
  const server = useApp((st) => st.servers.find((x) => x.id === st.selection.serverId) ?? st.servers[0]);
  const rt = useServerState(server?.id);
  const online = rt?.status === 'online';
  const owner = isOwner(rt);
  const supported = !!rt?.info?.features?.checkpoints;
  const [data, setData] = useState<CheckpointList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<CheckpointSummary | null>(null);
  const seq = useRef(0);

  const load = useCallback(async (): Promise<CheckpointList | null> => {
    if (!server) return null;
    const mine = ++seq.current;
    setLoading(true);
    try {
      const next = await listCheckpoints(server);
      if (mine === seq.current) {
        setData(next);
        setError('');
      }
      return next;
    } catch (e) {
      if (mine === seq.current) setError((e as Error).message);
      return null;
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [server]);

  // The result's "Undo this restore" opens the safety snapshot Hermes just took.
  const openCheckpoint = useCallback(async (hash: string) => {
    const list = await load();
    const target = list?.checkpoints.find((row) => row.hash === hash || row.hash.startsWith(hash));
    if (target) setOpen(target);
    else setOpen(null);
  }, [load]);

  // Coming back from a restore (or another screen) shows the new safety snapshot.
  useFocusEffect(useCallback(() => {
    if (!server) return;
    if (!rt?.info) return; // wait for this bot's capabilities
    if (!rt.info.features?.checkpoints) {
      setLoading(false);
      return;
    }
    if (rt.status === 'online' || data === null) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server?.id, rt?.status, rt?.info, load]));

  const reload = () => {
    haptic.soft();
    load();
  };

  const body = () => {
    if (!owner) return <Notice icon="shield" title="Owners only" body="Only owners can inspect and restore server files." />;
    if (!rt?.info) {
      return online ? <TimelineSkeleton />
        : <Notice icon="alert" title="Offline" body="Connect to your server to see the folder it snapshots." />;
    }
    if (!supported) {
      return <Notice icon="alert" title="Not available on this server"
        body="Update this server to enable workspace checkpoints." />;
    }
    if (loading && !data) return <TimelineSkeleton />;
    if (error && !data) return <LoadError message={error} onRetry={reload} />;
    if (!data) return <Notice icon="alert" title="Couldn't read the checkpoints"
      body={online ? 'Try again in a moment.' : 'Connect to your server and pull to refresh.'} />;
    if (!data.supported) {
      return <Notice icon="alert" title="Checkpoints aren't available here"
        body={data.reason || 'This version of Hermes has no checkpoint manager. Update Hermes on the server.'} />;
    }
    if (!data.enabled) {
      return <Notice icon="alert" title="Checkpoints are off" testID="checkpoints-off"
        body={data.reason || "Turn them on in the server's config.yaml (checkpoints: enabled: true), then restart Hermes."} />;
    }
    if (!data.checkpoints.length) {
      return <Notice icon="clock" title="No snapshots yet"
        body="Snapshots appear before Hermes changes a file." />;
    }
    const days: { label: string; rows: CheckpointSummary[] }[] = [];
    for (const row of data.checkpoints) {
      const label = dayLabel(row.at);
      if (!days.length || days[days.length - 1].label !== label) days.push({ label, rows: [] });
      days[days.length - 1].rows.push(row);
    }
    return (
      <>
        {error ? <Text style={s.inlineError}>{error}</Text> : null}
        {data.busy.length ? (
          <View style={s.busyNote} accessibilityLiveRegion="polite">
            <ActivityIndicator size="small" color={t.colors.warning} />
            <Text style={s.busyText}>A reply is running in {data.busy[0]}. Restoring waits until it finishes.</Text>
          </View>
        ) : null}
        {days.map((group) => (
          <View key={group.label}>
            <SectionHeader title={group.label} />
            <View style={s.timeline}>
              {group.rows.map((row, index) => (
                <TimelineRow key={row.hash} checkpoint={row} first={group === days[0] && index === 0}
                  last={group === days[days.length - 1] && index === group.rows.length - 1}
                  onPress={() => { haptic.selection(); setOpen(row); }} />
              ))}
            </View>
          </View>
        ))}
      </>
    );
  };

  return (
    <Screen title="Checkpoints" subtitle={data?.workspace?.path || undefined}
      onRefresh={load} right={<IconButton label="Refresh checkpoints" variant="filled" onPress={reload}>
        {loading && data ? <ActivityIndicator size="small" color={t.colors.text} /> : <RefreshCw size={19} color={t.colors.text} />}
      </IconButton>}>
      <View style={s.body}>
        {data?.supported && data.enabled && data.checkpoints.length ? (
          <ListGroup><ListRow icon={<FileDiff />} title="Snapshots" value={String(data.checkpoints.length)} /></ListGroup>
        ) : null}
        {body()}
        {data?.supported && data.enabled && data.can_restore && data.checkpoints.length ? (
          <Footnote>Restoring changes files only. Chats, memory and skills stay unchanged; a safety snapshot lets you undo.</Footnote>
        ) : null}
      </View>
      <CheckpointSheet server={server} checkpoint={open} visible={!!open} online={online}
        busy={data?.busy ?? []} onClose={() => setOpen(null)} onChanged={load}
        onOpenCheckpoint={openCheckpoint} />
    </Screen>
  );
}

/** One snapshot in the timeline: when, what was about to happen, and what changed. */
function TimelineRow({ checkpoint, first, last, onPress }: {
  checkpoint: CheckpointSummary; first: boolean; last: boolean; onPress: () => void;
}) {
  const t = useTheme();
  const s = useStyles();
  const counts = countsLabel(checkpoint);
  const meta = [clockTime(checkpoint.at), counts, checkpoint.short].filter(Boolean).join(', ');
  return (
    <Tap feedback="selection" scaleTo={0.99} onPress={onPress} accessibilityRole="button"
      accessibilityLabel={`${checkpoint.label}, ${meta}${checkpoint.safety ? ', safety snapshot' : ''}`}
      accessibilityHint="Opens the changed files and the restore option"
      style={({ pressed, hovered }) => [s.row, (pressed || hovered) && { backgroundColor: t.colors.pressed }]}>
      <View style={s.rail}>
        <View style={[s.dot, first ? { backgroundColor: t.colors.accent, borderColor: t.colors.accent } : null]} />
        {last ? null : <View style={s.line} />}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={s.titleRow}>
          <Text style={s.label} numberOfLines={2}>{checkpoint.label}</Text>
          {checkpoint.safety ? <View style={s.safetyChip}><ShieldCheck size={11} color={t.colors.textSecondary} /><Text style={s.safetyText}>Safety</Text></View> : null}
        </View>
        <Text style={s.meta} numberOfLines={2}>{counts || checkpoint.short}</Text>
      </View>
      <Text style={s.time}>{clockTime(checkpoint.at)}</Text><ChevronRight size={18} color={t.colors.textTertiary} />
    </Tap>
  );
}

function TimelineSkeleton() {
  const s = useStyles();
  return (
    <View style={{ gap: 10, marginTop: 18 }}>
      {[0, 1, 2, 3].map((i) => <Skeleton key={i} height={64} radius={16} />)}
      <Text style={s.loading}>Reading this folder's snapshots…</Text>
    </View>
  );
}

/** One honest card for "can't", "off" or "nothing yet" — never a blank screen. */
function Notice({ icon, title, body, testID }: { icon: 'alert' | 'shield' | 'clock'; title: string; body: string; testID?: string }) {
  const t = useTheme();
  const s = useStyles();
  const glyph = icon === 'shield' ? <ShieldCheck size={20} color={t.colors.textSecondary} />
    : icon === 'clock' ? <FileDiff size={20} color={t.colors.textSecondary} />
      : <TriangleAlert size={20} color={t.colors.warning} />;
  return (
    <Card style={s.notice} accessibilityLabel={`${title}. ${body}`}>
      <View testID={testID} style={{ flex: 1, gap: 10 }}>
        <View style={s.noticeIcon}>{glyph}</View>
        <Text style={s.noticeTitle} accessibilityRole="header">{title}</Text>
        <Text style={s.noticeBody}>{body}</Text>
      </View>
    </Card>
  );
}

const useStyles = makeStyles((t) => ({
  body: { marginTop: 16, gap: 4 },
  scopeRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: t.radius.lg,
    backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border, marginBottom: 6,
  },
  scopeTile: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.surfaceSunken },
  scopeLabel: { ...t.type.label, color: t.colors.textSecondary },
  scopePath: { ...t.type.caption, fontFamily: t.fonts.mono, color: t.colors.text, marginTop: 3 },
  scopeCount: { ...t.type.caption, color: t.colors.textTertiary },
  dayLabel: { ...t.type.label, color: t.colors.textSecondary, paddingHorizontal: 4, marginTop: 18, marginBottom: 8 },
  timeline: { backgroundColor: t.colors.surface, borderRadius: t.radius.lg, borderWidth: 1, borderColor: t.colors.border, overflow: 'hidden', paddingVertical: 4 },
  row: { flexDirection: 'row', alignItems: 'stretch', gap: 12, paddingLeft: 14, paddingRight: 12, paddingVertical: 13, minHeight: 66 },
  rail: { width: 10, alignItems: 'center' },
  dot: { width: 10, height: 10, borderRadius: 5, marginTop: 5, borderWidth: 2, borderColor: t.colors.borderStrong, backgroundColor: t.colors.surface },
  line: { flex: 1, width: 1.5, marginTop: 4, marginBottom: -18, backgroundColor: t.colors.border },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { ...t.type.bodyStrong, color: t.colors.text, flexShrink: 1 },
  safetyChip: {
    flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 7, paddingVertical: 2, borderRadius: t.radius.pill,
    backgroundColor: t.colors.surfaceSunken,
  },
  safetyText: { ...t.type.caption, color: t.colors.textSecondary },
  meta: { ...t.type.footnote, color: t.colors.textSecondary, marginTop: t.space.xs },
  time: { ...t.type.caption, color: t.colors.textSecondary, alignSelf: 'center' },
  busyNote: {
    flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, marginTop: 10, borderRadius: t.radius.md,
    backgroundColor: t.colors.warningSoft,
  },
  busyText: { ...t.type.callout, color: t.colors.text, flex: 1 },
  inlineError: { ...t.type.callout, color: t.colors.danger, marginTop: 12 },
  loading: { ...t.type.caption, color: t.colors.textTertiary, textAlign: 'center', marginTop: 4 },
  footnote: { ...t.type.caption, fontFamily: t.fonts.regular, color: t.colors.textTertiary, lineHeight: 18, marginTop: 16, paddingHorizontal: 4 },
  notice: { alignItems: 'center', marginTop: 14 },
  noticeIcon: { alignItems: 'flex-start' },
  noticeTitle: { ...t.type.heading, color: t.colors.text, marginTop: 2 },
  noticeBody: { ...t.type.callout, color: t.colors.textSecondary, lineHeight: 21 },
}));
