import { cacheSet } from './cache';
import { useApp } from './store';
import type { InboxItem, Message } from './types';

const CACHED_MESSAGES = 200;
const CACHED_INBOX = 100;

/**
 * Write chats, recent messages, the inbox and drafts to the on-device cache as they change, batched
 * once a second and immediately when the app leaves the foreground. Only server-confirmed messages
 * are cached; the outbox persists itself.
 */
export function attachPersistence(): () => void {
  let prev = useApp.getState();
  const dirty = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const state = useApp.getState();
    for (const key of dirty) {
      if (key === 'reading') { cacheSet('reading', state.reading); continue; }
      if (key === 'drafts') {
        cacheSet('drafts', state.drafts);
        continue;
      }
      if (key === 'draftFiles') {
        // Only finished uploads are worth keeping: the server holds them for a day.
        const ready = Object.fromEntries(Object.entries(state.draftFiles)
          .map(([k, files]) => [k, files.filter((f) => f.status === 'ready' && !f.autoSend)]).filter(([, files]) => files.length));
        cacheSet('draftFiles', ready);
        continue;
      }
      if (key === 'replyTo') {
        cacheSet('replyTo', state.replyTo);
        continue;
      }
      const [kind, serverId, chatId] = key.split('|');
      const rt = state.runtime[serverId];
      if (!rt) continue; // removed meanwhile; removeServer clears its cache
      if (kind === 'chats') cacheSet(`chats:${serverId}`, rt.chats);
      else if (kind === 'inbox') cacheSet(`inbox:${serverId}`, recentInbox(Object.values(rt.inbox)));
      else if (kind === 'msgs' && rt.messages[chatId] && (rt.chats[chatId] || !Object.keys(rt.chats).length)) {
        cacheSet(`msgs:${serverId}:${chatId}`, cacheable(rt.messages[chatId]));
      }
    }
    dirty.clear();
  };

  const unsubscribe = useApp.subscribe((state) => {
    if (state.reading !== prev.reading) dirty.add('reading');
    if (state.drafts !== prev.drafts) dirty.add('drafts');
    if (state.draftFiles !== prev.draftFiles) dirty.add('draftFiles');
    if (state.replyTo !== prev.replyTo) dirty.add('replyTo');
    for (const [serverId, rt] of Object.entries(state.runtime)) {
      const before = prev.runtime[serverId];
      if (!before || rt === before) continue;
      if (rt.chats !== before.chats) dirty.add(`chats|${serverId}`);
      if (rt.inbox !== before.inbox) dirty.add(`inbox|${serverId}`);
      if (rt.messages !== before.messages) {
        for (const [chatId, list] of Object.entries(rt.messages)) {
          if (list !== before.messages[chatId] && rt.loaded[chatId]) dirty.add(`msgs|${serverId}|${chatId}`);
        }
      }
    }
    const backgrounding = prev.foreground && !state.foreground;
    prev = state;
    if (backgrounding || (!state.foreground && dirty.size)) flush();
    else if (dirty.size && !timer) timer = setTimeout(flush, 1000);
  });
  // pagehide also covers closing a browser tab before visibilitychange has reached the store.
  globalThis.addEventListener?.('pagehide', flush);
  return () => {
    unsubscribe();
    globalThis.removeEventListener?.('pagehide', flush);
    flush();
  };
}

export function cacheable(list: Message[]): Message[] {
  return list.filter((m) => m.status === 'final' || m.status === 'streaming').slice(-CACHED_MESSAGES);
}

function recentInbox(items: InboxItem[]): InboxItem[] {
  const pending = items.filter((i) => i.status === 'pending');
  const rest = items.filter((i) => i.status !== 'pending').sort((a, b) => b.created_at - a.created_at);
  return [...pending, ...rest].slice(0, Math.max(CACHED_INBOX, pending.length));
}
