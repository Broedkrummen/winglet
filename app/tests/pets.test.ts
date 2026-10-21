import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const exports: any = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/pets.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, require: () => ({}) });
const { petState, petFrames, petBox, PET_STATES, hashText, paletteColor, avatarColor, petTones } = exports;

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

const PALETTE = ['#7C6CFF', '#EC4899', '#22C55E', '#F59E0B', '#EF4444', '#06B6D4', '#A855F7', '#14B8A6', '#F97316', '#3B82F6'];

test('the same text always hashes and colours the same way', () => {
  assert.equal(hashText('hermes'), hashText('hermes'));
  assert.notEqual(hashText('hermes'), hashText('atlas'));
  assert.ok(PALETTE.includes(paletteColor(PALETTE, 'anything')));
  assert.equal(paletteColor(PALETTE, 'atlas'), paletteColor(PALETTE, 'atlas'));
});

test("a bot's colour follows its pet, and falls back to the one it was made with", () => {
  assert.equal(avatarColor(PALETTE, 'hermes'), paletteColor(PALETTE, 'hermes'));
  assert.equal(avatarColor(PALETTE, '', null), paletteColor(PALETTE, 'hermes'));
  assert.equal(avatarColor(PALETTE, 'hermes', { slug: 'boba' }), paletteColor(PALETTE, 'pet:boba'));
  // Same pet on two bots: the same colour. Another pet on the same bot: its own.
  assert.equal(avatarColor(PALETTE, 'atlas', { slug: 'boba' }), avatarColor(PALETTE, 'nova', { slug: 'boba' }));
  const colours = new Set(['boba', 'mochi', 'pixel', 'ember', 'cloud', 'sprout'].map((slug) => avatarColor(PALETTE, 'hermes', { slug })));
  assert.ok(colours.size > 1);
});

test("a pet's own palette wins over the colour its slug hashes to", () => {
  const palette = { base: '#d22832', soft: '#f5d0d2', deep: '#500f13' };
  assert.equal(avatarColor(['#111111', '#222222'], 'bot', { slug: 'boba', palette }), '#d22832');
  // Older servers send no palette: exactly today's colour.
  assert.equal(avatarColor(['#111111', '#222222'], 'bot', { slug: 'boba' }), paletteColor(['#111111', '#222222'], 'pet:boba'));
});

test('the disc behind a pet is a tint of it, never its own colour', () => {
  const palette = { base: '#d22832', soft: '#f5d0d2', deep: '#500f13' };
  const light = petTones({ palette }, 'light')!.disc;
  const dark = petTones({ palette }, 'dark')!.disc;
  assert.ok(!light.includes('#d22832') && !dark.includes('#d22832'));
  assert.equal(light[1], '#f5d0d2');
  assert.equal(dark[1], '#500f13');
  assert.equal(petTones({}, 'light'), null);
  assert.equal(petTones(null, 'dark'), null);
});
