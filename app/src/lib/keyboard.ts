/** Only cover the part of this viewport actually hidden by a docked keyboard. */
export function keyboardInset(y: number, height: number, frame: { screenY: number; height: number } | null): number {
  if (!frame || frame.height <= 0 || height <= 0 || !Number.isFinite(frame.screenY)) return 0;
  return Math.max(0, Math.min(height, y + height - frame.screenY));
}
