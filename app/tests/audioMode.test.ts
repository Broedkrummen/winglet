import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

// The real module with expo-audio replaced: every mode it asks for is recorded, as the whole mode it sends.
function load() {
  const modes: any[] = [];
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/audioMode.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, require: (id: string) => {
      if (id === 'expo-audio') return { setAudioModeAsync: async (m: any) => { modes.push({ ...m }); } };
      throw new Error(`Unexpected import ${id}`);
    },
  });
  return { ...exports, modes };
}

test("a chime mixes with the user's music, then the app's own mode comes back", async () => {
  const a = load();
  await a.chimeMode();
  await a.defaultMode();
  assert.deepEqual(a.modes, [
    { playsInSilentMode: true, interruptionMode: 'mixWithOthers' },
    { playsInSilentMode: true },
  ]);
});

test('a chime never touches the mode while a voice note records', async () => {
  const a = load();
  await a.recordingMode(true);
  assert.equal(await a.chimeMode(), false);
  await a.defaultMode();
  assert.deepEqual(a.modes, [{ allowsRecording: true, playsInSilentMode: true }]);
  await a.recordingMode(false);
  assert.deepEqual(a.modes.at(-1), { allowsRecording: false, playsInSilentMode: true });
  assert.equal(await a.chimeMode(), true);
});

test('no mode ever turns off playback on a silenced phone (voice notes must still play)', async () => {
  const a = load();
  await a.chimeMode();
  await a.recordingMode(true);
  await a.recordingMode(false);
  await a.defaultMode();
  assert.ok(a.modes.every((m: any) => m.playsInSilentMode === true));
});
