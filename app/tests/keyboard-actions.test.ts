import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

test('commands recheck lock, reuse navigation and deduplicate chat creation until it settles', async () => {
  let locked = false, creates = 0, homes = 0, closes = 0;
  let finish!: () => void;
  const routes: string[] = [];
  const modules: Record<string, any> = {
    'expo-router': { router: { navigate: (path: string) => routes.push(path) } },
    '../../lib/appLock': { useLock: { getState: () => ({ locked }) } },
    '../../lib/store': { useApp: { getState: () => ({ servers: [{ id: 'bot' }], selection: { serverId: 'bot' } }) } },
    '../../lib/actions': { startNewChat: async (id: string) => { assert.equal(id, 'bot'); creates++; await new Promise<void>(resolve => { finish = resolve; }); } },
  };
  const output = ts.transpileModule(readFileSync(new URL('../src/features/keyboard/actions.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports: any = {};
  vm.runInNewContext(output, { exports, require: (id: string) => { assert.ok(modules[id], id); return modules[id]; } });
  const navigation = { home: () => { homes++; }, close: () => { closes++; } };
  locked = true;
  await exports.runCommand('new-chat', navigation);
  await exports.runCommand('inbox', navigation);
  assert.equal(creates, 0); assert.equal(closes, 0); assert.equal(routes.length, 0);
  locked = false;
  await exports.runCommand('home', navigation);
  await exports.runCommand('inbox', navigation);
  assert.equal(homes, 1); assert.deepEqual(routes, ['/inbox']);
  const pending = exports.runCommand('new-chat', navigation);
  await exports.runCommand('new-chat', navigation);
  assert.equal(creates, 1);
  finish(); await pending;
  const retry = exports.runCommand('new-chat', navigation);
  assert.equal(creates, 2); finish(); await retry;
});
