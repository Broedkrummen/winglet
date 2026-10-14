import type { Mood } from '../components/BotAvatar';
import { isTyping, type ServerState } from './store';
import type { Chat, InboxItem } from './types';

const CELEBRATE_MS = 2500;

/** Chats where the agent is working right now, newest first. */
export function workingChats(rt: ServerState | undefined): Chat[] {
  if (!rt) return [];
  return Object.values(rt.chats).filter((c) => isTyping(rt, c.id)).sort((a, b) => b.updated_at - a.updated_at);
}

export function pendingItems(rt: ServerState | undefined): InboxItem[] {
  if (!rt) return [];
  return Object.values(rt.inbox).filter((i) => i.status === 'pending').sort((a, b) => b.created_at - a.created_at);
}

/** The face the agent should make: offline beats needing you, which beats working. */
export function moodOf(rt: ServerState | undefined, now = Date.now()): Mood {
  if (!rt || rt.status !== 'online') return 'offline';
  if (pendingItems(rt).length) return 'waiting';
  if (workingChats(rt).length) return 'working';
  if (rt.lastReplyAt && now - rt.lastReplyAt < CELEBRATE_MS) return 'happy';
  return 'idle';
}

export function chatName(chat: Chat | undefined): string {
  if (!chat) return 'a chat';
  return chat.kind === 'home' ? 'Updates' : chat.title;
}

/** One line for Home: what the agent is doing, in plain words. */
export function headline(rt: ServerState | undefined, bot: string): { title: string } {
  const mood = moodOf(rt);
  const pending = pendingItems(rt);
  const working = workingChats(rt);
  if (mood === 'offline') return { title: `${bot} is out of reach` };
  if (mood === 'waiting') {
    return { title: pending.length === 1 ? `${bot} needs you` : `${bot} needs you · ${pending.length}` };
  }
  if (mood === 'working') {
    return { title: working.length === 1 ? `Working on ${chatName(working[0])}` : `Working on ${working.length} things` };
  }
  return { title: 'All quiet' };
}

export function ago(ts: number, now = Date.now() / 1000): string {
  const s = Math.max(0, now - ts);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(ts * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** "just now", "5m ago", "Sep 30". */
export function agoText(ts: number, now = Date.now() / 1000): string {
  const a = ago(ts, now);
  return a === 'now' ? 'just now' : /\d[mhd]$/.test(a) ? `${a} ago` : a;
}
