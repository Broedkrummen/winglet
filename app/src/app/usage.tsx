import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { shortModel } from '../components/PickerCard';
import { Screen } from '../components/Screen';
import { withSelectedServer } from '../components/ServerScreen';
import { Card, LoadError, SectionHeader, Segmented, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';

type Row = { input_tokens?: number; output_tokens?: number; estimated_cost?: number; sessions?: number };
type Usage = {
  daily: (Row & { day: string })[];
  by_model: (Row & { model: string })[];
  totals: { total_input?: number; total_output?: number; total_estimated_cost?: number; total_actual_cost?: number; total_sessions?: number };
  period_days: number;
};

const compact = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n));
const money = (n: number) => n === 0 ? '$0' : n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`;
const tokens = (r: Row) => (r.input_tokens ?? 0) + (r.output_tokens ?? 0);

/** Tokens and estimated cost, per day and per model, from Hermes's own session records. */
export default withSelectedServer(UsageScreen);

function UsageScreen() {
  const s = useStyles();
  const server = useApp((st) => st.servers.find((x) => x.id === st.selection.serverId) ?? st.servers[0]);
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  // Each period's figures, kept: switching back shows them at once while they refresh.
  const [byDays, setByDays] = useState<Record<string, Usage>>({});
  const [error, setError] = useState('');
  const data = byDays[days] ?? null;

  const load = () => {
    if (!server) return;
    const period = days;
    return api<Usage>(server, `/api/usage?days=${period}`)
      .then((d) => { setByDays((all) => ({ ...all, [period]: d })); setError(''); })
      .catch((e) => setError((e as Error).message));
  };
  useEffect(() => { setError(''); load(); }, [server?.id, days]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalTokens = (data?.totals.total_input ?? 0) + (data?.totals.total_output ?? 0);
  const cost = data?.totals.total_actual_cost || data?.totals.total_estimated_cost || 0;
  return (
    <Screen title="Usage" subtitle="Tokens and estimated cost from your agent's sessions. Costs are estimates from public prices." onRefresh={load}>
      <Segmented label="Period" value={days} onChange={setDays}
        options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
      {error && data ? <Text style={s.error}>{error}</Text> : null}
      {!data ? (error ? <LoadError message={error} onRetry={load} />
        : <View style={{ gap: 12, marginTop: 16 }}><Skeleton height={88} radius={20} /><Skeleton height={200} radius={20} /></View>) : (
        <>
          <View style={s.tiles}>
            <Tile label="Tokens" value={compact(totalTokens)} />
            <Tile label="Est. cost" value={money(cost)} />
            <Tile label="Sessions" value={String(data.totals.total_sessions ?? 0)} />
          </View>
          <SectionHeader title="Tokens per day" />
          <DailyBars rows={data.daily} />
          <SectionHeader title="By model" />
          <Models rows={data.by_model} />
        </>
      )}
    </Screen>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  const s = useStyles();
  return (
    <Card style={s.tile} accessibilityLabel={`${label}: ${value}`}>
      <Text style={s.tileLabel}>{label}</Text>
      <Text style={s.tileValue} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
    </Card>
  );
}

/**
 * One series, one hue: a bar per day, tap one for its numbers. The pick is a day, not a position: switching
 * period keeps it when that day is in the new one, and shows the latest day when it isn't.
 */
export function DailyBars({ rows }: { rows: Usage['daily'] }) {
  const t = useTheme();
  const s = useStyles();
  const [day, setDay] = useState<string | null>(null);
  if (!rows.length) return <Card><Text style={s.empty}>No sessions in this period.</Text></Card>;
  const max = Math.max(1, ...rows.map(tokens));
  const chosen = day === null ? undefined : rows.find((r) => r.day === day);
  const picked = chosen ? rows.indexOf(chosen) : null;
  const shown = chosen ?? rows[rows.length - 1];
  const label = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
  return (
    <Card style={{ gap: 12 }}>
      <View style={s.readout} accessibilityLiveRegion="polite">
        <Text style={s.readoutDay}>{label(shown.day)}{picked === null ? ' (latest)' : ''}</Text>
        <Text style={s.readoutValue}>{compact(tokens(shown))} tokens · {money(shown.estimated_cost ?? 0)}</Text>
      </View>
      <View style={s.plot}>
        <View style={s.grid} />
        <View style={s.bars}>
          {rows.map((r, i) => {
            const h = Math.max(2, (tokens(r) / max) * 140);
            const on = picked === i;
            return (
              <Pressable key={r.day} onPress={() => setDay(on ? null : r.day)} style={s.hit} hitSlop={4}
                accessibilityRole="button" accessibilityLabel={`${label(r.day)}: ${compact(tokens(r))} tokens, ${money(r.estimated_cost ?? 0)}`}>
                <View style={[s.bar, { height: h, backgroundColor: t.colors.accent, opacity: picked === null || on ? 1 : 0.35 }]} />
              </Pressable>
            );
          })}
        </View>
      </View>
      <View style={s.axis}>
        <Text style={s.axisText}>{label(rows[0].day)}</Text>
        <Text style={s.axisText}>{label(rows[rows.length - 1].day)}</Text>
      </View>
    </Card>
  );
}

function Models({ rows }: { rows: Usage['by_model'] }) {
  const t = useTheme();
  const s = useStyles();
  if (!rows.length) return <Card><Text style={s.empty}>Nothing yet.</Text></Card>;
  const max = Math.max(1, ...rows.map(tokens));
  return (
    <Card style={{ gap: 14 }}>
      {rows.slice(0, 12).map((r) => (
        <View key={r.model} style={{ gap: 6 }} accessible accessibilityLabel={`${r.model}: ${compact(tokens(r))} tokens, ${money(r.estimated_cost ?? 0)}`}>
          <View style={s.modelHead}>
            <Text style={s.modelName} numberOfLines={1}>{shortModel(r.model)}</Text>
            <Text style={s.modelValue}>{compact(tokens(r))} · {money(r.estimated_cost ?? 0)}</Text>
          </View>
          <View style={s.track}><View style={[s.fill, { width: `${Math.max(1, (tokens(r) / max) * 100)}%`, backgroundColor: t.colors.accent }]} /></View>
        </View>
      ))}
    </Card>
  );
}

const useStyles = makeStyles((t) => ({
  error: { ...t.type.callout, color: t.colors.danger, marginTop: 10 },
  tiles: { flexDirection: 'row', gap: 10, marginTop: 16 },
  tile: { flex: 1, gap: 4, paddingVertical: 14, paddingHorizontal: 14 },
  tileLabel: { ...t.type.caption, color: t.colors.textSecondary },
  tileValue: { fontFamily: t.fonts.bold, fontSize: 24, color: t.colors.text, letterSpacing: -0.5 },
  empty: { ...t.type.callout, color: t.colors.textSecondary },
  readout: { gap: 2 },
  readoutDay: { ...t.type.caption, color: t.colors.textSecondary },
  readoutValue: { ...t.type.bodyStrong, color: t.colors.text },
  plot: { height: 148, justifyContent: 'flex-end' },
  grid: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 1, backgroundColor: t.colors.border },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 148 },
  hit: { flex: 1, height: 148, justifyContent: 'flex-end', alignItems: 'center' },
  bar: { width: '100%', maxWidth: 18, borderTopLeftRadius: 4, borderTopRightRadius: 4 },
  axis: { flexDirection: 'row', justifyContent: 'space-between' },
  axisText: { ...t.type.caption, fontSize: 11.5, color: t.colors.textTertiary },
  modelHead: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  modelName: { ...t.type.callout, fontFamily: t.fonts.semibold, color: t.colors.text, flexShrink: 1 },
  modelValue: { ...t.type.callout, color: t.colors.textSecondary },
  track: { height: 6, borderRadius: 3, backgroundColor: t.colors.surfaceSunken, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3 },
}));
