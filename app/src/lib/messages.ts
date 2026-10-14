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

/** Hermes's tool names: snake_case (web_search, read_file) or one of its plain ones. */
const PLAIN_TOOLS = new Set(['terminal', 'process', 'browser', 'todo', 'memory', 'patch', 'delegate', 'clarify', 'cronjob', 'vision', 'search', 'think']);
/** One line of Hermes's tool progress: an emoji, the tool's name, and what it's doing ("🔍 web_search: "cats""). */
const PROGRESS_LINE = /^\p{Extended_Pictographic}️?\s+([a-z][a-z0-9]*(?:[_.-][a-z0-9]+)*)(?:\s*:.*|\s*\.{3}|\s*…)?$/u;

function isProgressLine(line: string): boolean {
  const m = PROGRESS_LINE.exec(line.trim());
  return !!m && (m[1].includes('_') || PLAIN_TOOLS.has(m[1]));
}

/**
 * Hermes narrating its own work, not answering: a tool-progress bubble ("🔍 web_search: …"), or a status note it
 * keeps updating in place (context pressure, fallback). The server can say so itself (`meta.activity`); otherwise
 * a bot message counts only when every line of it is tool progress, so a real answer that mentions a tool stays.
 */
export function isActivity(m: Message): boolean {
  const meta = m.meta ?? {};
  if (m.role === 'user' || meta.inbox_id || meta.picker || meta.kind || meta.attachments?.length || meta.reply_to || meta.routine) return false;
  if (meta.activity) return true;
  if (m.role === 'system') return !!meta.status_key;
  const lines = m.text.split('\n').filter((l) => l.trim());
  return m.role === 'bot' && m.text.length <= 1200 && lines.length > 0 && lines.every(isProgressLine);
}

export type Entry = { kind: 'msg'; m: Message } | { kind: 'activity'; id: string; items: Message[] };

/** The messages as the chat shows them: runs of backend activity folded into one entry, the replies as they are. */
export function groupActivity(messages: readonly Message[]): Entry[] {
  const out: Entry[] = [];
  for (const m of messages) {
    if (!isActivity(m)) {
      out.push({ kind: 'msg', m });
      continue;
    }
    const last = out[out.length - 1];
    if (last?.kind === 'activity') last.items.push(m);
    else out.push({ kind: 'activity', id: m.id, items: [m] });
  }
  return out;
}

/**
 * Pickers the model sheet asks for, which belong in the sheet and not the chat: every model picker, and the
 * reasoning choice that arrives while the sheet is waiting for it (a card not already in the chat when it asked).
 */
export function inSheet(m: Message, slot: { before: readonly string[]; claimed?: string; until: number } | undefined, now = Date.now()): boolean {
  const picker = m.meta?.picker;
  if (!picker) return false;
  if (picker.kind === 'model') return true;
  if (!slot || picker.kind !== 'choice') return false;
  return m.id === slot.claimed || (!slot.claimed && now < slot.until && !slot.before.includes(m.id));
}
