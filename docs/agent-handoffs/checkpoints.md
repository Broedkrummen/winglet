# Checkpoint history, change previews and guarded restore

Assignment: 03 (branch `codex/major-03-checkpoints`, worktree `03-checkpoints`).
Status labels: **implemented** / **automated checks passed** / **native build not run** / **MOBILE VALIDATION PENDING**.

## What Hermes actually provides (discovered, not assumed)

Hermes keeps *filesystem* checkpoints, not agent transcripts:

- `tools/checkpoint_manager.py::CheckpointManager` takes a git snapshot of a working
  directory before a file-mutating tool call (`write_file`, `patch`, a destructive
  `terminal` command), at most once per turn per directory.
- The snapshots live in one shadow store under `<HERMES_HOME>/checkpoints/store`
  (`refs/hermes/<hash16>` per project), written with `GIT_DIR`/`GIT_WORK_TREE`/
  `GIT_INDEX_FILE` so nothing leaks into the user's repository. It is not the user's
  Git repository and not a commit in it; we never call it a Git commit.
- `list_checkpoints(dir)` returns `hash`, `short_hash`, `timestamp` (`%aI`),
  `reason` ("before write_file …"), plus changed/insertion/deletion counts.
- `diff(dir, hash)` returns `{success, stat, diff}` between the checkpoint and the
  directory as it is now (the unified diff, not truncated by the manager).
- `restore(dir, hash, file_path=None, safe=False)` performs a **full-directory**
  restore: it always takes a `pre-rollback snapshot` first, and with `safe=True` it
  leaves files the user hand-edited after Hermes last wrote them alone (agent-write
  ledger), reporting `restored_files`, `skipped_user_edits`, `skipped_oversize`,
  `failed_deletes`. `enable` comes from `checkpoints.enabled` in `config.yaml`; a
  container `terminal.backend` refuses host checkpoints
  (`unsupported_backend_reason`).
- The TUI/Desktop `rollback.restore` RPC additionally rewinds the *TUI session
  history* in memory (`history_removed`). That is dashboard-session behaviour, not
  the checkpoint store. Winglet's chats are messaging sessions with their own store
  and the branch/rewind agent owns transcript revisions; **Winglet will not claim a
  transcript rollback**. Every screen says so.

So a checkpoint covers: **workspace files**. It does not cover the transcript, chat
messages, memory, skills, or anything outside the working folder. Ignored paths are
Hermes's own (`node_modules/`, `.venv/`, `.env*`, media, build output, …); nested git
repositories are recorded as gitlinks and Hermes refuses to restore a scope that
contains one.

### Which folder is "the workspace"?

Winglet runs inside Hermes's messaging gateway. All of a bot's chats share the
gateway's terminal working directory (`TERMINAL_CWD`, resolved by Hermes's
`_terminal_scope_cwd`), unlike the TUI where each session has its own `cwd`. The
feature therefore lists **workspace checkpoints for the bot**, not "this chat's
folder", and says so. Nested projects that Hermes resolves through a project marker
keep their own refs and are not listed here (documented limitation).

## Contract

### Capability keys (additive booleans in `/api/info.features`, false unless real)

| key | true when |
| --- | --- |
| `checkpoints` | Hermes has `tools.checkpoint_manager.CheckpointManager` and the profile's checkpoint config can be read |
| `checkpoint_diff` | additionally `diff()` exists and can return a stat/diff for a checkpoint |
| `checkpoint_restore` | additionally `restore()` exists (a list-only Hermes hides the restore button) |

### Routes

| route | policy | notes |
| --- | --- | --- |
| `GET /api/checkpoints` | `owner` | list, workspace, coverage, busy chats, enabled/unsupported state |
| `GET /api/checkpoints/{hash}` | `owner` | bounded preview: files, effects, unified diff lines, revision |
| `POST /api/checkpoints/{hash}/restore` | `owner_signed` | body `{revision, safe, operation_id}` |

