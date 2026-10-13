import { router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { signedApi } from '../lib/api';
import { haptic } from '../lib/haptics';
import { useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';
import type { BotRow, Server } from '../lib/types';
import { Pencil, Trash2 } from './icons';
import { Sheet } from './Sheet';
import { Button, Field, ListGroup, ListRow, SectionHeader } from './ui';

/** Rename or delete one of a server's other bots. Changes go through its server, as Hermes Desktop's do. */
export function ManageBot({ server, parent }: { server: Server; parent: Server }) {
  const t = useTheme();
  const s = useStyles();
  const [sheet, setSheet] = useState<'rename' | 'delete' | null>(null);
  const [title, setTitle] = useState(server.bot.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const path = `/api/bots/${encodeURIComponent(server.profile ?? '')}`;

  const close = () => { setSheet(null); setError(''); };
  const rename = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await signedApi<{ bot: BotRow }>(parent, 'PATCH', path, { title: title.trim() });
      useApp.getState().updateServer(server.id, { bot: { name: r.bot.name, title: r.bot.title, description: r.bot.description } });
      haptic.success();
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    setError('');
    try {
      await signedApi(parent, 'DELETE', path);
      haptic.success();
      close();
      await useApp.getState().removeServer(server.id, false);
      useApp.getState().select(parent.id);
      router.replace('/');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SectionHeader title="This bot" />
      <ListGroup>
        <ListRow icon={<Pencil size={18} color={t.colors.onAccentSoft} />} title="Rename" value={server.bot.title}
          onPress={() => { setTitle(server.bot.title); setSheet('rename'); }} />
        <ListRow icon={<Trash2 size={18} color={t.colors.danger} />} iconColor={t.colors.danger} title={`Delete ${server.bot.title}`} destructive
          onPress={() => setSheet('delete')} />
      </ListGroup>
      <Text style={s.note}>
        {server.bot.title} runs on {parent.bot.title}'s server. Its status, updates, devices and security are under {parent.bot.title}.
      </Text>

      <Sheet visible={sheet === 'rename'} onClose={close} title="Rename">
        <View style={{ gap: 12, paddingHorizontal: 4 }}>
          <Field label="Name" value={title} onChangeText={setTitle} maxLength={60} autoFocus />
          <Text style={s.note}>Hermes and your other bots still call it @{server.profile}.</Text>
          {error ? <Text style={s.error}>{error}</Text> : null}
          <Button title="Save" loading={busy} disabled={!title.trim() || title.trim() === server.bot.title} onPress={rename} />
        </View>
      </Sheet>
      <Sheet visible={sheet === 'delete'} onClose={close} title={`Delete ${server.bot.title}?`}>
        <View style={{ gap: 12, paddingHorizontal: 4 }}>
          <Text style={s.body}>
            Its Hermes profile is deleted from the server: its persona, memory, skills, schedule and every conversation, here and in
            any other app. This can't be undone.
          </Text>
          {error ? <Text style={s.error}>{error}</Text> : null}
          <Button title={`Delete ${server.bot.title}`} variant="danger" loading={busy} icon={<Trash2 size={16} color={t.colors.danger} />}
            onPress={remove} />
          <Button title="Keep it" variant="secondary" onPress={close} />
        </View>
      </Sheet>
    </>
  );
}

const useStyles = makeStyles((t) => ({
  note: { ...t.type.caption, color: t.colors.textSecondary, marginTop: 10, paddingHorizontal: 4 },
  body: { ...t.type.callout, color: t.colors.text },
  error: { ...t.type.callout, color: t.colors.danger },
}));
