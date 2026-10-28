import assert from 'node:assert/strict';
import { test } from 'node:test';
import { statusNoticeText } from '../src/lib/statusNotice.ts';
import type { Message } from '../src/lib/types.ts';

const message = (text: string, patch: Partial<Message> = {}): Message => ({
  id: 'notice', chat_id: 'chat', role: 'bot', status: 'final', text, created_at: 1, updated_at: 1, meta: {}, ...patch,
});

test('short gateway notices become icon-free status text without rewriting their contents', () => {
  const notices = [
    ['⏳ Working — 12 min — iteration 2/500, waiting for stream response (119s, post_chunk)', 'Working — 12 min — iteration 2/500, waiting for stream response (119s, post_chunk)'],
    ['⚡ Stopped. You can continue this session.', 'Stopped. You can continue this session.'],
    ['⏱ Waiting for a response', 'Waiting for a response'],
    ['⏱️ Waiting for a response', 'Waiting for a response'],
    ['🔄 Reconnecting…', 'Reconnecting…'],
    ['⚠️ Connection interrupted', 'Connection interrupted'],
  ];
  for (const [input, expected] of notices) assert.equal(statusNoticeText(message(input)), expected);
});

test('ordinary replies, multiline text, long replies and markdown blocks stay conversation', () => {
  for (const text of ['A normal reply', 'Here is ⏳ a timer', '⏳', '⏳Working', '⚠️ First line\nSecond line',
    '⚡ First line\rSecond line', `⚡ ${'a'.repeat(198)}`, '⚠️ ```ts const x = 1; ```', '⚠️ # A heading',
    '⚠️ > A quotation', '⚠️ - A list item', '⚠️ ~~~code~~~', '✅ Finished']) {
    assert.equal(statusNoticeText(message(text)), null, text);
  }
});

test('streaming and rich bot messages never collapse into a status notice', () => {
  const text = '⚠️ Read this';
  for (const patch of [
    { role: 'user' }, { role: 'system' }, { status: 'streaming' }, { status: 'pending' }, { status: 'failed' },
    { meta: { attachments: [{ id: 'file', kind: 'file' }] } }, { meta: { reply_to: { id: 'reply' } } },
    { meta: { picker: { id: 'picker' } } }, { meta: { inbox_id: 'inbox' } }, { meta: { routine: 'Daily check' } },
    { meta: { kind: 'card' } },
  ]) assert.equal(statusNoticeText(message(text, patch as Partial<Message>)), null);
});

test('short replies with Markdown formatting stay ordinary replies', () => {
  for (const text of ['⚠️ [Renew your key](https://example.com)', '⚠️ Run `hermes doctor` first', '⚡ **Done**, all set']) {
    assert.equal(statusNoticeText(message(text)), null, text);
  }
});
