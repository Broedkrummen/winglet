import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const exports: any = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/features/checkpoints/format.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, Date, Math, Number, String });

const at = (d: number, h = 10, m = 24) => new Date(2026, 9, d, h, m).getTime() / 1000;
const now = at(23, 18);

test('days group as today, yesterday, a weekday, then a date', () => {
  assert.equal(exports.dayLabel(at(23), now), 'Today');
  assert.equal(exports.dayLabel(at(22), now), 'Yesterday');
  // Within the week it is the weekday, in the phone's own wording; older is its date.
  const weekday = new Date(at(20) * 1000).toLocaleDateString([], { weekday: 'long' });
  assert.equal(exports.dayLabel(at(20), now), weekday);
  const date = new Date(at(2) * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' });
  assert.equal(exports.dayLabel(at(2), now), date);
  const lastYear = new Date(at(2) * 1000).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  assert.equal(exports.dayLabel(at(2), now + 366 * 86400), lastYear);
  assert.equal(exports.dayLabel(0), '');
});

test('a snapshot reads as its counts, and says nothing when Hermes could not count it', () => {
  assert.equal(exports.countsLabel({ files: 3, insertions: 42, deletions: 7 }), '3 files · +42 −7');
  assert.equal(exports.countsLabel({ files: 1, insertions: 2, deletions: 0 }), '1 file · +2');
  assert.equal(exports.countsLabel({ files: 1, insertions: 0, deletions: 3 }), '1 file · −3');
  assert.equal(exports.countsLabel({ files: 0, insertions: 0, deletions: 0 }), '');
  assert.equal(exports.countsLabel({ files: 2, insertions: 0, deletions: 0 }), '2 files');
});

test('diff lines are coloured by what they do', () => {
  assert.equal(exports.diffTone('+echo kept'), 'added');
  assert.equal(exports.diffTone('-echo gone'), 'removed');
  assert.equal(exports.diffTone('@@ -1,3 +1,4 @@'), 'hunk');
  assert.equal(exports.diffTone('diff --git a/x b/x'), 'meta');
  assert.equal(exports.diffTone('Binary files a/x and b/x differ'), 'meta');
  assert.equal(exports.diffTone('--- a/x'), 'plain');
  assert.equal(exports.diffTone('+++ b/x'), 'plain');
  assert.equal(exports.diffTone(' context'), 'plain');
});

test('the confirm step says what restoring does, in safe and full modes', () => {
  assert.deepEqual([...exports.effectLines({ restore: 2, remove: 1, recreate: 0 }, true)], [
    'Up to 2 files go back to how they were.',
    '1 file created since is removed. Files you made yourself are left alone.',
  ]);
  assert.deepEqual([...exports.effectLines({ restore: 1, remove: 2, recreate: 1, renamed: 1 }, false)], [
    '1 file goes back to how it was, including ones you edited yourself.',
    '1 file Hermes removed since is put back.',
    '1 renamed file is renamed back.',
    '2 files created since, including any you made yourself, are removed.',
  ]);
  assert.deepEqual([...exports.effectLines({}, true)], ['Nothing has changed since this snapshot, so there is nothing to restore.']);
});

test('a preview summary keeps the totals and flags binary files', () => {
  const files = [
    { path: 'a', status: 'modified', binary: false, insertions: 3, deletions: 1, start: 0, end: 4, shown: true, from: '', change: 'restore' },
    { path: 'b', status: 'added', binary: true, insertions: 0, deletions: 0, start: null, end: null, shown: false, from: '', change: 'remove' },
  ];
  assert.equal(exports.previewSummary({ files, effects: { binary: 1 } }), '2 files changed · +3 −1 · 1 file binary');
  assert.equal(exports.previewSummary({ files: [], effects: {} }), '');
});

test('the restore button explains every reason it cannot run', () => {
  const preview = (over: any = {}) => ({
    supported: true, enabled: true, can_restore: true, error: null, unchanged: false, busy: [],
    files: [], effects: {}, ...over,
  });
  assert.equal(exports.restoreBlocker(preview(), { online: true, busy: [] }), '');
  assert.match(exports.restoreBlocker(preview({ supported: false, reason: 'No manager.' }), { online: true, busy: [] }), /No manager/);
  assert.match(exports.restoreBlocker(preview({ enabled: false }), { online: true, busy: [] }), /off/);
  assert.match(exports.restoreBlocker(preview({ can_restore: false }), { online: true, busy: [] }), /can't restore/);
  assert.match(exports.restoreBlocker(preview({ error: 'Could not read' }), { online: true, busy: [] }), /Could not read/);
  assert.match(exports.restoreBlocker(preview({ unchanged: true }), { online: true, busy: [] }), /Nothing has changed/);
  assert.match(exports.restoreBlocker(preview(), { online: true, busy: ['General'] }), /General/);
  assert.match(exports.restoreBlocker(preview(), { online: false, busy: [] }), /Connect/);
});

test('a result groups only the files Hermes actually reported', () => {
  const groups = exports.resultGroups({
    ok: true, message: '', restored: ['a'], skipped_user_edits: [], skipped_oversize: ['b'], failed_deletes: ['c'],
  });
  assert.deepEqual([...groups.map((g: any) => g.key)], ['restored', 'oversize', 'failed']);
  assert.deepEqual([...groups[0].files], ['a']);
  assert.deepEqual([...exports.resultGroups({ ok: false, message: '', error: 'boom' })], []);
  assert.equal(exports.safetyOf({ ok: true, message: '', safety: { hash: 'aa', short: 'aa' } })?.short, 'aa');
  assert.equal(exports.safetyOf({ ok: true, message: '' }), null);
});

test('a file mark and a retry id are stable enough for the server', () => {
  assert.equal(exports.fileMark({ status: 'added' }), 'A');
  assert.equal(exports.fileMark({ status: 'deleted' }), 'D');
  assert.equal(exports.fileMark({ status: 'renamed' }), 'R');
  assert.equal(exports.fileMark({ status: 'modified' }), 'M');
  const first = exports.operationId();
  assert.match(first, /^[A-Za-z0-9._:-]{8,80}$/);
  assert.notEqual(first, exports.operationId());
});

test('a file shows only its own bounded slice of the diff', () => {
  const preview = { diff: { lines: Array.from({ length: 1000 }, (_, i) => `line ${i}`) } };
  const file = { start: 10, end: 1000 };
  const lines = exports.patchLines(preview, file, 900);
  assert.equal(lines.length, 900);
  assert.equal(lines[0], 'line 10');
  assert.deepEqual([...exports.patchLines(preview, { start: null, end: null })], []);
});
