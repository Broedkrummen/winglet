import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { applyOutput, EMPTY_OUTPUT, OUTPUT_LIMIT, processLabel, type ProcessRow } from '../src/features/processes/model.ts';

test('output deltas are deduplicated and reset after cursor loss or changed redaction', () => {
  const initial = applyOutput(EMPTY_OUTPUT, { cursor: '1', reset: true, text: 'first\n', truncated: false, unavailable: false });
  const next = applyOutput(initial, { cursor: '2', reset: false, text: 'second\n', truncated: false, unavailable: false });
  assert.equal(next.text, 'first\nsecond\n');
  assert.equal(applyOutput(next, { cursor: '2', reset: false, text: 'second\n', truncated: false, unavailable: false }), next);
  const reset = applyOutput(next, { cursor: '3', reset: true, text: '[redacted]\n', truncated: true, unavailable: false });
  assert.equal(reset.text, '[redacted]\n');
  assert.equal(reset.truncated, true);
});

test('retained output is bounded without splitting a Unicode character', () => {
  const result = applyOutput(EMPTY_OUTPUT, { cursor: '1', reset: true, text: '🪴'.repeat(OUTPUT_LIMIT + 20), truncated: false, unavailable: false });
  assert.equal(Array.from(result.text).length, OUTPUT_LIMIT);
  assert.equal(result.truncated, true);
  assert.equal(result.text.includes('\ufffd'), false);
});

test('unchanged output still reports that upstream discarded earlier bytes', () => {
  const initial = { cursor: '1', text: 'same tail', truncated: false, unavailable: false };
  const next = applyOutput(initial, { cursor: '1', reset: false, text: '', truncated: true, unavailable: false });
  assert.equal(next.text, 'same tail');
  assert.equal(next.truncated, true);
});

test('stop remains pending until the server confirms the process outcome', () => {
  const row = { status: 'running', exit_code: null, stop: { status: 'stopping' } } as ProcessRow;
  assert.equal(processLabel(row), 'Stopping…');
  assert.equal(processLabel({ ...row, stop: null, status: 'exited', exit_code: 3 }), 'Exited · 3');
  assert.equal(processLabel({ ...row, stop: null, status: 'stopped', exit_code: -15 }), 'Stopped');
});