`hash` must match `^[0-9a-f]{4,64}$` (same shape Hermes validates) — no path input
ever reaches the filesystem, so traversal, absolute paths and symlink escapes cannot
be requested. The workspace path is resolved by Hermes from the bot's terminal scope
and is only ever *displayed* (home-collapsed), never accepted from the caller.

### Response shapes

`GET /api/checkpoints` →

```json
{
  "supported": true, "enabled": true, "can_restore": true,
  "workspace": {"path": "~/projects/acme", "name": "acme"},
  "coverage": {"files": true, "transcript": false},
  "busy": ["General"],
  "checkpoints": [
    {"hash": "9d75…", "short": "9d752f94", "at": 1790000000.0,
     "label": "before patch backup.sh", "files": 1, "insertions": 3, "deletions": 1,
     "safety": false}
  ],
  "reason": ""
}
```

`GET /api/checkpoints/{hash}` → adds

```json
{
  "revision": "…", "unchanged": false,
  "effects": {"restore": 1, "remove": 0, "recreate": 0, "binary": 0, "unknown": 0},
  "files": [{"path": "backup.sh", "status": "modified", "insertions": 3, "deletions": 1,
             "binary": false, "start": 4, "end": 18, "patch_truncated": false}],
  "diff": {"lines": ["…"], "truncated": false, "bytes": 812}
}
```

`POST …/restore` → `{"result": {...}}`:

```json
{"ok": true, "restored_to": "9d752f94", "safety": {"hash": "…", "short": "…"},
 "restored": ["backup.sh"], "skipped_user_edits": [], "skipped_oversize": [],
 "failed_deletes": [], "message": "Restored 1 file. Your chats are unchanged."}
```

Refusals: `409` stale preview (`needs: "refresh"`), `409` busy (`busy: [...]`),
`409` restore already running (`operation_id`), `404` unknown/pruned checkpoint,
`400` bad hash/body. A replayed `operation_id` returns the recorded result with
`"replayed": true` and restores nothing.

### Events

