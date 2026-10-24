/** At-least-once replay, serialized application, and durable checkpoints per authenticated scope. */
import type { SyncState } from '../../lib/types';
import { eventStreamInfo, journalEvent, orderJournalEvents, resumeReply, syncSnapshot,
  type EventStreamInfo, type JournalEvent, type SyncSnapshot } from './protocol';

export type ReplayCursor = { epoch: string; scope: string; cursor: number };
export type SyncHost = {
  read(): ReplayCursor | undefined;
  /** Must persist applied state AND this cursor atomically; rejects on storage failure. */
  write(cursor: ReplayCursor): Promise<void>;
  apply(event: any, replayed?: boolean): void | Promise<void>;
  applySnapshot(snapshot: SyncSnapshot): Promise<void>;
  fetch(): Promise<unknown>;
  view(view: SyncState): void;
  disconnect(): void;
};
const MAX_HELD = 512;
const MAX_BYTES = 4 * 1024 * 1024;
export const MAX_PAGES = 12;
export class SyncSession {
  private stream?: EventStreamInfo;
  private cursor?: ReplayCursor;
  private state: SyncState = { phase: 'unsupported', caught: 0 };
  private held: JournalEvent[] = [];
  private generation = 0;
  private pages = 0;
  private queued = 0;
  private bytes = 0;
  private heldBytes = 0;
  private chain = Promise.resolve();
  private timeout?: ReturnType<typeof setTimeout>;
  constructor(private host: SyncHost, private send: (frame: any) => void) {}
  view() { return this.state; }
  closed() {
    this.generation++; this.stream = undefined; this.cursor = undefined;
    this.held = []; this.pages = 0; this.bytes = 0; this.heldBytes = 0; this.queued = 0;
    clearTimeout(this.timeout); this.chain = Promise.resolve();
    this.show('idle');
  }
  /** The queue includes async persistence. A slow/full device disconnects before memory grows unbounded. */
  receive(event: any): Promise<void> {
    const generation = this.generation;
    const size = JSON.stringify(event).length * 2;
    this.queued++; this.bytes += size;
    if (this.queued + this.held.length > MAX_HELD || this.bytes + this.heldBytes > MAX_BYTES) {
      this.closed(); this.host.disconnect(); return Promise.resolve();
    }
    const work = this.chain.then(async () => {
      if (generation !== this.generation) return;
      try { await this.process(event, generation); }
      catch { if (generation === this.generation) this.show('blocked', 'network'); }
      finally { if (generation === this.generation) { this.queued--; this.bytes -= size; } }
    });
    this.chain = work; return work;
  }
  retry() {
    if (!this.stream) return;
    void this.receive({ type: 'sync.retry' });
  }
  private show(phase: SyncState['phase'], reason?: SyncState['reason']) {
    this.state = { phase, caught: this.state.caught, reason }; this.host.view(this.state);
  }
  private request() {
    if (!this.cursor) return;
    clearTimeout(this.timeout);
    this.timeout = setTimeout(() => { this.closed(); this.host.disconnect(); }, 15000);
    this.send({ type: 'resume', ...this.cursor });
  }
  private async save(cursor: ReplayCursor, generation: number) {
    await this.host.write(cursor);
    if (generation === this.generation) this.cursor = cursor;
  }
  private async apply(events: JournalEvent[]) {
    const floor = this.cursor?.cursor ?? 0;
    for (const event of orderJournalEvents(events)) {
      if (event.event_seq <= floor) continue;
      await this.host.apply(event, true); this.state.caught++;
    }
  }
  private async process(event: any, generation: number): Promise<void> {
    if (event?.type === 'hello') {
      await this.host.apply(event);
      this.stream = event.features?.event_replay === true ? eventStreamInfo(event.event_stream) : undefined;
      this.state.caught = 0; this.pages = 0; this.held = []; this.heldBytes = 0;
      if (!this.stream) { this.show('unsupported'); return; }
      const saved = this.host.read();
      if (!saved || saved.scope !== this.stream.scope || saved.epoch !== this.stream.epoch ||
          !Number.isSafeInteger(saved.cursor) || saved.cursor < 0 || saved.cursor > this.stream.watermark) {
        await this.snapshot(generation); return;
      }
      this.cursor = saved; this.show('catching-up'); this.request(); return;
    }
    if (event?.type === 'sync.retry') { await this.snapshot(generation); return; }
    if (event?.type === 'resume') {
      if (this.state.phase !== 'catching-up' || !this.stream) return;
      clearTimeout(this.timeout);
      const reply = resumeReply(event);
      if (!reply || !reply.ok || reply.scope !== this.stream.scope || reply.epoch !== this.stream.epoch ||
          !this.cursor || reply.cursor < this.cursor.cursor || reply.watermark < this.cursor.cursor ||
          (reply.has_more && reply.cursor === this.cursor.cursor)) {
        await this.snapshot(generation); return;
      }
      if (reply.events.some(e => e.type === 'sync.hint')) { await this.snapshot(generation); return; }
      await this.apply(reply.events);
      await this.save({ scope: reply.scope, epoch: reply.epoch, cursor: reply.has_more ? reply.cursor : reply.watermark }, generation);
      if (generation !== this.generation) return;
      if (reply.has_more) {
        if (++this.pages > MAX_PAGES) { await this.snapshot(generation); return; }
        this.request(); this.show('catching-up'); return;
      }
      await this.apply(this.held);
      const high = this.held.reduce((n, e) => Math.max(n, e.event_seq), this.cursor!.cursor);
      this.held = []; this.heldBytes = 0;
      await this.save({ ...this.cursor!, cursor: high }, generation);
      if (generation === this.generation) this.show('idle');
      return;
    }
    const journal = journalEvent(event);
    if (!this.stream || !journal) { await this.host.apply(event); return; }
    if (this.state.phase === 'catching-up' || this.state.phase === 'snapshot' || this.state.phase === 'blocked') {
      this.held.push(journal); this.heldBytes += JSON.stringify(journal).length * 2;
      if (this.held.length >= MAX_HELD || this.heldBytes > MAX_BYTES) { this.closed(); this.host.disconnect(); }
      return;
    }
    if (journal.event_seq <= (this.cursor?.cursor ?? 0)) return;
    await this.host.apply(event);
    await this.save({ scope: this.stream.scope, epoch: this.stream.epoch, cursor: journal.event_seq }, generation);
  }
  private async snapshot(generation: number) {
    clearTimeout(this.timeout); this.show('snapshot');
    try {
      const snapshot = syncSnapshot(await this.host.fetch());
      if (generation !== this.generation) return;
      if (!snapshot || !this.stream || snapshot.scope !== this.stream.scope) throw Error('scope');
      await this.host.applySnapshot(snapshot);
      if (generation !== this.generation) return;
      this.stream = { ...this.stream, epoch: snapshot.epoch };
      await this.save({ scope: snapshot.scope, epoch: snapshot.epoch, cursor: snapshot.watermark }, generation);
      if (generation !== this.generation) return;
      // Replay AFTER snapshot/history fetch; held frames alone cannot prove subscription coverage.
      this.show('catching-up'); this.pages = 0; this.request();
    } catch { if (generation === this.generation) this.show('blocked', 'network'); }
  }
}
