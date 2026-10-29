import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Button, ConfirmButton, Footnote, ListGroup, ListRow, SectionHeader } from '../../components/ui';
import { useLock } from '../../lib/appLock';
import { makeStyles } from '../../lib/themeContext';
import { exportSyncBytes } from './exportFile';
import { personalSubmissions, releaseSharedSubmissionFiles, sharedSubmissionFile, usePersonalSync, type SharedSubmission } from './runtime';

export function SubmissionRecovery() {
  const s = useStyles();
  const home = usePersonalSync(state => state.home);
  const locked = useLock(state => state.locked);
  const [items, setItems] = useState<SharedSubmission[]>();
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setItems(undefined); setNext(null); setError(''); }, [home?.groupId, home?.deviceId, home?.serverId, locked]);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not review retained submissions. Try again.'); }
    finally { setBusy(false); }
  };
  const load = async (after?: string) => {
    const page = await personalSubmissions(after);
    setItems(previous => after ? [...previous!, ...page.submissions] : page.submissions);
    setNext(page.next);
  };
  if (!home || locked) return null;
  return <View style={s.recovery}>
    <SectionHeader title="Shared submission recovery" />
    <Footnote>Review submissions from all linked devices. Delivery confirmation means a linked device saw a target message; it does not prove the bot completed its work.</Footnote>
    <Button title={items ? 'Refresh submissions' : 'Review retained submissions'} variant="secondary" loading={busy}
      onPress={() => void run(() => load())} />
    {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
    {items?.length === 0 ? <Footnote>No shared submissions yet.</Footnote> : null}
    {items?.map(item => <View key={item.id} style={s.submission}>
      <ListGroup><ListRow title={item.preview || 'Attachment submission'}
        subtitle={`${item.chat_id || item.record_id} · ${new Date(item.created_at * 1000).toLocaleString()}`}
        value={item.delivery_confirmed ? 'Message confirmed' : 'Delivery unconfirmed'} /></ListGroup>
      <Text selectable style={s.identifier}>Submission {item.id}</Text>
      {item.files.map(file => <Button key={file.slot} title={`Download ${file.name}`} variant="secondary" loading={busy}
        onPress={() => void run(async () => { const bytes = await sharedSubmissionFile(file); await exportSyncBytes(file.name, bytes); })} />)}
      {item.files_released ? <Footnote>Shared source retention released. Live drafts and local files may still retain copies.</Footnote>
        : item.delivery_confirmed ? <Footnote>Confirmed message; submission pins have been retired. Live drafts may still retain files.</Footnote>
        : item.files.length ? <>
          <Footnote>Download files you need before releasing shared source retention. This does not cancel execution, discard a local outbox or create permission to send again. Live drafts and local copies keep their own retention.</Footnote>
          <ConfirmButton title="Release shared source retention" confirmTitle="Release without confirmed delivery? This does not stop work."
            loading={busy} onConfirm={() => void run(async () => { await releaseSharedSubmissionFiles(item); await load(); })} />
        </> : null}
    </View>)}
    {next ? <Button title="Load more submissions" variant="secondary" loading={busy} onPress={() => void run(() => load(next))} /> : null}
  </View>;
}

const useStyles = makeStyles(t => ({
  recovery: { gap: t.space.sm, flexShrink: 0 },
  submission: { gap: t.space.sm, marginTop: t.space.lg },
  identifier: { ...t.type.footnote, color: t.colors.textSecondary },
  error: { ...t.type.body, color: t.colors.danger },
}));
