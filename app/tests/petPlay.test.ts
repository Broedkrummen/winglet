import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const exports: any = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/petPlay.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, require: () => ({}) });
const { tapReaction, holdReaction, shownState, TRIPLE_MS } = exports;

test('a tap waves for one loop, then the pet is back to what it was doing', () => {
  const { reaction } = tapReaction([], 1000, 1100);
  assert.deepEqual({ ...reaction }, { state: 'wave', until: 2100 });
  assert.equal(shownState('idle', reaction, 1500), 'wave');
  assert.equal(shownState('idle', reaction, 2100), 'idle');
});

test('three quick taps make it jump, and start counting again', () => {
  let r = tapReaction([], 0, 1100);
  r = tapReaction(r.recent, 300, 1100);
  assert.equal(r.reaction.state, 'wave');
  r = tapReaction(r.recent, 600, 1100);
  assert.deepEqual({ ...r.reaction }, { state: 'jump', until: 1700 });
  assert.equal(r.recent.length, 0);
});

test('taps further apart than the window never add up to a jump', () => {
  let r = tapReaction([], 0, 1100);
  r = tapReaction(r.recent, TRIPLE_MS + 1, 1100);
  r = tapReaction(r.recent, TRIPLE_MS + 300, 1100);
  assert.equal(r.reaction.state, 'wave');
});

test('touch never hides what the agent is doing for longer than the reaction', () => {
  const { reaction } = tapReaction([], 0, 1100);
  assert.equal(shownState('run', reaction, 500), 'wave');
  assert.equal(shownState('run', reaction, 1100), 'run');
  assert.equal(shownState('waiting', null, 0), 'waiting');
});

test('holding shows it thinking until let go', () => {
  const held = holdReaction();
  assert.equal(shownState('idle', held, 1e12), 'review');
  assert.equal(shownState('run', null, 1e12), 'run');
});
