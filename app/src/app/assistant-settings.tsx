import { useCallback, useState } from 'react';
import { AppState, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Screen } from '../components/Screen';
import { Button, Card, Footnote, ListGroup, ListRow, LoadError, SectionHeader } from '../components/ui';
import { makeStyles } from '../lib/themeContext';
import { assistantNative } from '../features/android-assistant/native';

export default function AssistantSettings() {
  const s = useStyles();
  const [status, setStatus] = useState<{ supported: boolean; held: boolean } | null>(null);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try { setStatus(await assistantNative?.capabilities() ?? { supported: false, held: false }); setError(''); }
    catch (e) { setError((e as Error).message); }
  }, []);
  useFocusEffect(useCallback(() => {
    void refresh();
    const sub = AppState.addEventListener('change', state => { if (state === 'active') void refresh(); });
    return () => sub.remove();
  }, [refresh]));

  return <Screen title="Android assistant">
    <SectionHeader title="Assistant" />
    <ListGroup>
      <ListRow title="Winglet" value={status?.held ? 'Selected' : status?.supported ? 'Not selected' : status ? 'Unavailable' : 'Checking…'} />
    </ListGroup>
    <Card style={s.card}>
      <Text style={s.note}>Use your phone's assistant gesture to ask a question.</Text>
      <Button title={status?.held ? 'Review Android choice' : 'Choose in Android'} disabled={!status?.supported}
        onPress={async () => { try { await assistantNative?.requestRole(); } catch (e) { setError((e as Error).message); } }} />
    </Card>
    <Footnote>You review the bot, chat and optional screen text before anything is sent.</Footnote>
    <Footnote>Screen text is temporary. Input fields and screenshots are excluded; no wake-word listening.</Footnote>
    {status?.held ? <View style={s.help}><Footnote>Change assistants in Android Settings → Apps → Default apps → Digital assistant.</Footnote></View> : null}
    {error ? <LoadError message={error} onRetry={refresh} /> : null}
  </Screen>;
}

const useStyles = makeStyles(t => ({
  card: { marginTop: t.space.md, gap: t.space.md },
  note: { ...t.type.callout, color: t.colors.textSecondary },
  help: { marginTop: t.space.md },
}));
