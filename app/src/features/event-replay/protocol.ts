/**
 * The wire half of resumable events: what the server said, checked before anything trusts it.
 *
 * A resume reply decides whether the phone may keep its cursor or must reload its world, and the
 * events in it are applied without a second look, so everything here is validation first: a frame
 * that doesn't fit is ignored rather than half-applied. Older servers send none of this, which is
 * why every reader returns undefined instead of throwing.
 */

/** What `hello.event_stream` promises. Absent on servers before the feature. */
export type EventStreamInfo = {
  epoch: string;
  watermark: number;
  /** Retention, for explaining a refusal: "the oldest events fell off". */
  keep_events: number;
  keep_seconds: number;
};

/** Why the server can't replay from a cursor, and therefore why the phone must snapshot. */
export type RefusalReason = 'epoch' | 'cursor' | 'gap' | 'journal';

/** An event as the server committed it. `seq` orders it within the bot's stream. */
export type JournalEvent = { type: string; seq: number; chat_id?: string; [key: string]: unknown };

export type ResumeReply =
  | { ok: true; epoch: string; watermark: number; cursor: number; events: JournalEvent[]; has_more: boolean }
  | { ok: false; epoch?: string; watermark: number; reason: RefusalReason };

/** The authoritative scoped state behind `GET /api/sync/snapshot`. */
export type SyncSnapshot = {
  server_id: string;
  bot: string | null;
  epoch: string;
  watermark: number;
  chats: any[];
  inbox: any[];
  pending: number;
  paused: any;
  me?: any;
  deletions: Record<string, string[]>;
  retention?: { keep_events: number; keep_seconds: number };
};

const REFUSALS: RefusalReason[] = ['epoch', 'cursor', 'gap', 'journal'];
const DEFAULT_KEEP_EVENTS = 1500;
const DEFAULT_KEEP_SECONDS = 3 * 86400;

const object = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** A committed sequence number: a whole number, one or more. */
const seqOf = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

/** A count that may be zero (a watermark, a retention bound). */
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

export function eventStreamInfo(value: unknown): EventStreamInfo | undefined {
  if (!object(value)) return undefined;
  const epoch = value.epoch;
  // A stream without a generation can't be trusted with a saved cursor: leave it to a snapshot.
  if (typeof epoch !== 'string' || !epoch || !count(value.watermark)) return undefined;
  return {
    epoch,
    watermark: value.watermark,
    keep_events: count(value.keep_events) ? value.keep_events : DEFAULT_KEEP_EVENTS,
    keep_seconds: count(value.keep_seconds) ? value.keep_seconds : DEFAULT_KEEP_SECONDS,
  };
}

/** A live frame or replayed event, if it carries the seq that makes it resumable. */
export function journalEvent(value: unknown): JournalEvent | undefined {
  if (!object(value) || typeof value.type !== 'string' || !seqOf(value.seq)) return undefined;
  return value as JournalEvent;
}

/**
 * Sort by seq and drop repeated seqs. A replay page can overlap a live frame the phone buffered,
 * and applying the same event twice is safe but wasteful; the first copy wins because it is the one
 * that arrived in order.
 */
export function orderJournalEvents(events: JournalEvent[]): JournalEvent[] {
  const seen = new Set<number>();
  return [...events]
    .sort((a, b) => a.seq - b.seq)
    .filter((event) => (seen.has(event.seq) ? false : seen.add(event.seq) > 0));
}

export function resumeReply(value: unknown): ResumeReply | undefined {
  if (!object(value) || value.type !== 'resume') return undefined;
  const watermark = count(value.watermark) ? value.watermark : undefined;
  if (watermark === undefined) return undefined;
  if (value.ok === true) {
    if (typeof value.epoch !== 'string' || !value.epoch || !count(value.cursor) || !Array.isArray(value.events)) {
      return undefined;
    }
    if (value.cursor > watermark) return undefined;
    return {
      ok: true,
      epoch: value.epoch,
      watermark,
      cursor: value.cursor,
      events: value.events.map(journalEvent).filter((event): event is JournalEvent => !!event),
      has_more: value.has_more === true,
    };
  }
  if (value.ok === false) {
    // An unknown reason is still a refusal; snapshotting is the safe reading of it.
    const reason = REFUSALS.includes(value.reason) ? (value.reason as RefusalReason) : 'journal';
    return { ok: false, reason, watermark, ...(typeof value.epoch === 'string' && value.epoch ? { epoch: value.epoch } : {}) };
  }
  return undefined;
}

export function syncSnapshot(value: unknown): SyncSnapshot | undefined {
  if (!object(value)) return undefined;
  if (typeof value.server_id !== 'string' || typeof value.epoch !== 'string' || !value.epoch) return undefined;
  if (!count(value.watermark) || !Array.isArray(value.chats) || !Array.isArray(value.inbox)) return undefined;
  if (!count(value.pending)) return undefined;
  const deletions: Record<string, string[]> = {};
  if (object(value.deletions)) {
    for (const [chatId, ids] of Object.entries(value.deletions)) {
      if (!Array.isArray(ids)) continue;
      deletions[chatId] = ids.filter((id): id is string => typeof id === 'string');
    }
  }
  return {
    server_id: value.server_id,
    bot: typeof value.bot === 'string' ? value.bot : null,
    epoch: value.epoch,
    watermark: value.watermark,
    chats: value.chats.filter((chat) => object(chat) && typeof chat.id === 'string'),
    inbox: value.inbox.filter((item) => object(item) && typeof item.id === 'string'),
    pending: value.pending,
    paused: value.paused ?? null,
    me: value.me,
    deletions,
    retention: object(value.retention) && count(value.retention.keep_events)
      ? { keep_events: value.retention.keep_events, keep_seconds: count(value.retention.keep_seconds) ? value.retention.keep_seconds : DEFAULT_KEEP_SECONDS }
      : undefined,
  };
}
