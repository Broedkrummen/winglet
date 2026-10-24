/**
 * When a recording has heard enough.
 *
 * Ported from Herald's `EndOfSpeech` (`shared/core/src/commonMain/kotlin/dev/hermeskotlin/core/
 * voice/Speech.kt`, MIT). Desktop's fixed level assumes a quiet room; a phone is often somewhere
 * noisier, so the bar rises with the measured background noise: speech must stand clearly above
 * it, and quiet is anything back near it. The opening moments only measure the room.
 */

export type VoiceActivity = {
  /** The least normalized level (0..1) that counts as speech; noise around it raises the bar. */
  speechLevel: number;
  /** Quiet this long after speech ends the recording. */
  silenceMs: number;
  /** With no speech at all, give up after this long; 0 waits for `finish`. */
  idleMs: number;
  /** Hard cap on one recording. */
  maxMs: number;
};

export const DEFAULT_ACTIVITY: VoiceActivity = {
  speechLevel: 0.025,
  silenceMs: 1250,
  idleMs: 12_000,
  maxMs: 60_000,
};

const CALIBRATION_MS = 300;
const SPEECH_OVER_NOISE = 2.5;
const QUIET_OVER_NOISE = 1.6;
const QUIET_FRACTION = 0.8;
/** A syllable's worth of speech in a pause starts the sentence over. */
const SPEECH_RUN_MS = 60;
/** A level between quiet and speech needs longer, because noise reaches it often. */
const MURMUR_RUN_MS = 200;

export class EndOfSpeech {
  readonly activity: VoiceActivity;
  heardSpeech = false;
  /** The measured background level, for diagnostics; negative until the first frame. */
  noise = -1;
  private silenceSince = -1;
  /** Since when the level has stood above quiet, in a pause after speech; -1 when it hasn't. */
  private loudSince = -1;
  private lastFrameEnd = 0;

  constructor(activity: Partial<VoiceActivity> = {}) {
    this.activity = { ...DEFAULT_ACTIVITY, ...activity };
  }

  /** Feed one frame's `level` at `elapsedMs`; true once the recording should end. */
  onFrame(level: number, elapsedMs: number): boolean {
    const value = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
    const frameStart = this.lastFrameEnd;
    this.lastFrameEnd = elapsedMs;
    if (elapsedMs <= CALIBRATION_MS) {
      this.noise = this.noise < 0 ? value : this.noise + (value - this.noise) * 0.2;
      return false;
    }
    const speechBar = Math.max(this.activity.speechLevel, this.noise * SPEECH_OVER_NOISE);
    const quietBar = Math.max(this.activity.speechLevel * QUIET_FRACTION, this.noise * QUIET_OVER_NOISE);
    const speech = value >= speechBar;
    if (speech) {
      this.heardSpeech = true;
      // A steady loud room lifts the bar too, slowly enough that a long sentence doesn't.
      this.noise += (value - this.noise) * 0.002;
    } else {
      // The background follows the quiet frames: down quickly, up slowly.
      this.noise = this.noise < 0 ? value
        : value < this.noise ? this.noise + (value - this.noise) * 0.3
          : this.noise + (value - this.noise) * 0.02;
    }
    if (this.heardSpeech && value < quietBar) {
      this.loudSince = -1;
      if (this.silenceSince < 0) this.silenceSince = elapsedMs;
      if (elapsedMs - this.silenceSince >= this.activity.silenceMs) return true;
    } else if (this.heardSpeech) {
      // Road noise, wind or a fan poke above the quiet bar for a moment; only a run of it is
      // someone talking again, so a blip doesn't start the pause over. A run counts from its
      // first frame's start. Speech needs only a syllable; a murmur needs longer.
      if (this.loudSince < 0) this.loudSince = frameStart;
      if (elapsedMs - this.loudSince >= (speech ? SPEECH_RUN_MS : MURMUR_RUN_MS)) this.silenceSince = -1;
    }
    if (!this.heardSpeech && this.activity.idleMs > 0 && elapsedMs >= this.activity.idleMs) return true;
    return elapsedMs >= this.activity.maxMs;
  }
}

/** MediaRecorder and expo-audio both report a level; this makes it the 0..1 Herald expects. */
export function normalizeLevel(level: number): number {
  if (!Number.isFinite(level)) return 0;
  return Math.max(0, Math.min(1, level));
}

/** expo-audio's metering is dBFS (-160..0); the VAD wants 0..1. */
export function dbToLevel(db: number | undefined | null): number {
  if (db === undefined || db === null || !Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(1, Math.pow(10, db / 20)));
}
