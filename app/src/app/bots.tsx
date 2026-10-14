import { router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { useAddBot } from '../components/AddBot';
import { AgentFace } from '../components/AgentFace';
import { Plus, Trash2 } from '../components/icons';
import { Screen } from '../components/Screen';
import { Button, ListGroup, ListRow, SectionHeader } from '../components/ui';
import { addressKind, connectionView } from '../lib/connection';
import { homeChat, useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';

/** Every bot this phone is paired with. Removing one unpairs this phone from it. */
export default function BotsScreen() {
  const t = useTheme();
  const s = useStyles();
  const servers = useApp((st) => st.servers);
  const runtime = useApp((st) => st.runtime);
  const network = useApp((st) => st.network);
  const removeServer = useApp((st) => st.removeServer);
  const select = useApp((st) => st.select);
  const [confirm, setConfirm] = useState<string | null>(null);
  const addBot = useAddBot();
  return (
    <Screen title="Your bots" subtitle="Each bot is a Hermes profile on one of your machines.">
      <SectionHeader title={`${servers.length} paired`} />
      <ListGroup>
        {servers.map((srv) => {
          const view = connectionView(network, runtime[srv.id], srv.bot.title);
          const parent = srv.parent ? servers.find((x) => x.id === srv.parent) : undefined;
          return (
            <View key={srv.id}>
              <ListRow icon={<AgentFace server={srv} size={32} still />} iconColor="transparent"
                title={srv.bot.title} subtitle={parent ? `${view.kind === 'online' ? 'Online' : view.title} · on ${parent.bot.title}'s server`
                  : `${view.kind === 'online' ? 'Online' : view.title} · ${addressKind(srv.url)}`}
                onPress={() => { select(srv.id, homeChat(useApp.getState().runtime[srv.id])); router.navigate('/agent'); }} right={parent ? undefined : (
                  <Button size="sm" variant={confirm === srv.id ? 'danger' : 'ghost'} title={confirm === srv.id ? 'Remove' : ''}
                    accessibilityLabel={confirm === srv.id ? `Confirm removing ${srv.bot.title}` : `Remove ${srv.bot.title}`}
                    icon={<Trash2 size={16} color={t.colors.danger} />}
                    onPress={() => { if (confirm !== srv.id) setConfirm(srv.id); else { setConfirm(null); removeServer(srv.id); } }} />
                )} chevron={false} />
            </View>
          );
        })}
        <ListRow icon={<Plus size={18} color={t.colors.success} />} iconColor={t.colors.success} title="Add a bot" onPress={addBot.open} />
      </ListGroup>
      {addBot.sheet}
      <Text style={s.note}>Removing a server's bot unpairs this phone from that server and its other bots. Their chats stay on the server; pair again any time with a new code.</Text>
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  note: { ...t.type.caption, fontFamily: t.fonts.regular, fontSize: 13, color: t.colors.textSecondary, marginTop: 12, lineHeight: 18 },
}));
