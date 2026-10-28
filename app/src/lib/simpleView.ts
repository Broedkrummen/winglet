import type { Chat } from './types';
import { chatKey } from './chatOrganization';

export type BotOpening = 'last' | 'main' | 'list';

/** Missing, archived and Updates destinations never silently become the bot's resumed conversation. */
export function simpleBotChat(serverId: string, main: string, chats: Record<string, Chat> | undefined,
  last: string | undefined, opening: BotOpening, archived: string[]): string | undefined {
  if (opening === 'list') return undefined;
  if (opening === 'last' && last && chats?.[last]?.kind === 'chat' && !archived.includes(chatKey(serverId, last))) return last;
  return main;
}

export function simpleSidebarWidth(width: number, fontScale = 1): number {
  return width / Math.max(1, fontScale) >= 900 ? 280 : 0;
}
