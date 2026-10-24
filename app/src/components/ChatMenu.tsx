import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { exportChat } from '../lib/exportChat';
import { chatKey, changeChatOrganization } from '../lib/chatOrganization';
import { usePrefs } from '../lib/prefs';
import { mutedUntil, pushPrefsKey, usePushPrefs } from '../lib/pushPrefs';
import { homeChat, useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { Server } from '../lib/types';
import { Activity, Archive, ArchiveRestore, Bell, BellOff, Download, FileDiff, Folder, Images, Pencil, Pin, PinOff, Target, Trash2 } from './icons';
import { Sheet, SheetAction } from './Sheet';
import { ProjectPicker } from '../features/projects/MoveToProjectSheet';
import { Button, Field } from './ui';

const clockTime = (ts: number) => new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const MUTE_OPTIONS: { label: string; seconds: number }[] = [
  { label: 'For 1 hour', seconds: 3600 },
  { label: 'For 8 hours', seconds: 8 * 3600 },
  { label: 'For a day', seconds: 24 * 3600 },
  { label: 'Until I turn it back on', seconds: 0 },
];

/**
 * What you can do to a chat, the same from the chat itself and from the list: rename, mute, export, delete,
 * and where it's open its goal and files.
 */
export function ChatMenu({ server, chatId, title, visible, onClose, onGoal, hasGoal, onFiles, onCheckpoints, onDeleted, onArchived }: {
  server: Server; chatId: string; title: string; visible: boolean; onClose: () => void;
  /** Only where the chat is open: its goal, files and workspace snapshots live in that screen. */
  onGoal?: () => void; hasGoal?: boolean; onFiles?: () => void; onCheckpoints?: () => void;
  /** Where to go once the chat is gone: the chat's own screen has nowhere left to show, a list does. */
  onDeleted?: () => void;
  onArchived?: () => void;
}) {
  const t = useTheme();
  const s = useStyles();
  const chat = useApp((st) => st.runtime[server.id]?.chats[chatId]);
  const renameChat = useApp((st) => st.renameChat);
  const deleteChat = useApp((st) => st.deleteChat);
  const features = useApp((st) => st.runtime[server.id]?.info?.features);
  const prefs = usePushPrefs((st) => st.byServer[pushPrefsKey(server)]);
  const organization = usePrefs((st) => st.prefs);
  const key = chatKey(server.id, chatId);
  const pinned = organization.pinnedChats.includes(key);
  const archived = organization.archivedChats.includes(key);
  const [mode, setMode] = useState<'menu' | 'rename' | 'delete' | 'mute' | 'move'>('menu');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const side = chat?.kind === 'chat' && chatId !== homeChat(useApp.getState().runtime[server.id]);
  const until = mutedUntil(prefs, chatId);
  const close = () => { setMode('menu'); onClose(); };
  const rename = async () => { await renameChat(server.id, chatId, name); close(); };
  const organize = (action: 'pin' | 'unpin' | 'archive' | 'restore' | 'remove') => {
    usePrefs.getState().update(changeChatOrganization(usePrefs.getState().prefs, key, action));
    close();
    if (action === 'archive') {
      useApp.getState().toast({ serverId: server.id, title: 'Chat archived', body: 'Find it in Chats → Archived on this device.' });
      onArchived?.();
    }
  };

  useEffect(() => {
    if (visible && features?.mute) usePushPrefs.getState().load(server);
  }, [visible, features?.mute, server]);

  const fail = (title: string) => (e: unknown) => useApp.getState().toast({ serverId: server.id, title, body: (e as Error).message });
  const mute = (seconds: number | null) => {
    close();
    usePushPrefs.getState().save(server, (p) => {
      const muted = { ...p.muted };
      if (seconds === null) delete muted[chatId];
      else muted[chatId] = seconds === 0 ? 0 : Date.now() / 1000 + seconds;
      return { ...p, muted };
    }).catch(fail("Couldn't change notifications"));
  };

  return (
    <Sheet visible={visible} onClose={close}
      title={mode === 'mute' ? 'Mute notifications' : mode === 'move' ? 'Move to project' : title}>
      {mode === 'menu' ? (
        <>
          {side ? <SheetAction icon={archived ? <ArchiveRestore size={20} color={t.colors.text} /> : pinned ? <PinOff size={20} color={t.colors.text} /> : <Pin size={20} color={t.colors.text} />}
            label={archived ? 'Restore chat' : pinned ? 'Unpin chat' : 'Pin chat'} onPress={() => organize(archived ? 'restore' : pinned ? 'unpin' : 'pin')} /> : null}
          {side && !archived ? <SheetAction icon={<Archive size={20} color={t.colors.text} />} label="Archive chat" onPress={() => organize('archive')} /> : null}
          {side && features?.projects ? <SheetAction icon={<Folder size={20} color={t.colors.text} />} label="Move to project…"
            onPress={() => setMode('move')} /> : null}
          {onGoal ? <SheetAction icon={<Target size={20} color={t.colors.text} />} label={hasGoal ? 'Goal' : 'Set a goal'} onPress={() => { close(); onGoal(); }} /> : null}
          {onFiles ? <SheetAction icon={<Images size={20} color={t.colors.text} />} label="Files and photos" onPress={() => { close(); onFiles(); }} /> : null}
          {onCheckpoints ? <SheetAction icon={<FileDiff size={20} color={t.colors.text} />} label="Workspace checkpoints"
            onPress={() => { close(); onCheckpoints(); }} /> : null}
          {side ? <SheetAction icon={<Pencil size={20} color={t.colors.text} />} label="Rename" onPress={() => { setName(chat?.title ?? ''); setMode('rename'); }} /> : null}
          {features?.mute ? (until !== undefined ? (
            <SheetAction icon={<Bell size={20} color={t.colors.text} />} label={`Unmute${until ? ` (muted until ${clockTime(until)})` : ''}`} onPress={() => mute(null)} />
          ) : (
            <SheetAction icon={<BellOff size={20} color={t.colors.text} />} label="Mute notifications" onPress={() => setMode('mute')} />
          )) : null}
          {features?.export ? (
            <SheetAction icon={<Download size={20} color={t.colors.text} />} label={busy ? 'Exporting…' : 'Export chat'} onPress={async () => {
              setBusy(true);
              try {
                await exportChat(server, chatId, title.replace(/^#/, ''));
                close();
              } catch (e) {
                fail("Couldn't export")(e);
              } finally {
                setBusy(false);
              }
            }} />
          ) : null}
          <SheetAction icon={<Activity size={20} color={t.colors.text} />} label="Connection details" onPress={() => { close(); router.push(`/connection/${server.id}`); }} />
          {side ? <SheetAction icon={<Trash2 size={20} color={t.colors.danger} />} label="Delete chat" destructive onPress={() => setMode('delete')} /> : null}
        </>
      ) : mode === 'mute' ? (
        <>
          <Text style={s.menuNote}>Approvals and questions still come through: {server.bot.title} is waiting on those.</Text>
          {MUTE_OPTIONS.map((o) => <SheetAction key={o.label} label={o.label} onPress={() => mute(o.seconds)} />)}
        </>
      ) : mode === 'move' ? (
        <ProjectPicker server={server} chatId={chatId} onDone={close} />
      ) : mode === 'rename' ? (
        <View style={{ gap: 14, paddingHorizontal: 4 }}>
          <Field value={name} onChangeText={setName} placeholder="Chat name" autoFocus onSubmitEditing={rename} />
          <Button title="Save" onPress={rename} />
        </View>
      ) : (
        <View style={{ gap: 14, paddingHorizontal: 4 }}>
          <Text style={s.menuNote}>This removes the chat from Winglet on every device. Hermes keeps its own session history.</Text>
          <Button title="Delete chat" variant="danger" onPress={async () => { await deleteChat(server.id, chatId); organize('remove'); onDeleted?.(); }} />
          <Button title="Cancel" variant="secondary" onPress={() => setMode('menu')} />
        </View>
      )}
    </Sheet>
  );
}

const useStyles = makeStyles((t) => ({
  menuNote: { ...t.type.callout, color: t.colors.textSecondary, textAlign: 'center', paddingHorizontal: 12, marginBottom: 6 },
}));
