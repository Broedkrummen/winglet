import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

function load(name: string, mocks: Record<string, any> = {}): any {
  const exports: any = {};
  const source = readFileSync(new URL('../src/features/live-voice/' + name + '.ts', import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, require: (id: string) => mocks[id] ?? (id.startsWith('./') ? load(id.slice(2), mocks) : {}),
    Date, Math, Set, Map, AbortController, FormData, Blob, setTimeout, clearTimeout, globalThis,
  });
  return exports;
}
const { VoiceEngine } = load('engine');
const { EndOfSpeech, dbToLevel } = load('endOfSpeech');
const { speechChunks, speakableText, isVoiceStopCommand } = load('voiceText');
const session = { id: 'vs', token: 'test', expiresAt: 9999999, chatId: 'general', sttProvider: 'local', ttsProvider: 'edge' };
function setup(options = {}) {
  let id = 0;
  const e = new VoiceEngine({ now: () => 10000, newId: (p: string) => p + ++id, ...options });
  e.open(); e.sessionReady(session);
  const listen = e.startListening()[0];
  return { e, listen, audio: () => e.utteranceDone({ ...listen, outcome: { kind: 'audio', hasSpeech: true, durationMs: 1500 } }),
    text: (text = 'A new question') => e.utteranceDone({ ...listen, outcome: { kind: 'transcript', text, durationMs: 1500 } }) };
}
const plain = (v: any) => JSON.parse(JSON.stringify(v));

test('a deliberate turn listens, sends one final transcript, reads final reply, then listens', () => {
  const f = setup();
  assert.equal(f.e.snapshot().phase, 'listening');
  const send = f.text();
  assert.equal(send[0].type, 'send');
  assert.equal(send[0].clientId, 'voice-' + f.listen.turnId);
  assert.equal(f.e.replyMessage({ id: 'r', text: 'Working', createdAtMs: 10000, final: false }).length, 0);
  const speak = f.e.replyMessage({ id: 'r', text: 'Here is the answer.', createdAtMs: 11000, final: true });
  assert.equal(speak[0].type, 'speak');
  const next = f.e.speechFinished(f.listen.turnId);
  assert.equal(next[0].type, 'listen');
  assert.notEqual(next[0].turnId, f.listen.turnId);
});

test('opening, reconnecting, backgrounding, interruption and unmuting never auto-open the mic', () => {
  const e = new VoiceEngine();
  assert.deepEqual(plain(e.open()).map((v: any) => v.type), ['openSession']);
  assert.equal(e.sessionReady(session).length, 0);
  const effects = e.suspend('reconnect');
  assert.ok(!effects.some((v: any) => v.type === 'listen'));
  assert.equal(e.sessionReady(session, { reconnected: true }).length, 0);
  e.startListening();
  assert.ok(!e.suspend('background').some((v: any) => v.type === 'listen'));
  e.setMuted(true); assert.equal(e.setMuted(false).length, 0);
});

test('manual interrupt invalidates all pending effects and asks for generation Stop', () => {
  const f = setup(); f.text();
  const generation = f.e.generation;
  const effects = f.e.interrupt();
  assert.ok(f.e.generation > generation);
  assert.deepEqual(plain(effects).map((v: any) => v.type), ['stopSpeech', 'cancelCapture', 'cancelTurn', 'stopGeneration']);
  assert.equal(f.e.replyMessage({ id: 'late', text: 'Late result', createdAtMs: 12000, final: true }).length, 0);
  assert.equal(f.e.speechFinished(f.listen.turnId).length, 0);
  assert.equal(f.e.transcriptReceived({ ...f.listen, text: 'Late transcript', final: true }).length, 0);
});

test('interrupt during transcription never sends a late final, and capture failure requires a new tap', () => {
  const f = setup(); f.audio(); f.e.interrupt();
  assert.equal(f.e.transcriptReceived({ ...f.listen, text: 'This must not send', final: true }).length, 0);
  f.e.startListening(); const gen = f.e.generation; f.e.captureFailed('Microphone revoked', 'permission');
  assert.equal(f.e.snapshot().phase, 'error');
  assert.equal(f.e.generation, gen);
  assert.equal(f.e.snapshot().error.code, 'permission');
});

test('partial packets replace captions in sequence; duplicate final transcription sends once', () => {
  const f = setup(); f.audio();
  f.e.partialTranscript({ ...f.listen, text: 'latest', seq: 3 });
  f.e.partialTranscript({ ...f.listen, text: 'old', seq: 2 });
  assert.equal(f.e.snapshot().partial, 'latest');
  const event = { ...f.listen, text: 'A question', final: true };
  assert.equal(f.e.transcriptReceived(event)[0].type, 'send');
  assert.equal(f.e.transcriptReceived(event).length, 0);
});

test('failed transcription retries the same identity; busy never starts a new recorder', () => {
  const f = setup(); f.audio();
  assert.equal(f.e.transcriptionFailed({ ...f.listen, message: 'Busy', busy: true }).length, 0);
  f.e.transcriptionFailed({ ...f.listen, message: 'Try again' });
  const retry = f.e.retry()[0];
  assert.equal(retry.type, 'transcribe'); assert.equal(retry.turnId, f.listen.turnId); assert.equal(retry.utteranceId, f.listen.utteranceId);
});

