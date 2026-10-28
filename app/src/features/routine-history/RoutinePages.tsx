import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { EditSheet, type Draft } from '../../app/schedule';
import { Markdown } from '../../components/Markdown';
import { Screen } from '../../components/Screen';
import { Button, Card, ListGroup, ListRow, LoadError, SectionHeader, Skeleton, Tap } from '../../components/ui';
import { api, signedApi } from '../../lib/api';
import { isOwner, useApp, useServerState } from '../../lib/store';
import { makeStyles, useTheme } from '../../lib/themeContext';
import { dateText, duration, MAX_VISIBLE_RUNS, mergeRuns, routineHref, statusLabel, triggerLabel,
  type HistoryPage, type RoutineRun } from './model';

function useRoute() {
  const { serverId, routineId, runId } = useLocalSearchParams<{ serverId: string; routineId: string; runId?: string }>();
  const server = useApp(st => st.servers.find(s => s.id === serverId));
  const rt = useServerState(serverId);
  return { serverId, routineId, runId, server, rt, owner: isOwner(rt), online: rt?.status === 'online',
    supported: rt?.info?.features?.routine_history === true };
}

/** Uses only explicit route scope: switching selected bots cannot redirect an in-flight response. */
export function RoutinePage() {
  const { serverId, routineId } = useLocalSearchParams<{ serverId: string; routineId: string }>();
  return <RoutineHistoryBody key={`${serverId}:${routineId}`} />;
}
function RoutineHistoryBody() {
  const { serverId, routineId, server, rt, owner, online, supported } = useRoute();
  const s = useStyles();
  const [data, setData] = useState<HistoryPage | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const active = useRef(0);
  const pending = useRef(false);
  const pageRef = useRef<HistoryPage | null>(null);
  const onlineRef = useRef(online); onlineRef.current = online;
  const load = useCallback(async (older = false, refresh = false) => {
    if (!server || !supported || !owner || pending.current) return;
    const generation = active.current;
    const before = pageRef.current;
    if (older && (!before?.next_cursor || before.runs.length >= MAX_VISIBLE_RUNS)) return;
    pending.current = true; setLoading(true);
    try {
      const page = await api<HistoryPage>(server, `/api/routine-history/${encodeURIComponent(routineId)}?limit=30${older ? `&cursor=${encodeURIComponent(before!.next_cursor!)}` : ''}`);
      if (generation !== active.current) return;
      const keep = (older || refresh) && before;
      const next = { ...page, runs: keep ? mergeRuns(before.runs, page.runs) : page.runs,
        next_cursor: older ? page.next_cursor : keep && before.runs.length > 30 ? before.next_cursor : page.next_cursor };
      pageRef.current = next; setData(next); setError('');
    } catch (e) { if (generation === active.current) setError((e as Error).message); }
    finally { if (generation === active.current) { pending.current = false; setLoading(false); } }
  }, [server, routineId, owner, supported]);
  useFocusEffect(useCallback(() => {
    active.current++; pending.current = false;
    if (!owner) { pageRef.current = null; setData(null); }
    if (onlineRef.current) void load(false, true);
    const timer = setInterval(() => { if (onlineRef.current) void load(false, true); }, 10000);
    return () => { active.current++; pending.current = false; clearInterval(timer); };
  }, [load, owner]));
  useEffect(() => { if (online) void load(false, true); }, [online, load]);
  const acting = useRef(false);
  const act = async (action: 'run' | 'pause' | 'resume') => {
    if (!server || !online || !owner || data?.archived || acting.current) return;
    acting.current = true; setBusy(action);
    try {
      await signedApi(server, 'POST', `/api/schedule/${encodeURIComponent(routineId)}/${action}`);
      useApp.getState().toast({ serverId, title: action === 'run' ? 'Run requested' : action === 'pause' ? 'Routine paused' : 'Routine resumed',
        body: action === 'run' ? 'The scheduler will start the current definition. Its actual outcome appears here.' : 'The scheduler confirmed the change.' });
      await load(false, true);
    } catch (e) { setError((e as Error).message); }
    finally { acting.current = false; setBusy(null); }
  };
  if (!server) return <Screen title="Routine"><Text style={s.note}>This bot is no longer paired.</Text></Screen>;
  if (!owner) return <Screen title="Routine history"><Text style={s.note}>Only an owner can read this bot’s scheduled runs.</Text></Screen>;
  if (!supported && rt?.info) return <Screen title="Routine history"><Text style={s.note}>Update Winglet on the server to view run history. Routine controls remain in Schedule.</Text></Screen>;
  const routine = data?.routine;
  const paused = routine?.state === 'paused' || routine?.enabled === false;
  return <Screen title={routine?.name || 'Routine'}
    onRefresh={() => load(false, true)}>
    {!online ? <Text style={s.note}>Offline. Loaded results remain readable.</Text> : null}
    {data?.stale ? <Text style={s.notice}>The scheduler store is unavailable. Showing previously observed evidence.</Text> : null}
    {error ? <LoadError message={error} onRetry={() => load(false, true)} /> : null}
    {!data && !error ? <View style={s.stack}>{[100, 74, 74].map((h,i) => <Skeleton key={h+'-'+i} height={h} radius={16} />)}</View> : null}
    {data && routine ? <>
      <Card style={[s.stack, { marginTop: 16 }]}>
        <Text style={s.eyebrow}>{data.archived ? 'Archived' : paused ? 'Paused' : routine.state === 'completed' ? 'Finished' : 'Scheduled'}</Text>
        <Text style={s.schedule}>{routine.schedule_display || 'Schedule unavailable'}</Text>
        <Text style={s.note}>{routine.timezone || 'Time zone unavailable'}</Text>
        {!data.archived && routine.next_run_at && !paused ? <Text style={s.note}>Next: {dateText(routine.next_run_at, routine.timezone)}</Text> : null}
        {routine.manual_run_at ? <Text style={s.notice}>Run requested. Waiting for the scheduler.</Text> : null}
        {routine.prompt ? <Text style={s.prompt} selectable>{routine.prompt}</Text> : <Text style={s.note}>The original prompt is unavailable.</Text>}
        {!data.archived ? <>
          <View style={s.actions}>
            {routine.state !== 'completed' ? <Button size="sm" style={s.control} title={data.runs.length ? 'Run again' : 'Run now'} disabled={!online || !!busy}
              loading={busy === 'run'} onPress={() => act('run')} /> : null}
            {routine.state !== 'completed' ? <Button size="sm" style={s.control} variant="secondary" title={paused ? 'Resume' : 'Pause'} disabled={!online || !!busy}
              loading={busy === 'pause' || busy === 'resume'} onPress={() => act(paused ? 'resume' : 'pause')} /> : null}
            {routine.prompt ? <Button size="sm" style={s.control} variant="ghost" title="Edit routine" disabled={!online || !!busy} onPress={() => setDraft({ id: routineId,
              name: routine.name || '', prompt: routine.prompt || '', schedule: routine.schedule_display || '' })} /> : null}
          </View>
          <Text style={s.caption}>Run again uses the current definition, not a historical execution.</Text>
        </> : <Text style={s.notice}>This routine was removed. Retained runs and captured output remain read-only.</Text>}
      </Card>
      <SectionHeader title="Runs" />
      {!data.runs.length ? <View style={s.empty}><Text style={s.rowTitle}>No recorded runs yet</Text><Text style={s.note}>Runs appear after the scheduler starts them.</Text></View>
        : <ListGroup>{data.runs.map(run => <RunRow key={run.id} run={run} onPress={() => router.push(routineHref(serverId, routineId, run.id) as any)} />)}</ListGroup>}
      {data.next_cursor && data.runs.length < MAX_VISIBLE_RUNS ? <Button title="Load older runs" variant="secondary" loading={loading}
        disabled={loading || !online} onPress={() => load(true)} style={{ marginTop: 16 }} /> : null}
      <Text style={[s.caption, { marginTop: 14 }]}>{data.runs.length >= MAX_VISIBLE_RUNS ? 'Showing 200 runs. Only the newest 200 loaded records are displayed. ' : ''}{data.history_notice}</Text>
    </> : null}
    <EditSheet server={server} draft={draft} onClose={() => setDraft(null)} onSaved={() => { setDraft(null); void load(false, true); }} />
  </Screen>;
}

