import { Image } from 'expo-image';
import { Redirect, router } from 'expo-router';
import { useEffect } from 'react';
import { ScrollView, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { AgentFace } from '../components/AgentFace';
import { FileText, Hash, MessageCircle, X } from '../components/icons';
import { Screen } from '../components/Screen';
import { Button, Card, IconButton, ListGroup, ListRow, SectionHeader } from '../components/ui';
import { attachFiles } from '../lib/attach';
import { haptic } from '../lib/haptics';
import { formatSize } from '../lib/media';
import { mainChat, mergeDraft, shareTargets, type Shared } from '../lib/share';
import { usePendingShare } from '../lib/shareStore';
import { useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';

/** Something shared from another app: pick the chat it goes to. It lands in that chat's composer to send. */
export default function ShareScreen() {
  const t = useTheme();
  const s = useStyles();
  const shared = usePendingShare((st) => st.shared);
  const servers = useApp((st) => st.servers);
  const runtime = useApp((st) => st.runtime);
  // However the screen goes away (a chat picked, Cancel, or the system Back), the share goes with it.
  // Clearing it here rather than before navigating also keeps the screen from redirecting mid-transition.
  useEffect(() => () => usePendingShare.setState({ shared: null }), []);
  if (!shared) return <Redirect href="/" />;

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };
  const deliver = (serverId: string, chatId: string) => {
    const app = useApp.getState();
    app.setDraft(serverId, chatId, mergeDraft(app.drafts[`${serverId}:${chatId}`] ?? '', shared.text));
    if (shared.files.length) attachFiles(serverId, chatId, shared.files);
    app.select(serverId, chatId);
    haptic.success();
    router.replace(`/chat/${serverId}/${chatId}`);
  };

  return (
    <Screen title="Share to…" subtitle="Pick a chat. It goes into the message box there, so you can add a note before you send it."
      right={<IconButton label="Cancel" onPress={close}><X size={20} color={t.colors.text} /></IconButton>}>
      <Preview shared={shared} />
      {!servers.length ? (
        <Card style={{ gap: 12, marginTop: 18 }}>
          <Text style={s.body}>Pair Winglet with your Hermes server first, then share again.</Text>
          <Button title="Pair a server" onPress={() => router.replace('/pair')} />
        </Card>
      ) : servers.map((server) => {
        const rt = runtime[server.id];
        const main = mainChat(rt?.me?.home_chat, rt?.chats, server.deviceId);
        return (
          <Animated.View key={server.id} entering={FadeIn}>
            <SectionHeader title={server.bot.title} right={<AgentFace server={server} size={22} still />} />
            <ListGroup>
              {shareTargets(rt?.chats, main, server.deviceId).map((chat) => (
                <ListRow key={chat.id} title={chat.main ? `${server.bot.title} (main chat)` : chat.title}
                  icon={chat.main ? <MessageCircle size={18} color={t.colors.onAccentSoft} /> : <Hash size={18} color={t.colors.onAccentSoft} />}
                  onPress={() => deliver(server.id, chat.id)} />
              ))}
            </ListGroup>
          </Animated.View>
        );
      })}
    </Screen>
  );
}

function Preview({ shared }: { shared: Shared }) {
  const t = useTheme();
  const s = useStyles();
  return (
    <Card style={{ gap: 12, marginTop: 14 }}>
      {shared.files.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {shared.files.map((f, i) => f.isImage ? (
            <Image key={`${f.uri}-${i}`} source={{ uri: f.uri }} style={s.thumb} contentFit="cover" accessibilityLabel={f.name} />
          ) : (
            <View key={`${f.uri}-${i}`} style={s.file}>
              <FileText size={18} color={t.colors.textSecondary} />
              <Text style={s.fileName} numberOfLines={2}>{f.name}</Text>
              {f.size ? <Text style={s.fileSize}>{formatSize(f.size)}</Text> : null}
            </View>
          ))}
        </ScrollView>
      ) : null}
      {shared.text ? <Text style={s.text} numberOfLines={6} selectable>{shared.text}</Text> : null}
      {shared.dropped ? (
        <Text style={s.note}>Only the first {shared.files.length} files come along; {shared.dropped} more were left out.</Text>
      ) : null}
    </Card>
  );
}

const useStyles = makeStyles((t) => ({
  body: { ...t.type.callout, color: t.colors.textSecondary },
  text: { ...t.type.callout, color: t.colors.text },
  note: { ...t.type.caption, color: t.colors.textSecondary },
  thumb: { width: 84, height: 84, borderRadius: t.radius.md, backgroundColor: t.colors.surfaceSunken },
  file: { width: 120, height: 84, borderRadius: t.radius.md, padding: 10, gap: 4, backgroundColor: t.colors.surfaceSunken },
  fileName: { ...t.type.caption, color: t.colors.text },
  fileSize: { ...t.type.caption, color: t.colors.textTertiary },
}));
