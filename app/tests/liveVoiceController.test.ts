import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

function deferred<T = any>() { let resolve!: (v: T) => void; let reject!: (e: Error) => void; const promise = new Promise<T>((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }
function harness() {
  const hooks: any[] = []; let cursor = 0; const effects: (() => void)[] = []; const cleanup: (() => void)[] = [];
  const captures: any[] = []; const transcriptions: any[] = []; const playbacks: any[] = []; const sends: any[] = []; const stops: any[] = [];
  const events: Record<string, any> = {};
  let callsOpen = 0; let disposed = 0;
  const server = { id: 'bot', url: 'http://fixture', token: 'fixture', deviceId: 'fixture', bot: { name: 'Hermes' } };
  const rt = { status: 'online', messages: { general: [] as any[] }, typing: {} };
  const store: any = { network: true, foreground: true, servers: [server], runtime: { bot: rt },
    sendMessage: (...args: any[]) => { const gate = deferred<void>(); sends.push({ args, gate }); return gate.promise; } };
  const useApp = Object.assign((fn: any) => fn(store), { getState: () => store });
  const lock = { locked: false };
  const useLock = Object.assign((fn: any) => fn(lock), { getState: () => lock });
  const prefs = { voiceListenWith: 'server', voiceSpeakWith: 'server' };
  class FakeClient {
    async open() { callsOpen++; return { id: 's' + callsOpen, token: 't', expiresAt: Date.now() + 100000, chatId: 'general' }; }
    transcribe(...args: any[]) { const gate = deferred(); transcriptions.push({ args, gate }); return gate.promise; }
    async speak() { return 'http://fixture/speech.wav'; }
    stop(...args: any[]) { const gate = deferred(); stops.push({ args, gate }); return gate.promise; }
    async end() {}
  }
  const mock: Record<string, any> = {
    react: {
      useState(value: any) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof value === 'function' ? value() : value; return [hooks[i], (v: any) => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v; }]; },
      useRef(value: any) { const i = cursor++; return hooks[i] ??= { current: value }; },
      useSyncExternalStore(_sub: any, get: any) { cursor++; return get(); },
      useEffect(fn: any, deps: any[]) { const i = cursor++; if (!hooks[i] || deps.some((v, at) => v !== hooks[i][at])) { hooks[i] = deps; effects.push(() => { cleanup[i]?.(); cleanup[i] = fn(); }); } },
    },
    'react-native': { Platform: { OS: 'android' }, AppState: { currentState: 'active', addEventListener(_event: string, fn: any) { events.app = fn; return { remove() {} }; } } },
    '../../lib/audioMode': { claimVoiceAudio: () => () => undefined },
    '../../lib/store': { useApp },
    '../../lib/appLock': { useLock },
    '../../lib/prefs': { usePrefs: { getState: () => ({ prefs }) } },
    '../../lib/api': { ApiError: class extends Error {} },
    './client': { VoiceClient: FakeClient, backpressure: (fn: any) => fn() },
    './capture': { useCapture: () => ({ finish() {}, record(signal: AbortSignal, _level: any, started: any) { started(); const gate = deferred(); captures.push({ signal, gate }); return gate.promise; } }) },
    './deviceSpeech': {},
    './playback': { playSpeech: (_url: string, signal: AbortSignal) => { const gate = deferred(); playbacks.push({ signal, gate }); return gate.promise; } },
  };
  const cache: Record<string, any> = {};
  function load(name: string): any {
    if (cache[name]) return cache[name];
    const exports: any = {}; cache[name] = exports;
    const source = readFileSync(new URL('../src/features/live-voice/' + name + '.ts', import.meta.url), 'utf8');
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { exports, require: (id: string) => mock[id] ?? load(id.slice(2)), AbortController, Date, Math, Set, Map, setTimeout, clearTimeout });
    return exports;
  }
  const { useLiveVoice } = load('useLiveVoice');
  let result: any;
  const render = () => { cursor = 0; result = useLiveVoice(server, 'general'); while (effects.length) effects.shift()!(); return result; };
  const flush = async () => { await new Promise((r) => setImmediate(r)); return render(); };
  const audio = () => ({ uri: 'file://synthetic', mime: 'audio/mp4', hasSpeech: true, durationMs: 2000, dispose: () => { disposed++; } });
  render();
  return { render, flush, captures, transcriptions, playbacks, sends, stops, rt, store, events, lock, audio,
    unmount: () => cleanup.forEach((fn) => fn?.()), get disposed() { return disposed; }, get opened() { return callsOpen; } };
}

