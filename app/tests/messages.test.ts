import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markFailed, mergeMessages } from '../src/lib/messages.ts';
import type { Message } from '../src/lib/types.ts';

const msg = (id: string, over: Partial<Message> = {}): Message => ({
  id, chat_id: 'general', role: 'bot', text: id, status: 'final', meta: {}, created_at: 1, updated_at: 1, ...over,
});

test('a stale history snapshot does not erase a newer live reply', () => {
  const live = [msg('a'), msg('b', { created_at: 5, updated_at: 5 })];
  const snapshot = [msg('a')]; // taken before "b" arrived over the socket
  assert.deepEqual(mergeMessages(live, snapshot).map((m) => m.id), ['a', 'b']);
});

test('the most recently updated copy of a streaming message wins', () => {
  const live = [msg('a', { text: 'Hello world', status: 'final', updated_at: 9 })];
  const snapshot = [msg('a', { text: 'Hel', status: 'streaming', updated_at: 3 })];
  assert.equal(mergeMessages(live, snapshot)[0].text, 'Hello world');
});

test('older pages stay loaded when the latest page is reloaded', () => {
  const current = [msg('old', { created_at: 0 }), msg('a')];
  assert.deepEqual(mergeMessages(current, [msg('a')]).map((m) => m.id), ['old', 'a']);
});

test('confirmed sends replace their optimistic row', () => {
  const optimistic = msg('c-1', { role: 'user', status: 'pending', meta: { client_id: 'c-1' } });
  const server = msg('srv1', { role: 'user', meta: { client_id: 'c-1' } });
  assert.deepEqual(mergeMessages([optimistic], [server]).map((m) => m.id), ['srv1']);
});

test('a send the server already confirmed is never marked failed', () => {
  const confirmed = [msg('srv1', { role: 'user', meta: { client_id: 'c-1' } })];
  assert.equal(markFailed(confirmed, 'c-1')[0].status, 'final');
  const pending = [msg('c-1', { role: 'user', status: 'pending', meta: { client_id: 'c-1' } })];
  assert.equal(markFailed(pending, 'c-1')[0].status, 'failed');
});

test('server positions order equal-timestamp pages and optimistic rows stay last', () => {
  const current = [msg('later', { position: 3 }), msg('c-1', { role: 'user', status: 'pending', created_at: 0 })];
  const incoming = [msg('oldest', { position: 1 }), msg('middle', { position: 2 })];
  assert.deepEqual(mergeMessages(current, incoming).map(m => m.id), ['oldest', 'middle', 'later', 'c-1']);
});

test('older servers still keep older equal-timestamp pages before the current page', () => {
  assert.deepEqual(mergeMessages([msg('later')], [msg('earlier')], [], true).map(m => m.id), ['earlier', 'later']);
});

test('durable deletion removes cached older history without erasing a newer live reply', () => {
  const current = [msg('deleted', { position: 1 }), msg('older', { position: 2 }), msg('live', { position: 4 })];
  const snapshot = [msg('latest', { position: 3 })];
  assert.deepEqual(mergeMessages(current, snapshot, ['deleted']).map(m => m.id), ['older', 'latest', 'live']);
});

test('a stale history response cannot resurrect a live deletion', () => {
  assert.deepEqual(mergeMessages([], [msg('deleted')], ['deleted']), []);
});

test('a merge keeps the same objects for messages that did not change, so their rows do not re-render', () => {
  const a = msg('a', { position: 1 });
  const b = msg('b', { position: 2 });
  const merged = mergeMessages([a, b], [msg('b', { position: 2, text: 'b!', updated_at: 2 })]);
  assert.equal(merged[0], a);
  assert.notEqual(merged[1], b);
  // A copy without a position still gets the one it had.
  const relabeled = mergeMessages([a], [msg('a', { updated_at: 2 })]);
  assert.equal(relabeled[0].position, 1);
});
