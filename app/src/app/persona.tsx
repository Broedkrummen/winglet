import { useEffect, useState } from 'react';
import { Platform, Text, TextInput, View } from 'react-native';
import { Screen } from '../components/Screen';
import { withSelectedServer } from '../components/ServerScreen';
import { Button, Card, LoadError, Skeleton } from '../components/ui';
import { api, signedApi } from '../lib/api';
import { haptic } from '../lib/haptics';
import { useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';

const MAX = 20_000;

/** The agent's persona (SOUL.md): who it is and how it talks. Applies to new chats. */
export default withSelectedServer(PersonaScreen);

function PersonaScreen() {
  const t = useTheme();
  const s = useStyles();
  const server = useApp((st) => st.servers.find((x) => x.id === st.selection.serverId) ?? st.servers[0]);
  const [saved, setSaved] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = () => {
    if (!server) return;
    setError('');
    return api<{ content: string }>(server, '/api/identity').then((d) => { setSaved(d.content); setText(d.content); })
      .catch((e) => setError((e as Error).message));
  };
  useEffect(() => { load(); }, [server?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!server) return;
    setBusy(true);
    setMessage('');
    try {
      await signedApi(server, 'PUT', '/api/identity', { content: text });
      haptic.success();
      setSaved(text);
      setMessage('Saved. New chats use it; start a new chat (/new) to try it.');
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const changed = saved !== null && text !== saved;
  return (
    <Screen title="Persona" subtitle={`Who ${server?.bot.title ?? 'your agent'} is and how it talks. Plain words work best: its tone, what to focus on, what to avoid.`}>
      {saved === null ? error ? <LoadError message={error} onRetry={load} /> : <Skeleton height={320} radius={20} style={{ marginTop: 12 }} /> : (
        <Card style={{ marginTop: 12, padding: 0, overflow: 'hidden' }}>
          <TextInput value={text} onChangeText={setText} editable={!busy} multiline textAlignVertical="top" maxLength={MAX}
            placeholder="You are a calm, practical assistant. Keep answers short…" placeholderTextColor={t.colors.textTertiary}
            style={s.editor} accessibilityLabel="Persona" autoCorrect={Platform.OS !== 'web'} />
        </Card>
      )}
      <View style={s.row}>
        <Text style={s.count}>{text.length.toLocaleString()} / {MAX.toLocaleString()}</Text>
        {changed ? <Button size="sm" variant="ghost" title="Undo changes" onPress={() => setText(saved ?? '')} /> : null}
      </View>
      <Button title="Save persona" loading={busy} disabled={!changed} onPress={save} />
      {message ? <Text style={s.message} accessibilityLiveRegion="polite">{message}</Text> : null}
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  editor: { minHeight: 320, padding: 16, ...t.type.body, fontFamily: t.fonts.mono, fontSize: 14.5, lineHeight: 22, color: t.colors.text,
    ...({ outlineStyle: 'none' } as object) },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginVertical: 10 },
  count: { ...t.type.caption, color: t.colors.textTertiary },
  message: { ...t.type.callout, color: t.colors.textSecondary, marginTop: 10, textAlign: 'center' },
}));
