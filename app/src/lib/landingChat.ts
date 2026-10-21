import { draftKey, useApp } from './store';

/** A local draft slot, never sent to the server as a chat ID. */
export const NEW_CHAT_DRAFT = 'local:new-chat';

/** One shared promise per bot prevents send/model/attachment taps creating duplicate chats. */
export function newChatTarget(serverId: string, resolved: (chatId: string) => void) {
  let id: string | undefined;
  let pending: Promise<string | null> | undefined;
  return (): Promise<string | null> => {
    if (id) return Promise.resolve(id);
    if (pending) return pending;
    pending = (async () => {
      try {
        const chat = await useApp.getState().createChat(serverId);
        if (!chat) return null;
        id = chat.id;
        const st = useApp.getState();
        // Read after creation: typing may have continued while the request was in flight.
        const key = draftKey(serverId, NEW_CHAT_DRAFT);
        st.setDraft(serverId, id, st.drafts[key] ?? '');
        st.setDraft(serverId, NEW_CHAT_DRAFT, '');
        resolved(id);
        return id;
      } catch {
        useApp.getState().toast({ serverId, title: "Couldn't start a chat", body: 'Your draft is saved. Try again when your bot is reachable.' });
        return null;
      } finally { pending = undefined; }
    })();
    return pending;
  };
}
