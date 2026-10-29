import { router } from 'expo-router';
import { useState } from 'react';
import { Text } from 'react-native';
import { Screen } from '../components/Screen';
import { Sheet } from '../components/Sheet';
import { Button, ConfirmButton, Field, Footnote, ListGroup, ListRow, SearchField, Toggle } from '../components/ui';
import { signedApi } from '../lib/api';
import { useLock } from '../lib/appLock';
import { requestFocus } from '../lib/focus';
import { useApp } from '../lib/store';
import { useTheme } from '../lib/themeContext';
import { bookmarkField, bookmarkFrom, bookmarkMatches } from '../features/bookmarks/model';
import { sourcePath, useBookmarkSource } from '../features/bookmarks/source';
import { refreshPersonalSync, savePersonalBookmark, usePersonalSync, type PersonalRecord } from '../features/sync/runtime';

export default function BookmarksScreen() {
  const sync = usePersonalSync(), locked = useLock(state => state.locked);
  const [query, setQuery] = useState(''), [selected, setSelected] = useState<{ record: PersonalRecord; scope: string }>();
  const [showRemoved, setShowRemoved] = useState(false);
  const records = !locked && sync.scope ? sync.bookmarks.filter(record => {
    const bookmark = bookmarkFrom(record.values);
    return record.conflicted || !bookmark || (bookmark.removed === showRemoved && bookmarkMatches(bookmark, query));
  }) : [];
  return <Screen title="Saved answers" onRefresh={refreshPersonalSync}>
    {!sync.scope ? <><Footnote>Connect Sync to save answers across your devices.</Footnote><Button title="Open Sync settings" onPress={() => router.push('/sync-settings')} /></> : <>
      <SearchField value={query} onChangeText={setQuery} placeholder="Find saved answers" />
      <ListGroup><ListRow title="Show removed bookmarks" right={<Toggle label="Show removed bookmarks" value={showRemoved} onValueChange={setShowRemoved} />} /></ListGroup>
      <Footnote>{sync.pending ? `${sync.pending} sync changes pending. Offline edits stay on this device until reconnecting.` : 'Your titles, notes and tags sync. Original text is checked on its source bot when opened.'}</Footnote>
      {sync.error ? <Footnote>{sync.error}</Footnote> : null}
      <ListGroup>{records.map(record => {
        const bookmark = bookmarkFrom(record.values);
        return <ListRow key={record.id} title={bookmark?.title || 'Bookmark needs review'}
          subtitle={record.conflicted ? 'Conflicting changes — choose each version' : bookmark ? bookmark.tags.join(' · ') || 'Saved message reference' : 'Invalid record — inspect in Sync settings'}
          onPress={() => { if (record.conflicted || !bookmark) router.push('/sync-settings'); else if (sync.scope) setSelected({ record, scope: sync.scope }); }} />;
      })}</ListGroup>
      {!records.length ? <Footnote>{query ? 'No saved answers match your search.' : 'Save an answer from a message’s options. You can add a note, tags and an optional text snapshot.'}</Footnote> : null}
    </>}
    {selected && sync.scope === selected.scope ? <BookmarkEditor key={`${selected.scope}:${selected.record.id}`} record={selected.record} scope={selected.scope} onClose={() => setSelected(undefined)} /> : null}
  </Screen>;
}

