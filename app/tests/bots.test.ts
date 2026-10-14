import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const exports: any = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/bots.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, require: () => ({}) });
const { botName } = exports;

test("a bot's short name is a Hermes profile name", () => {
  assert.equal(botName('Meal Planner!'), 'meal-planner');
  assert.equal(botName('  Café Crème  '), 'cafe-creme');
  assert.equal(botName('---'), '');
  assert.equal(botName('A'.repeat(60)).length, 40);
  assert.equal(botName('R2-D2 / C-3PO'), 'r2-d2-c-3po');
});

const { resolveMainBot, mainFirst } = exports;
const bots = [{ id: 'a' }, { id: 'a~chef', parent: 'a' }, { id: 'b' }];

test('the main bot is the one chosen, else the first paired on its own', () => {
  assert.equal(resolveMainBot(bots, 'b').id, 'b');
  assert.equal(resolveMainBot(bots, 'a~chef').id, 'a~chef');
  assert.equal(resolveMainBot(bots, '').id, 'a');
  assert.equal(resolveMainBot(bots, 'gone').id, 'a'); // removed since it was chosen
  assert.equal(resolveMainBot([{ id: 'x~y', parent: 'x' }], undefined).id, 'x~y');
  assert.equal(resolveMainBot([], 'a'), undefined);
});

test('the main bot leads, the others keep their order', () => {
  const ids = (list: any[]) => Array.from(list, (x) => x.id); // the vm's arrays aren't this realm's
  assert.deepEqual(ids(mainFirst(bots, 'b')), ['b', 'a', 'a~chef']);
  assert.deepEqual(ids(mainFirst(bots)), ['a', 'a~chef', 'b']);
  assert.equal(mainFirst([]).length, 0);
});
