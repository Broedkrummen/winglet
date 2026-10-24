export type StopState = { operation_id: string; status: 'stopping' | 'stopped' | 'already_exited' | 'failed'; message: string };
export type ProcessRow = {
  handle: string; command: string; workspace: string; status: 'running' | 'exited' | 'stopped';
  started_at: number; exit_code: number | null; detached: boolean; can_stop: boolean; stop: StopState | null;
};
export type OutputPage = { cursor: string; reset: boolean; text: string; truncated: boolean; unavailable: boolean };
export type OutputState = { cursor?: string; text: string; truncated: boolean; unavailable: boolean };
export const EMPTY_OUTPUT: OutputState = { text: '', truncated: false, unavailable: false };
export const OUTPUT_LIMIT = 16_384;

/** A full replacement after truncation/redaction prevents stale cursors duplicating or leaking old lines. */
export function applyOutput(previous: OutputState, page: OutputPage): OutputState {
  if (previous.cursor === page.cursor) {
    // Retention/recovery metadata can change even when the retained text is identical.
    const truncated = previous.truncated || page.truncated;
    return truncated === previous.truncated && page.unavailable === previous.unavailable ? previous
      : { ...previous, truncated, unavailable: page.unavailable };
  }
  const combined = page.reset ? page.text : previous.text + page.text;
  const chars = Array.from(combined);
  return { cursor: page.cursor, text: chars.slice(-OUTPUT_LIMIT).join(''),
    truncated: page.truncated || chars.length > OUTPUT_LIMIT, unavailable: page.unavailable };
}

export function processLabel(row: ProcessRow): string {
  if (row.stop?.status === 'stopping') return 'Stopping…';
  if (row.status === 'running') return 'Running';
  if (row.status === 'stopped') return 'Stopped';
  return row.exit_code == null ? 'Exited' : `Exited · ${row.exit_code}`;
}
