import { useState } from 'react';
import { Text, View } from 'react-native';
import { Button, ConfirmButton, Footnote, ListGroup, ListRow, SectionHeader } from '../../components/ui';
import { shareMedia } from '../../components/MediaViewer';
import { api, encodeApiComponent, mediaUrl, signedApi } from '../../lib/api';
import { useLock } from '../../lib/appLock';
import { bytes } from '../../lib/control';
import { useApp } from '../../lib/store';
import { makeStyles } from '../../lib/themeContext';
import type { Server, Upload } from '../../lib/types';

type Retained = { upload: Upload; chat_id: string; source_device: string; hold_id: string };
type Page = { files: Retained[]; next: string | null };

/** A removed pairing cannot recover these originals itself; a current owner can export them. */
export function RetainedFiles() {
  const s = useStyles();
  const servers = useApp(state => state.servers);
  const locked = useLock(state => state.locked);
  const [selected, setSelected] = useState<Server>();
  const [page, setPage] = useState<Page>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const check = (server: Server) => {
    const state = useApp.getState();
    if (useLock.getState().locked || !state.foreground || !state.network || !state.ready
      || !state.servers.includes(server)) throw new Error('Reconnect and unlock this paired server, then try again.');
  };
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load retained files. Try again.'); }
    finally { setBusy(false); }
  };
  const load = async (server: Server, after?: string) => {
    check(server);
    const next = await api<Page>(server, `/api/uploads/retained${after ? `?after=${encodeApiComponent(after)}` : ''}`);
    check(server);
    setSelected(server);
    setPage(previous => ({ files: after ? [...previous!.files, ...next.files] : next.files, next: next.next }));
  };
  const release = async (file: Retained) => {
    const server = selected!;
    check(server);
    await signedApi(server, 'DELETE', `/api/chats/${encodeApiComponent(file.chat_id)}/uploads/hold`,
      { hold_id: file.hold_id, source_device: file.source_device });
    check(server);
    await load(server);
  };
  return <>
    <SectionHeader title="Recover files from removed devices" />
    <Footnote>Files kept for a removed pairing stay on its server. Download what you need before releasing storage. Releasing files does not stop a task or prove delivery.</Footnote>
    <ListGroup>{servers.map(server => <ListRow key={server.id} title={server.bot.title}
      value={selected === server ? 'Selected' : undefined} onPress={() => void run(() => load(server))} />)}</ListGroup>
    {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
    {busy ? <Footnote>Loading retained files…</Footnote> : null}
    {!locked && selected && servers.includes(selected) && page ? <>
      {!page.files.length ? <Footnote>No files retained for removed devices on this bot.</Footnote> : null}
      {page.files.map(file => <View key={file.upload.id} style={s.file}>
        <ListGroup><ListRow title={file.upload.name} subtitle={`${bytes(file.upload.size)} · ${file.chat_id}`} /></ListGroup>
        <Button title={`Download ${file.upload.name}`} variant="secondary" loading={busy}
          onPress={() => void run(async () => { check(selected); await shareMedia({ uri: mediaUrl(selected, file.upload.url), name: file.upload.name }); })} />
        <ConfirmButton title={`Release ${file.upload.name}`} confirmTitle="Release this retained file? Download it first."
          loading={busy} onConfirm={() => void run(() => release(file))} />
      </View>)}
      {page.next ? <Button title="Load more retained files" variant="secondary" loading={busy}
        onPress={() => void run(() => load(selected, page.next!))} /> : null}
    </> : null}
  </>;
}

const useStyles = makeStyles(t => ({
  file: { gap: t.space.sm, marginBottom: t.space.lg },
  error: { ...t.type.body, color: t.colors.danger },
}));
