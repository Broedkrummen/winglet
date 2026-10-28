import { Redirect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { useBotSheet } from '../../components/BotSwitcher';
import { SquarePen, X } from '../../components/icons';
import { IconButton } from '../../components/ui';
import { useAppNavigation } from '../../components/AppNavigation';
import { ChatView } from '../../components/ChatView';
import { focusComposer } from '../../components/Composer';
import { Landing, type LandingMode } from '../../components/Landing';
import { NEW_CHAT_DRAFT, newChatTarget } from '../../lib/landingChat';
import { useMainBot } from '../../lib/mainBot';
import { mergeDraft } from '../../lib/share';
import { draftKey, homeChat, useApp } from '../../lib/store';
import { makeStyles, useTheme } from '../../lib/themeContext';
import type { Server } from '../../lib/types';

function pairFromHash(): { code: string; fp?: string } | null {
  if (Platform.OS !== 'web') return null;
  const hash = globalThis.location?.hash ?? '';
  const m = hash.match(/pair=([A-Za-z0-9-]+)/);
  const fp = hash.match(/[&#]fp=([A-Za-z0-9_-]{16,64})/);
  return m ? { code: m[1], ...(fp ? { fp: fp[1] } : {}) } : null;
}

/** A quiet, chat-first landing. History and the rest of the app live in the sidebar. */
export default function Home() {
  const servers = useApp((st) => st.servers);
  const selection = useApp((st) => st.selection);
  const main = useMainBot();
  const { homeRevision } = useAppNavigation();
  const hashLink = pairFromHash();
  useEffect(() => {
    if (!selection.serverId && main) useApp.getState().select(main.id, homeChat(useApp.getState().runtime[main.id]));
  }, [selection.serverId, main]);
  if (hashLink) {
    globalThis.history?.replaceState(null, '', '/');
    return <Redirect href={{ pathname: '/pair', params: { ...hashLink, url: globalThis.location.origin } }} />;
  }
  if (!servers.length) return <Redirect href="/pair" />;
  return <HomeFor key={homeRevision} server={servers.find((x) => x.id === selection.serverId) ?? servers[0]} />;
}

function HomeFor({ server }: { server: Server }) {
  const s = useStyles();
  const t = useTheme();
  const chatId = useApp((st) => homeChat(st.runtime[server.id]));
  const [mode, setMode] = useState<LandingMode>('bot');
  const [newChatId, setNewChatId] = useState<string>();
  const [generation, setGeneration] = useState(0);
  const currentGeneration = useRef(0);
  const bots = useBotSheet(server);
  const changeMode = useCallback((next: LandingMode) => {
    setMode(next);
    if (next === 'new-chat') {
      currentGeneration.current++;
      setGeneration(currentGeneration.current);
      setNewChatId(undefined);
    }
  }, []);
  // A bot picked elsewhere (the sidebar, the header) brings the landing back to that bot.
  const previous = useRef(server.id);
  useEffect(() => { if (previous.current !== server.id) { previous.current = server.id; setMode('bot'); } }, [server.id]);
  const prepareChat = useMemo(() => newChatTarget(server.id, (id) => {
    if (currentGeneration.current === generation) setNewChatId(id);
  }), [server.id, generation]);
  const fresh = mode === 'new-chat';
  const targetChat = fresh ? newChatId ?? NEW_CHAT_DRAFT : chatId;
  const suggest = useCallback((text: string) => {
    const app = useApp.getState();
    // Anything already typed stays; the suggestion goes after it.
    app.setDraft(server.id, targetChat, mergeDraft(app.drafts[draftKey(server.id, targetChat)] ?? '', text));
    focusComposer(server.id, targetChat);
  }, [server.id, targetChat]);
  return <View style={s.root}>
    <ChatView server={server} chatId={targetChat}
      landing={{ title: server.bot.title, onTitlePress: bots.open,
        actions: fresh
          ? <IconButton label="Cancel new chat" onPress={() => changeMode('bot')}><X size={22} color={t.colors.text} /></IconButton>
          : <IconButton label="New chat" onPress={() => changeMode('new-chat')}><SquarePen size={21} color={t.colors.text} /></IconButton>,
        dock: (props) => <Landing server={server} mode={mode} onSuggest={suggest} {...props} />,
        prepareChat: fresh && !newChatId ? prepareChat : undefined }} />
    {bots.sheet}
  </View>;
}

const useStyles = makeStyles((t) => ({
  root: { flex: 1, backgroundColor: t.colors.bg },
}));
