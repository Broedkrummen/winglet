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
