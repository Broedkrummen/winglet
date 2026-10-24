import { router } from 'expo-router';
import { api } from './api';
import { homeChat, useApp } from './store';
import type { Server } from './types';

/**
 * Start a side chat and open it: where you are decides how it opens (a phone pushes the chat, the wide layout
 * shows it beside the list), but the failure is the same everywhere.
 */
export async function startNewChat(serverId: string, open: (chatId: string) => void = (id) => router.push(`/chat/${serverId}/${id}`)) {
  try {
    const chat = await useApp.getState().createChat(serverId);
    if (chat) open(chat.id);
  } catch {
    useApp.getState().toast({ serverId, title: "Couldn't start a chat", body: 'Your bot is out of reach right now. Try again when it’s back.' });
  }
}

/** Send a question to the bot's main chat and go there to watch the answer arrive. */
export function askMainChat(serverId: string, text: string) {
  const main = homeChat(useApp.getState().runtime[serverId]);
  useApp.getState().sendMessage(serverId, main, text);
  router.push(`/chat/${serverId}/${main}`);
}

/** A command the app sends for a control (/model, /reasoning): Hermes answers with a card, and the command itself stays out of the chat. */
export function sendHidden(server: Server, chatId: string, text: string, what: string) {
  return api(server, `/api/chats/${encodeURIComponent(chatId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text, hidden: true, client_id: `c-${Date.now().toString(36)}-${what}` }),
  }).catch((e) => useApp.getState().toast({ serverId: server.id, title: `Couldn't ask for ${what}`, body: (e as Error).message }));
}

const stopping = new Set<string>();

/** Stop belongs to the task running now. It must never sit in the offline outbox. */
export async function stopTask(server: Server, chatId: string): Promise<boolean> {
  const key = JSON.stringify([server.id, chatId]);
  if (stopping.has(key)) return false;
  const state = useApp.getState();
  if (!state.network || state.runtime[server.id]?.status !== 'online') {
    state.toast({ serverId: server.id, title: 'Reconnect to stop', body: 'Stop is available when your bot is connected.' });
    return false;
  }
  stopping.add(key);
  try {
    await api(server, `/api/chats/${encodeURIComponent(chatId)}/messages`, {
      method: 'POST', body: JSON.stringify({ text: '/stop', hidden: true,
        client_id: `c-${Date.now().toString(36)}-stop-${Math.random().toString(36).slice(2, 7)}` }),
    });
    return true;
  } catch (error) {
    useApp.getState().toast({ serverId: server.id, title: "Couldn't stop", body: (error as Error).message });
    return false;
  } finally { stopping.delete(key); }
}
