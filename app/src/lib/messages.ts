import type { Message } from './types';

const isLocal = (m: Message) => m.status === 'pending' || m.status === 'queued' || m.status === 'failed';

/** Only completed answers produce chat alerts. Inbox cards have their own alert. */
export function isNotifiable(m: Message): boolean {
  const meta = m.meta ?? {};
  return m.role === 'bot' && m.status === 'final' && meta.notify !== false
    && !meta.hidden && !meta.picker && !meta.inbox_id && !meta.activity && !meta.status_key && !meta.routine
    && !activityKind(m) && !!(m.text.trim() || meta.attachments?.length);
}

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
/** One line of Hermes's tool progress: an emoji, the tool's name, and what it's doing ("🔍 web_search: "cats""), and "(×3)" when it repeats. */
const PROGRESS_LINE = /^\p{Extended_Pictographic}\uFE0F?\s+([a-z][a-z0-9]*(?:[_.-][a-z0-9]+)*)(?:\s*:.*|\s*\.{3}|\s*…)?(?:\s+\(×\d+\))?$/u;
/** The same lines in Hermes's friendly wording ("🔍 Searching the web for cats"): the verbs it has for its built-in tools. */
const FRIENDLY_VERBS = [
  'Searching the web', 'Searching past sessions', 'Searching files', 'Reading skill', 'Listing skills', 'Updating skill', 'Updating memory',
  'Updating tasks', 'Looking at the image', 'Generating image', 'Generating video', 'Generating speech', 'Running code', 'Running', 'Reading',
  'Browsing', 'Clicking', 'Typing', 'Writing', 'Editing', 'Delegating', 'Scheduling', 'Asking',
];
const FRIENDLY_LINE = new RegExp(`^\\p{Extended_Pictographic}\\uFE0F?\\s+(?:${FRIENDLY_VERBS.join('|')})(?:\\s.*)?$`, 'u');

function isProgressLine(line: string): boolean {
  const m = PROGRESS_LINE.exec(line.trim());
  return !!m && (m[1].includes('_') || PLAIN_TOOLS.has(m[1]));
}

const isFriendlyLine = (line: string) => FRIENDLY_LINE.test(line.trim());

/** A bot message that could be Hermes narrating its work, with no attachment, picker, card or reply on it. */
function isPlainBot(m: Message): boolean {
  const meta = m.meta ?? {};
  return m.role === 'bot' && !(meta.inbox_id || meta.picker || meta.kind || meta.attachments?.length || meta.reply_to || meta.routine) && m.text.length <= 1200;
}

/**
 * How sure we are that a message is Hermes narrating its own work, not answering. "sure": the server says so
 * (`meta.activity`), it's a status note Hermes updates in place, or every line is a tool-progress line with
 * the tool's own name. "maybe": every line is in Hermes's friendly wording, which a real answer could also
 * start with, so it counts only where an answer follows (see `groupActivity`).
 */
export function activityKind(m: Message): 'sure' | 'maybe' | null {
  const meta = m.meta ?? {};
  if (m.role === 'user' || meta.inbox_id || meta.picker || meta.kind || meta.attachments?.length || meta.reply_to || meta.routine) return null;
  if (meta.activity) return 'sure';
  if (m.role === 'system') return meta.status_key ? 'sure' : null;
  if (!isPlainBot(m)) return null;
  const lines = m.text.split('\n').filter((l) => l.trim());
  if (!lines.length) return null;
  if (lines.every(isProgressLine)) return 'sure';
  // Hermes posts its progress whole; a reply still streaming in that starts like one is a reply.
  if (m.status === 'streaming') return null;
  return lines.every((l) => isProgressLine(l) || isFriendlyLine(l)) ? 'maybe' : null;
}

/** Hermes narrating its work (see `activityKind`), without the ones that depend on what comes after. */
export const isActivity = (m: Message) => activityKind(m) === 'sure';

export type Entry = { kind: 'msg'; m: Message } | { kind: 'activity'; id: string; items: Message[] };

/**
 * The messages as the chat shows them: runs of backend activity folded into one entry, the replies as they are.
 * A "maybe" message folds when the reply it led up to comes after it, or while the bot is still working on it
 * (`typing`) and nothing from you comes after it. A turn that ended on one keeps it visible: it may be the answer.
 */
export function groupActivity(messages: readonly Message[], typing = false): Entry[] {
  const hidden = new Set<string>();
  let answered = false; // a real reply later in the same turn
  let open = true; // no message from you later: this is the turn still in progress
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') { answered = false; open = false; continue; }
    const kind = activityKind(m);
    if (kind === 'sure' || (kind === 'maybe' && (answered || (open && typing)))) hidden.add(m.id);
    else if (m.role === 'bot') answered = true;
  }
  const out: Entry[] = [];
  for (const m of messages) {
    if (!hidden.has(m.id)) {
      out.push({ kind: 'msg', m });
      continue;
    }
    const last = out[out.length - 1];
    if (last?.kind === 'activity') last.items.push(m);
    else out.push({ kind: 'activity', id: m.id, items: [m] });
  }
  return out;
}

type SheetSlot = { before: readonly string[]; claimed?: string; until: number };

/**
 * Pickers the model sheet asks for, which belong in the sheet and not the chat: a model or reasoning card that
 * answers a command the sheet sent (`answersHidden`: the latest user message before it is a hidden one), and the
 * reasoning choice that arrives while the sheet is waiting for it (a card not already in the chat when it asked).
 * A /model or /reasoning typed in the chat by hand gets its card in the chat, as before.
 */
export function inSheet(m: Message, slot: SheetSlot | undefined, now = Date.now(), answersHidden = false): boolean {
  const picker = m.meta?.picker;
  if (!picker || (picker.kind !== 'model' && picker.kind !== 'choice')) return false;
  if (answersHidden) return true;
  if (!slot || picker.kind !== 'choice') return false;
  return m.id === slot.claimed || (!slot.claimed && now < slot.until && !slot.before.includes(m.id));
}

/** The conversation as the chat shows it: without the commands the app sent for a control, or the cards that went to the sheet. */
export function chatMessages(messages: readonly Message[], slot: SheetSlot | undefined, now = Date.now()): Message[] {
  const out: Message[] = [];
  let hiddenAsk = false;
  for (const m of messages) {
    if (m.role === 'user') hiddenAsk = !!m.meta?.hidden;
    if (m.meta?.hidden || inSheet(m, slot, now, hiddenAsk)) continue;
    out.push(m);
  }
  return out;
}
