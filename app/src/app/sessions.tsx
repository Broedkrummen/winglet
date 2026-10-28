import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { MessageSquareText, Pin, Search } from '../components/icons';
import { Screen } from '../components/Screen';
import { withSelectedServer } from '../components/ServerScreen';
import { Button, ListGroup, ListRow, LoadError, SearchField, SectionHeader, Skeleton, Tap } from '../components/ui';
import { ago } from '../lib/agent';
import { api } from '../lib/api';
import { spring, useReducedMotion } from '../lib/motion';
import { markedParts, sessionTitle, sourceLabel } from '../lib/sessions';
import { useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { SessionRow } from '../lib/types';

const PAGE = 30;

/** Every conversation the agent has had, in any app or routine: browse, search, and read them. */
export default withSelectedServer(SessionsScreen);

function SessionsScreen() {
  const t = useTheme();
  const s = useStyles();
  const reduced = useReducedMotion();
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
    <Screen title="Sessions" onRefresh={searching ? undefined : load}>
      <View style={{ marginTop: 16 }}>
        <SearchField value={query} onChangeText={setQuery} placeholder="Search what was said" />
      </View>
      {searching ? (searchError ? <Text style={s.error}>{searchError}</Text> : null) : error && list ? <Text style={s.error}>{error}</Text> : null}
      {!list ? (
        error && !searching ? <LoadError message={error} onRetry={load} style={{ marginTop: 12 }} />
          : searching && searchError ? null
          : <View style={{ gap: 10, marginTop: 18 }}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={68} radius={t.radius.lg} />)}</View>
      ) : (
        <Animated.View entering={reduced ? undefined : FadeIn}>
          <SectionHeader title={searching ? 'Search results' : 'Conversations'} right={<Text style={s.time}>{searching ? list.length : total}</Text>} />
          {list.length ? <ListGroup>{list.map((row, i) => (
            <Animated.View key={row.id} entering={reduced || i > 12 ? undefined
              : FadeIn.duration(180)}>
              <SessionItem row={row} first={i === 0} onPress={() => router.push(`/session/${encodeURIComponent(row.id)}`)} />
            </Animated.View>
          ))}</ListGroup> : null}
          {!list.length ? (
            <View style={s.empty}>
              <View style={s.emptyIcon}><Search size={24} color={t.colors.textSecondary} /></View>
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
  const meta = `${sourceLabel(row.source)}, ${row.message_count ?? 0} messages, ${row.tool_call_count ?? 0} tool calls`;
  return (
    <Tap feedback="selection" scaleTo={0.99} onPress={onPress} accessibilityLabel={`${sessionTitle(row)}, ${meta}. Open`}
      style={({ pressed, hovered }) => [(pressed || hovered) && { backgroundColor: t.colors.pressed }]}>
      <ListRow icon={row.pinned ? <Pin /> : <MessageSquareText />} title={sessionTitle(row)}
        value={when ? ago(when) : undefined} subtitle={row.active ? `Active in ${sourceLabel(row.source)}` : sourceLabel(row.source)} chevron />
      {row.snippet ? (
        <Text style={s.preview} numberOfLines={2}>
          {markedParts(row.snippet).map((p, i) => (p.hit ? <Text key={i} style={s.hit}>{p.text}</Text> : p.text))}
        </Text>
      ) : row.title && row.preview ? <Text style={s.preview} numberOfLines={1}>{row.preview.replace(/^\[[^\]]*\]\s*/, '')}</Text> : null}
      {row.message_count || row.tool_call_count ? <View style={s.counts}>
        {row.message_count ? <Text style={s.meta}>Messages {row.message_count}</Text> : null}
        {row.tool_call_count ? <Text style={s.meta}>Tool calls {row.tool_call_count}</Text> : null}
      </View> : null}
    </Tap>
  );
}

const useStyles = makeStyles((t) => ({
  error: { ...t.type.callout, color: t.colors.danger, marginTop: 10 },
  time: { ...t.type.caption, color: t.colors.textTertiary },
  preview: { ...t.type.footnote, color: t.colors.textSecondary, paddingHorizontal: t.space.lg, paddingBottom: t.space.sm },
  hit: { color: t.colors.text, fontFamily: t.fonts.semibold },
  meta: { ...t.type.caption, color: t.colors.textTertiary },
  counts: { flexDirection: 'row', gap: t.space.md, paddingHorizontal: t.space.lg, paddingBottom: t.space.md },
  empty: { alignItems: 'center', gap: t.space.md, paddingVertical: t.space.xxl },
  emptyIcon: { width: 56, height: 56, borderRadius: t.radius.pill, backgroundColor: t.colors.surfaceSunken, alignItems: 'center', justifyContent: 'center' },
  emptyText: { ...t.type.callout, color: t.colors.textSecondary },
}));
