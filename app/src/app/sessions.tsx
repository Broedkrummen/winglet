import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { MessageSquareText, Pin, Search } from '../components/icons';
import { Screen } from '../components/Screen';
import { Button, LoadError, SearchField, Skeleton, Tap } from '../components/ui';
import { ago } from '../lib/agent';
import { api } from '../lib/api';
import { markedParts, sessionTitle, sourceLabel } from '../lib/sessions';
import { useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { SessionRow } from '../lib/types';

const PAGE = 30;

/** Every conversation the agent has had, in any app or routine: browse, search, and read them. */
export default function SessionsScreen() {
  const t = useTheme();
  const s = useStyles();
  const server = useApp((st) => st.servers.find((x) => x.id === st.selection.serverId) ?? st.servers[0]);
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState('');
  const [searchError, setSearchError] = useState('');
  const searchSeq = useRef(0);

  const load = useCallback(() => {
    if (!server) return;
    return api<{ sessions: SessionRow[]; total: number }>(server, `/api/sessions?limit=${PAGE}&offset=0`)
      .then((d) => { setRows(d.sessions); setTotal(d.total); setError(''); })
      .catch((e) => setError((e as Error).message));
  }, [server]);
  useEffect(() => { load(); }, [load]);

  // Search as you type, after a pause; only the latest answer counts.
  useEffect(() => {
    const q = query.trim();
    const seq = ++searchSeq.current;
    setSearchError('');
    if (!server || q.length < 2) { setResults(null); return; }
    const id = setTimeout(() => {
      api<{ results: SessionRow[] }>(server, `/api/sessions/search?q=${encodeURIComponent(q)}`)
        .then((d) => { if (seq === searchSeq.current) setResults(d.results); })
        .catch((e) => { if (seq === searchSeq.current) setSearchError((e as Error).message); });
    }, 300);
    return () => clearTimeout(id);
  }, [query, server]);

  const more = useCallback(async () => {
    if (!server || !rows) return;
    setLoadingMore(true);
    try {
      const d = await api<{ sessions: SessionRow[]; total: number }>(server, `/api/sessions?limit=${PAGE}&offset=${rows.length}`);
      setRows((list) => [...(list ?? []), ...d.sessions.filter((x) => !(list ?? []).some((y) => y.id === x.id))]);
      setTotal(d.total);
    } catch (e) {
      setError((e as Error).message);
    }
    setLoadingMore(false);
  }, [server, rows]);

  if (!server) return null;
  const searching = query.trim().length >= 2;
  // Pinned conversations first, as Hermes shows them; the rest stay most recent first.
  const list = searching ? results : rows && [...rows.filter((r) => r.pinned), ...rows.filter((r) => !r.pinned)];
  return (
    <Screen title="Sessions" subtitle="Every conversation your agent has had, in any app or routine. Most recent first." onRefresh={searching ? undefined : load}>
      <View style={{ marginTop: 16 }}>
        <SearchField value={query} onChangeText={setQuery} placeholder="Search what was said" />
      </View>
      {searching ? (searchError ? <Text style={s.error}>{searchError}</Text> : null) : error && list ? <Text style={s.error}>{error}</Text> : null}
      {!list ? (
        error && !searching ? <LoadError message={error} onRetry={load} style={{ marginTop: 12 }} />
          : searching && searchError ? null
          : <View style={{ gap: 10, marginTop: 18 }}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={68} radius={16} />)}</View>
      ) : (
        <Animated.View entering={FadeIn} style={s.group}>
          {list.map((row, i) => (
            <SessionItem key={row.id} row={row} first={i === 0} onPress={() => router.push(`/session/${encodeURIComponent(row.id)}`)} />
          ))}
          {!list.length ? (
            <View style={s.empty}>
              <Search size={22} color={t.colors.textTertiary} />
              <Text style={s.emptyText}>{searching ? `Nothing said matches "${query.trim()}".` : 'No conversations yet.'}</Text>
            </View>
          ) : null}
        </Animated.View>
      )}
      {!searching && rows && rows.length < total ? (
        <View style={{ marginTop: 14 }}>
          <Button title={`Show more (${total - rows.length} left)`} variant="secondary" loading={loadingMore} onPress={more} />
        </View>
      ) : null}
    </Screen>
  );
}

function SessionItem({ row, first, onPress }: { row: SessionRow; first: boolean; onPress: () => void }) {
  const t = useTheme();
  const s = useStyles();
  const when = row.last_active ?? row.started_at;
  const meta = [sourceLabel(row.source), row.message_count ? `${row.message_count} messages` : null,
    row.tool_call_count ? `${row.tool_call_count} tool ${row.tool_call_count === 1 ? 'call' : 'calls'}` : null].filter(Boolean).join(' · ');
  return (
    <Tap feedback="selection" scaleTo={0.99} onPress={onPress} accessibilityLabel={`${sessionTitle(row)}, ${meta}. Open`}
      style={({ pressed, hovered }) => [s.row, !first && s.rowBorder, (pressed || hovered) && { backgroundColor: t.colors.pressed }]}>
      <View style={s.icon}>
        <MessageSquareText size={18} color={t.colors.onAccentSoft} />
        {row.active ? <View style={[s.live, { borderColor: t.colors.surface }]} /> : null}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={s.head}>
          {row.pinned ? <Pin size={13} color={t.colors.textTertiary} accessibilityLabel="Pinned" /> : null}
          <Text style={s.title} numberOfLines={1}>{sessionTitle(row)}</Text>
          {when ? <Text style={s.time}>{ago(when)}</Text> : null}
        </View>
        {row.snippet ? (
          <Text style={s.preview} numberOfLines={2}>
            {markedParts(row.snippet).map((p, i) => (p.hit ? <Text key={i} style={s.hit}>{p.text}</Text> : p.text))}
          </Text>
        ) : row.title && row.preview ? (
          // How it started, under a titled conversation (untitled ones already show it as their title).
          <Text style={s.preview} numberOfLines={1}>{row.preview.replace(/^\[[^\]]*\]\s*/, '')}</Text>
        ) : null}
        <Text style={s.meta} numberOfLines={1}>{meta}</Text>
      </View>
    </Tap>
  );
}

const useStyles = makeStyles((t) => ({
  error: { ...t.type.callout, color: t.colors.danger, marginTop: 10 },
  group: { marginTop: 18, borderRadius: t.radius.lg, backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border, overflow: 'hidden' },
  row: { flexDirection: 'row', gap: 12, paddingHorizontal: 14, paddingVertical: 12, alignItems: 'flex-start' },
  rowBorder: { borderTopWidth: 1, borderTopColor: t.colors.border },
  icon: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.accentSoft },
  live: { position: 'absolute', right: -2, top: -2, width: 11, height: 11, borderRadius: 6, borderWidth: 2, backgroundColor: t.colors.success },
  head: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  title: { ...t.type.callout, fontFamily: t.fonts.semibold, color: t.colors.text, flex: 1 },
  time: { ...t.type.caption, color: t.colors.textTertiary },
  preview: { ...t.type.caption, color: t.colors.textSecondary, marginTop: 3 },
  hit: { color: t.colors.text, fontFamily: t.fonts.semibold },
  meta: { ...t.type.caption, color: t.colors.textTertiary, marginTop: 3 },
  empty: { alignItems: 'center', gap: 8, paddingVertical: 32 },
  emptyText: { ...t.type.callout, color: t.colors.textSecondary },
}));
