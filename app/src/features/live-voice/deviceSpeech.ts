import { Platform } from 'react-native';
import { microphonePermission } from './microphonePermission';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { nativeSpeech, type DeviceSpeechCapabilities, type NativeSpeechPort } from './nativeSpeech';

const speechModule = Platform.OS === 'android' ? requireOptionalNativeModule<NativeSpeechPort>('WingletVoice') : null;
const native = speechModule ? nativeSpeech(speechModule, microphonePermission) : null;
let cached: DeviceSpeechCapabilities = { listen:false, speak:false, language:'', voice:'', engine:'',
  listenReason:'Device speech is unavailable in this native build. Use Server.', speakReason:'Device speech is unavailable in this native build. Use Server.' };
export async function probeDeviceSpeech(): Promise<DeviceSpeechCapabilities> {
  if (Platform.OS === 'web') return { ...cached, listen:!!recognizer(), speak:!!globalThis.speechSynthesis,
    listenReason:recognizer()?'Browser-managed speech may use its own online service.':'Unavailable in this browser.',
    speakReason:globalThis.speechSynthesis?'Browser-managed speech may use its own online service.':'Unavailable in this browser.' };
  if (!native) return cached;
  try { cached=await native.probe(); } catch { cached={...cached,listen:false,speak:false,listenReason:'Device speech could not be checked. Use Server.',speakReason:'Device speech could not be checked. Use Server.'}; }
  return cached;
}
type Recognition = {
  lang: string; interimResults: boolean; continuous: boolean;
  onstart: (() => void) | null; onresult: ((event: any) => void) | null; onerror: ((event: any) => void) | null; onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
};
function recognizer(): (new () => Recognition) | undefined {
  if (Platform.OS !== 'web') return undefined;
  return (globalThis as any).SpeechRecognition ?? (globalThis as any).webkitSpeechRecognition;
}
export const deviceCanListen = () => Platform.OS === 'web' ? !!recognizer() : cached.listen;
export const deviceCanSpeak = () => Platform.OS === 'web' ? !!globalThis.speechSynthesis : cached.speak;
export function dictate(signal: AbortSignal, partial: (s: string) => void, setFinish: (f: () => void) => void, onStarted: () => void, onLevel?: (level: number) => void): Promise<string> {
  if (Platform.OS !== 'web') return native ? native.dictate(signal, partial, setFinish, onStarted, onLevel) : Promise.reject(new Error('On-device recognition unavailable. Choose Server.'));
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
  if (Platform.OS !== 'web') return native ? native.say(text, signal) : Promise.reject(new Error('Device speech unavailable. Choose Server.'));
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
