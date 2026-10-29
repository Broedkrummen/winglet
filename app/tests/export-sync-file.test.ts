import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

function harness(os: string, fail = false) {
  const events: any[] = [];
  const timers: (() => void)[] = [];
  class Directory {
    constructor(..._args: any[]) {}
    create() { events.push('create'); }
    delete() { events.push('delete'); }
  }
  class File {
    uri = 'file:///synthetic-export/file';
    constructor(..._args: any[]) {}
    write(bytes: Uint8Array) { events.push(['write', Array.from(bytes)]); if (fail) throw new Error('disk full'); }
  }
  const imports: Record<string, unknown> = {
    'expo-file-system': { Directory, File, Paths: { cache: 'cache' } },
    'expo-sharing': { shareAsync: async () => { events.push('share'); } },
    'react-native': { Platform: { OS: os } }, '../../lib/control': { idempotencyKey: () => 'fixture' },
  };
  const exports: any = {};
  const code = ts.transpileModule(readFileSync(new URL('../src/features/sync/exportFile.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const anchor: any = { click() { events.push(['download', this.download, this.href]); } };
  vm.runInNewContext(code, { exports, require: (name: string) => imports[name], Blob, Uint8Array,
    URL: { createObjectURL: () => 'blob:synthetic', revokeObjectURL: (url: string) => events.push(['revoke', url]) },
    document: { createElement: () => anchor }, setTimeout: (fn: () => void) => timers.push(fn) });
  return { exportFile: exports.exportSyncBytes, events, timers };
}

test('browser export downloads local bytes and retires its object URL', async () => {
  const h = harness('web');
  await h.exportFile('notes.txt', new Uint8Array([0, 255]));
  assert.deepEqual(h.events, [['download', 'notes.txt', 'blob:synthetic']]);
  h.timers[0]();
  assert.deepEqual(h.events.at(-1), ['revoke', 'blob:synthetic']);
});

test('native export cleans its private temporary directory after sharing', async () => {
  const h = harness('android');
  await h.exportFile('notes.txt', new Uint8Array([0, 255]));
  assert.deepEqual(h.events, ['create', ['write', [0, 255]], 'share', 'delete']);
});

test('a failed native write still cleans the temporary export and does not share', async () => {
  const h = harness('android', true);
  await assert.rejects(h.exportFile('notes.txt', new Uint8Array([0])), /disk full/);
  assert.deepEqual(h.events, ['create', ['write', [0]], 'delete']);
});
