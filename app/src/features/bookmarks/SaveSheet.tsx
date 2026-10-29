import { router } from 'expo-router';
import { useState } from 'react';
import { Text } from 'react-native';
import { Sheet } from '../../components/Sheet';
import { Button, Field, Footnote, ListGroup, ListRow, Toggle } from '../../components/ui';
import { encodeApiComponent, signedApi } from '../../lib/api';
import { idempotencyKey } from '../../lib/control';
import { useLock } from '../../lib/appLock';
import { useApp } from '../../lib/store';
import { useTheme } from '../../lib/themeContext';
import type { Message, Server } from '../../lib/types';
import { savePersonalBookmark, usePersonalSync } from '../sync/runtime';
import { bookmarkField, bookmarkFrom, type BookmarkSource } from './model';
import { useBookmarkSource } from './source';

export function SaveBookmarkSheet({ server, message, onClose }: { server: Server; message: Message; onClose: () => void }) {
  const t = useTheme();
  const [id] = useState(idempotencyKey), [title, setTitle] = useState('Saved answer'), [note, setNote] = useState('');
  const [tags, setTags] = useState(''), [snapshot, setSnapshot] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [scope] = useState(usePersonalSync.getState().scope);
  const source: BookmarkSource = { server_id: server.id, server_fingerprint: server.fingerprint ?? '', chat_id: message.chat_id, message_id: message.id };
  const preview = useBookmarkSource(source, undefined, snapshot);
  const save = async () => {
    if (busy) return;
    setBusy(true); setError('');
    let journaled = false;
    try {
      const changes = { source: bookmarkField(source), title: bookmarkField(title.trim() || 'Saved answer'), note: bookmarkField(note),
        tags: bookmarkField(tags.split(',').map(value => value.trim()).filter(Boolean)), removed: bookmarkField(false) };
      if (!scope || !bookmarkFrom(changes)) throw new Error('Connect Sync and verify the source bot before saving. Use up to 20 tags of 64 characters.');
      const expectedHash = snapshot ? preview.data?.sha256 : undefined;
      if (snapshot && (!expectedHash || preview.data?.state !== 'available' || !preview.server)) throw new Error('Reload and review the source before saving a snapshot.');
      if (useLock.getState().locked || useApp.getState().servers.find(item => item.id === server.id) !== server)
        throw new Error('The source connection changed. Review it before saving.');
      await savePersonalBookmark(scope, id, { ...changes, ...(expectedHash ? { snapshot: bookmarkField({ id, sha256: expectedHash }) } : {}) }, {});
      journaled = true;
      if (snapshot) {
        if (useLock.getState().locked || useApp.getState().servers.find(item => item.id === server.id) !== server) throw new Error('Source connection changed.');
        const savedSnapshot = (await signedApi<{ snapshot: { id: string; sha256: string } }>(preview.server!, 'PUT',
          `/api/chats/${encodeApiComponent(source.chat_id)}/bookmark-snapshots/${encodeApiComponent(id)}`,
          { message_id: source.message_id, expected_sha256: expectedHash })).snapshot;
        if (savedSnapshot.id !== id || savedSnapshot.sha256 !== expectedHash) throw new Error('The snapshot could not be verified.');
      }
      useApp.getState().toast({ serverId: server.id, title: 'Answer saved', body: 'Available in Saved answers. Sync keeps pending changes while offline.' });
      onClose();
    } catch (error) {
      if (journaled) {
        useApp.getState().toast({ serverId: server.id, title: 'Bookmark saved; snapshot unconfirmed', body: 'Open it in Saved answers to retry the snapshot or release its reference.' });
        onClose();
      } else setError((error as Error).message);
    } finally { setBusy(false); }
  };
  return <Sheet visible onClose={onClose} title="Save answer" scrollable>
    {!scope ? <><Footnote>Connect your devices to a sync home before saving answers.</Footnote><Button title="Open Sync settings" onPress={() => { onClose(); router.push('/sync-settings'); }} /></> : <>
      <Field label="Title" value={title} onChangeText={setTitle} maxLength={160} />
      <Field label="Note" value={note} onChangeText={setNote} maxLength={8000} multiline />
      <Field label="Tags" hint="Separate tags with commas" value={tags} onChangeText={setTags} />
      <ListGroup><ListRow title="Keep a text snapshot" subtitle="Stored on the source server, up to 8,192 characters" right={<Toggle label="Keep a bounded text snapshot on the source server" value={snapshot} onValueChange={setSnapshot} />} /></ListGroup>
      {snapshot ? <><Footnote>{preview.error ?? (preview.data?.state === 'available' ? 'The snapshot keeps up to 8,192 characters. Access still follows the original conversation.' : 'Checking the original answer…')}</Footnote>
        {preview.data?.message ? <Text selectable style={{ ...t.type.body, color: t.colors.text }}>{Array.from(preview.data.message.text).slice(0, 8192).join('')}</Text> : null}
        <Button title="Reload source" variant="ghost" onPress={preview.refresh} /></> : null}
      {error ? <Footnote>{error}</Footnote> : null}
      <Button title={busy ? 'Saving…' : 'Save answer'} disabled={busy} onPress={() => void save()} />
    </>}
  </Sheet>;
}
