import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatActivity, chatActivityLabel, draftPreview, matchesChatFilter } from '../src/lib/chatActivity.ts';

const request = (id: string, chat_id: string, status = 'pending', kind = 'question'): any => ({ id, chat_id, status, kind });

test('pending questions and approvals take precedence over running, and results and other chats do not', () => {
  const activity = { typing: { a: 120, b: 120 }, inbox: { q: request('q', 'a'), approval: request('approval', 'a', 'pending', 'approval'),
    done: request('done', 'b', 'resolved'), result: request('result', 'b', 'pending', 'result') } };
  assert.deepEqual(chatActivity(activity, 'a', 100), { pending: 2, running: false });
  assert.equal(chatActivityLabel(chatActivity(activity, 'a', 100)), 'Needs you · 2');
  assert.deepEqual(chatActivity(activity, 'b', 100), { pending: 0, running: true });
  assert.equal(chatActivityLabel(chatActivity(activity, 'b', 100)), 'Running');
});

test('filters use the same activity as the badges and let expired work leave Running', () => {
  const activity = { typing: { chat: 120 } };
  assert.equal(matchesChatFilter('running', chatActivity(activity, 'chat', 119)), true);
  assert.equal(matchesChatFilter('running', chatActivity(activity, 'chat', 120)), false);
  assert.equal(matchesChatFilter('needs-you', chatActivity(activity, 'chat', 100)), false);
  assert.equal(matchesChatFilter('all', chatActivity(undefined, 'chat', 100)), true);
  assert.equal(chatActivityLabel(chatActivity(activity, 'chat', 120)), null);
});

test('the same chat ID on another bot cannot pick up a request or working indicator', () => {
  const first = { inbox: { q: request('q', 'general') }, typing: { general: 120 } };
  assert.equal(matchesChatFilter('needs-you', chatActivity(first, 'general', 100)), true);
  assert.equal(matchesChatFilter('needs-you', chatActivity({}, 'general', 100)), false);
  assert.equal(matchesChatFilter('running', chatActivity({}, 'general', 100)), false);
});

test('draft previews expose text, attachments and reply-only drafts without altering the stored text', () => {
  const text = '  Keep\nthis  paragraph  ';
  assert.equal(draftPreview(text), 'Draft · Keep this paragraph');
  assert.equal(text, '  Keep\nthis  paragraph  ');
  assert.equal(draftPreview('', [{ name: 'photo.png' } as any]), 'Draft · photo.png');
  assert.equal(draftPreview('', [{ name: 'a' }, { name: 'b' }] as any), 'Draft · 2 attachments');
  assert.equal(draftPreview('', [], true), 'Draft · Reply');
  assert.equal(draftPreview('   '), null);
});
