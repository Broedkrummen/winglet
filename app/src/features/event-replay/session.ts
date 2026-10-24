/**
 * The client half of resumable events: one per socket, decides what to ask for, what to hold back
 * and when to give up on the journal.
 *
 * It is deliberately free of React and of the store so its behaviour can be tested on its own: the
 * transport hands it every frame, it hands back the frames to apply and the frames to send. The
 * rules it enforces:
 *
 * - A journaled frame that arrives while catching up is **held**, never applied, because the replay
 *   page it overlaps may still be on its way; applying live first would let a `message.update` land
 *   before the `message.new` it edits.
 * - The cursor only ever moves to a position the server proved: a page's `cursor`, the final
 *   `watermark`, or a snapshot's `watermark`. It never moves to "the last frame I saw", because the
 *   seq a phone receives has gaps where events were not for it.
 * - Anything the journal can't prove (another generation, a cursor past the head, a retention hole)
 *   is repaired with the snapshot endpoint, not by guessing.
 *
 * Delivery is at-least-once: a page can repeat events the phone already has, and a live frame can
 * duplicate one in the reply. Both are applied as idempotent upserts by the store, and `orderJournalEvents`
 * drops the duplicate seq.
 */

import type { SyncPhase, SyncState } from '../../lib/types';
import {
  eventStreamInfo, journalEvent, orderJournalEvents, resumeReply, syncSnapshot,
  type EventStreamInfo, type JournalEvent, type RefusalReason, type ResumeReply, type SyncSnapshot,
} from './protocol';

/** Where this phone got to in one bot's journal. Persisted per `(server, bot)`. */
export type ReplayCursor = { epoch: string; cursor: number };

export type { SyncPhase };

/** What the UI shows. `caught` counts events applied in this catch-up. */
export type SyncView = SyncState;

/** Everything this session needs from its owner; the transport sends and fetches beside it. */
export type SyncHost = {
  /** The cursor saved for this bot, from a previous run of the app. */
  read(): ReplayCursor | undefined;
  /** Remember a cursor. Must be cheap: it is called after every page and snapshot. */
  write(cursor: ReplayCursor): void;
  /** Apply one committed event, exactly as a live frame would be applied. */
  apply(event: JournalEvent): void;
  /** Replace this bot's scoped state with the snapshot. */
  applySnapshot(snapshot: SyncSnapshot): void;
  /** Show catching up / blocked in the UI. */
  view(view: SyncView): void;
};

export type SyncTransport = {
  send(frame: { type: 'resume'; cursor: number; epoch: string }): void;
  /** `GET /api/sync/snapshot`; a rejection means "couldn't right now", not "not supported". */
  fetch(): Promise<unknown>;
};

/** A page is 200 events; twelve of them is well past the journal's own retention. */
export const MAX_PAGES = 12;

export class SyncSession {
  private phase: SyncPhase = 'unsupported';
  private stream?: EventStreamInfo;
  private cursor?: ReplayCursor;
  private held: JournalEvent[] = [];
  private caught = 0;
  private pages = 0;
  private reason?: RefusalReason | 'network';
  /** Bumped whenever the socket or the stream generation changes, so late replies are ignored. */
  private generation = 0;
  private running = false;

  constructor(private host: SyncHost, private send: (frame: { type: 'resume'; cursor: number; epoch: string }) => void) {}

  /**
   * Called for every frame before the store sees it. Returning true means this session took the
   * frame: either it is a resume reply, or a journaled frame held back until the catch-up finishes.
   */
  intercept(event: any): boolean {
    const reply = resumeReply(event);
    if (reply) {
      void this.onReply(reply);
      return true;
    }
    const journal = journalEvent(event);
    if (journal && (this.phase === 'catching-up' || this.phase === 'snapshot')) {
      this.held.push(journal);
      return true;
    }
    return false;
  }

  /** Called after a frame has been applied to the store. */
  note(event: any): void {
    if (event?.type === 'hello') {
      this.begin(event);
      return;
    }
    const journal = journalEvent(event);
    if (!journal || !this.cursor) return;
    if (journal.seq > this.cursor.cursor) this.remember({ epoch: this.cursor.epoch, cursor: journal.seq });
  }

  /** The socket is gone. Held frames were never applied, so the saved cursor still covers them. */
  closed(): void {
    this.generation += 1;
    this.held = [];
    this.stream = undefined;
    this.cursor = undefined;
    this.reason = undefined;
    this.caught = 0;
    this.pages = 0;
    this.running = false;
    this.phase = 'idle';
  }

  /** "Resync now": try the snapshot again after a failure. No-op in any other state. */
  retry(): void {
    if (this.phase !== 'blocked') return;
    void this.recover(this.reason ?? 'network', this.generation);
  }

  view(): SyncView {
    return { phase: this.phase, caught: this.caught, reason: this.reason };
  }

