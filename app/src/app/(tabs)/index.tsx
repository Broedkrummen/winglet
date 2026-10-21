import { Redirect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, Platform, View } from 'react-native';
import { BotCarousel, type DeckPage } from '../../components/BotCarousel';
import { useAddBot } from '../../components/AddBot';
import { useAppNavigation } from '../../components/AppNavigation';
import { ChatView } from '../../components/ChatView';
import { focusComposer } from '../../components/Composer';
import { Button } from '../../components/ui';
import { NEW_CHAT_DRAFT, newChatTarget } from '../../lib/landingChat';
import { useMainBot } from '../../lib/mainBot';
import { homeChat, useApp } from '../../lib/store';
import { makeStyles } from '../../lib/themeContext';
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
  const chatId = useApp((st) => homeChat(st.runtime[server.id]));
  const [dockPage, setDockPage] = useState<DeckPage>('bot');
  const [newChatId, setNewChatId] = useState<string>();
  const [generation, setGeneration] = useState(0);
  const currentGeneration = useRef(0);
  const main = useMainBot();
  const mainBot = main ?? server;
  const addBot = useAddBot();
  const pageChanged = useCallback((page: DeckPage) => {
    setDockPage(page);
    if (page === 'add-bot') Keyboard.dismiss();
    if (page === 'new-chat') {
      currentGeneration.current++;
      setGeneration(currentGeneration.current);
      setNewChatId(undefined);
    }
  }, []);
  const prepareChat = useMemo(() => newChatTarget(mainBot.id, (id) => {
    if (currentGeneration.current === generation) setNewChatId(id);
  }), [mainBot.id, generation]);
  const dockAction = useCallback((page: 'new-chat' | 'add-bot') => {
    if (page === 'add-bot') addBot.open();
    else focusComposer(mainBot.id, newChatId ?? NEW_CHAT_DRAFT);
  }, [addBot.open, mainBot.id, newChatId]);
  return <View style={s.root}>
    <ChatView server={dockPage === 'new-chat' ? mainBot : server}
      chatId={dockPage === 'new-chat' ? newChatId ?? NEW_CHAT_DRAFT : chatId}
      landing={{ title: dockPage === 'new-chat' ? 'New chat' : dockPage === 'add-bot' ? 'Add a bot' : server.bot.title,
        dock: (props) => <BotCarousel selectedId={server.id} compact activePage={dockPage} {...props} onPageChange={pageChanged}
          onAction={dockAction} />,
        action: dockPage === 'add-bot' ? <Button title="Add a bot" onPress={addBot.open} /> : undefined,
        prepareChat: dockPage === 'new-chat' && !newChatId ? prepareChat : undefined }} />
    {addBot.sheet}
  </View>;
}

const useStyles = makeStyles((t) => ({
  root: { flex: 1, backgroundColor: t.colors.bg },
}));
