import { setAudioModeAsync } from 'expo-audio';

// The audio mode is one setting for the whole app, and each call replaces all of it (on Android anything left
// out goes back to its default). So the app asks for it here only, always as a whole mode:
// - chimes mix with whatever's playing, so they never pause the user's music;
// - everything else (voice-note playback) keeps the default, which takes the audio while it plays;
// - while a voice note records, chimes leave the mode alone.
// No mode turns off playback on a silenced phone: on Android that switch is app-wide and would stop voice notes.

let recording = false;

/** Before a chime. False while a voice note records: play it without touching the mode. */
export async function chimeMode(): Promise<boolean> {
  if (recording) return false;
  await setAudioModeAsync({ playsInSilentMode: true, interruptionMode: 'mixWithOthers' });
  return true;
}

/** After a chime: back to the app's own mode. */
export async function defaultMode(): Promise<void> {
  if (recording) return;
  await setAudioModeAsync({ playsInSilentMode: true });
}

/** Around a voice note's recording. */
export async function recordingMode(on: boolean): Promise<void> {
  recording = on;
  await setAudioModeAsync({ allowsRecording: on, playsInSilentMode: true });
}
