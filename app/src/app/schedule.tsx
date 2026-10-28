import { ArchivedRoutineLinks } from '../features/routine-history/ArchivedRoutineLinks';
import { routineHref } from '../features/routine-history/model';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Text, View, StyleSheet } from 'react-native';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';
import { CalendarClock, CheckCircle2, ChevronRight, CircleAlert, CirclePause, Pause, Play, Plus } from '../components/icons';
import { Screen } from '../components/Screen';
import { withSelectedServer } from '../components/ServerScreen';
import { Sheet } from '../components/Sheet';
import { Button, Chip, ConfirmButton, Field, IconButton, ListGroup, ListRow, LoadError, SectionHeader, Skeleton, Tap } from '../components/ui';
import { agoText } from '../lib/agent';
import { api, signedApi } from '../lib/api';
import { firstLine, whenNext } from '../lib/control';
import { haptic } from '../lib/haptics';
import { spring, useReducedMotion } from '../lib/motion';
import { useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { Routine, Server } from '../lib/types';

const PRESETS = ['every day at 8am', 'weekdays at 9am', 'every friday 5pm', 'every 2h', 'in 1h'];
const IDEAS = [
  { name: 'Morning briefing', prompt: 'Give me a short briefing for today: my calendar, anything urgent, and the weather.', schedule: 'every day at 8am' },
  { name: 'Weekly review', prompt: 'Summarise what we worked on this week and list anything still open.', schedule: 'every friday 5pm' },
  { name: 'Break reminder', prompt: 'Remind me to stand up and take a short break.', schedule: 'in 1h' },
];
export type Draft = { id?: string; name: string; prompt: string; schedule: string };

const rise = (reduced: boolean, i: number) => (reduced ? undefined
  : FadeIn.duration(180));

/** Prompts your agent runs on its own schedule. Results arrive in the Updates chat. */
export default withSelectedServer(ScheduleScreen);

function ScheduleScreen() {
  const t = useTheme();
  const s = useStyles();
  const reduced = useReducedMotion();
  const server = useApp((st) => st.servers.find((x) => x.id === st.selection.serverId) ?? st.servers[0]);
  const history = useApp(st => !!server && st.runtime[server.id]?.info?.features?.routine_history === true);
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!server) return;
    return api<{ routines: Routine[] }>(server, '/api/schedule').then((d) => { setRoutines(d.routines); setError(''); })
      .catch((e) => setError((e as Error).message));
  }, [server]);
  useEffect(() => { load(); }, [load]);

  if (!server) return null;
  const act = async (r: Routine, action: 'pause' | 'resume' | 'run') => {
    setBusy(`${r.id}:${action}`);
    try {
      const { routine } = await signedApi<{ routine: Routine }>(server, 'POST', `/api/schedule/${r.id}/${action}`);
      setRoutines((list) => (list ?? []).map((x) => (x.id === r.id ? routine : x)));
      haptic.success();
      if (action === 'run') {
        useApp.getState().toast({ serverId: server.id, title: 'Run requested', body: `${r.name || 'The routine'} posts its result in Updates.`,
          href: `/chat/${server.id}/home` });
      }
    } catch (e) {
      haptic.error();
      useApp.getState().toast({ serverId: server.id, title: "Couldn't do that", body: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const active = (routines ?? []).filter((r) => r.state !== 'completed');
  const finished = (routines ?? []).filter((r) => r.state === 'completed');
  return (
    <Screen title="Schedule"
      right={<IconButton label="New routine" variant="filled" onPress={() => setDraft({ name: '', prompt: '', schedule: '' })}>
        <Plus size={22} color={t.colors.text} />
      </IconButton>} onRefresh={load}>
      {error && routines ? <Text style={s.error}>{error}</Text> : null}
      {!routines ? (error ? <LoadError message={error} onRetry={load} /> : (
        <View style={{ gap: 12, marginTop: 16 }}>{[0, 1].map((i) => <Skeleton key={i} height={132} radius={t.radius.lg} />)}</View>
      )) : !routines.length ? (
        <Empty onPick={(idea) => setDraft(idea ?? { name: '', prompt: '', schedule: '' })} />
      ) : (
        <>
          {([{ title: 'Routines', rows: active }, { title: 'Done', rows: finished }]).map((group) => group.rows.length ? (
            <View key={group.title}>
              <SectionHeader title={group.title} />
              {group.rows.map((r, i) => (
                <Animated.View key={r.id} entering={rise(reduced, i)} layout={reduced ? undefined : LinearTransition.duration(180)}>
                  <RoutineCard routine={r} busy={busy} onAction={(a) => act(r, a)} last={i === group.rows.length - 1}
                    onEdit={() => history ? router.push(routineHref(server.id, r.id) as any) : setDraft({ id: r.id, name: r.name ?? '', prompt: r.prompt, schedule: r.schedule_display ?? '' })} />
                </Animated.View>
              ))}
            </View>
          ) : null)}
          <Button title="Open Updates" style={{ marginTop: t.space.md }} variant="secondary" onPress={() => router.push(`/chat/${server.id}/home`)} />
        </>
      )}
      {history ? <ArchivedRoutineLinks server={server} revision={routines} /> : null}
      <EditSheet server={server} draft={draft} onClose={() => setDraft(null)} onSaved={() => { setDraft(null); load(); }} />
    </Screen>
  );
}

function Empty({ onPick }: { onPick: (d?: Draft) => void }) {
  const t = useTheme();
  const s = useStyles();
  const reduced = useReducedMotion();
  return (
    <View>
      <Animated.View entering={rise(reduced, 0)} style={s.emptyHero}>
        <CalendarClock size={32} color={t.colors.textTertiary} strokeWidth={1.6} />
        <Text style={s.emptyBody}>No routines yet</Text>
        <Button title="New routine" icon={<Plus size={16} color={t.colors.onInk} />} onPress={() => onPick()} />
      </Animated.View>
      <Animated.View entering={rise(reduced, 1)}>
        <SectionHeader title="Ideas" />
        <ListGroup>
          {IDEAS.map((idea) => <ListRow key={idea.name} title={idea.name} value={idea.schedule} onPress={() => onPick(idea)} />)}
        </ListGroup>
      </Animated.View>
    </View>
  );
}

/** One routine: when it runs next, what it is, how it last went, and its two everyday actions. */
function RoutineCard({ routine: r, busy, onAction, onEdit, last }: {
  routine: Routine; busy: string | null; last?: boolean; onAction: (a: 'pause' | 'resume' | 'run') => void; onEdit: () => void;
}) {
  const t = useTheme();
  const s = useStyles();
  const paused = r.state === 'paused' || !r.enabled;
  const done = r.state === 'completed';
  const failed = r.last_status && r.last_status !== 'ok';
  const next = !paused && !done ? whenNext(r.next_run_at) : '';
  const spin = (a: string) => busy === `${r.id}:${a}`;
  const status = failed ? `Last run failed: ${r.last_error || r.last_status}`
    : paused ? r.paused_reason || 'Paused' : done ? 'Completed'
    : r.last_run_at ? `Last ran ${agoText(Date.parse(r.last_run_at) / 1000)}` : undefined;
  const whenColor = failed ? t.colors.danger : paused ? t.colors.warning : t.colors.textSecondary;
  const when = next ? `Next ${next}` : paused ? 'Paused' : done ? 'Done' : undefined;
  return (
    <View style={[s.item, done && { opacity: 0.7 }]}>
      <View style={s.card}>
        <Tap feedback="selection" scaleTo={0.98} onPress={onEdit} accessibilityLabel={r.name || r.prompt} style={s.cardHead}>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            {when ? <Text style={[s.when, { color: whenColor }]}>{when}</Text> : null}
            <Text style={s.cardTitle} numberOfLines={2}>{r.name || r.prompt}</Text>
            {r.schedule_display ? <Text style={s.cardSub} numberOfLines={1}>{r.schedule_display}</Text> : null}
          </View>
          <ChevronRight size={18} color={t.colors.textTertiary} />
        </Tap>
        {status ? <Text style={[s.last, failed && { color: t.colors.danger }]}>{status}</Text> : null}
        {!done ? <View style={s.actions}>
        <Button size="sm" variant="secondary" title="Run now" loading={spin('run')} disabled={!!busy}
          icon={<Play size={14} color={t.colors.text} />} onPress={() => onAction('run')} />
        <Button size="sm" variant="secondary" title={paused ? 'Resume' : 'Pause'} loading={spin(paused ? 'resume' : 'pause')} disabled={!!busy}
          icon={paused ? <Play size={14} color={t.colors.text} /> : <Pause size={14} color={t.colors.text} />}
          onPress={() => onAction(paused ? 'resume' : 'pause')} />
        </View> : null}
      </View>
    </View>
  );
}

export function EditSheet({ server, draft, onClose, onSaved }: { server: Server; draft: Draft | null; onClose: () => void; onSaved: () => void }) {
  const t = useTheme();
  const s = useStyles();
  const [form, setForm] = useState<Draft>({ name: '', prompt: '', schedule: '' });
  const [last, setLast] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<{ display: string; next_run_at: string | null } | null>(null);
  const [parseError, setParseError] = useState('');
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (draft && draft !== last) { setLast(draft); setForm(draft); setError(''); setPreview(null); setParseError(''); }

  // Show when it will run while the schedule is typed, using Hermes's own parser.
  useEffect(() => {
    const text = form.schedule.trim();
    if (!draft || !text) { setPreview(null); setParseError(''); setChecking(false); return; }
    let active = true;
    setChecking(true);
    const id = setTimeout(() => {
      api<{ display: string; next_run_at: string | null }>(server, '/api/schedule/parse', { method: 'POST', body: JSON.stringify({ schedule: text }) })
        .then((p) => { if (active) { setPreview(p); setParseError(''); } })
        .catch((e) => { if (active) { setPreview(null); setParseError(firstLine((e as Error).message)); } })
        .finally(() => { if (active) setChecking(false); });
    }, 400);
    return () => { active = false; clearTimeout(id); };
  }, [form.schedule, draft, server]);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const body = { name: form.name.trim(), prompt: form.prompt.trim(), schedule: form.schedule.trim() };
      if (form.id) await signedApi(server, 'PATCH', `/api/schedule/${form.id}`, body);
      else await signedApi(server, 'POST', '/api/schedule', body);
      haptic.success();
      onSaved();
    } catch (e) {
      haptic.error();
      setError(firstLine((e as Error).message));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!form.id) return;
    setBusy(true);
    try {
      await signedApi(server, 'DELETE', `/api/schedule/${form.id}`);
      haptic.success();
      onSaved();
    } catch (e) {
      haptic.error();
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const f = draft ?? last;
  if (!f) return null;
  const ready = !!form.prompt.trim() && !!form.schedule.trim() && !!preview && !parseError && !checking;
  return (
    <Sheet visible={!!draft} onClose={onClose} title={form.id ? 'Edit routine' : 'New routine'} scrollable>
      <View style={{ gap: 14, paddingHorizontal: 4 }}>
        <Field label="Name" value={form.name} onChangeText={(name) => setForm((x) => ({ ...x, name }))} placeholder="Morning briefing" />
        <Field label="What should it do?" value={form.prompt} onChangeText={(prompt) => setForm((x) => ({ ...x, prompt }))} multiline
          style={{ minHeight: 96, textAlignVertical: 'top' }} placeholder="Check my calendar and tell me what's on today." />
        <Field label="When" value={form.schedule} onChangeText={(schedule) => setForm((x) => ({ ...x, schedule }))}
          placeholder="every day at 8am" autoCapitalize="none" autoCorrect={false} />
        <View style={s.presets}>
          {PRESETS.map((p) => <Chip key={p} label={p} selected={form.schedule.trim() === p} onPress={() => setForm((x) => ({ ...x, schedule: p }))} />)}
        </View>
        <View style={s.preview} accessibilityLiveRegion="polite">
          {checking ? <ActivityIndicator size="small" color={t.colors.textTertiary} />
            : parseError ? <CircleAlert size={16} color={t.colors.danger} /> : <CalendarClock size={16} color={t.colors.textSecondary} />}
          <Text style={[s.previewText, parseError ? { color: t.colors.danger } : null]}>
            {parseError || (preview ? `Runs ${preview.display}${preview.next_run_at ? ` · first ${whenNext(preview.next_run_at)}` : ''}` : 'Try "weekdays at 9am", "every 2h" or "in 30m".')}
          </Text>
        </View>
        <Button title={form.id ? 'Save' : 'Schedule it'} loading={busy} disabled={!ready || busy} onPress={save} />
        {form.id ? <ConfirmButton title="Delete routine" loading={busy} onConfirm={remove} /> : null}
        {error ? <Text style={[s.previewText, { color: t.colors.danger, textAlign: 'center' }]}>{error}</Text> : null}
      </View>
    </Sheet>
  );
}

const useStyles = makeStyles((t) => ({
  error: { ...t.type.callout, color: t.colors.danger, marginTop: 10 },
  item: { marginBottom: t.space.md },
  card: {
    flex: 1, minWidth: 0, backgroundColor: t.colors.surface, borderRadius: t.radius.lg, borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: t.colors.border, overflow: 'hidden',
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: t.space.md, padding: t.space.lg, minHeight: 56 },
  when: { ...t.type.footnote, fontFamily: t.fonts.medium },
  cardTitle: { ...t.type.heading, color: t.colors.text },
  cardSub: { ...t.type.footnote, color: t.colors.textSecondary },
  last: { ...t.type.footnote, color: t.colors.textTertiary, paddingHorizontal: t.space.lg, marginTop: -t.space.sm, paddingBottom: t.space.md },
  actions: { flexDirection: 'row', gap: t.space.sm, paddingHorizontal: t.space.lg, paddingBottom: t.space.lg },
  emptyHero: { alignItems: 'center', gap: t.space.md, marginTop: t.space.xl, paddingVertical: t.space.lg },
  emptyBody: { ...t.type.heading, color: t.colors.text },
  presets: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  preview: {
    flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderRadius: t.radius.md, backgroundColor: t.colors.surfaceSunken,
  },
  previewText: { ...t.type.caption, color: t.colors.textSecondary, flex: 1 },
}));