test('silence is discarded and bounded; two silent attempts pause the session', () => {
  const f = setup();
  const second = f.e.utteranceDone({ ...f.listen, outcome: { kind: 'silence', durationMs: 12000 } })[0];
  assert.equal(second.type, 'listen'); assert.notEqual(second.utteranceId, f.listen.utteranceId);
  assert.equal(f.e.utteranceDone({ ...second, outcome: { kind: 'silence', durationMs: 12000 } }).length, 0);
  assert.equal(f.e.snapshot().phase, 'idle'); assert.equal(f.e.snapshot().turns.length, 0);
});

test('mute during capture changes generation and discards old transcription; unmute requires a tap', () => {
  const f = setup(); const gen = f.e.generation;
  assert.equal(f.e.setMuted(true)[0].type, 'cancelCapture');
  assert.ok(f.e.generation > gen);
  assert.equal(f.e.transcriptReceived({ ...f.listen, text: 'Late', final: true }).length, 0);
  assert.equal(f.e.setMuted(false).length, 0);
  assert.equal(f.e.snapshot().phase, 'idle');
});

test('authoritative user text wins; old messages cannot claim a reply and final duplicates stay silent', () => {
  const f = setup(); f.text();
  f.e.sentMessage({ clientId: 'voice-' + f.listen.turnId, text: 'Corrected by server' });
  assert.equal(f.e.turn.userText, 'Corrected by server');
  assert.equal(f.e.replyMessage({ id: 'old', text: 'Old reply', createdAtMs: 1000, final: true }).length, 0);
  f.e.replyMessage({ id: 'new', text: 'Current', createdAtMs: 11000, final: true });
  assert.equal(f.e.replyMessage({ id: 'new', text: 'Edited later', createdAtMs: 11000, final: true }).length, 0);
});

test('turn buffers stay bounded and stop phrases end the session without sending', () => {
  const f = setup({ maxTurns: 3 });
  for (let i = 0; i < 15; i++) { f.e.interrupt(); f.e.startListening(); }
  assert.equal(f.e.snapshot().turns.length, 3);
  f.e.interrupt();
  const effect = f.e.startListening()[0];
  const end = f.e.utteranceDone({ ...effect, outcome: { kind: 'transcript', text: 'stop', durationMs: 1 } });
  assert.equal(f.e.snapshot().phase, 'ended');
  assert.ok(end.some((e: any) => e.type === 'endSession'));
  assert.ok(!end.some((e: any) => e.type === 'send'));
});

test('VAD ignores calibration, ends after a spoken pause, and bounds silence', () => {
  const vad = new EndOfSpeech({ silenceMs: 300 });
  assert.equal(vad.onFrame(0.005, 100), false);
  assert.equal(vad.onFrame(0.1, 400), false);
  assert.equal(vad.heardSpeech, true);
  assert.equal(vad.onFrame(0.001, 500), false);
  assert.equal(vad.onFrame(0.001, 800), true);
  const quiet = new EndOfSpeech({ idleMs: 1000 });
  quiet.onFrame(0.001, 100);
  assert.equal(quiet.onFrame(0.001, 1000), true); assert.equal(quiet.heardSpeech, false);
});

test('native dB levels use amplitude, not a linear scale that mistakes room noise for speech', () => {
  assert.equal(dbToLevel(-60), 0.001);
  assert.equal(dbToLevel(0), 1);
  assert.equal(dbToLevel(undefined), 0);
  assert.ok(dbToLevel(-40) < 0.025);
});

test('speech sanitizes formatting, chunks within provider caps, and recognizes only whole stop phrases', () => {
  assert.equal(speakableText('## Answer\nHello **world**.\n```js\nsecret code\n```\nhttps://example.test'), 'Answer Hello world.');
  const chunks = speechChunks('A'.repeat(1000));
  assert.ok(chunks.length > 2); assert.ok(chunks.every((s: string) => s.length <= 400));
  assert.equal(isVoiceStopCommand('Hey Hermes, STOP!'), true);
  assert.equal(isVoiceStopCommand("That's all."), true);
  assert.equal(isVoiceStopCommand('stop the container'), false);
  assert.equal(isVoiceStopCommand('goodbye for now, then run the job'), false);
});

test('server 429 retries are bounded and interrupted backpressure never retries', async () => {
  class ErrorType extends Error { status: number; data: any; constructor(message: string, status: number, data = {}) { super(message); this.status = status; this.data = data; } }
  const { backpressure } = load('client', { '../../lib/api': { ApiError: ErrorType } });
  let calls = 0; const controller = new AbortController();
  const pending = backpressure(async () => { calls++; throw new ErrorType('busy', 429, { retry_after_ms: 250 }); }, controller.signal);
  controller.abort();
  await assert.rejects(pending); assert.equal(calls, 1);
});

test('an interrupted spoken reply still asks the server to settle generation', () => {
  const f = setup(); f.text();
  f.e.replyMessage({ id: 'final', text: 'Answer', createdAtMs: 11000, final: true });
  assert.ok(f.e.interrupt().some((e: any) => e.type === 'stopGeneration'));
});
test('stop phrases may address the selected bot by its own name', () => {
  assert.equal(isVoiceStopCommand('Hey Winglet, stop!', 'Winglet'), true);
  assert.equal(isVoiceStopCommand('Hey Winglet, stop the container', 'Winglet'), false);
});
