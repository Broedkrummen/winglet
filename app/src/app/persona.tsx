import { useEffect, useState } from 'react';
import { Platform, Text, TextInput, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Screen } from '../components/Screen';
import { withSelectedServer } from '../components/ServerScreen';
import { Button, Card, Footnote, LoadError, Skeleton } from '../components/ui';
import { api, signedApi } from '../lib/api';
import { haptic } from '../lib/haptics';
import { spring, useReducedMotion } from '../lib/motion';
import { useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';

const MAX = 20_000;

/** The agent's persona (SOUL.md): who it is and how it talks. Applies to new chats. */
export default withSelectedServer(PersonaScreen);

function PersonaScreen() {
  const t = useTheme();
  const s = useStyles();
  const reduced = useReducedMotion();
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
      setMessage('Saved for new chats.');
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const changed = saved !== null && text !== saved;
  return (
    <Screen title="Persona">
      {saved === null ? error ? <LoadError message={error} onRetry={load} /> : <Skeleton height={320} radius={t.radius.lg} style={{ marginTop: 12 }} /> : (
        <Animated.View entering={reduced ? undefined : FadeIn.duration(180)}>
          <Card style={{ marginTop: 12, padding: 0, overflow: 'hidden', borderRadius: t.radius.xl }}>
            <TextInput value={text} onChangeText={setText} editable={!busy} multiline textAlignVertical="top" maxLength={MAX}
              placeholder="You are a calm, practical assistant. Keep answers short…" placeholderTextColor={t.colors.textTertiary}
              style={s.editor} accessibilityLabel="Persona" autoCorrect={Platform.OS !== 'web'} />
          </Card>
        </Animated.View>
      )}
      <View style={s.row}>
        <Text style={s.count}>{text.length.toLocaleString()} / {MAX.toLocaleString()}</Text>
        {changed ? <Button size="sm" variant="ghost" title="Undo changes" onPress={() => setText(saved ?? '')} /> : null}
      </View>
      <Footnote>Changes apply to new chats.</Footnote>
      <Button style={{ marginTop: t.space.lg }} title="Save persona" loading={busy} disabled={!changed} onPress={save} />
      {message ? <Text style={s.message} accessibilityLiveRegion="polite">{message}</Text> : null}
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  editor: { minHeight: 320, padding: 16, ...t.type.callout, fontFamily: t.fonts.mono, color: t.colors.text,
    ...({ outlineStyle: 'none' } as object) },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginVertical: 10 },
  count: { ...t.type.caption, color: t.colors.textTertiary },
  message: { ...t.type.callout, color: t.colors.textSecondary, marginTop: 10, textAlign: 'center' },
}));
