/** What Hermes snapshotted, as `/api/checkpoints` reports it. Times are server seconds. */

export type CheckpointCoverage = { files: boolean; transcript: boolean };

export type CheckpointWorkspace = { path: string; name: string };

export type CheckpointSummary = {
  hash: string;
  /** The first eight characters, as Hermes's `/rollback` shows them. */
  short: string;
  at: number;
  /** What was about to happen: "before patch backup.sh". */
  label: string;
  files: number;
  insertions: number;
  deletions: number;
  /** Hermes's own snapshot before a restore, kept so an undo is one tap. */
  safety: boolean;
};

/** The feature's state for this bot, plus the list. */
export type CheckpointList = {
  supported: boolean;
  enabled: boolean;
  can_restore: boolean;
  workspace: CheckpointWorkspace;
  coverage: CheckpointCoverage;
  /** This bot's chats with a reply running now: a workspace restore waits for them. */
  busy: string[];
  /** Hermes's own explanation when it can't do this (off in config, a container backend, …). */
  reason: string;
  checkpoints: CheckpointSummary[];
};

export type CheckpointFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'changed' | string;

/** One file's part of the preview. `start`/`end` index into `diff.lines`; null when it didn't fit. */
export type CheckpointFile = {
  path: string;
  /** The previous path for a rename, else "". */
  from: string;
  status: CheckpointFileStatus;
  binary: boolean;
  insertions: number;
  deletions: number;
  /** What restoring does: put it back, remove it, or bring it back. */
  change: 'restore' | 'remove' | 'recreate' | string;
  start: number | null;
  end: number | null;
  shown: boolean;
};

export type CheckpointEffects = {
  restore?: number;
  remove?: number;
  recreate?: number;
  binary?: number;
  renamed?: number;
};

export type CheckpointPreview = CheckpointList & {
  hash: string;
  short: string;
  at: number;
  label: string;
  safety: boolean;
  /** Identifies this exact view of the folder; the restore must send it back. */
  revision: string;
  unchanged: boolean;
  files: CheckpointFile[];
  /** How many of `files` carried their diff lines in this bounded preview. */
  shown_files: number;
  /** The bounded unified diff, split into lines the app can show. */
  diff: { lines: string[]; truncated: boolean; bytes: number };
  effects: CheckpointEffects;
  error: string | null;
};

/** What Hermes reported after a restore, never a guess. */
export type RestoreOutcome = {
  ok: boolean;
  error?: string;
  message: string;
  restored_to?: string;
  reason?: string;
  /** False for a full restore, which puts the folder back without listing each file. */
  reported?: boolean;
  safe?: boolean;
  restored?: string[];
  skipped_user_edits?: string[];
  skipped_oversize?: string[];
  failed_deletes?: string[];
  /** The snapshot Hermes took just before restoring, for an undo. */
  safety?: { hash: string; short: string; label?: string };
  checkpoint?: { hash: string; short: string };
  /** A retried request: this is the first attempt's recorded result. */
  replayed?: boolean;
  by?: string;
};

export type RestoreRequest = { revision: string; safe: boolean; operation_id: string };
