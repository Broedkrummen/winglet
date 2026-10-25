import { Platform } from 'react-native';
type Recognition = {
  lang: string; interimResults: boolean; continuous: boolean;
  onstart: (() => void) | null; onresult: ((event: any) => void) | null; onerror: ((event: any) => void) | null; onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
};
function recognizer(): (new () => Recognition) | undefined {
  if (Platform.OS !== 'web') return undefined;
  return (globalThis as any).SpeechRecognition ?? (globalThis as any).webkitSpeechRecognition;
}
export const deviceCanListen = () => !!recognizer();
export const deviceCanSpeak = () => Platform.OS === 'web' && !!globalThis.speechSynthesis;
export function dictate(signal: AbortSignal, partial: (s: string) => void, setFinish: (f: () => void) => void, onStarted: () => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const Constructor = recognizer();
    if (!Constructor) { reject(new Error('This device has no available speech recognizer. Choose Server.')); return; }
    const r = new Constructor(); let final = ''; let done = false;
    const finish = (error?: Error) => {
      if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      r.onstart = r.onresult = r.onerror = r.onend = null; r.abort();
      error ? reject(error) : resolve(final);
    };
    const abort = () => finish(new Error('Cancelled'));
    const timer = setTimeout(() => r.stop(), 60000);
    r.lang = globalThis.navigator?.language || 'en-US'; r.continuous = false; r.interimResults = true;
    r.onstart = onStarted;
    r.onresult = (e) => {
      let current = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const text = e.results[i][0]?.transcript || '';
        if (e.results[i].isFinal) final += text + ' '; else current += text;
      }
      partial((final + current).slice(0, 8000));
    };
    r.onerror = (e) => finish(new Error(e.error === 'not-allowed' ? 'Microphone permission denied. Allow it in browser settings.' : `Speech recognition failed: ${e.error}`));
    r.onend = () => finish(); setFinish(() => r.stop());
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else { try { r.start(); } catch (e) { finish(e as Error); } }
  });
}
export function sayOnDevice(text: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!deviceCanSpeak()) { reject(new Error('Device speech is unavailable. Choose Server.')); return; }
    const synth = globalThis.speechSynthesis; const utterance = new SpeechSynthesisUtterance(text);
    let done = false;
    const finish = (error?: Error) => {
      if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      utterance.onend = utterance.onerror = null; error ? reject(error) : resolve();
    };
    const abort = () => { synth.cancel(); finish(new Error('Cancelled')); };
    const timer = setTimeout(() => { synth.cancel(); finish(new Error('Device speech timed out.')); }, 90000);
    utterance.onend = () => finish(); utterance.onerror = (e) => finish(new Error(`Device speech: ${e.error}`));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else synth.speak(utterance);
  });
}
