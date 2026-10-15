import type { PetState } from './pets';

/** What touching the pet makes it do, and until when. `until` is Infinity while it's held. */
export type Reaction = { state: PetState; until: number } | null;

/** Three taps inside this window make it jump. */
export const TRIPLE_MS = 1200;

/** A tap: a wave for one loop of the animation, or a jump on the third quick tap. */
export function tapReaction(recent: readonly number[], now: number, loopMs: number): { reaction: Reaction; recent: number[] } {
  const taps = [...recent.filter((at) => now - at < TRIPLE_MS), now];
  if (taps.length >= 3) return { reaction: { state: 'jump', until: now + loopMs }, recent: [] };
  return { reaction: { state: 'wave', until: now + loopMs }, recent: taps };
}

/** Held down: it looks like it's thinking about you until you let go. */
export function holdReaction(): Reaction {
  return { state: 'review', until: Infinity };
}

/** What the pet shows: a reaction while it lasts, then what the agent is really doing. */
export function shownState(real: PetState, reaction: Reaction, now: number): PetState {
  return reaction && now < reaction.until ? reaction.state : real;
}

/** Slide this far from where the hold began to cancel a hold-to-talk. */
export const CANCEL_PX = 80;

/** Whether a hold-to-talk that just ended was cancelled: slid well away, or interrupted by the system. */
export function holdCancelled(completed: boolean, dx: number, dy: number): boolean {
  return !completed || Math.hypot(dx, dy) > CANCEL_PX;
}
