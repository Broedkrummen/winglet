import { Redirect, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { ChatView } from '../../../components/ChatView';
import { useApp } from '../../../lib/store';

export default function ChatScreen() {
  const { serverId, chatId } = useLocalSearchParams<{ serverId: string; chatId: string }>();
  const server = useApp((s) => s.servers.find((x) => x.id === serverId));
  useEffect(() => { if (server) useApp.getState().select(server.id, chatId); }, [server?.id, chatId]);
  if (!server) return <Redirect href="/" />;
  return <ChatView server={server} chatId={chatId} showBack />;
}
