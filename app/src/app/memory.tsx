import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { BookUser, NotebookPen, Plus } from '../components/icons';
import { Screen } from '../components/Screen';
import { withSelectedServer } from '../components/ServerScreen';
import { Sheet } from '../components/Sheet';
import { Button, ConfirmButton, Field, Footnote, ListGroup, ListRow, LoadError, SectionHeader, Skeleton } from '../components/ui';
import { api, signedApi } from '../lib/api';
import { haptic } from '../lib/haptics';
import { spring, useReducedMotion } from '../lib/motion';
import { useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';

type Target = 'user' | 'memory';
type Store = Record<Target, { entries: string[]; enabled: boolean; limit: number; used: number }>;
const TITLES: Record<Target, { title: string; note: string }> = {
  user: { title: 'About you', note: 'What it has learned about you: preferences, how you like to work.' },
  memory: { title: 'Its notes', note: 'Facts about its world: your machines, tools and projects.' },
};

/** What the agent remembers between chats, with the same limits and safety checks Hermes applies. */
export default withSelectedServer(MemoryScreen);

function MemoryScreen() {
  const t = useTheme();
  const s = useStyles();
  const server = useApp((st) => st.servers.find((x) => x.id === st.selection.serverId) ?? st.servers[0]);
  const [data, setData] = useState<Store | null>(null);
  const [edit, setEdit] = useState<{ target: Target; entry?: string } | null>(null);
  const [error, setError] = useState('');

  const load = () => {
    if (!server) return;
    return api<Store>(server, '/api/memory').then((d) => { setData(d); setError(''); }).catch((e) => setError((e as Error).message));
  };
  useEffect(() => { load(); }, [server?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Screen title="Memory"
      onRefresh={load}>
      {error && data ? <Text style={s.error}>{error}</Text> : null}
      {!data ? (error ? <LoadError message={error} onRetry={load} />
        : <View style={{ gap: 10, marginTop: 12 }}>{[0, 1, 2].map((i) => <Skeleton key={i} height={64} radius={t.radius.lg} />)}</View>)
        : (['user', 'memory'] as Target[]).map((target, i) => (
          <Section key={target} index={i} target={target} store={data[target]} onEdit={(entry) => setEdit({ target, entry })} />
        ))}
      <EditSheet edit={edit} onClose={() => setEdit(null)} onSaved={(next) => { setData(next); setEdit(null); }} />
    </Screen>
  );
}

function Section({ target, store, onEdit, index }: { target: Target; store: Store[Target]; onEdit: (entry?: string) => void; index: number }) {
  const t = useTheme();
  const s = useStyles();
  const reduced = useReducedMotion();
  const share = store.limit ? Math.min(1, store.used / store.limit) : 0;
  const nearlyFull = !!store.limit && store.used / store.limit > 0.9;
  return (
    <Animated.View entering={reduced ? undefined
      : FadeIn.duration(180)}>
      <SectionHeader title={TITLES[target].title} />
      <ListGroup>
        {store.limit ? (
          <View style={s.meter} accessible accessibilityLabel={`Characters: ${store.used.toLocaleString()} of ${store.limit.toLocaleString()}`}>
            <View style={s.meterHead}>
              <Text style={s.meterTitle}>Characters</Text>
              <Text style={s.meterValue}>{store.used.toLocaleString()} / {store.limit.toLocaleString()}</Text>
            </View>
            <View style={s.track}>
              <View style={[s.fill, { width: `${Math.max(2, share * 100)}%`, backgroundColor: nearlyFull ? t.colors.warning : t.colors.accent }]} />
            </View>
          </View>
        ) : null}
        {store.entries.length ? store.entries.map((entry, i) => (
          <ListRow key={`${i}-${entry.slice(0, 20)}`} title={entry}
            icon={target === 'user' ? <BookUser /> : <NotebookPen />} onPress={() => onEdit(entry)} />
        )) : <ListRow title={store.enabled ? 'No memories yet.' : 'Memory is off in Hermes.'} />}
      </ListGroup>
      {nearlyFull ? <Footnote>Nearly full. Remove old memories to make room.</Footnote> : null}
      {store.enabled ? <Button style={{ marginTop: t.space.md }} variant="secondary" title="Add memory"
        icon={<Plus size={16} color={t.colors.text} />} onPress={() => onEdit()} /> : null}
    </Animated.View>
  );
}

function EditSheet({ edit, onClose, onSaved }: { edit: { target: Target; entry?: string } | null; onClose: () => void; onSaved: (s: Store) => void }) {
  const t = useTheme();
  const s = useStyles();
  const server = useApp((st) => st.servers.find((x) => x.id === st.selection.serverId) ?? st.servers[0]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [last, setLast] = useState(edit);
  if (edit && edit !== last) { setLast(edit); setText(edit.entry ?? ''); setError(''); }
  const e = edit ?? last;

  const run = async (body: object) => {
    if (!server) return;
    setBusy(true);
    setError('');
    try {
      onSaved(await signedApi<Store>(server, 'POST', '/api/memory', body));
      haptic.success();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!e) return null;
  return (
    <Sheet visible={!!edit} onClose={onClose} title={e.entry ? 'Edit memory' : `Add to ${TITLES[e.target].title.toLowerCase()}`} scrollable>
      <View style={{ gap: 14, paddingHorizontal: 4 }}>
        <Field value={text} onChangeText={setText} multiline style={{ minHeight: 100, textAlignVertical: 'top' }} autoFocus={!e.entry}
          placeholder={e.target === 'user' ? 'Prefers short answers in the morning' : 'The home server runs Ubuntu 24.04'} />
        <Button title="Save" loading={busy} disabled={!text.trim() || text.trim() === e.entry}
          onPress={() => run(e.entry ? { action: 'replace', target: e.target, entry: e.entry, content: text } : { action: 'add', target: e.target, content: text })} />
        {e.entry ? <ConfirmButton title="Forget this" onConfirm={() => run({ action: 'remove', target: e.target, entry: e.entry })} /> : null}
        {error ? <Text style={[s.note, { color: t.colors.danger, textAlign: 'center' }]}>{error}</Text> : null}
      </View>
    </Sheet>
  );
}

const useStyles = makeStyles((t) => ({
  meter: { paddingHorizontal: t.space.lg, paddingVertical: t.space.md, gap: t.space.sm, minHeight: 52, justifyContent: 'center' },
  meterHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: t.space.md },
  meterTitle: { ...t.type.body, color: t.colors.text },
  meterValue: { ...t.type.callout, color: t.colors.textSecondary },
  track: { height: 6, borderRadius: t.radius.pill, backgroundColor: t.colors.border, overflow: 'hidden' },
  fill: { height: 6, borderRadius: t.radius.pill },
  note: { ...t.type.callout, color: t.colors.textSecondary, marginBottom: 10 },
  error: { ...t.type.callout, color: t.colors.danger, marginTop: 10 },
}));