  // -- the handshake ---------------------------------------------------------------------

  private begin(hello: any): void {
    this.generation += 1;
    const generation = this.generation;
    this.held = [];
    this.caught = 0;
    this.pages = 0;
    this.reason = undefined;
    this.cursor = undefined;
    this.stream = eventStreamInfo(hello?.event_stream);
    if (!this.stream || hello?.features?.event_replay !== true) {
      // An older server: nothing to resume, and nothing to warn about.
      this.phase = 'unsupported';
      this.publish();
      return;
    }
    const saved = this.host.read();
    if (!saved) {
      // First connection since the app learned to resume: hello *is* the snapshot, and the watermark
      // is where live frames start. Nothing to replay, nothing to reload.
      this.phase = 'idle';
      this.remember({ epoch: this.stream.epoch, cursor: this.stream.watermark });
      this.publish();
      return;
    }
    this.phase = 'catching-up';
    if (saved.epoch !== this.stream.epoch) {
      // A restored database or a reset journal: the saved position describes events that no longer exist.
      this.publish();
      void this.recover('epoch', generation);
      return;
    }
    if (saved.cursor > this.stream.watermark) {
      // The server's journal is behind the cursor: it never issued this position in this generation.
      this.publish();
      void this.recover('cursor', generation);
      return;
    }
    this.remember(saved);
    this.publish();
    this.send({ type: 'resume', cursor: saved.cursor, epoch: saved.epoch });
  }

  private async onReply(reply: ResumeReply): Promise<void> {
    if (this.phase !== 'catching-up') return; // a reply for a socket or generation we already left
    const generation = this.generation;
    if (!reply.ok) {
      // Apply what arrived while we were asking: those events are committed and on this socket.
      this.release();
      await this.recover(reply.reason, generation);
      return;
    }
    if (!this.cursor || reply.watermark < this.cursor.cursor) {
      this.release();
      await this.recover('cursor', generation);
      return;
    }
    if (this.stream && reply.epoch !== this.stream.epoch) {
      this.release();
      await this.recover('epoch', generation);
      return;
    }
    this.applyAll(reply.events);
    this.pages += 1;
    if (reply.has_more && this.pages < MAX_PAGES) {
      this.remember({ epoch: reply.epoch, cursor: Math.max(reply.cursor, this.cursor.cursor) });
      this.publish();
      this.send({ type: 'resume', cursor: this.cursor.cursor, epoch: reply.epoch });
      return;
    }
    if (reply.has_more) {
      // More than we will page through: the journal is deeper than a reconnect should replay.
      this.release();
      await this.recover('gap', generation);
      return;
    }
    this.remember({ epoch: reply.epoch, cursor: Math.max(reply.watermark, this.cursor.cursor) });
    this.finish();
  }

  private async recover(reason: RefusalReason | 'network', generation: number): Promise<void> {
    if (generation !== this.generation || this.running) return;
    this.running = true;
    this.phase = 'snapshot';
    this.reason = reason;
    this.publish();
    let raw: unknown;
    try {
      raw = await this.host.fetch();
    } catch {
      raw = undefined;
    }
    if (generation !== this.generation) {
      this.running = false;
      return;
    }
    const snapshot = syncSnapshot(raw);
    if (!snapshot) {
      // The socket may still be delivering live frames; leave them flowing and offer Retry.
      this.phase = 'blocked';
      this.reason = raw === undefined ? 'network' : reason;
      this.release();
      this.publish();
      this.running = false;
      return;
    }
    this.host.applySnapshot(snapshot);
    this.remember({ epoch: snapshot.epoch, cursor: snapshot.watermark });
    // Anything held with a seq above the watermark happened after the snapshot was read.
    this.phase = 'catching-up';
    this.finish();
    this.running = false;
  }

  private finish(): void {
    this.phase = 'catching-up'; // so `release` may still advance the cursor over newer frames
    this.release();
    this.phase = 'idle';
    this.publish();
  }

  // -- applying --------------------------------------------------------------------------

  private applyAll(events: JournalEvent[]): void {
    const floor = this.cursor?.cursor ?? 0;
    for (const event of orderJournalEvents(events)) {
      if (event.seq <= floor) continue;
      this.host.apply(event);
      this.caught += 1;
    }
  }

  /** Apply the frames held back during the catch-up, newest cursor last. */
  private release(): void {
    const held = this.held;
    this.held = [];
    if (!held.length) return;
    this.applyAll(held);
    const high = Math.max(...held.map((event) => event.seq));
    if (this.cursor && high > this.cursor.cursor) this.remember({ epoch: this.cursor.epoch, cursor: high });
  }

  private remember(cursor: ReplayCursor): void {
    this.cursor = cursor;
    this.host.write(cursor);
  }

  private publish(): void {
    this.host.view(this.view());
  }
}
