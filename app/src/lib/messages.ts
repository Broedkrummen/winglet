import type { Message } from './types';

const isLocal = (m: Message) => m.status === 'pending' || m.status === 'queued' || m.status === 'failed';

/**
 * Preserve newer live replies and older pages while applying durable deletions from history or the
 * socket. Server insertion positions, rather than timestamps, determine history and paging order.
 */
export function mergeMessages(current: Message[], incoming: Message[], deletedIds: string[] = [], older = false): Message[] {
  const deleted = new Set(deletedIds);
  const byId = new Map<string, Message>();
  // For older servers without positions, preserve page order on equal timestamps too.
  for (const m of older ? [...incoming, ...current] : [...current, ...incoming]) {
    if (deleted.has(m.id)) continue;
    const have = byId.get(m.id);
    if (!have || m.updated_at >= have.updated_at) {
      // Keep the same object when nothing changes, so rows that didn't change don't re-render.
      const position = m.position ?? have?.position;
      byId.set(m.id, position === m.position ? m : { ...m, position });
    }
  }
  const confirmed = new Set<string>();
  for (const m of byId.values()) {
    if (!isLocal(m) && m.meta?.client_id) confirmed.add(m.meta.client_id);
  }
  const rows = [...byId.values()].filter((m) => !(isLocal(m) && m.meta?.client_id && confirmed.has(m.meta.client_id)));
  const history = rows.filter((m) => !isLocal(m)).sort((a, b) =>
    a.position !== undefined && b.position !== undefined ? a.position - b.position : a.created_at - b.created_at);
  const local = rows.filter(isLocal).sort((a, b) => a.created_at - b.created_at);
  return [...history, ...local];
}

/** Mark an optimistic send as failed, unless the server already confirmed it (e.g. over the socket). */
export function markFailed(list: Message[], clientId: string): Message[] {
  return list.map((m) => (m.id === clientId && m.status === 'pending' ? { ...m, status: 'failed' } : m));
}