`checkpoint.restored` `{bot, at, result}` broadcast after a completed restore,
owners only (a member's socket never receives `checkpoint.*`). Older clients ignore
the unknown type.

### Storage / migrations

None. Hermes owns the checkpoint store; Winglet adds no table and no migration.
Restore operation ids are kept in memory for 15 minutes (replay protection is not
durable, and clients never queue a restore offline).

### Shared files touched (minimal)

- `plugin/hub.py` — routes, `ROUTE_POLICY` entries, three handlers, capability keys,
  `checkpoint.*` visibility, service wiring.
- `plugin/adapter.py` — one line installing the service.
- `plugin/hermes_api.py` — all Hermes imports for list/diff/restore/workspace.
- `plugin/checkpoints.py` — new; parsing, revisions, idempotency, refusal rules.
- `app/src/features/checkpoints/*` — new screen, detail sheet, pure helpers.
- `app/src/components/ChatMenu.tsx`, `app/src/app/(tabs)/agent.tsx` — entry points.
- `app/src/lib/types.ts`, `app/src/components/icons.ts` — types and one icon.

## UI plan

Entry points: **Chat → ⋯ → Workspace checkpoints** (owner, feature-gated), and
**Agent → Server → Checkpoints** (owner). Both open `/checkpoints`.

- **Timeline.** Large title "Checkpoints"; subtitle states the exact folder and that
  snapshots come from Hermes before it changes files. Rows are a timeline: time
  column, label ("before patch backup.sh"), then `3 files · +42 −7 · 9d752f94`.
  A quiet notice says files only, not chats.
- **States.** loading skeletons; offline (`LoadError` on the list); unsupported with
  Hermes's own reason (manager missing / off in config / container backend); empty
  ("none yet" explains when one is taken); busy ("a reply is running in General,
  restoring waits").
- **Detail sheet.** Opens from a row: coverage notice, workspace, label/time/hash,
  summary and effect counts, file navigation (chips on phones, a column on wide
  screens), monospace bounded diff with horizontal scroll and green/red lines,
  binary and too-large files named honestly. Footer: "Restore this point" (only when
  `checkpoint_restore`), "Done".
- **Guarded restore.** A second step lists the exact scope (folder), what happens to
  files, a toggle for "Also revert files I edited myself" (off: safe restore), the
  safety snapshot Hermes takes first, and "Your chats are unchanged". While running,
  a progress state; on completion the *actual* result with restored / left alone /
  too large / couldn't remove lists, or the failure and recovery pointer to the
  safety snapshot. Stale/busy refusals appear inline with "Look again".
- **Mobile vs wide.** Phone: bottom sheet, chips, diff ~44vh, 44–48 px targets.
  ≥900 px: centred 760 px dialog, file column + diff pane. Light/dark tokens only,
  reduced motion respected, no document-level horizontal overflow.

## Reference comparison (Herald 95ca999)

| Reference behaviour/source | Winglet result | Matching edge cases/tests | Intentional difference |
| --- | --- | --- | --- |
| `Checkpoints.kt` parses `rollback.list` `{enabled, checkpoints[hash,timestamp,message]}` | `plugin/checkpoints.py` normalizes Hermes's manager rows (`reason` → label, `%aI` → epoch seconds) | enabled-off, empty, unparsable timestamp | Winglet reads Hermes's Python manager directly (its plugin protocol is not JSON-RPC); no dashboard RPC invented |
| `CheckpointsSheet.kt` sheet with count line, per-row Restore, expandable diff well | Timeline screen + detail sheet with file navigation and effect summary | unchanged folder, binary file, huge diff, diff failure | Winglet separates list and preview (preview is bounded and returns a revision the restore must match) |
| `CheckpointsController.kt` drops answers after a chat switch, re-asks failed diffs | Screen reloads per bot; preview/restore carry revisions; late answers for a closed sheet are ignored | stale preview, bot switch, retry | Winglet's checkpoints are workspace-scoped (gateway cwd), not per chat session |
| `restore` reads `success`, `restored_files`, `skipped_user_edits`, `skipped_oversize`, `failed_deletes`, `history_removed` | Same lists, no `history_removed` claim; adds safety snapshot pointer | partial restore, failed deletes, nothing to restore | Winglet does not rewind chat history: it is not part of Hermes's checkpoint store and the branch agent owns transcript revisions |
| Restore confirm dialog states scope and effects | Two-step confirm with folder, effect counts, safe-mode toggle and "chats unchanged" | cancel, stale, busy | Winglet requires a signed owner action, a matching revision and an idempotent operation id (Herald has no owner signature model) |

## Reuse provenance

Interaction structure (timeline rows, expandable bounded diff, restore confirmation
copy about files vs chat turns) was adapted from Herald at commit
`95ca999fa48c1c9de232fe499a174900f0d25272` (`shared/core/.../Checkpoints.kt`,
`shared/ui/.../CheckpointsSheet.kt`, its controller tests and screenshot). The
Kotlin/Compose implementation was not copied: Winglet's views are React Native and
its data path is the real Python checkpoint manager, so only behaviour, hierarchy
and wording patterns were ported. MIT notice:
`third_party/notices/herald-checkpoints.md`.

## Validation (to be completed and recorded below)

- pytest: routing, member/owner refusal, signature requirement, unsupported state,
  stale revision, busy refusal, idempotent replay, failure reporting, path/hash
  rejection, persistence of the list after a restart, real Hermes manager
  integration (skipped when Hermes is absent).
- app: `node --test` for helpers (diff parsing, effect counts, time labels, safe-mode
  copy), `tsc`, web export, Android export.
- Browser preview at 320/390/tablet/1440 in light and dark with synthetic fixtures.