test('controller discards capture on background and ignores late transcription without sending', async () => {
  const h = harness(); let v = await h.flush(); v.start();
  await h.flush(); h.captures[0].gate.resolve(h.audio()); v = await h.flush();
  assert.equal(h.transcriptions.length, 1);
  h.events.app('background'); await h.flush();
  h.transcriptions[0].gate.resolve({ transcript: 'Late private words', seq: 1 }); v = await h.flush();
  assert.equal(h.sends.length, 0);
  assert.equal(v.state.phase, 'idle'); assert.equal(h.disposed, 1);
  h.unmount();
});

test('controller waits for an in-flight send then server Stop before permitting a new turn', async () => {
  const h = harness(); let v = await h.flush(); v.start();
  await h.flush(); h.captures[0].gate.resolve(h.audio()); await h.flush();
  h.transcriptions[0].gate.resolve({ transcript: 'A question', seq: 1 }); v = await h.flush();
  assert.equal(h.sends.length, 1); assert.equal(h.sends[0].args[3].liveOnly, true);
  v.interrupt(); v = await h.flush(); assert.equal(h.stops.length, 0);
  h.sends[0].gate.resolve(); v = await h.flush();
  assert.equal(h.stops.length, 1); assert.equal(h.stops[0].args[2], true);
  v.start(); assert.equal(h.captures.length, 1);
  h.stops[0].gate.resolve(); v = await h.flush(); v.start();
  assert.equal(h.captures.length, 2);
  h.unmount();
});

test('controller claims only an acknowledged new final reply, cancels playback, and requires tap after reconnect', async () => {
  const h = harness(); let v = await h.flush(); v.start();
  await h.flush(); h.captures[0].gate.resolve(h.audio()); await h.flush();
  h.transcriptions[0].gate.resolve({ transcript: 'A question', seq: 1 }); await h.flush();
  const clientId = h.sends[0].args[3].clientId;
  h.rt.messages.general = [
    { id: 'old', role: 'bot', text: 'Not this reply', status: 'final', meta: {}, position: 1, created_at: Date.now() / 1000 - 20 },
    { id: 'user', role: 'user', text: 'A question', status: 'final', meta: { client_id: clientId }, position: 2, created_at: Date.now() / 1000 },
    { id: 'progress', role: 'bot', text: 'Internal', status: 'final', meta: { activity: true }, position: 3, created_at: Date.now() / 1000 },
    { id: 'reply', role: 'bot', text: 'The answer', status: 'final', meta: {}, position: 4, created_at: Date.now() / 1000 },
  ];
  h.sends[0].gate.resolve(); v = await h.flush();
  assert.equal(h.playbacks.length, 1); assert.equal(v.state.turns[0].messageId, 'reply');
  h.store.network = false; v = h.render();
  assert.equal(h.playbacks[0].signal.aborted, true);
  h.playbacks[0].gate.resolve(); await h.flush();
  h.store.network = true; v = h.render();
  assert.equal(v.state.phase, 'reconnecting'); assert.equal(h.captures.length, 1);
  v.start(); v = await h.flush();
  assert.equal(v.state.phase, 'idle'); assert.equal(h.captures.length, 1);
  h.unmount();
});

test('late microphone preparation after closing is disposed, never transcribed', async () => {
  const h = harness(); const v = await h.flush(); v.start(); await h.flush();
  h.unmount(); h.captures[0].gate.resolve(h.audio()); await new Promise((r) => setImmediate(r));
  assert.equal(h.transcriptions.length, 0); assert.equal(h.disposed, 1);
});
