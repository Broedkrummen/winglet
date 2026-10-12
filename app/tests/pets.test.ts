import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const exports: any = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/pets.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, require: () => ({}) });
const { petState, petFrames, petBox, PET_STATES } = exports;

const CODEX = ['idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review'];
const LEGACY = ['idle', 'wave', 'run', 'failed', 'review', 'jump', 'extra1', 'extra2'];
const sheet = (over: any = {}) => ({
  slug: 'boba', name: 'Boba', revision: 'r', mime: 'image/webp', frame_w: 192, frame_h: 208, columns: 8, rows: 9,
  state_rows: CODEX, frames_per_state: 6, frames: {}, loop_ms: 1100, sheet_url: '', thumb_url: '', ...over,
});

test("follows Hermes's priority: a reply that just landed, then waiting on you, then working", () => {
  assert.equal(petState({}), 'idle');
  assert.equal(petState({ working: true }), 'run');
  assert.equal(petState({ working: true, waiting: true }), 'waiting');
  assert.equal(petState({ working: true, waiting: true, replied: true }), 'wave');
});

test('finds each state on new petdex sheets and older Hermes ones', () => {
  assert.deepEqual({ ...petFrames(sheet(), 'wave') }, { row: 3, count: 6 });
  assert.deepEqual({ ...petFrames(sheet(), 'run') }, { row: 7, count: 6 });
  assert.deepEqual({ ...petFrames(sheet(), 'review') }, { row: 8, count: 6 });
  const legacy = sheet({ state_rows: LEGACY, rows: 8, columns: 9 });
  assert.deepEqual({ ...petFrames(legacy, 'wave') }, { row: 1, count: 6 });
  assert.deepEqual({ ...petFrames(legacy, 'jump') }, { row: 5, count: 6 });
  // Older sheets have no waiting row: idle stands in.
  assert.equal(petFrames(legacy, 'waiting').row, 0);
});

test('uses the real frame counts, and an empty row shows idle instead of blank frames', () => {
  const counted = sheet({ frames: { idle: 4, wave: 5, failed: 0 } });
  assert.deepEqual({ ...petFrames(counted, 'wave') }, { row: 3, count: 5 });
  assert.deepEqual({ ...petFrames(counted, 'failed') }, { row: 0, count: 4 });
  // Never more frames than the sheet has columns; a row past the sheet's end is idle.
  assert.equal(petFrames(sheet({ columns: 4 }), 'idle').count, 4);
  assert.equal(petFrames(sheet({ rows: 5 }), 'review').row, 0);
  assert.equal(petFrames(sheet({ frames: { idle: 0 } }), 'idle').count, 1);
});

test('frames are whole pixels in the sheet’s proportions', () => {
  assert.deepEqual({ ...petBox(sheet(), 104) }, { width: 96, height: 104 });
  assert.deepEqual({ ...petBox(sheet(), 43.7) }, { width: 41, height: 44 });
  assert.deepEqual({ ...petBox(sheet(), 0) }, { width: 1, height: 1 });
});

test('every state has a label for previews and screen readers', () => {
  assert.deepEqual(Array.from(PET_STATES, (x: any) => x.state).sort(), ['failed', 'idle', 'jump', 'review', 'run', 'waiting', 'wave']);
});
