import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

function compile(name: string, imports: any = {}) {
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/features/event-replay/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (id: string) => imports[id], setTimeout: () => 0, clearTimeout: () => {} });
  return exports;
}
const protocol = compile('protocol');
const { SyncSession } = compile('session', { './protocol': protocol });
const { mergeSnapshot } = compile('merge');
const cursor = (n = 0, scope = 's', epoch = 'e') => ({ scope, epoch, cursor: n });
const hello = (watermark = 0, scope = 's', epoch = 'e') => ({ type: 'hello', features: { event_replay: true }, event_stream: { scope, epoch, watermark } });
const event = (n: number) => ({ type: 'message.update', event_seq: n, message: { id: `m${n}` } });
const page = (events: any[], n: number, more = false, watermark = n) => ({ type: 'resume', ok: true,
  scope: 's', epoch: 'e', cursor: n, watermark, events, has_more: more });
const snapshot = (watermark = 0) => ({ server_id: 'server', bot: null, scope: 's', epoch: 'e', watermark,
  chats: [{ id: 'chat' }], inbox: [], pending: 0, deletions: {} });
function harness(saved: any = cursor()) {
  const applied: any[] = [], writes: any[] = [], sent: any[] = [], views: any[] = [], snapshots: any[] = [];
  let fetch = async (): Promise<any> => snapshot();
  let write = async (c: any) => { writes.push(c); saved = c; };
  let disconnected = 0;
  const session = new SyncSession({ read: () => saved, write: (c: any) => write(c),
    apply: (e: any) => { applied.push(e); }, applySnapshot: async (s: any) => { snapshots.push(s); },
    fetch: () => fetch(), view: (v: any) => views.push(v), disconnect: () => { disconnected++; } }, (f: any) => sent.push(f));
  return { session, applied, writes, sent, views, snapshots, saved: () => saved, disconnected: () => disconnected,
    fetch: (fn: typeof fetch) => { fetch = fn; }, write: (fn: typeof write) => { write = fn; } };
}
test('pages, filtered sequence gaps, overlaps and held live frames apply once in journal order', async () => {
  const h = harness(); await h.session.receive(hello(8));
  await h.session.receive(event(9));
  await h.session.receive(page([event(3), event(1), event(3)], 4, true, 8));
  assert.equal(h.sent.at(-1).cursor, 4);
  await h.session.receive(page([event(3), event(8)], 8));
  assert.deepEqual(h.applied.filter(e => e.event_seq).map(e => e.event_seq), [1, 3, 8, 9]);
  assert.equal(h.saved().cursor, 9); assert.equal(h.session.view().phase, 'idle');
  await h.session.receive(event(8)); assert.equal(h.saved().cursor, 9);
});
test('a cursor is not acknowledged until applied state is durably committed', async () => {
  const h = harness(); await h.session.receive(hello(1));
  let commit: any;
  h.write(c => new Promise(resolve => { commit = () => { h.writes.push(c); resolve(); }; }));
  const processing = h.session.receive(page([event(1)], 1));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.applied.at(-1).event_seq, 1); assert.equal(h.saved().cursor, 0);
  commit(); await new Promise(resolve => setImmediate(resolve));
  commit(); await processing; assert.equal(h.session.view().phase, 'idle');
});
test('storage failure blocks catch-up with the durable cursor unchanged and Retry repairs it', async () => {
  const h = harness(); await h.session.receive(hello(1));
  h.write(async () => { throw Error('disk full'); });
  await h.session.receive(page([event(1)], 1));
  assert.equal(h.session.view().phase, 'blocked'); assert.equal(h.saved().cursor, 0);
});
test('scope, epoch, corrupt and pre-checkpoint cursors recover through snapshot then replay', async () => {
  for (const saved of [null, cursor(0, 'wrong-bot'), cursor(0, 's', 'old'), cursor(NaN), cursor(-1), { cursor: 9, epoch: 'e' }]) {
    const h = harness(saved);
    await h.session.receive(hello());
    assert.equal(h.snapshots.length, 1);
    h.session.closed();
  }
});
test('snapshot watermark is followed by replay so event-before-subscribe cannot be lost', async () => {
  const h = harness(cursor(99)); h.fetch(async () => snapshot(5));
  await h.session.receive(hello(5));
  assert.equal(h.sent.at(-1).cursor, 5); assert.equal(h.session.view().phase, 'catching-up');
  await h.session.receive(event(7));
  await h.session.receive(page([event(6), event(7)], 7));
  assert.deepEqual(h.applied.filter(e => e.event_seq).map(e => e.event_seq), [6, 7]);
  assert.equal(h.saved().cursor, 7);
});
test('failed snapshot remains actionable; retry and old socket completions cannot advance a new session', async () => {
  const h = harness(cursor(10)); h.fetch(async () => { throw Error('offline'); });
  await h.session.receive(hello()); assert.equal(h.session.view().phase, 'blocked');
  let finish: any; h.fetch(() => new Promise(resolve => { finish = resolve; }));
  const pending = h.session.receive({ type: 'sync.retry' });
  await new Promise(resolve => setImmediate(resolve));
  h.session.closed(); finish(snapshot()); await pending;
  assert.equal(h.snapshots.length, 0); assert.equal(h.saved().cursor, 10);
});
test('malformed pages never partially apply or advance the cursor', async () => {
  const h = harness(); await h.session.receive(hello(2));
  await h.session.receive(page([event(1), { type: 'message.new', event_seq: 'bad' }], 2));
  assert.equal(h.applied.filter(e => e.event_seq).length, 0);
  assert.equal(h.snapshots.length, 1);
});
test('execution seq cannot be confused with the additive global event_seq', () => {
  assert.equal(protocol.journalEvent({ type: 'task.event', seq: 500 }), undefined);
  assert.equal(protocol.journalEvent({ type: 'task.event', seq: 500, event_seq: 3 }).seq, 500);
});
test('slow persistence is bounded and reconnects without acknowledging queued frames', async () => {
  const h = harness(); await h.session.receive(hello(1));
  h.write(async () => new Promise(() => {}));
  void h.session.receive(page([event(1)], 1));
  await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 520; i++) void h.session.receive(event(i + 2));
  assert.ok(h.disconnected() > 0); assert.equal(h.saved().cursor, 0);
});
test('snapshot merge applies chat/message tombstones without mutating drafts, outbox or reply context', () => {
  const local = { chats: { chat: { id: 'chat' }, removed: { id: 'removed' } }, messages: { chat: [{ id: 'gone' }, { id: 'keep' }] },
    deleted: {}, loaded: { chat: true }, inbox: {}, drafts: { chat: 'draft' }, outbox: [{ client_id: 'delivery' }], replyTo: { id: 'keep' } };
  const merged = mergeSnapshot(local, { ...snapshot(), deletions: { chat: ['gone'] } });
  const result = { ...local, ...merged };
  assert.equal(result.messages.chat.length, 1); assert.equal(result.messages.chat[0].id, 'keep');
  assert.equal(result.chats.removed, undefined); assert.equal(result.drafts, local.drafts);
  assert.equal(result.outbox, local.outbox); assert.equal(result.replyTo, local.replyTo);
});
test('old-server events retain baseline delivery and never create a replay cursor', async () => {
  const h = harness(); await h.session.receive({ type: 'hello' }); await h.session.receive({ type: 'message.new' });
  assert.equal(h.applied.length, 2); assert.equal(h.writes.length, 0); assert.equal(h.sent.length, 0);
  assert.equal(h.session.view().phase, 'unsupported');
});

test('oversize replay hints recover the whole scoped snapshot rather than acknowledge missing state', async () => {
  const h = harness(); await h.session.receive(hello(3));
  h.fetch(async () => snapshot(3));
  await h.session.receive(page([{ type: 'sync.hint', event_seq: 2, reason: 'oversize' }], 3));
  assert.equal(h.snapshots.length, 1); assert.equal(h.sent.at(-1).cursor, 3);
  assert.equal(h.session.view().phase, 'catching-up');
});
