import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { BookUser, NotebookPen, Plus } from '../components/icons';
import { Screen } from '../components/Screen';
import { withSelectedServer } from '../components/ServerScreen';
import { Sheet } from '../components/Sheet';
import { Button, Card, ConfirmButton, Field, LoadError, SectionHeader, Skeleton, Tap } from '../components/ui';
import { api, signedApi } from '../lib/api';
import { haptic } from '../lib/haptics';
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
    <Screen title="Memory" subtitle={`What ${server?.bot.title ?? 'your agent'} carries from one chat to the next. Edit or remove anything that's wrong.`}
      onRefresh={load}>
      {error && data ? <Text style={s.error}>{error}</Text> : null}
      {!data ? (error ? <LoadError message={error} onRetry={load} />
        : <View style={{ gap: 10, marginTop: 12 }}>{[0, 1, 2].map((i) => <Skeleton key={i} height={64} radius={16} />)}</View>)
        : (['user', 'memory'] as Target[]).map((target) => (
          <Section key={target} target={target} store={data[target]} onEdit={(entry) => setEdit({ target, entry })} />
        ))}
      <EditSheet edit={edit} onClose={() => setEdit(null)} onSaved={(next) => { setData(next); setEdit(null); }} />
    </Screen>
  );
}

function Section({ target, store, onEdit }: { target: Target; store: Store[Target]; onEdit: (entry?: string) => void }) {
  const t = useTheme();
  const s = useStyles();
  const pct = store.limit ? Math.min(1, store.used / store.limit) : 0;
  return (
    <>
      <SectionHeader title={TITLES[target].title} right={store.enabled ? (
        <Button size="sm" variant="tonal" title="Add" icon={<Plus size={15} color={t.colors.onAccentSoft} />} onPress={() => onEdit()} />
      ) : null} />
      <Text style={s.note}>{TITLES[target].note}</Text>
      {store.limit ? (
        <>
          <View style={s.meter} accessibilityLabel={`${Math.round(pct * 100)}% full`}>
            <View style={[s.meterFill, { width: `${Math.max(2, pct * 100)}%`, backgroundColor: pct > 0.9 ? t.colors.warning : t.colors.accent }]} />
          </View>
          <Text style={[s.meterText, pct > 0.9 && { color: t.colors.warning }]}>
            {store.used.toLocaleString()} of {store.limit.toLocaleString()} characters
            {pct > 0.9 ? '. Nearly full: remove what you no longer need to make room for new things.' : ''}
          </Text>
        </>
      ) : null}
      {store.entries.length ? (
        <View style={{ gap: 8 }}>
          {store.entries.map((entry, i) => (
            <Tap key={`${i}-${entry.slice(0, 20)}`} feedback="selection" onPress={() => onEdit(entry)} accessibilityLabel={`${entry}. Edit`}
              style={({ hovered }) => [s.entry, hovered && { borderColor: t.colors.borderStrong }]}>
              {target === 'user' ? <BookUser size={16} color={t.colors.textSecondary} /> : <NotebookPen size={16} color={t.colors.textSecondary} />}
              <Text style={s.entryText}>{entry}</Text>
            </Tap>
          ))}
        </View>
      ) : (
        <Card><Text style={s.note}>{store.enabled ? 'Nothing yet.' : 'Turned off in Hermes\'s memory settings.'}</Text></Card>
      )}
    </>
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
  meterText: { ...t.type.caption, color: t.colors.textTertiary, marginTop: 6 },
  note: { ...t.type.callout, color: t.colors.textSecondary, marginBottom: 10 },
  error: { ...t.type.callout, color: t.colors.danger, marginTop: 10 },
  meter: { height: 4, borderRadius: 2, backgroundColor: t.colors.surfaceSunken, overflow: 'hidden', marginBottom: 12 },
  meterFill: { height: 4, borderRadius: 2 },
  entry: {
    flexDirection: 'row', gap: 10, padding: 14, borderRadius: t.radius.md, backgroundColor: t.colors.surface,
    borderWidth: 1, borderColor: t.colors.border,
  },
  entryText: { flex: 1, ...t.type.callout, color: t.colors.text },
}));
