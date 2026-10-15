import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const exports: any = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/voiceSession.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, require: () => ({}) });
const { voiceSession } = exports;

/** A recorder whose permission and preparation finish when the test says so. */
function fake() {
  let clock = 0;
  const log: string[] = [];
  let allow!: (ok: boolean) => void;
  let ready!: () => void;
  const d = {
    permission: () => new Promise<boolean>((r) => { allow = r; }),
    begin: () => { log.push('begin'); return new Promise<void>((r) => { ready = r; }); },
    stop: async () => { log.push('stop'); return 'file://note.m4a'; },
    now: () => clock,
    started: () => log.push('started'),
    denied: () => log.push('denied'),
    tooShort: () => log.push('tooShort'),
    failed: () => log.push('failed'),
    send: (uri: string) => log.push(`send ${uri}`),
  };
  const flush = () => new Promise((r) => setImmediate(r));
  return { d, log, allow: (ok = true) => allow(ok), ready: () => ready(), at: (t: number) => { clock = t; }, flush };
}

test('a held note is sent when let go', async () => {
  const f = fake();
  const s = voiceSession(f.d);
  const started = s.start();
  f.allow(); await f.flush(); f.ready(); await started;
  f.at(2000);
  await s.finish(false);
  assert.deepEqual([...f.log], ['begin', 'started', 'stop', 'send file://note.m4a']);
});

test('letting go while the recorder is still getting ready stops it, and sends nothing', async () => {
  const f = fake();
  const s = voiceSession(f.d);
  const started = s.start();
  f.allow(); await f.flush();
  await s.finish(false); // released before recording began
  f.ready(); await started;
  assert.deepEqual([...f.log], ['begin', 'stop', 'tooShort']);
  // The next hold starts clean.
  const again = s.start();
  f.allow(); await f.flush(); f.ready(); await again;
  f.at(5000);
  await s.finish(false);
  assert.equal(f.log.at(-1), 'send file://note.m4a');
});

test('letting go during the permission prompt never starts the recorder', async () => {
  const f = fake();
  const s = voiceSession(f.d);
  const started = s.start();
  await s.finish(true);
  f.allow(); await started;
  assert.deepEqual([...f.log], []);
});

test('a quick hold says to keep holding; a cancelled one says nothing; neither sends', async () => {
  const f = fake();
  const s = voiceSession(f.d);
  let p = s.start(); f.allow(); await f.flush(); f.ready(); await p;
  f.at(300); await s.finish(false);
  p = s.start(); f.allow(); await f.flush(); f.ready(); await p;
  f.at(5000); await s.finish(true);
  assert.deepEqual([...f.log].filter((x) => !['begin', 'started', 'stop'].includes(x)), ['tooShort']);
});

test('no permission, or a recorder that fails to start, is reported and nothing records', async () => {
  const f = fake();
  const s = voiceSession(f.d);
  let p = s.start(); f.allow(false); await p;
  assert.deepEqual([...f.log], ['denied']);
  const g = fake();
  const t = voiceSession({ ...g.d, begin: async () => { throw new Error('busy'); } });
  p = t.start(); g.allow(); await p;
  assert.deepEqual([...g.log], ['stop', 'failed']);
});
