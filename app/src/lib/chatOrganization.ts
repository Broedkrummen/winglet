import type { Chat } from './types';

/** IDs are scoped to a bot; JSON encoding avoids delimiter collisions. */
export const chatKey = (serverId: string, chatId: string) => JSON.stringify([serverId, chatId]);

export function organizeChats(chats: Chat[], serverId: string, mainId: string, pinned: string[], archived: string[]) {
  const pins = new Set(pinned);
  const archives = new Set(archived);
  const groups: { pinned: Chat[]; recent: Chat[]; archived: Chat[] } = { pinned: [], recent: [], archived: [] };
  for (const chat of [...chats].sort((a, b) => b.updated_at - a.updated_at)) {
    if (chat.kind !== 'chat' || chat.id === mainId) continue;
    const key = chatKey(serverId, chat.id);
    groups[archives.has(key) ? 'archived' : pins.has(key) ? 'pinned' : 'recent'].push(chat);
  }
  return groups;
}

export function changeChatOrganization(prefs: { pinnedChats: string[]; archivedChats: string[] }, key: string, action: 'pin' | 'unpin' | 'archive' | 'restore' | 'remove') {
  const pinnedChats = prefs.pinnedChats.filter((id) => id !== key);
  const archivedChats = prefs.archivedChats.filter((id) => id !== key);
  if (action === 'pin') pinnedChats.push(key);
  else if (action === 'archive' || (action === 'unpin' && prefs.archivedChats.includes(key))) archivedChats.push(key);
  // Pinning also restores a chat; restoring never silently re-pins it.
  return { pinnedChats, archivedChats };
}
