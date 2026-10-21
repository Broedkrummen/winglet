/** Page-space physics keep the deck in place when its viewport changes size. */
export function resistDeckEdge(page: number, count: number): number {
  'worklet';
  const bound = Math.max(0, Math.min(Math.max(0, count - 1), page));
  const excess = page - bound;
  return bound + excess * 0.28 / (1 + Math.abs(excess) * 3);
}

/** Deliberate drags and short flicks advance one character; tentative drags return home. */
export function releaseDeckPage(start: number, translation: number, velocity: number, count: number): number {
  'worklet';
  const anchor = Math.round(start);
  const travel = -translation;
  const speed = -velocity;
  const direction = Math.abs(travel) >= 0.18 ? Math.sign(travel) : Math.abs(speed) >= 0.65 ? Math.sign(speed) : 0;
  return Math.max(0, Math.min(Math.max(0, count - 1), anchor + direction));
}

export const DECK_SPRING = { stiffness: 250, damping: 24, mass: 0.9 };
