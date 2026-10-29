import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acknowledge, emptyReplica, prepare, receive, recordKey, stage, SyncReplica, visibleValues,
  type Candidate, type RecordState } from '../src/features/sync/model.ts';

const candidate = (value: string, operation = 'remote'): Candidate => ({ deleted: false, value, device_id: 'phone', operation_id: operation, at: 1 });
const record = (revision: number, text: string): RecordState => ({ revision, fields: { text: { revision, candidates: [candidate(text)] } } });

test('offline edits retain field-specific causal bases without acknowledging foreign edits', () => {
  let state = stage(emptyReplica(), 'draft', 'chat', 'first', { text: { deleted: false, value: 'one' } });
  state = stage(state, 'draft', 'chat', 'second', { text: { deleted: false, value: 'two' }, title: { deleted: false, value: 'local title' } });
  state = acknowledge(prepare(state), 'first', { revision: 3, fields: {
    text: { revision: 3, candidates: [candidate('one', 'first')] },
    title: { revision: 2, candidates: [candidate('foreign title')] },
  } });
  state = prepare(state);
  assert.deepEqual(state.pending[0].mutation.base_fields, { text: 3, title: 0 });
  assert.equal(state.pending[0].mutation.base_revision, 3);
  assert.equal(visibleValues(state, 'draft', 'chat').text.value, 'two');
});

test('a prepared retry stays byte-identical after receiving newer server state', () => {
  let state = prepare(stage(emptyReplica(), 'draft', 'chat', 'one', { text: { deleted: false, value: 'local' } }));
  const frozen = JSON.stringify(state.pending[0]);
  state = receive(state, 'draft', 'chat', record(8, 'remote'));
  assert.equal(JSON.stringify(prepare(state).pending[0]), frozen);
  state = acknowledge(state, 'one', record(1, 'local'));
  assert.equal(state.records[recordKey('draft', 'chat')].revision, 8);
});

test('unresolved candidates never become a silently selected value', () => {
  const conflict: RecordState = { revision: 2, fields: { text: { revision: 2, candidates: [candidate('a'), candidate('b')] } } };
  const state = receive(emptyReplica(), 'draft', 'chat', conflict);
  assert.deepEqual(visibleValues(state, 'draft', 'chat'), {});
  const resolution = stage(state, 'draft', 'chat', 'choice', { text: { deleted: false, value: 'combined' } }, true);
  assert.equal(resolution.pending[0].mutation.base_revision, 2);
  assert.equal(resolution.pending[0].mutation.resolve, true);
  assert.deepEqual(resolution.pending[0].predecessors, {});
});

test('network is never called before the journal commit, and failed storage retains pending state', async () => {
  const writes: string[] = [];
  const replica = new SyncReplica(emptyReplica(), async value => { writes.push(value.pending[0]?.prepared ? 'frozen' : 'queued'); });
  await replica.edit(state => stage(state, 'draft', 'chat', 'one', { text: { deleted: false, value: 'local' } }));
  await replica.flush(async pending => {
    assert.deepEqual(writes, ['queued', 'frozen']);
    assert.equal(pending.prepared, true);
    return record(1, 'local');
  });
  assert.equal(replica.state.pending.length, 0);
  let savingFails = true;
  const failed = new SyncReplica(emptyReplica(), async () => { if (savingFails) throw new Error('disk full'); });
  await assert.rejects(failed.edit(state => stage(state, 'draft', 'chat', 'one', { text: { deleted: false, value: 'kept' } })), /disk full/);
  assert.equal(failed.state.pending.length, 1);
  assert.equal(failed.unsaved, true);
  await assert.rejects(failed.flush(async () => { throw new Error('HTTP must not run'); }), /disk full/);
  savingFails = false;
  await failed.edit(state => stage(state, 'draft', 'chat', 'two', { text: { deleted: false, value: 'kept' } }));
  await assert.rejects(failed.flush(async () => { throw new Error('offline'); }), /offline/);
  assert.equal(failed.state.pending[0].mutation.operation_id, 'one');
  assert.equal(failed.state.pending[0].prepared, true);
});

test('typing during an in-flight request stays queued and concurrent flush calls share one sender', async () => {
  const replica = new SyncReplica(emptyReplica(), async () => {});
  await replica.edit(state => stage(state, 'draft', 'chat', 'first', { text: { deleted: false, value: 'a' } }));
  let release!: () => void;
  let started!: () => void;
  const arrived = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sent: string[] = [];
  const first = replica.flush(async pending => {
    sent.push(pending.mutation.operation_id);
    if (sent.length === 1) { started(); await gate; }
    return record(sent.length, sent.length === 1 ? 'a' : 'b');
  });
  await arrived;
  await replica.edit(state => stage(state, 'draft', 'chat', 'second', { text: { deleted: false, value: 'b' } }));
  const second = replica.flush(async () => { throw new Error('duplicate sender'); });
  release();
  await Promise.all([first, second]);
  assert.deepEqual(sent, ['first', 'second']);
  assert.equal(visibleValues(replica.state, 'draft', 'chat').text.value, 'b');
});

test('acknowledging an own edit advances only its proven field before incoming application', () => {
  let state = stage({ ...emptyReplica(), observed: {} }, 'draft', 'chat', 'one', { text: { deleted: false, value: 'own' } });
  state = acknowledge(prepare(state), 'one', { revision: 3, fields: {
    text: { revision: 3, candidates: [candidate('own', 'one')] },
    title: { revision: 2, candidates: [candidate('unseen title')] },
  } });
  state = stage(state, 'draft', 'chat', 'two', { text: { deleted: false, value: 'continued' }, title: { deleted: false, value: 'my title' } });
  assert.deepEqual(state.pending[0].mutation.base_fields, { text: 3, title: 0 });
});

test('unsent typing coalesces but prepared requests never change', () => {
  let state = stage(emptyReplica(), 'draft', 'chat', 'one', { text: { deleted: false, value: 'a' } }, false, true);
  state = stage(state, 'draft', 'chat', 'two', { text: { deleted: false, value: 'ab' } }, false, true);
  assert.equal(state.pending.length, 1);
  assert.equal(state.pending[0].mutation.operation_id, 'one');
  assert.equal(state.pending[0].mutation.changes.text.value, 'ab');
  state = prepare(state);
  state = stage(state, 'draft', 'chat', 'three', { text: { deleted: false, value: 'abc' } }, false, true);
  assert.equal(state.pending.length, 2);
  assert.equal(state.pending[0].mutation.changes.text.value, 'ab');
});

test('choosing a recorded candidate sends its value without immutable source metadata', () => {
  const state = stage(emptyReplica(), 'draft', 'chat', 'choose', { text: candidate('chosen') }, true);
  assert.deepEqual(state.pending[0].mutation.changes.text, { deleted: false, value: 'chosen' });
});
