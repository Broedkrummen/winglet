import { useState } from 'react';
import { Text, View } from 'react-native';
import { Button, ConfirmButton, Footnote, ListGroup, ListRow, SectionHeader } from '../../components/ui';
import { shareMedia } from '../../components/MediaViewer';
import { mediaUrl } from '../../lib/api';
import { useLock } from '../../lib/appLock';
import { bytes } from '../../lib/control';
import { useApp } from '../../lib/store';
import { makeStyles } from '../../lib/themeContext';
import type { Server } from '../../lib/types';
import { currentRetainedFiles, releaseCurrentRetainedFile, type CurrentRetained } from './localRetention';

export function CurrentRetainedFiles() {
  const s = useStyles();
  const servers = useApp(state => state.servers);
  const locked = useLock(state => state.locked);
  const [server, setServer] = useState<Server>();
  const [files, setFiles] = useState<CurrentRetained[]>();
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not review this device’s retained files. Refresh and try again.'); }
    finally { setBusy(false); }
  };
  const load = async (target: Server, after?: string) => {
    const page = await currentRetainedFiles(target, after);
    setServer(target); setFiles(previous => after ? [...previous!, ...page.files] : page.files); setNext(page.next);
  };
  return <View style={s.section}>
    <SectionHeader title="Files retained for this device" />
    <Footnote>Review uploads and unused copies stored on a bot’s server for this pairing. Download what you need first. Files still in a saved draft or outbox cannot be released. Releasing retention does not stop work.</Footnote>
    <ListGroup>{servers.map(target => <ListRow key={target.id} title={target.bot.title} value={server === target ? 'Selected' : undefined}
      onPress={() => void run(() => load(target))} />)}</ListGroup>
    {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
    {busy ? <Footnote>Checking retained files…</Footnote> : null}
    {!locked && server && servers.includes(server) && files ? <>
      {files.length === 0 ? <Footnote>No retained uploads for this pairing on this bot.</Footnote> : null}
      {files.map(file => <View key={file.upload.id} style={s.file}>
        <ListGroup><ListRow title={file.upload.name} subtitle={`${bytes(file.upload.size)} · ${file.chat_id}`} /></ListGroup>
        <Button title={`Download retained ${file.upload.name}`} variant="secondary" loading={busy}
          onPress={() => void run(async () => {
            if (useLock.getState().locked || !useApp.getState().servers.includes(server)) throw new Error('Unlock and reconnect this pairing before downloading.');
            await shareMedia({ uri: mediaUrl(server, file.upload.url), name: file.upload.name });
          })} />
        <ConfirmButton title={`Release retained ${file.upload.name}`} confirmTitle="Release this unused copy? Download it first."
          loading={busy} onConfirm={() => void run(async () => { await releaseCurrentRetainedFile(server, file); await load(server); })} />
      </View>)}
      {next ? <Button title="Load more files for this pairing" variant="secondary" loading={busy}
        onPress={() => void run(() => load(server, next))} /> : null}
    </> : null}
  </View>;
}

const useStyles = makeStyles(t => ({
  section: { gap: t.space.sm, flexShrink: 0 },
  file: { gap: t.space.sm, marginTop: t.space.md },
  error: { ...t.type.body, color: t.colors.danger },
}));
