import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { Platform } from 'react-native';
/** Each play owns its player. Abort detaches callbacks and releases the native/browser source immediately. */
export async function playSpeech(url: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (Platform.OS === 'web') return playBrowserSpeech(url, signal);
  await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false,
    interruptionMode: 'doNotMix', shouldPlayInBackground: false, allowsBackgroundRecording: false });
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let done = false; let started = false; let paused: ReturnType<typeof setTimeout> | undefined;
    const player = createAudioPlayer({ uri: url }, { updateInterval: 100 });
    const finish = (error?: Error) => {
      if (done) return; done = true; clearTimeout(timer); clearTimeout(paused); signal.removeEventListener('abort', abort);
      sub.remove(); player.pause(); player.remove(); error ? reject(error) : resolve();
    };
    const abort = () => finish(new Error('Cancelled'));
    const timer = setTimeout(() => finish(new Error('Audio timed out. Check the audio output, then retry.')), 120000);
    const sub = player.addListener('playbackStatusUpdate', (s) => {
      if (s.error || s.mediaServicesDidReset) finish(new Error(s.error || 'Audio was interrupted. Tap to continue.'));
      else if (s.didJustFinish) finish();
      else if (started && !s.playing && !s.isBuffering && !paused) paused = setTimeout(() => finish(new Error('Audio paused by the system. Tap to continue.')), 250);
      if (s.playing) { started = true; clearTimeout(paused); paused = undefined; }
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else { try { player.play(); } catch (e) { finish(e as Error); } }
  });
}

/** Browser media has a separate ended event; a final pause can precede it. */
function playBrowserSpeech(url: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const audio = new Audio(url); let done = false;
    let paused: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (done) return; done = true; clearTimeout(timer); clearTimeout(paused);
      signal.removeEventListener('abort', abort);
      audio.onended = audio.onerror = audio.onpause = audio.onplaying = null;
      audio.pause(); audio.removeAttribute('src'); audio.load();
      error ? reject(error) : resolve();
    };
    const abort = () => finish(new Error('Cancelled'));
    const timer = setTimeout(() => finish(new Error('Speech playback timed out.')), 120000);
    audio.onended = () => finish();
    audio.onerror = () => finish(new Error('Speech audio could not be played.'));
    audio.onpause = () => {
      clearTimeout(paused);
      paused = setTimeout(() => { if (!audio.ended) finish(new Error('Audio paused by the system. Tap to continue.')); }, 250);
    };
    audio.onplaying = () => clearTimeout(paused);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else void audio.play().catch((e) => finish(new Error(e.message || 'Tap to allow speech playback.')));
  });
}
