/**
 * Folding a snapshot into what the phone already holds.
 *
 * The snapshot is authoritative for *scoped state*: which chats exist, their order and previews,
 * which cards are waiting, and which messages are gone. It is not authoritative for message text —
 * there is no transcript in it — so a chat's loaded page is kept unless a chat itself disappeared.
 *
 * What it must never do: touch a draft, a queued message or the reply the composer is holding. A
 * reconnect repairs state; it doesn't rewrite what you were in the middle of writing. That is why
 * this function only ever returns the keys below.
 */

import type { Chat, InboxItem, Me, Message, PauseState } from '../../lib/types';
import type { SyncSnapshot } from './protocol';

/** The part of a bot's runtime state a snapshot can replace. */
export type SyncSlices = {
  chats: Record<string, Chat>;
  messages: Record<string, Message[]>;
  deleted: Record<string, string[]>;
  loaded: Record<string, boolean>;
  inbox: Record<string, InboxItem>;
};

export type SyncMerge = {
  chats: Record<string, Chat>;
  messages: Record<string, Message[]>;
  deleted: Record<string, string[]>;
  loaded: Record<string, boolean>;
  inbox: Record<string, InboxItem>;
  pending: number;
  paused: PauseState;
  me?: Me;
};

export function mergeSnapshot(state: SyncSlices, snapshot: SyncSnapshot): SyncMerge {
  const chats: Record<string, Chat> = {};
  for (const chat of snapshot.chats as Chat[]) chats[chat.id] = chat;

  // A deletion is permanent, so what the phone already knew is unioned with what the server still
  // remembers: a tombstone can age out of the server's window while the message must stay gone.
  const deleted: Record<string, string[]> = {};
  for (const [chatId, ids] of Object.entries(state.deleted)) {
    if (chats[chatId]) deleted[chatId] = ids;
  }
  for (const [chatId, ids] of Object.entries(snapshot.deletions)) {
    if (!chats[chatId]) continue; // a chat this device can't see; its tombstones are none of its business
    deleted[chatId] = [...new Set([...(deleted[chatId] ?? []), ...ids])];
  }

  // Chats that vanished lose everything held for them; the rest keep their loaded page.
  const messages: Record<string, Message[]> = {};
  const loaded: Record<string, boolean> = {};
  for (const chatId of Object.keys(chats)) {
    const gone = new Set(deleted[chatId] ?? []);
    const page = state.messages[chatId];
    if (page) messages[chatId] = gone.size ? page.filter((m) => !gone.has(m.id)) : page;
    if (state.loaded[chatId]) loaded[chatId] = true;
  }

  const inbox: Record<string, InboxItem> = {};
  for (const item of snapshot.inbox as InboxItem[]) inbox[item.id] = item;

  return {
    chats,
    messages,
    deleted,
    loaded,
    inbox,
    pending: snapshot.pending,
    paused: (snapshot.paused ?? null) as PauseState,
    ...(snapshot.me ? { me: snapshot.me as Me } : {}),
  };
}
