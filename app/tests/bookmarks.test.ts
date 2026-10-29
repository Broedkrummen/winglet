import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bookmarkField as field, bookmarkFrom, bookmarkMatches } from '../src/features/bookmarks/model.ts';

const source = { server_id: 'server', server_fingerprint: 'fp', chat_id: 'chat', message_id: 'message' };
test('bookmark records contain references and own notes, never implicit source snippets', () => {
  const bookmark = bookmarkFrom({ source: field(source), title: field('Travel answer'), note: field('Check Friday'), tags: field(['Lisbon']) })!;
  assert.ok(bookmarkMatches(bookmark, 'lisbon friday'));
  assert.ok(!bookmarkMatches(bookmark, 'unrelated'));
  assert.equal(bookmarkFrom({ source: field({ ...source, token: 'secret' }) }), undefined);
  assert.equal(bookmarkFrom({ source: field(source), snapshot: field({ id: 'snapshot', sha256: '0'.repeat(64), text: 'private' }) }), undefined);
  assert.equal(bookmarkFrom({ source: field(source), tags: field(['x'.repeat(65)]) }), undefined);
  assert.equal(bookmarkFrom({ source: field(source), removed: field('true') }), undefined);
});

test('removed records retain snapshot identity for explicit release or restoration', () => {
  const bookmark = bookmarkFrom({ source: field(source), removed: field(true), snapshot: field({ id: 'snapshot', sha256: 'a'.repeat(64) }) })!;
  assert.equal(bookmark.removed, true);
  assert.equal(bookmark.snapshot?.id, 'snapshot');
  assert.equal(bookmarkFrom({ source: { deleted: true } }), undefined);
});
