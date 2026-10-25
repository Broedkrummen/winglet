import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { dateText, duration, mergeRuns, routineHref, statusLabel, triggerLabel, type RoutineRun } from '../src/features/routine-history/model.ts';

test('stable run IDs deduplicate refresh and overlapping attempts remain distinct', () => {
  const row = (id: string, claimed_at: number, status = 'running') => ({ id, claimed_at, status }) as RoutineRun;
  const result = mergeRuns([row('a', 10), row('b', 10)], [row('a', 10, 'completed'), row('new',20)]);
  assert.deepEqual(result.map(r => r.id), ['new','b','a']);
  assert.equal(result[2].status, 'completed');
  assert.equal(mergeRuns(result, [row('older', 1)], 2).length, 2);
});
test('links retain explicit bot and run scope with safe path encoding', () => {
  assert.equal(routineHref('bot/a', 'routine b', 'run?1'), '/routine/bot%2Fa/routine%20b/run/run%3F1');
  assert.notEqual(routineHref('bot-a','job'),routineHref('bot-b','job'));
});
test('unestablished outcomes and triggers stay explicit', () => {
  assert.equal(statusLabel('unrecognized'), 'Unknown');
  assert.equal(statusLabel('interrupted'), 'Interrupted');
  assert.equal(triggerLabel('unknown'), 'Trigger unavailable');
  assert.equal(duration(null),'Duration unavailable');
  assert.equal(duration(61),'1 min 1 sec');
});
test('timestamps use server zone across DST and invalid evidence stays unavailable', () => {
  assert.equal(dateText(null),'Unavailable');
  assert.equal(dateText('corrupt'),'Unavailable');
  const before = dateText('2026-03-29T00:30:00Z','Europe/London');
  const after = dateText('2026-03-29T01:30:00Z','Europe/London');
  assert.notEqual(before,after);
  assert.match(dateText('2026-03-29T00:30:00Z','invalid-zone'),/UTC$/);
});
