import { RecordingPresets, useAudioRecorder } from 'expo-audio';
import { File } from 'expo-file-system';
import { useRef } from 'react';
import { Platform } from 'react-native';
import { recordingMode } from '../../lib/audioMode';
import { dbToLevel, EndOfSpeech } from './endOfSpeech';
import { microphonePermission } from './microphonePermission';
import type { Recording } from './client';

type Run = { cancel: () => void; finish: () => void };
export function useCapture() {
  const active = useRef<Run | null>(null);
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, bitRate: 48000, numberOfChannels: 1, isMeteringEnabled: true,
    android: { ...RecordingPresets.HIGH_QUALITY.android, audioSource: 'voice_recognition', maxFileSize: 1400000 } },
    (s) => { if (s.hasError || s.mediaServicesDidReset) active.current?.cancel(); });
  return {
    finish: () => active.current?.finish(),
    async record(signal: AbortSignal, level: (n: number) => void, onStarted: () => void): Promise<Recording> {
      if (active.current) throw new Error('The microphone is still stopping. Try again.');
      if (Platform.OS === 'web') return webRecord(signal, level, active, onStarted);
      let cancelled = false; let prepared = false; let success = false; let stopping = false;
      let finish!: () => void; let rejectRun!: (e: Error) => void;
      const completed = new Promise<void>((resolve, reject) => { finish = resolve; rejectRun = reject; });
      const cancel = () => { cancelled = true; finish(); };
      active.current = { cancel, finish };
      signal.addEventListener('abort', cancel, { once: true });
      let timer: ReturnType<typeof setInterval> | undefined;
      const vad = new EndOfSpeech(); const began = Date.now();
      try {
        if (!(await microphonePermission(signal))) throw new Error('Microphone permission denied. Allow Winglet microphone access in Settings.');
        if (signal.aborted || cancelled) throw new Error('Cancelled');
        await recordingMode(true);
        await recorder.prepareToRecordAsync(); prepared = true;
        if (signal.aborted || cancelled) throw new Error('Cancelled');
        recorder.record(); onStarted();
        let inputUid: string | undefined;
        let inputs: string | undefined;
        let routeChecking = false;
        let frames = 0;
        try {
          inputUid = (await recorder.getCurrentInput()).uid;
          inputs = recorder.getAvailableInputs().map((i) => i.uid).sort().join(',');
        } catch {} // Older OS versions cannot report the route; recorder/status errors still pause.

        timer = setInterval(() => {
          const s = recorder.getStatus();
          if (s.mediaServicesDidReset || !s.isRecording) { rejectRun(new Error('Microphone interrupted. Tap to speak again.')); return; }
          const n = dbToLevel(s.metering); level(n);
          if (++frames % 5 === 0 && !routeChecking) {
            routeChecking = true;
            void (async () => {
              const current = await recorder.getCurrentInput();
              const available = recorder.getAvailableInputs().map((i) => i.uid).sort().join(',');
              if (inputUid !== undefined && (inputUid !== current.uid || inputs !== available))
                rejectRun(new Error('Audio route changed. Check your headphones, then tap to speak again.'));
            })().catch(() => undefined).finally(() => { routeChecking = false; });
          }
          if (vad.onFrame(n, s.durationMillis)) finish();
        }, 100);
        await completed;
        stopping = true; await recorder.stop();
        const uri = recorder.uri;
        if (!uri || cancelled || signal.aborted) throw new Error('Cancelled');
        success = true;
        return { uri, mime: 'audio/mp4', durationMs: Date.now() - began, hasSpeech: vad.heardSpeech,
          dispose: () => { try { new File(uri).delete(); } catch {} } };
      } finally {
        if (timer) clearInterval(timer);
        signal.removeEventListener('abort', cancel);
        if (prepared && !stopping) await recorder.stop().catch(() => undefined);
        if (!success && prepared && recorder.uri) { try { new File(recorder.uri).delete(); } catch {} }
        await recordingMode(false).catch(() => undefined); active.current = null; level(0);
      }
    },
  };
}

async function webRecord(signal: AbortSignal, level: (n: number) => void, active: { current: Run | null }, onStarted: () => void): Promise<Recording> {
  let cancelled = false; let finishEarly = false;
  let finish = () => { finishEarly = true; };
  const cancel = () => { cancelled = true; finish(); };
  active.current = { cancel, finish: () => finish() };
  signal.addEventListener('abort', cancel, { once: true });
  let stream: MediaStream | undefined; let context: AudioContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let recorder: MediaRecorder | undefined;
  try {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('This browser cannot record audio. Use a supported browser over HTTPS.');
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    if (cancelled || signal.aborted) throw new Error('Cancelled');
    context = new AudioContext();
    const analyser = context.createAnalyser(); analyser.fftSize = 2048;
    context.createMediaStreamSource(stream).connect(analyser); await context.resume();
    const samples = new Float32Array(analyser.fftSize); const vad = new EndOfSpeech();
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 48000 });
    const chunks: Blob[] = []; let bytes = 0; const began = Date.now();
    const blob = await new Promise<Blob>((resolve, reject) => {
      finish = () => { if (recorder?.state !== 'inactive') recorder?.stop(); };
      recorder!.ondataavailable = (e) => { bytes += e.data.size; if (bytes > 1400000) { cancelled = true; finish(); } else chunks.push(e.data); };
      recorder!.onerror = () => reject(new Error('The microphone is unavailable.'));
      recorder!.onstop = () => resolve(new Blob(chunks, { type: recorder!.mimeType || mime || 'audio/webm' }));
      stream!.getAudioTracks().forEach((track) => { track.onended = () => { cancelled = true; finish(); }; track.onmute = () => { cancelled = true; finish(); }; });
      recorder!.start(250); onStarted();
      if (finishEarly || cancelled) finish();
      timer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, n) => sum + n * n, 0) / samples.length);
        level(rms);
        if (context?.state !== 'running') { cancelled = true; finish(); }
        if (vad.onFrame(rms, Date.now() - began)) finish();
      }, 100);
    });
    if (cancelled || signal.aborted) throw new Error('Recording interrupted. Tap to speak again.');
    return { blob, mime: blob.type.split(';')[0], durationMs: Date.now() - began, hasSpeech: vad.heardSpeech, dispose: () => undefined };
  } finally {
    if (timer) clearInterval(timer);
    signal.removeEventListener('abort', cancel);
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    stream?.getTracks().forEach((track) => { track.onended = null; track.onmute = null; track.stop(); });
    await context?.close().catch(() => undefined); active.current = null; level(0);
  }
}
