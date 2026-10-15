import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import { chimeMode, defaultMode } from './audioMode';
import { usePrefs } from './prefs';

// One map so every screen sounds the same, like haptics. Quiet, short, and never in the way: they mix with
// whatever's playing and a failure to play is ignored.
const SOURCES = {
  tap: require('../../assets/sounds/tap.wav'),
  sent: require('../../assets/sounds/sent.wav'),
  reply: require('../../assets/sounds/reply.wav'),
  needsYou: require('../../assets/sounds/needs-you.wav'),
} as const;

type Name = keyof typeof SOURCES;
const players: Partial<Record<Name, AudioPlayer>> = {};
/** Longer than the longest sound: then the app's own audio mode comes back. */
const RESTORE_MS = 1200;
let lastChime = 0;

async function play(name: Name) {
  if (!usePrefs.getState().prefs.sounds) return;
  try {
    const switched = await chimeMode();
    const player = players[name] ?? (players[name] = createAudioPlayer(SOURCES[name]));
    player.volume = 0.4;
    await player.seekTo(0);
    player.play();
    if (switched) {
      const at = (lastChime = Date.now());
      setTimeout(() => { if (lastChime === at) defaultMode().catch(() => undefined); }, RESTORE_MS);
    }
  } catch {
    // A missing audio device, or a browser that hasn't been tapped yet: stay quiet.
  }
}

export const sound = {
  /** The pet was poked. */
  tap: () => { play('tap'); },
  /** Your message or voice note went out. */
  sent: () => { play('sent'); },
  /** A reply finished in the chat on screen. */
  reply: () => { play('reply'); },
  /** An approval or question arrived while the app is open. */
  needsYou: () => { play('needsYou'); },
};
