import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';
import { CalendarClock, CalendarPlus, CircleAlert, CirclePause, Pause, Play, Plus } from '../components/icons';
import { Screen } from '../components/Screen';
import { Sheet } from '../components/Sheet';
import { Button, Card, Chip, ConfirmButton, Field, IconButton, LoadError, Skeleton, Tap } from '../components/ui';
import { agoText } from '../lib/agent';
import { api, ApiError, signedApi } from '../lib/api';
import { firstLine, whenNext } from '../lib/control';
import { haptic } from '../lib/haptics';
import { useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { Routine, Server } from '../lib/types';

const PRESETS = ['every day at 8am', 'weekdays at 9am', 'every friday 5pm', 'every 2h', 'in 1h'];
const IDEAS = [
  { name: 'Morning briefing', prompt: 'Give me a short briefing for today: my calendar, anything urgent, and the weather.', schedule: 'every day at 8am' },
  { name: 'Weekly review', prompt: 'Summarise what we worked on this week and list anything still open.', schedule: 'every friday 5pm' },
  { name: 'Break reminder', prompt: 'Remind me to stand up and take a short break.', schedule: 'in 1h' },
];
type Draft = { id?: string; name: string; prompt: string; schedule: string };

/** Prompts your agent runs on its own schedule. Results arrive in the Updates chat. */
export default function ScheduleScreen() {
  const t = useTheme();
  const s = useStyles();
  const server = useApp((st) => st.servers.find((x) => x.id === st.selection.serverId) ?? st.servers[0]);
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
        useApp.getState().toast({ serverId: server.id, title: 'Running now', body: `${r.name || 'The routine'} posts its result in Updates.`,
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
    <Screen title="Schedule" subtitle="Things your agent does on its own, on a schedule. Results arrive in the Updates chat."
      right={<IconButton label="New routine" variant="filled" onPress={() => setDraft({ name: '', prompt: '', schedule: '' })}>
        <Plus size={22} color={t.colors.text} />
      </IconButton>} onRefresh={load}>
      {error && routines ? <Text style={s.error}>{error}</Text> : null}
      {!routines ? (error ? <LoadError message={error} onRetry={load} /> : (
        <View style={{ gap: 12, marginTop: 16 }}>{[0, 1].map((i) => <Skeleton key={i} height={132} radius={20} />)}</View>
      )) : !routines.length ? (
        <Empty onPick={(idea) => setDraft(idea ?? { name: '', prompt: '', schedule: '' })} />
      ) : (
        <View style={{ gap: 12, marginTop: 16 }}>
          {active.map((r) => (
            <RoutineCard key={r.id} routine={r} busy={busy} onAction={(a) => act(r, a)}
              onEdit={() => setDraft({ id: r.id, name: r.name ?? '', prompt: r.prompt, schedule: r.schedule_display ?? '' })} />
          ))}
          {finished.length ? <Text style={s.group}>Done</Text> : null}
          {finished.map((r) => (
            <RoutineCard key={r.id} routine={r} busy={busy} onAction={(a) => act(r, a)}
              onEdit={() => setDraft({ id: r.id, name: r.name ?? '', prompt: r.prompt, schedule: r.schedule_display ?? '' })} />
          ))}
          <Button title="Open Updates" variant="ghost" onPress={() => router.push(`/chat/${server.id}/home`)} />
        </View>
      )}
      <EditSheet server={server} draft={draft} onClose={() => setDraft(null)} onSaved={() => { setDraft(null); load(); }} />
    </Screen>
  );
}

function Empty({ onPick }: { onPick: (d?: Draft) => void }) {
  const t = useTheme();
  const s = useStyles();
  return (
    <Animated.View entering={FadeIn} style={{ marginTop: 20 }}>
      <Card style={{ alignItems: 'center', gap: 10, paddingVertical: 28 }}>
        <View style={s.emptyIcon}><CalendarPlus size={28} color={t.colors.onAccentSoft} /></View>
        <Text style={s.emptyTitle}>Nothing scheduled yet</Text>
        <Text style={s.emptyBody}>Have it check something every morning, wrap up the week on Fridays, or nudge you in an hour.</Text>
        <Button title="New routine" icon={<Plus size={16} color={t.colors.onAccent} />} onPress={() => onPick()} style={{ marginTop: 6 }} />
      </Card>
      <Text style={s.group}>Ideas</Text>
      <View style={{ gap: 10 }}>
        {IDEAS.map((idea) => (
          <Tap key={idea.name} feedback="selection" onPress={() => onPick(idea)} accessibilityLabel={`${idea.name}, ${idea.schedule}`}
            style={({ hovered }) => [s.idea, hovered && { borderColor: t.colors.borderStrong }]}>
            <Text style={s.ideaName}>{idea.name}</Text>
            <Text style={s.ideaWhen}>{idea.schedule}</Text>
          </Tap>
        ))}
      </View>
    </Animated.View>
  );
}

function RoutineCard({ routine: r, busy, onAction, onEdit }: {
  routine: Routine; busy: string | null; onAction: (a: 'pause' | 'resume' | 'run') => void; onEdit: () => void;
}) {
  const t = useTheme();
  const s = useStyles();
  const paused = r.state === 'paused' || !r.enabled;
  const done = r.state === 'completed';
  const failed = r.last_status && r.last_status !== 'ok';
  const next = !paused && !done ? whenNext(r.next_run_at) : '';
  const spin = (a: string) => busy === `${r.id}:${a}`;
  return (
    <Animated.View layout={LinearTransition.duration(180)}>
      <Card onPress={onEdit} accessibilityLabel={`${r.name || r.prompt}, ${r.schedule_display}. ${paused ? 'Paused.' : next ? `Next ${next}.` : ''} Edit`}
        style={[s.card, done && { opacity: 0.7 }]}>
        <View style={s.head}>
          <View style={[s.icon, { backgroundColor: paused ? t.colors.warningSoft : t.colors.accentSoft }]}>
            {paused ? <CirclePause size={18} color={t.colors.warning} /> : <CalendarClock size={18} color={t.colors.onAccentSoft} />}
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={s.name} numberOfLines={1}>{r.name || r.prompt}</Text>
            <Text style={s.when} numberOfLines={1}>{r.schedule_display}{paused ? ' · paused' : done ? ' · done' : next ? ` · next ${next}` : ''}</Text>
          </View>
        </View>
        {paused && r.paused_reason ? <Text style={s.prompt} numberOfLines={2}>Paused: {r.paused_reason}</Text> : null}
        {r.name ? <Text style={s.prompt} numberOfLines={2}>{r.prompt}</Text> : null}
        {failed ? (
          <View style={s.failure}>
            <CircleAlert size={14} color={t.colors.danger} />
            <Text style={s.failureText} numberOfLines={2}>Last run failed{r.last_run_at ? ` ${agoText(Date.parse(r.last_run_at) / 1000)}` : ''}: {r.last_error || r.last_status}</Text>
          </View>
        ) : r.last_run_at ? <Text style={s.last}>Last ran {agoText(Date.parse(r.last_run_at) / 1000)}</Text> : null}
        {!done ? (
          <View style={s.actions}>
            <Button size="sm" variant="tonal" title="Run now" loading={spin('run')} disabled={!!busy}
              icon={<Play size={14} color={t.colors.onAccentSoft} />} onPress={() => onAction('run')} />
            <Button size="sm" variant="secondary" title={paused ? 'Resume' : 'Pause'} loading={spin(paused ? 'resume' : 'pause')} disabled={!!busy}
              icon={paused ? <Play size={14} color={t.colors.text} /> : <Pause size={14} color={t.colors.text} />}
              onPress={() => onAction(paused ? 'resume' : 'pause')} />
          </View>
        ) : null}
      </Card>
    </Animated.View>
  );
}

function EditSheet({ server, draft, onClose, onSaved }: { server: Server; draft: Draft | null; onClose: () => void; onSaved: () => void }) {
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
    setChecking(true);
    const id = setTimeout(() => {
      api<{ display: string; next_run_at: string | null }>(server, '/api/schedule/parse', { method: 'POST', body: JSON.stringify({ schedule: text }) })
        .then((p) => { setPreview(p); setParseError(''); })
        .catch((e) => { setPreview(null); setParseError(e instanceof ApiError && e.status === 400 ? firstLine(e.message) : ''); })
        .finally(() => setChecking(false));
    }, 400);
    return () => clearTimeout(id);
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
  const ready = !!form.prompt.trim() && !!form.schedule.trim() && !parseError && !checking;
  return (
    <Sheet visible={!!draft} onClose={onClose} title={form.id ? 'Edit routine' : 'New routine'}>
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
  group: { ...t.type.label, fontSize: 12, color: t.colors.textSecondary, marginTop: 18, marginBottom: 10 },
  card: { gap: 10 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  name: { ...t.type.bodyStrong, color: t.colors.text },
  when: { ...t.type.caption, color: t.colors.textSecondary, marginTop: 2 },
  prompt: { ...t.type.callout, color: t.colors.textSecondary },
  failure: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  failureText: { ...t.type.caption, color: t.colors.danger, flex: 1 },
  last: { ...t.type.caption, color: t.colors.textTertiary },
  actions: { flexDirection: 'row', gap: 8, marginTop: 2 },
  emptyIcon: { width: 60, height: 60, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.accentSoft },
  emptyTitle: { ...t.type.bodyStrong, color: t.colors.text, marginTop: 4 },
  emptyBody: { ...t.type.callout, color: t.colors.textSecondary, textAlign: 'center', maxWidth: 340 },
  idea: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: 14, borderRadius: t.radius.md,
    backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border,
  },
  ideaName: { ...t.type.callout, fontFamily: t.fonts.semibold, color: t.colors.text },
  ideaWhen: { ...t.type.caption, color: t.colors.textSecondary },
  presets: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  preview: {
    flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderRadius: t.radius.md, backgroundColor: t.colors.surfaceSunken,
  },
  previewText: { ...t.type.caption, color: t.colors.textSecondary, flex: 1 },
}));