function BookmarkEditor({ record, scope, onClose }: { record: PersonalRecord; scope: string; onClose: () => void }) {
  const bookmark = bookmarkFrom(record.values)!;
  const t = useTheme();
  const [title, setTitle] = useState(bookmark.title), [note, setNote] = useState(bookmark.note), [tags, setTags] = useState(bookmark.tags.join(', '));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const preview = useBookmarkSource(bookmark.source, bookmark.snapshot?.id);
  const verified = preview.data && (!bookmark.snapshot || preview.data.snapshot?.sha256 === bookmark.snapshot.sha256);
  const text = verified ? preview.data?.snapshot?.text ?? preview.data?.message?.text : undefined;
  const change = async (changes: Parameters<typeof savePersonalBookmark>[2]) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await savePersonalBookmark(scope, record.id, changes, record.bases); onClose(); }
    catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  };
  const save = () => {
    const changes = { title: bookmarkField(title.trim() || 'Saved answer'), note: bookmarkField(note),
      tags: bookmarkField(tags.split(',').map(value => value.trim()).filter(Boolean)) };
    if (!bookmarkFrom({ ...record.values, ...changes })) { setError('Use at most 20 tags of 1–64 characters.'); return; }
    void change(Object.fromEntries(Object.entries(changes).filter(([field, value]) => JSON.stringify(value) !== JSON.stringify(record.values[field]?.deleted === false
      ? { deleted: false, value: record.values[field].value } : { deleted: true }))));
  };
  return <Sheet visible onClose={onClose} title="Saved answer" scrollable>
    <Field label="Title" value={title} onChangeText={setTitle} maxLength={160} />
    <Field label="Note" value={note} onChangeText={setNote} maxLength={8000} multiline />
    <Field label="Tags" hint="Separate tags with commas" value={tags} onChangeText={setTags} />
    <Footnote>{preview.error ?? (preview.data?.state === 'edited' ? 'The original answer changed. This is your saved snapshot.'
      : preview.data?.state === 'deleted' ? bookmark.snapshot ? 'The original message was deleted. This saved snapshot remains accessible.' : 'The original message was deleted.'
        : text !== undefined ? bookmark.snapshot ? 'Saved text snapshot' : 'Current original answer' : 'Checking source access…')}</Footnote>
    {preview.data && !verified ? <Footnote>The saved snapshot does not match its recorded hash. Reload the source before using it.</Footnote> : null}
    {text !== undefined ? <Text selectable style={{ ...t.type.body, color: t.colors.text }}>{text}</Text> : null}
    {preview.data?.snapshot?.truncated ? <Footnote>This snapshot was truncated to 8,192 characters.</Footnote> : null}
    <Button title="Reload source" variant="ghost" onPress={preview.refresh} />
    {bookmark.snapshot && preview.error && preview.server ? <Button title="Retry snapshot creation" variant="secondary" disabled={busy} onPress={async () => {
      if (!preview.enabled || !preview.server || useLock.getState().locked || busy) return;
      setBusy(true); setError('');
      try {
        const result = await signedApi<{ snapshot: { id: string; sha256: string } }>(preview.server, 'PUT', sourcePath(bookmark.source, bookmark.snapshot!.id),
          { message_id: bookmark.source.message_id, expected_sha256: bookmark.snapshot!.sha256 });
        if (result.snapshot.id !== bookmark.snapshot!.id || result.snapshot.sha256 !== bookmark.snapshot!.sha256) throw new Error();
        preview.refresh();
      } catch { setError('The saved version could not be recovered. Open the source to review changes, or release the snapshot reference.'); }
      finally { setBusy(false); }
    }} /> : null}
    <Button title="Open original message" variant="secondary" disabled={!verified || preview.data?.state === 'deleted' || !preview.server} onPress={() => {
      if (!preview.enabled || !preview.server || useLock.getState().locked) return;
      useApp.getState().select(preview.server.id, bookmark.source.chat_id);
      requestFocus(preview.server.id, bookmark.source.chat_id, bookmark.source.message_id);
      onClose(); router.navigate(`/chat/${preview.server.id}/${bookmark.source.chat_id}`);
    }} />
    {error ? <Footnote>{error}</Footnote> : null}
    <Button title={busy ? 'Saving…' : 'Save changes'} disabled={busy} onPress={save} />
    <ConfirmButton title={bookmark.removed ? 'Restore bookmark' : 'Remove bookmark'} confirmTitle={bookmark.removed ? 'Restore this bookmark?' : 'Remove this bookmark?'} disabled={busy} onConfirm={() => change({ removed: bookmarkField(!bookmark.removed) })} />
    {bookmark.snapshot ? <Footnote>Removing a bookmark keeps its snapshot. Show removed bookmarks to restore it or release the saved text.</Footnote> : null}
    {bookmark.snapshot ? <ConfirmButton title="Release saved snapshot" confirmTitle="Delete the saved snapshot?" disabled={busy || !preview.server} onConfirm={async () => {
      if (!preview.server || useLock.getState().locked) return;
      try {
        await signedApi(preview.server, 'DELETE', sourcePath(bookmark.source, bookmark.snapshot!.id));
        await change({ snapshot: { deleted: true } });
      } catch { setError('Snapshot release could not be confirmed. Reload the source and retry.'); preview.refresh(); }
    }} /> : null}
  </Sheet>;
}
