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
