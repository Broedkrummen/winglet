import { chatKey } from './chatOrganization';
import type { Chat, Server } from './types';

export function sidebarDrawerWidth(width: number): number {
  return Math.min(340, width * 0.72);
}

export function navigationWidth(width: number, mode: 'auto' | 'drawer' | 'pinned' = 'auto'): number {
  if (mode === 'drawer') return 0;
  if (width >= 1100) return 280;
  return mode === 'pinned' ? 64 : 0;
}

/** Pinned conversations first; archives and the separate Updates feed stay out of recents. */
export function sidebarChats(servers: Server[], chats: Record<string, Record<string, Chat>>, pinned: string[], archived: string[], query = '', previews: Record<string, string | null> = {}) {
  const pins = new Set(pinned);
  const archives = new Set(archived);
  const q = query.trim().toLowerCase();
  return servers.flatMap((server) => Object.values(chats[server.id] ?? {}).filter((chat) =>
    chat.kind === 'chat' && !archives.has(chatKey(server.id, chat.id)) &&
    (!q || `${chat.title} ${server.bot.title} ${chat.preview ?? ''} ${previews[chatKey(server.id, chat.id)] ?? ''}`.toLowerCase().includes(q)),
  ).map((chat) => ({ server, chat, pinned: pins.has(chatKey(server.id, chat.id)) })))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.chat.updated_at - a.chat.updated_at);
}
