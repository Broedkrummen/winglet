import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

function browser() {
  const instances: any[] = [];
  class AudioStub {
    ended = false; removed = false; paused = false;
    onended: any; onpause: any; onerror: any; onplaying: any;
    constructor(_url: string) { instances.push(this); }
    async play() {}
    pause() { this.paused = true; this.onpause?.(); }
    removeAttribute() { this.removed = true; }
    load() {}
  }
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/features/live-voice/playback.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, Audio: AudioStub, setTimeout, clearTimeout,
    require: (id: string) => id === 'react-native' ? { Platform: { OS: 'web' } } : {
      createAudioPlayer: () => { throw new Error('Browser must not use a native player'); },
      setAudioModeAsync: () => { throw new Error('Browser must not set native audio mode'); },
    },
  });
  return { play: exports.playSpeech, instances };
}

test('browser ended event wins when the final pause arrives first', async () => {
  const h = browser(); const controller = new AbortController();
  const done = h.play('http://fixture/voice.wav', controller.signal);
  const audio = h.instances[0];
  audio.onpause(); // Chrome can report pause before ended.
  audio.ended = true; audio.onended();
  await done;
  assert.equal(audio.removed, true); assert.equal(audio.paused, true);
});

test('abort synchronously releases browser audio and a saved late callback cannot resume it', async () => {
  const h = browser(); const controller = new AbortController();
  const done = h.play('http://fixture/voice.wav', controller.signal);
  const audio = h.instances[0]; const late = audio.onended;
  controller.abort();
  assert.equal(audio.paused, true); assert.equal(audio.removed, true);
  await assert.rejects(done, /Cancelled/); late();
  assert.equal(audio.onended, null);
});

test('browser audio load error is recoverable and detaches listeners', async () => {
  const h = browser(); const controller = new AbortController();
  const done = h.play('http://fixture/expired.wav', controller.signal);
  const audio = h.instances[0]; audio.onerror();
  await assert.rejects(done, /could not be played/);
  assert.equal(audio.onpause, null); assert.equal(audio.removed, true);
});

test('a signal cancelled before playback never creates a player', async () => {
  const h = browser(); const controller = new AbortController(); controller.abort();
  await assert.rejects(h.play('http://fixture/late.wav', controller.signal));
  assert.equal(h.instances.length, 0);
});
