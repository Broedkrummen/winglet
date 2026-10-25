import { setAudioModeAsync } from 'expo-audio';

// The audio mode is one setting for the whole app, and each call replaces all of it (on Android anything left
// out goes back to its default). So the app asks for it here only, always as a whole mode:
// - chimes mix with whatever's playing, so they never pause the user's music;
// - everything else (voice-note playback) keeps the default, which takes the audio while it plays;
// - while a voice note records, chimes leave the mode alone.
// No mode turns off playback on a silenced phone: on Android that switch is app-wide and would stop voice notes.

let recording = false;
let conversation = false;

/** One foreground conversation owns audio routing; chimes must not change focus beneath it. */
export function claimVoiceAudio(): (() => void) | null {
  if (conversation || recording) return null;
  conversation = true;
  let released = false;
  return () => {
    if (released) return;
    released = true; conversation = false;
    void defaultMode().catch(() => undefined);
  };
}

/** Before a chime. False while a voice note records: play it without touching the mode. */
export async function chimeMode(): Promise<boolean> {
  if (recording || conversation) return false;
  await setAudioModeAsync({ playsInSilentMode: true, interruptionMode: 'mixWithOthers' });
  return true;
}

/** After a chime: back to the app's own mode. */
export async function defaultMode(): Promise<void> {
  if (recording || conversation) return;
  await setAudioModeAsync({ playsInSilentMode: true });
}

/** Around a voice note's recording. */
export async function recordingMode(on: boolean): Promise<void> {
  recording = on;
  await setAudioModeAsync({ allowsRecording: on, playsInSilentMode: true,
    ...(conversation ? { interruptionMode: 'doNotMix', shouldPlayInBackground: false, allowsBackgroundRecording: false } : {}) });
}
