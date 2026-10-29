import { router } from 'expo-router';
import { startNewChat } from '../../lib/actions';
import { useLock } from '../../lib/appLock';
import { useApp } from '../../lib/store';
import type { CommandId } from './commands';

let creating = false;

/** Both the searchable list and shortcuts dispatch through the existing actions. */
export async function runCommand(id: CommandId, navigation: { home: () => void; close: () => void }) {
  if (useLock.getState().locked) return;
  navigation.close();
  if (id === 'home') navigation.home();
  else if (id === 'new-chat') {
    const state = useApp.getState();
    const server = state.servers.find(item => item.id === state.selection.serverId) ?? state.servers[0];
    if (!server || creating) return;
    creating = true;
    try { await startNewChat(server.id); } finally { creating = false; }
  } else {
    const path = id === 'commands' ? '/commands' : id === 'bots' ? '/bots' : id === 'chats' ? '/chats'
      : id === 'inbox' ? '/inbox' : '/settings';
    router.navigate(path);
  }
}
