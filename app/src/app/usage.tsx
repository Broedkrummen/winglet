import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Coins, MessagesSquare, Zap } from '../components/icons';
import { shortModel } from '../components/PickerCard';
import { Screen } from '../components/Screen';
import { withSelectedServer } from '../components/ServerScreen';
import { Card, Footnote, ListGroup, ListRow, LoadError, SectionHeader, Segmented, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { spring, useReducedMotion } from '../lib/motion';
import { useApp } from '../lib/store';
import { alpha } from '../lib/theme';
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
const rise = (reduced: boolean, i: number) => (reduced ? undefined
  : FadeIn.duration(180));

/** Tokens and estimated cost, per day and per model, from Hermes's own session records. */
export default withSelectedServer(UsageScreen);

function UsageScreen() {
  const t = useTheme();
  const s = useStyles();
  const reduced = useReducedMotion();
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
    <Screen title="Usage" onRefresh={load}>
      <Segmented label="Period" value={days} onChange={setDays}
        options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
      {error && data ? <Text style={s.error}>{error}</Text> : null}
      {!data ? (error ? <LoadError message={error} onRetry={load} />
        : <View style={{ gap: 12, marginTop: 16 }}><Skeleton height={140} radius={t.radius.lg} /><Skeleton height={220} radius={t.radius.lg} /></View>) : (
        <>
          <Animated.View entering={rise(reduced, 0)} style={s.tiles}>
            <Stat label="Tokens" value={compact(totalTokens)} />
            <View style={s.divider} />
            <Stat label="Est. cost" value={money(cost)} />
            <View style={s.divider} />
            <Stat label="Sessions" value={String(data.totals.total_sessions ?? 0)} />
          </Animated.View>
          <Footnote>Costs use public prices and may differ from your bill.</Footnote>
          <Animated.View entering={rise(reduced, 1)}>
            <SectionHeader title="Tokens per day" />
            <DailyBars rows={data.daily} />
          </Animated.View>
          <Animated.View entering={rise(reduced, 2)}>
            <SectionHeader title="By model" />
            <Models rows={data.by_model} />
          </Animated.View>
        </>
      )}
    </Screen>
  );
}

/** One number with its label, a column of the summary. */
function Stat({ label, value }: { label: string; value: string }) {
  const s = useStyles();
  return (
    <View style={s.tile} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text style={s.tileLabel} numberOfLines={1}>{label}</Text>
      <Text style={s.tileValue} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
    </View>
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
    <Card style={{ gap: 14 }}>
      <View style={s.readout} accessibilityLiveRegion="polite">
        <Text style={s.readoutDay}>{label(shown.day)}{picked === null ? ' (latest)' : ''}</Text>
        <View style={s.modelHead}>
          <Text style={s.readoutValue}>{compact(tokens(shown))} tokens</Text>
          <Text style={s.modelValue}>{money(shown.estimated_cost ?? 0)}</Text>
        </View>
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
                <View style={[s.bar, { height: h, backgroundColor: t.colors.accent, opacity: picked === null || on ? 1 : 0.3 }]} />
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
  const s = useStyles();
  return (
    <ListGroup>
      {rows.length ? rows.slice(0, 12).map((r) => (
        <ListRow key={r.model} title={shortModel(r.model)} value={`${compact(tokens(r))} tokens`}
          right={<Text style={s.modelValue}>{money(r.estimated_cost ?? 0)}</Text>} />
      )) : <ListRow title="No model usage yet." />}
    </ListGroup>
  );
}

const useStyles = makeStyles((t) => ({
  error: { ...t.type.callout, color: t.colors.danger, marginTop: 10 },
  empty: { ...t.type.callout, color: t.colors.textSecondary },
  tiles: {
    flexDirection: 'row', marginTop: t.space.lg, paddingVertical: t.space.lg, backgroundColor: t.colors.surface,
    borderColor: t.colors.border, borderWidth: StyleSheet.hairlineWidth * 2, borderRadius: t.radius.lg,
  },
  divider: { width: StyleSheet.hairlineWidth * 2, backgroundColor: t.colors.border },
  tile: { flex: 1, minWidth: 0, gap: 4, paddingHorizontal: t.space.lg },
  tileValue: { ...t.type.title, fontSize: 22, color: t.colors.text, fontVariant: ['tabular-nums'] },
  tileLabel: { ...t.type.footnote, color: t.colors.textSecondary },
  readout: { gap: 2 },
  readoutDay: { ...t.type.caption, color: t.colors.textSecondary },
  readoutValue: { ...t.type.title, color: t.colors.text, fontVariant: ['tabular-nums'] },
  plot: { height: 148, justifyContent: 'flex-end' },
  grid: { position: 'absolute', left: 0, right: 0, bottom: 0, height: StyleSheet.hairlineWidth * 2, backgroundColor: t.colors.border },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 148 },
  hit: { flex: 1, height: 148, justifyContent: 'flex-end', alignItems: 'center' },
  bar: { width: '100%', maxWidth: 16, minWidth: 2, borderTopLeftRadius: 3, borderTopRightRadius: 3 },
  axis: { flexDirection: 'row', justifyContent: 'space-between' },
  axisText: { ...t.type.caption, color: t.colors.textTertiary },
  modelHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 },
  modelValue: { ...t.type.callout, color: t.colors.textSecondary },
}));
