import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, Text, View } from 'react-native';
import { RefreshCw } from '../components/icons';
import { Screen } from '../components/Screen';
import { withSelectedServer } from '../components/ServerScreen';
import { Button, Card, Chip, IconButton, LoadError, SearchField, Segmented, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { bytes, logLevel, splitLogLine, type LogLevel } from '../lib/control';
import { useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';

type File = 'agent' | 'gateway' | 'errors';
type Level = '' | 'INFO' | 'WARNING' | 'ERROR';
const LEVELS: { value: Level; label: string }[] = [
  { value: '', label: 'All' }, { value: 'INFO', label: 'Info' }, { value: 'WARNING', label: 'Warnings' }, { value: 'ERROR', label: 'Errors' },
];

/** The end of Hermes's own logs, newest first, with secrets hidden the way Hermes hides them. */
export default withSelectedServer(LogsScreen);

function LogsScreen() {
  const t = useTheme();
  const s = useStyles();
  const server = useApp((st) => st.servers.find((x) => x.id === st.selection.serverId) ?? st.servers[0]);
  const [file, setFile] = useState<File>('agent');
  const [level, setLevel] = useState<Level>('');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [lines, setLines] = useState(300);
  const [data, setData] = useState<{ lines: string[]; size: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestSeq = useRef(0);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), 350);
    return () => clearTimeout(id);
  }, [query]);

  const load = useCallback(() => {
    if (!server) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    const q = new URLSearchParams({ file, level, q: debounced, lines: String(lines) });
    return api<{ lines: string[]; size: number }>(server, `/api/logs?${q}`)
      .then((d) => { if (seq === requestSeq.current) { setData(d); setError(''); } })
      .catch((e) => { if (seq === requestSeq.current) setError((e as Error).message); })
      .finally(() => { if (seq === requestSeq.current) setLoading(false); });
  }, [server, file, level, debounced, lines]);
  useEffect(() => { load(); }, [load]);

  const rows = data ? [...data.lines].reverse() : [];
  return (
    <Screen title="Logs" subtitle="What Hermes has been doing, newest first. Keys and tokens are hidden the way Hermes hides them."
      right={<IconButton label="Refresh" variant="filled" onPress={load}>
        {loading ? <ActivityIndicator size="small" color={t.colors.text} /> : <RefreshCw size={19} color={t.colors.text} />}
      </IconButton>} onRefresh={load}>
      <View style={{ gap: 12, marginTop: 16 }}>
        <Segmented label="Log" value={file} onChange={(v) => { setFile(v); setLines(300); }}
          options={[{ value: 'agent', label: 'Agent' }, { value: 'gateway', label: 'Gateway' }, { value: 'errors', label: 'Errors' }]} />
        <View style={s.chips}>
          {LEVELS.map((l) => <Chip key={l.value || 'all'} label={l.label} selected={level === l.value} onPress={() => setLevel(l.value)} />)}
        </View>
        <SearchField value={query} onChangeText={setQuery} placeholder="Search the log" />
      </View>
      {error && data ? <Text style={s.error}>{error}</Text> : null}
      {!data ? (error ? <LoadError message={error} onRetry={load} /> : <Skeleton height={320} radius={20} style={{ marginTop: 16 }} />) : rows.length ? (
        <>
          <Text style={s.meta}>{rows.length} line{rows.length === 1 ? '' : 's'}{data.size ? ` · ${bytes(data.size)} log` : ''}</Text>
          <Card style={s.card}>
            {rows.map((line, i) => <LogLine key={`${i}-${line.slice(0, 24)}`} line={line} />)}
          </Card>
          {data.lines.length >= lines && lines < 1000 ? (
            <Button title="Show more" variant="secondary" style={{ marginTop: 12 }} onPress={() => setLines(1000)} />
          ) : null}
        </>
      ) : (
        <Card style={{ marginTop: 16 }}>
          <Text style={s.empty}>{debounced || level ? 'Nothing matches.' : file === 'errors' ? 'No errors. Nice.' : 'This log is empty.'}</Text>
        </Card>
      )}
    </Screen>
  );
}

/** One line, its level as a coloured edge. Long lines show three rows until tapped. */
function LogLine({ line }: { line: string }) {
  const t = useTheme();
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const level = logLevel(line);
  const [time, rest] = splitLogLine(line);
  const tint: Record<LogLevel, string> = { error: t.colors.danger, warn: t.colors.warning, info: t.colors.accent, debug: t.colors.textTertiary };
  const long = line.length > 160;
  return (
    <Pressable style={s.line} disabled={!long} onPress={() => setOpen((o) => !o)}
      accessibilityRole={long ? 'button' : undefined} accessibilityHint={long ? (open ? 'Shows less' : 'Shows the whole line') : undefined}>
      <View style={[s.stripe, { backgroundColor: level ? tint[level] : 'transparent' }]} />
      <Text selectable={open || !long} numberOfLines={long && !open ? 3 : undefined} style={s.text}>
        {time ? <Text style={s.time}>{time}  </Text> : null}
        {rest}
      </Text>
    </Pressable>
  );
}

const useStyles = makeStyles((t) => ({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  error: { ...t.type.callout, color: t.colors.danger, marginTop: 12 },
  meta: { ...t.type.caption, color: t.colors.textTertiary, marginTop: 16, marginBottom: 8 },
  card: { paddingVertical: 6, paddingHorizontal: 0, gap: 0 },
  line: { flexDirection: 'row', gap: 10, paddingVertical: 6, paddingRight: 12, borderBottomWidth: 1, borderBottomColor: t.colors.border },
  stripe: { width: 3, borderRadius: 2 },
  text: {
    flex: 1, minWidth: 0, fontFamily: t.fonts.mono, fontSize: 12, lineHeight: 17, color: t.colors.text,
    // Paths and URLs have no spaces to wrap at.
    ...(Platform.OS === 'web' ? ({ wordBreak: 'break-word' } as object) : {}),
  },
  time: { color: t.colors.textTertiary },
  empty: { ...t.type.callout, color: t.colors.textSecondary },
}));
