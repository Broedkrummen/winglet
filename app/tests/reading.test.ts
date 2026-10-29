import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseReadingEntry, readingKey, readingValues, resumeAnchor, visibleReading } from '../src/features/sync/reading.ts';

test('only visible final native positions count; the oldest visible row is the resume anchor', () => {
  const rows: any[] = [
    { id: 'real-new', status: 'final', position: 50 }, { id: 'real-old', status: 'final', position: 30 },
    { id: 'pending', status: 'pending', position: 100 }, { id: 'streaming', status: 'streaming', position: 101 },
    { id: 'failed', status: 'failed', position: 102 }, { id: 'legacy', status: 'final' },
    { id: 'local-id', status: 'final', position: 999, meta: { client_id: 'local-id' } },
  ];
  assert.deepEqual(visibleReading(rows), { watermark: 50, anchor: { message_id: 'real-old', position: 30 } });
});

test('reading identity includes the verified installation fingerprint and never a credential', () => {
  assert.notEqual(readingKey('server', 'old-key', 'chat'), readingKey('server', 'new-key', 'chat'));
  const entry = parseReadingEntry({ serverId: 'server', fingerprint: 'verified', chatId: 'chat', watermark: 5, token: 'secret' })!;
  assert.ok(!JSON.stringify(readingValues(entry)).includes('secret'));
  assert.equal(parseReadingEntry({ ...entry, watermark: -1 }), undefined);
});

test('resume anchors reject arbitrary URLs, invalid positions and unknown payload fields', () => {
  assert.equal(resumeAnchor({ message_id: 'message', url: 'https://example.test' }), undefined);
  assert.equal(resumeAnchor({ message_id: 'message', position: 0 }), undefined);
  assert.equal(resumeAnchor({ message_id: 'message', position: 1.5 }), undefined);
  assert.deepEqual(resumeAnchor({ message_id: 'message' }), { message_id: 'message' });
});
