export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown' | 'cancelled';
export type RoutineDefinition = { id: string; name?: string; prompt?: string; schedule_display?: string; timezone?: string;
  state?: string; enabled?: boolean; next_run_at?: string | null; manual_run_at?: string | null; revision?: string };
export type RoutineRun = { id: string; routine_id: string; title: string; status: RunStatus; trigger: 'manual' | 'scheduled' | 'unknown';
  recorded: boolean; claimed_at: number | null; scheduled_at: number | null; started_at: number | null; finished_at: number | null;
  duration_seconds?: number | null; error?: string | null; summary?: string; output?: string; has_output?: boolean;
  output_truncated?: boolean; session_id?: string; timezone?: string; archived: boolean; definition_changed: boolean;
  definition_provenance: 'run_output' | 'first_observed' | 'surviving_output'; definition?: RoutineDefinition; delivery_outcome?: string };
export type HistoryPage = { routine: RoutineDefinition; archived: boolean; runs: RoutineRun[]; next_cursor: string | null;
  history_notice: string; retention: { per_routine: number; per_bot: number }; stale?: boolean };
export const MAX_VISIBLE_RUNS = 200;
export const labels: Record<RunStatus, string> = { pending: 'Queued', running: 'Running', completed: 'Completed',
  failed: 'Failed', interrupted: 'Interrupted', unknown: 'Unknown', cancelled: 'Cancelled' };
export function statusLabel(status: string) { return labels[status as RunStatus] ?? 'Unknown'; }
export function triggerLabel(trigger: string) { return trigger === 'scheduled' ? 'Scheduled' : trigger === 'manual' ? 'Manual' : 'Trigger unavailable'; }
export function routineHref(serverId: string, routineId: string, runId?: string) {
  const base = `/routine/${encodeURIComponent(serverId)}/${encodeURIComponent(routineId)}`;
  return runId ? `${base}/run/${encodeURIComponent(runId)}` : base;
}
export function mergeRuns(current: RoutineRun[], incoming: RoutineRun[], limit = MAX_VISIBLE_RUNS): RoutineRun[] {
  const byId = new Map(current.map(r => [r.id, r]));
  for (const row of incoming) byId.set(row.id, row);
  return [...byId.values()].sort((a,b) => (b.claimed_at ?? 0) - (a.claimed_at ?? 0) || b.id.localeCompare(a.id)).slice(0, limit);
}
export function duration(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return 'Duration unavailable';
  if (value < 1) return 'Under a second';
  if (value < 60) return `${Math.floor(value)} sec`;
  const minutes = Math.floor(value / 60);
  return minutes < 60 ? `${minutes} min ${Math.floor(value % 60)} sec` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
export function dateText(value: number | string | null | undefined, timezone?: string) {
  if (value == null || value === '') return 'Unavailable';
  const d = new Date(typeof value === 'number' ? value * 1000 : value);
  if (!Number.isFinite(d.getTime())) return 'Unavailable';
  try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(d); }
  catch { return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'; }
}
