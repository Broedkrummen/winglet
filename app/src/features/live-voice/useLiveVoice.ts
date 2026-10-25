import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';
import { ApiError } from '../../lib/api';
import { claimVoiceAudio } from '../../lib/audioMode';
import { useLock } from '../../lib/appLock';
import { usePrefs } from '../../lib/prefs';
import { useApp } from '../../lib/store';
import type { Message, Server } from '../../lib/types';
import { backpressure, VoiceClient, type Recording } from './client';
import { useCapture } from './capture';
import { dictate, sayOnDevice } from './deviceSpeech';
import { VoiceEngine, type VoiceEffect, type VoiceSession } from './engine';
import { playSpeech } from './playback';
import { speechChunks } from './voiceText';

export function useLiveVoice(server: Server, chatId: string) {
  const [engine] = useState(() => new VoiceEngine({ assistantName: server.bot.name }));
  const state = useSyncExternalStore((fn) => engine.subscribe(fn), () => engine.snapshot());
  const capture = useCapture();
  const currentCapture = useRef(capture); currentCapture.current = capture;
  const [micActive, setMicActive] = useState(false);
  const [level, setLevel] = useState(0);
  const [stopStatus, setStopStatus] = useState('');
  const blocking = useRef(false);
  const control = useRef<AbortController | null>(null);
  const recording = useRef<Recording | null>(null);
  const session = useRef<VoiceSession | null>(null);
  const sendPending = useRef<Promise<void> | null>(null);
  const dictationFinish = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  const ownsAudio = useRef(false);
  const client = useRef(new VoiceClient(server, chatId)).current;
  const known = useRef(new Set<string>());
  const online = useApp((s) => s.network && s.runtime[server.id]?.status === 'online');
  const messages = useApp((s) => s.runtime[server.id]?.messages[chatId]) ?? EMPTY;
  const locked = useLock((s) => s.locked);
  const ready = () => {
    const s = useApp.getState();
    return mounted.current && ownsAudio.current && !useLock.getState().locked && s.foreground && s.network &&
      s.runtime[server.id]?.status === 'online' && s.servers.some((v) => v.id === server.id) &&
      (Platform.OS === 'web' ? document.visibilityState !== 'hidden' : AppState.currentState === 'active');
  };
  const disposeRecording = () => { recording.current?.dispose(); recording.current = null; };
  const cancel = () => { control.current?.abort(); control.current = null; dictationFinish.current = null; };
  const operate = (gen: number) => {
    cancel(); const controller = new AbortController(); control.current = controller;
    return { signal: controller.signal, valid: () => mounted.current && !controller.signal.aborted && engine.generation === gen && ready() };
  };
  const process = (effects: VoiceEffect[]) => {
    // Hard cancellation happens synchronously before any server acknowledgement is awaited.
    if (effects.some((e) => e.type === 'stopSpeech' || e.type === 'cancelCapture')) { cancel(); disposeRecording(); }
    if (effects.some((e) => e.type === 'cancelCapture')) setMicActive(false);
    const s = session.current;
    const cancelTurn = effects.find((e) => e.type === 'cancelTurn');
    if (cancelTurn?.type === 'cancelTurn' && s) {
      const generation = effects.some((e) => e.type === 'stopGeneration');
      const mustWait = engine.snapshot().phase === 'interrupted';
      if (mustWait) { blocking.current = true; setStopStatus('Stopping…'); }
      void (async () => {
        // A send already in flight must settle before Stop, otherwise it could start after Stop.
        if (generation) await sendPending.current?.catch(() => undefined);
        await client.stop(s, cancelTurn.turnId, generation);
        if (mustWait && mounted.current) setStopStatus(generation ? 'Stopped by the server' : 'Audio stopped');
        if (mustWait) blocking.current = false;
      })().catch((error) => {
        if (mustWait && mounted.current) setStopStatus(`Stop unconfirmed: ${(error as Error).message} End or retry Stop.`);
        // Do not let a new turn start while an earlier generation might still be running.
      });
    }
    for (const effect of effects) {
      if (effect.type === 'endSession') {
        session.current = null;
        if (s) void client.end(s).catch(() => undefined);
      } else if ('gen' in effect) void execute(effect).catch(() => undefined);
    }
  };
  const execute = async (effect: Extract<VoiceEffect, { gen: number }>) => {
    if (effect.gen !== engine.generation || !ready()) return;
    const { signal, valid } = operate(effect.gen);
    try {
      if (effect.type === 'openSession') {
        const s = await client.open(signal);
        if (!valid()) { void client.end(s).catch(() => undefined); return; }
        session.current = s; blocking.current = false; setStopStatus('');
        process(engine.sessionReady(s));
      } else if (effect.type === 'listen') {
        disposeRecording(); known.current = new Set((useApp.getState().runtime[server.id]?.messages[chatId] ?? []).map((m) => m.id));
        if (effect.delayMs) await new Promise((resolve) => setTimeout(resolve, effect.delayMs));
        if (!valid()) return;
        if (Date.now() >= (session.current?.expiresAt ?? 0)) { process(engine.sessionLost('Session expired. Tap to reconnect.')); return; }
        const prefs = usePrefs.getState().prefs;
        if (prefs.voiceListenWith === 'device') {
          const text = await dictate(signal, (text) => { if (valid()) engine.partialTranscript({ ...effect, text }); },
            (finish) => { dictationFinish.current = finish; }, () => { if (valid()) setMicActive(true); });
          if (mounted.current) setMicActive(false);
          if (valid()) process(engine.utteranceDone({ ...effect, outcome: { kind: 'transcript', text, durationMs: 0 } }));
        } else {
          const audio = await currentCapture.current.record(signal, (n) => { if (mounted.current) setLevel(n); }, () => { if (valid()) setMicActive(true); });
          if (mounted.current) setMicActive(false);
          if (!valid()) { audio.dispose(); return; }
          recording.current = audio;
          process(engine.utteranceDone({ ...effect, outcome: { kind: 'audio', hasSpeech: audio.hasSpeech, durationMs: audio.durationMs } }));
        }
      } else if (effect.type === 'transcribe') {
        const s = session.current; const audio = recording.current;
        if (!s || !audio) throw new Error('The recording was discarded. Speak again.');
        const data = await backpressure(() => client.transcribe(s, effect.turnId, effect.utteranceId, audio, signal), signal);
        if (valid()) { disposeRecording(); process(engine.transcriptReceived({ ...effect, text: data.transcript, noSpeech: data.no_speech, seq: data.seq, final: true })); }
      } else if (effect.type === 'send') {
        if (!valid()) return;
        // Text is sent once over the live connection. It cannot queue after a reconnect.
        const promise = useApp.getState().sendMessage(server.id, chatId, effect.text, { clientId: effect.clientId, liveOnly: true });
        sendPending.current = promise;
        await promise;
        if (sendPending.current === promise) sendPending.current = null;
        if (valid()) reconcile();
      } else if (effect.type === 'speak') {
        const s = session.current; if (!s) throw new Error('Session expired. Reconnect to speak.');
        for (const text of speechChunks(effect.text)) {
          if (!valid()) return;
          if (usePrefs.getState().prefs.voiceSpeakWith === 'device') await sayOnDevice(text, signal);
          else {
            const url = await backpressure(() => client.speak(s, effect.turnId, effect.messageId, text, signal), signal);
            if (!valid()) return;
            await playSpeech(url, signal);
          }
        }
        if (valid()) process(engine.speechFinished(effect.turnId));
      }
    } catch (error) {
      if (!valid()) return;
      if (effect.type === 'listen' && mounted.current) setMicActive(false);
      const message = (error as Error).message;
      if (error instanceof ApiError && (error.status === 404 || error.status === 401 || error.status === 403)) {
        disposeRecording(); session.current = null; process(engine.sessionLost(message));
      } else if (effect.type === 'openSession') process(engine.sessionFailed(message));
      else if (effect.type === 'listen') process(engine.captureFailed(message, /permission|denied|not.allowed/i.test(message) ? 'permission' : 'capture'));
      else if (effect.type === 'transcribe') process(engine.transcriptionFailed({ ...effect, message }));
      else if (effect.type === 'speak') process(engine.speechFailed(effect.turnId, message));
      else if (effect.type === 'send') process(engine.captureFailed('Delivery was not confirmed. Check the chat before speaking again.', 'send'));
    }
  };
  function reconcile() {
    const rows = useApp.getState().runtime[server.id]?.messages[chatId] ?? [];
    const turn = engine.turn;
    if (!turn) return;
    const user = rows.find((m) => m.meta?.client_id === `voice-${turn.id}` && m.status === 'final');
    if (!user) return;
    engine.sentMessage({ clientId: `voice-${turn.id}`, text: user.text });
    // Claim only a new final reply after this acknowledged user message. Progress/status cards stay silent.
    const reply = rows.find((m) => m.role === 'bot' && !known.current.has(m.id) && m.status === 'final' &&
      !m.meta?.activity && !m.meta?.hidden && !m.meta?.status_key && !m.meta?.kind && !m.meta?.routine &&
      (m.position !== undefined && user.position !== undefined ? m.position > user.position : m.created_at >= user.created_at));
    if (reply) process(engine.replyMessage({ id: reply.id, text: reply.text, createdAtMs: reply.created_at * 1000, final: true }));
  }

  useEffect(() => { reconcile(); }, [messages]);
  useEffect(() => {
    mounted.current = true;
    const release = claimVoiceAudio();
    if (!release) {
      engine.captureFailed('Another recording or voice conversation is open. End it before opening this one.');
      return () => { mounted.current = false; };
    }
    ownsAudio.current = true;
    process(engine.open());
    const pause = () => process(engine.suspend('background'));
    const subscription = AppState.addEventListener('change', (s) => { if (s !== 'active') pause(); });
    const visibility = () => { if (document.visibilityState === 'hidden') pause(); };
    const route = () => { if (engine.snapshot().phase === 'listening' || engine.snapshot().phase === 'speaking') pause(); };
    if (Platform.OS === 'web') {
      document.addEventListener('visibilitychange', visibility);
      navigator.mediaDevices?.addEventListener('devicechange', route);
    }
    return () => {
      process(engine.end()); mounted.current = false; ownsAudio.current = false; cancel(); disposeRecording(); release();
      subscription.remove();
      if (Platform.OS === 'web') { document.removeEventListener('visibilitychange', visibility); navigator.mediaDevices?.removeEventListener('devicechange', route); }
    };
  }, []);
  useEffect(() => {
    if (!online) process(engine.suspend('reconnect'));
    // Reconnect is deliberate: the next tap opens a fresh session and starts a fresh turn.
  }, [online]);
  useEffect(() => { if (locked) process(engine.suspend('background')); }, [locked]);
  useEffect(() => {
    if (state.phase !== 'thinking') return;
    const timer = setTimeout(() => process(engine.replyMissing()), 5 * 60 * 1000);
    return () => clearTimeout(timer);
  }, [state.phase, state.turnId]);

  return { state, level, micActive, stopStatus,
    start: () => {
      if (!ready() || blocking.current) return;
      if (state.phase === 'reconnecting' || state.phase === 'ended') { process(engine.open()); return; }
      setStopStatus('');
      process(state.phase === 'error' ? engine.retry() : engine.startListening());
    },
    finish: () => { dictationFinish.current?.(); currentCapture.current.finish(); },
    interrupt: () => process(engine.interrupt()),
    retryStop: () => {
      const turn = [...engine.snapshot().turns].reverse().find((t) => t.status === 'interrupted');
      if (turn && session.current) {
        setStopStatus('Stopping…'); void client.stop(session.current, turn.id, true).then(() => {
          blocking.current = false; if (mounted.current) setStopStatus('Stopped by the server');
        }).catch((e) => { if (mounted.current) setStopStatus(`Stop unconfirmed: ${e.message}`); });
      }
    },
    mute: () => process(engine.setMuted(!engine.snapshot().muted)),
    end: () => process(engine.end()),
    blocked: blocking.current,
  };
}
const EMPTY: Message[] = [];
