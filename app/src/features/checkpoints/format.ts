/** Pure decisions for the Checkpoints screens, kept out of the views so they can be tested. */

import type { CheckpointEffects, CheckpointFile, CheckpointPreview, CheckpointSummary, RestoreOutcome } from './types';

/** "Today", "Yesterday", a weekday within the week, then "21 Oct". Days are the phone's own. */
export function dayLabel(at: number, now = Date.now() / 1000): string {
  if (!at) return '';
  const day = (ms: number) => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const days = Math.round((day(at * 1000) - day(now * 1000)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === -1) return 'Yesterday';
  const date = new Date(at * 1000);
  if (days > -7 && days < 0) return date.toLocaleDateString([], { weekday: 'long' });
  const sameYear = date.getFullYear() === new Date(now * 1000).getFullYear();
  return date.toLocaleDateString([], sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

/** The time of day, as the chat shows message times. */
export function clockTime(at: number): string {
  if (!at) return '';
  return new Date(at * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function fileCount(n: number): string {
  return n === 1 ? '1 file' : `${n} files`;
}

/** "3 files · +42 −7", or "" when Hermes couldn't count a snapshot's diff. */
export function countsLabel(checkpoint: Pick<CheckpointSummary, 'files' | 'insertions' | 'deletions'>): string {
  const files = Math.max(0, checkpoint.files || 0);
  const insertions = Math.max(0, checkpoint.insertions || 0);
  const deletions = Math.max(0, checkpoint.deletions || 0);
  if (!files && !insertions && !deletions) return '';
  const parts: string[] = [];
  if (files) parts.push(fileCount(files));
  if (insertions && deletions) parts.push(`+${insertions} −${deletions}`);
  else if (insertions) parts.push(`+${insertions}`);
  else if (deletions) parts.push(`−${deletions}`);
  return parts.join(' · ');
}

/** What a file's mark reads: added, deleted, renamed, modified. */
export function fileMark(file: CheckpointFile): string {
  if (file.status === 'added') return 'A';
  if (file.status === 'deleted') return 'D';
  if (file.status === 'renamed') return 'R';
  return 'M';
}

export type DiffTone = 'added' | 'removed' | 'hunk' | 'meta' | 'plain';

/** The colour family for one line of a unified diff. */
export function diffTone(line: string): DiffTone {
  if (line.startsWith('+++') || line.startsWith('---')) return 'plain';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'added';
  if (line.startsWith('-')) return 'removed';
  if (/^(diff --git|index |new file mode|deleted file mode|renamed from|renamed to|rename from|rename to|similarity index|old mode|new mode|Binary files )/.test(line)) return 'meta';
  return 'plain';
}

/** What restoring will do, in sentences that match the safe/unsafe choice. */
export function effectLines(effects: CheckpointEffects, safe: boolean): string[] {
  const restore = Math.max(0, effects.restore || 0);
  const remove = Math.max(0, effects.remove || 0);
  const recreate = Math.max(0, effects.recreate || 0);
  const renamed = Math.max(0, effects.renamed || 0);
  const lines: string[] = [];
  if (!restore && !remove && !recreate && !renamed) return ['Nothing has changed since this snapshot, so there is nothing to restore.'];
  const goes = (n: number) => (n === 1 ? 'goes' : 'go');
  const how = (n: number) => (n === 1 ? 'how it was' : 'how they were');
  if (restore) {
    lines.push(safe
      ? `Up to ${fileCount(restore)} ${goes(restore)} back to ${how(restore)}.`
      : `${fileCount(restore)} ${goes(restore)} back to ${how(restore)}, including ones you edited yourself.`);
  }
  if (recreate) lines.push(recreate === 1 ? '1 file Hermes removed since is put back.' : `${fileCount(recreate)} Hermes removed since are put back.`);
  if (renamed) lines.push(renamed === 1 ? '1 renamed file is renamed back.' : `${fileCount(renamed)} renamed files are renamed back.`);
  if (remove) {
    lines.push(safe
      ? (remove === 1 ? '1 file created since is removed. Files you made yourself are left alone.'
        : `${fileCount(remove)} created since are removed. Files you made yourself are left alone.`)
      : (remove === 1 ? '1 file created since, including one you made yourself, is removed.'
        : `${fileCount(remove)} created since, including any you made yourself, are removed.`));
  }
  return lines;
}

/** "12 files changed · +340 −22" for a preview's heading. */
export function previewSummary(preview: Pick<CheckpointPreview, 'files' | 'effects'>): string {
  const total = preview.files.length;
  if (!total) return '';
  const added = preview.files.reduce((n, f) => n + Math.max(0, f.insertions), 0);
  const removed = preview.files.reduce((n, f) => n + Math.max(0, f.deletions), 0);
  const parts = [`${fileCount(total)} changed`];
  if (added || removed) parts.push(`+${added} −${removed}`);
  if (preview.effects?.binary) parts.push(`${fileCount(preview.effects.binary)} binary`);
  return parts.join(' · ');
}

/** Why the restore button is unavailable, or "" when it can run. */
export function restoreBlocker(preview: CheckpointPreview, options: { online: boolean; busy: string[] }): string {
  if (!preview.supported) return preview.reason || "This Hermes version doesn't keep checkpoints.";
  if (!preview.enabled) return preview.reason || 'Checkpoints are off on this server.';
  if (!preview.can_restore) return "This server can list checkpoints but can't restore them.";
  if (preview.error) return preview.error;
  if (preview.unchanged) return 'Nothing has changed since this snapshot.';
  if (options.busy.length) return `A reply is running in ${options.busy[0]}. Restoring waits until it finishes.`;
  if (!options.online) return 'Connect to your server to restore.';
  return '';
}

export type ResultGroup = { key: string; title: string; files: string[] };

/** The files a restore reported, grouped the way the result screen reads them. */
export function resultGroups(outcome: RestoreOutcome): ResultGroup[] {
  const groups: ResultGroup[] = [
    { key: 'restored', title: 'Restored', files: outcome.restored ?? [] },
    { key: 'skipped', title: 'Left alone, since you edited them', files: outcome.skipped_user_edits ?? [] },
    { key: 'oversize', title: 'Too large to restore', files: outcome.skipped_oversize ?? [] },
    { key: 'failed', title: "Couldn't be removed", files: outcome.failed_deletes ?? [] },
  ];
  return groups.filter((group) => group.files.length > 0);
}

/** The safety snapshot an undo would use, or null when Hermes didn't leave one. */
export function safetyOf(outcome: RestoreOutcome): { hash: string; short: string } | null {
  return outcome.safety?.hash ? outcome.safety : null;
}

/** A retried restore must carry the same id, so the server answers instead of restoring again. */
export function operationId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The files a preview shows for one path, bounded again on the phone. */
export function patchLines(preview: CheckpointPreview, file: CheckpointFile | undefined, limit = 900): string[] {
  if (!file || file.start === null || file.end === null) return [];
  return preview.diff.lines.slice(file.start, Math.min(file.end, file.start + limit));
}
