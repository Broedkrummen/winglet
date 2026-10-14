import assert from 'node:assert/strict';
import { test } from 'node:test';
import { afterOlderPage, atStart, canLoadOlder, newPaging, PAGE } from '../src/lib/history.ts';
import type { Message } from '../src/lib/types.ts';

const msg = (n: number, over: Partial<Message> = {}): Message => ({
  id: `m${n}`, chat_id: 'general', role: 'bot', text: `${n}`, status: 'final', meta: {}, created_at: n, updated_at: n, position: n, ...over,
});
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => msg(from + i));

test('reaching the start stops asking for older pages, and a reconnect with a gap starts again', () => {
  const p = newPaging();
  // The newest page is loaded; scrolling up asks for more.
  let loaded = range(21, 80);
  assert.equal(canLoadOlder(p, loaded), true);
  p.busy = true;
  assert.equal(canLoadOlder(p, loaded), false); // one request at a time
  // A short page comes back: that's the start.
  loaded = range(1, 80);
  afterOlderPage(p, true, 20, loaded);
  assert.equal(atStart(p, loaded), true);
  assert.equal(canLoadOlder(p, loaded), false);
  // New messages arriving at the bottom don't change that.
  loaded = range(1, 85);
  assert.equal(canLoadOlder(p, loaded), false);
  // Offline for a while, then a reconnect replaces everything with the newest page, far past what was loaded.
  loaded = range(200, 259);
  assert.equal(atStart(p, loaded), false); // no "Start of the conversation" under a gap
  assert.equal(canLoadOlder(p, loaded), true); // scrolling back loads again
});

test('a page that fails to load can be tried again, and a short chat never pages', () => {
  const p = newPaging();
  const loaded = range(1, PAGE);
  p.busy = true;
  afterOlderPage(p, false, 0, loaded);
  assert.equal(canLoadOlder(p, loaded), true);
  assert.equal(canLoadOlder(newPaging(), range(1, 12)), false);
});

test('a message still being sent is not taken for the oldest one the server has', () => {
  const p = newPaging();
  const loaded = [msg(0, { id: 'local', status: 'pending', position: undefined }), ...range(1, 70)];
  afterOlderPage(p, true, 10, loaded);
  assert.equal(p.start, 'm1');
  assert.equal(atStart(p, loaded), true);
});
