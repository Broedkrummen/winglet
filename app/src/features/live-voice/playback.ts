import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { Platform } from 'react-native';
/** Each play owns its player. Abort detaches callbacks and releases the native/browser source immediately. */
export async function playSpeech(url: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (Platform.OS !== 'web') await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false,
    interruptionMode: 'doNotMix', shouldPlayInBackground: false, allowsBackgroundRecording: false });
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let done = false; let started = false;
    const player = createAudioPlayer({ uri: url }, { updateInterval: 100 });
    const finish = (error?: Error) => {
      if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      sub.remove(); player.pause(); player.remove(); error ? reject(error) : resolve();
    };
    const abort = () => finish(new Error('Cancelled'));
    const timer = setTimeout(() => finish(new Error('Audio timed out. Check the audio output, then retry.')), 120000);
    const sub = player.addListener('playbackStatusUpdate', (s) => {
      if (s.error || s.mediaServicesDidReset) finish(new Error(s.error || 'Audio was interrupted. Tap to continue.'));
      else if (s.didJustFinish) finish();
      else if (started && !s.playing && !s.isBuffering) finish(new Error('Audio paused by the system. Tap to continue.'));
      if (s.playing) started = true;
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else { try { player.play(); } catch (e) { finish(e as Error); } }
  });
}