function RunRow({ run, onPress }: { run: RoutineRun; onPress: () => void }) {
  const s = useStyles();
  return <Tap accessibilityLabel={`${statusLabel(run.status)}, ${triggerLabel(run.trigger)}, ${dateText(run.claimed_at, run.timezone)}. Open run`}
    onPress={onPress} style={s.row}>
    <View style={s.rowHead}><Outcome status={run.status} /><Text style={s.caption}>{triggerLabel(run.trigger)}</Text></View>
    <Text style={s.rowTitle}>{dateText(run.started_at ?? run.claimed_at, run.timezone)}</Text>
    <Text style={s.caption}>{duration(run.duration_seconds)}{run.session_id ? ', session available' : run.has_output ? ', output available' : ''}</Text>
    {run.summary ? <Text style={s.note} numberOfLines={2}>{run.summary}</Text> : null}
  </Tap>;
}

function Outcome({ status }: { status: string }) {
  const t = useTheme(); const s = useStyles();
  const color = status === 'completed' ? t.colors.success : status === 'failed' ? t.colors.danger
    : status === 'running' || status === 'pending' ? t.colors.accent : t.colors.warning;
  return <Text style={[s.outcome, { color }]}>{statusLabel(status)}</Text>;
}

export function RunPage() {
  const { serverId, routineId, runId } = useLocalSearchParams<{ serverId: string; routineId: string; runId: string }>();
  return <RecordedRun key={`${serverId}:${routineId}:${runId}`} />;
}
function RecordedRun() {
  const { serverId, routineId, runId, server, rt, owner, supported, online } = useRoute();
  const s = useStyles();
  const [run, setRun] = useState<RoutineRun | null>(null);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true, pending = false, terminal = false;
    const load = async () => {
      if (!server || !owner || !supported || !runId || pending) return;
      pending = true;
      try {
        const d = await api<{ run: RoutineRun; stale?: boolean }>(server,
          `/api/routine-history/${encodeURIComponent(routineId)}/run/${encodeURIComponent(runId)}`);
        if (active) { setRun(d.run); setStale(!!d.stale); setError(''); terminal = !['running','pending'].includes(d.run.status); }
      } catch (e) { if (active) setError((e as Error).message); }
      finally { pending = false; }
    };
    void load();
    const timer = setInterval(() => { if (online && !terminal) void load(); }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [server, routineId, runId, owner, supported, online, refresh]);
  return <Screen title={run?.title || 'Run'} onRefresh={() => setRefresh(x => x + 1)}>
    {!server ? <Text style={s.note}>This bot is no longer paired.</Text> : !owner ? <Text style={s.note}>Only an owner can read scheduled-run output.</Text>
      : !supported && rt?.info ? <Text style={s.note}>Update Winglet on this server to view run details.</Text>
      : error && !run ? <LoadError message={error} onRetry={() => setRefresh(x => x + 1)} />
      : !run ? <View style={s.stack}>{[80, 140].map(h => <Skeleton key={h} height={h} radius={16} />)}</View> : <>
        <View style={[s.stack, { marginTop: 18 }]}>
          {error ? <Text style={s.notice}>{error}</Text> : null}
          <ListGroup><ListRow title="Recorded run" value="Read-only"/><ListRow title="Outcome" right={<Outcome status={run.status} />}/><ListRow title="Trigger" value={triggerLabel(run.trigger)}/><ListRow title="Duration" value={duration(run.duration_seconds)}/></ListGroup>
          {run.error ? <Text style={s.notice} selectable>{run.error}</Text> : null}
          {stale || !online ? <Text style={s.notice}>Showing remembered evidence; reconnect to refresh the scheduler record.</Text> : null}
          {run.archived ? <Text style={s.notice}>The routine was removed. This retained record remains available.</Text> : run.definition_changed ? <Text style={s.notice}>The current definition differs from the one first observed with this run.</Text> : null}
          {!run.recorded ? <Text style={s.note}>Scheduler record unavailable; outcome and trigger are unknown.</Text> : null}
          <ListGroup>{(['scheduled_at', 'claimed_at', 'started_at', 'finished_at'] as const).map((key,i) => <ListRow key={key}
            title={['Scheduled for', 'Claimed', 'Started', 'Finished'][i]} value={dateText(run[key], run.timezone)}/>)}</ListGroup>
          <Text style={s.caption}>Times shown in {run.timezone || 'the server’s configured zone'}.</Text>
        </View>
        <SectionHeader title="Output" />
        {run.output ? <>
          <View style={s.output}><Markdown text={expanded ? run.output : run.output.slice(0, 6000)} /></View>
          {run.output.length > 6000 && !expanded ? <Button title="Show full retained output" variant="ghost" onPress={() => setExpanded(true)} /> : null}
          {run.output_truncated ? <Text style={s.caption}>Output is capped at 64 KiB. The retained excerpt may be incomplete.</Text> : null}
        </> : <Text style={s.note}>No retained output could be matched to this run.</Text>}
        <SectionHeader title={run.definition_provenance === 'run_output' ? 'Definition from run output' : 'Observed definition'} />
        {run.definition?.prompt ? <Text style={s.prompt} selectable>{run.definition.prompt}</Text> : <Text style={s.note}>The original dispatch definition is unavailable.</Text>}
        {run.definition_provenance !== 'run_output' ? <Text style={s.caption}>This definition was first observed with the record; it is not proof of the exact dispatch prompt.</Text> : null}
        <View style={[s.actions, { marginTop: 20 }]}>
          {run.session_id ? <Button title="Open session" variant="secondary" onPress={() => router.push(`/session/${encodeURIComponent(run.session_id!)}?server=${encodeURIComponent(serverId)}` as any)} /> : null}
          <Button title={run.archived ? 'Routine history' : 'Current routine'} variant="ghost" onPress={() => router.push(routineHref(serverId, routineId) as any)} />
        </View>
        {!run.session_id ? <Text style={s.caption}>No actual Hermes session was matched. Script-only runs do not create a session.</Text> : null}
      </>}
  </Screen>;
}


const useStyles = makeStyles(t => ({
  control: { minHeight: 44 }, stack: { gap: 12 }, rows: { borderTopWidth: 1, borderColor: t.colors.border },
  row: { paddingVertical: t.space.md, paddingHorizontal: t.space.lg, minHeight: 76, gap: t.space.xs },
  rowHead: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  eyebrow: { ...t.type.label, color: t.colors.textSecondary },
  schedule: { ...t.type.heading, color: t.colors.text }, rowTitle: { ...t.type.bodyStrong, color: t.colors.text },
  prompt: { ...t.type.body, color: t.colors.text }, note: { ...t.type.callout, color: t.colors.textSecondary },
  caption: { ...t.type.caption, color: t.colors.textTertiary }, outcome: { ...t.type.label },
  notice: { ...t.type.callout, color: t.colors.warning }, empty: { paddingVertical: 22, gap: 8 },
  timeRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8 },
  timeValue: { ...t.type.callout, color: t.colors.text, flexShrink: 1 }, output: { paddingVertical: 8 },
}));
