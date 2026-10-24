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
  `failed_deletes`. A full restore (`safe=False`) reports no per-file list; Winglet
  says "Restored the folder" rather than inventing one. `enable` comes from
  `checkpoints.enabled` in `config.yaml`; a container `terminal.backend` refuses host
  checkpoints (`unsupported_backend_reason`).
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
- `app/src/features/checkpoints/*` — new screen, detail sheet, API calls, pure helpers.
- `app/src/app/checkpoints.tsx` — the route; no other route files changed.
- `app/src/components/ChatMenu.tsx`, `app/src/components/ChatView.tsx`,
  `app/src/app/(tabs)/agent.tsx` — feature-gated owner entry points.
- `app/src/components/icons.ts` — one icon (`FileDiff`). No `types.ts` change: the
  feature's wire types live in `app/src/features/checkpoints/types.ts`.

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
- **Mobile vs wide.** Phone: a full-height sheet for reading a diff (chips, a
  ~40% viewport diff well, footer pinned at the bottom); confirming and results are
  compact bottom sheets. ≥900 px: a centred 820 px dialog with a file column and a
  430 px diff pane. Light/dark tokens only, reduced motion respected, no
  document-level horizontal overflow.

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

## Implementation summary

- `plugin/checkpoints.py` (new): bounded diff parsing (adds/removes/renames/binary,
  quoted paths), preview revisions, effect counts, restore outcome wording, an
  in-memory idempotent operation registry, and all refusals. No Hermes imports.
- `plugin/hermes_api.py`: the only Hermes imports — the real
  `CheckpointManager` (config, workspace via the bot's terminal scope, list, diff,
  restore, container refusal) plus capability probes.
- `plugin/hub.py`: 3 routes, `ROUTE_POLICY` (`owner`, `owner`, `owner_signed`),
  capability booleans, owner-only `checkpoint.*` events, `busy_chats()`, audit and
  broadcast. `plugin/adapter.py` installs the service when Hermes keeps checkpoints.
- `app/src/features/checkpoints/`: the screen, the detail/confirm/result sheet, the
  API calls and pure formatting helpers; `app/src/app/checkpoints.tsx` is the route.
  Entry points are Chat → ⋯ → **Workspace checkpoints** and Agent → Server →
  **Checkpoints**.
- `app/src/components/icons.ts` gains `FileDiff`; `ChatMenu`, `ChatView` and the
  Agent tab pass the feature-gated entry only to owners.
- No database schema, migration, protocol bump or new dependency.

## Validation — actual results

Status: **implemented**, **automated checks passed**, **native build not run**,
**MOBILE VALIDATION PENDING**.

| Check | Command | Result |
| --- | --- | --- |
| Plugin suite (no Hermes) | `python -m pytest -q --ignore=tests/test_checkpoints_hermes.py` | **331 passed, 16 skipped** |
| Checkpoint tests | `python -m pytest tests/test_checkpoints.py -q` | **30 passed** |
| Real Hermes manager | `PythonPATH=<hermes checkout> pytest tests/test_checkpoints_hermes.py -q` | **4 passed** (real snapshots, safe restore, service round trip) |
| App tests | `npm test` | **278 passed** (10 new checkpoint tests) |
| TypeScript | `npm run typecheck` | passed |
| Web export | `npx expo export --platform web` | passed |
| Android bundle | `npx expo export --platform android --output-dir dist-android` | passed (HBC bundle) |

The real-Hermes tests skip cleanly in the plugin-only CI job (no Hermes import) and
run in CI's Hermes job. Locally they were run against a source checkout of Hermes, not
the CI pin; the API used (`list_checkpoints`, `diff`, `restore(..., safe=)`,
`unsupported_backend_reason`) exists at both the pinned commit and the checkout used.

### Browser checks (isolated Playwright session, disposable fixture)

The app was exported and served by a synthetic fixture on port 8303 (no Hermes, no
personal data). Verified flows and layout:

- 1440×900 light: timeline with Today/Yesterday/weekday grouping, workspace card,
  snapshot counts, Safety badge; detail sheet with file column, bounded monospace
  diff, coverage banner, Done/Restore.
- 390×844 light and dark: full-height diff sheet, file chips, compact confirm sheet
  (folder, effect sentences, safe toggle, safety note), success result with restored
  and left-alone lists + single Undo row, failure result with recovery pointer,
  stale-preview inline error + "Look again", busy banner, off/empty/unsupported/error
  states.
- 320×568 dark: timeline and wrap; no document-level horizontal overflow
  (`document.documentElement.scrollWidth === innerWidth` at 320 and 390). The diff
  well scrolls sideways for long lines by design.
- Chat → ⋯ → Workspace checkpoints opens the screen; Undo opens the safety snapshot.
- No uncaught page errors in the flows exercised; the only console error was the
  intentional 502 from the "error" fixture mode.

Screenshots (synthetic fixture, no tokens or personal chats):

- `docs/agent-handoffs/checkpoints/timeline-light.png`
- `docs/agent-handoffs/checkpoints/detail-light.png`
- `docs/agent-handoffs/checkpoints/detail-dark-phone.png`
- `docs/agent-handoffs/checkpoints/confirm-phone.png`
- `docs/agent-handoffs/checkpoints/result-phone.png`

## Privacy, permissions and compatibility

- Owners only: a checkpoint names files and restoring changes them. Members never see
  the routes or `checkpoint.*` events, and every restore is a signed, verified-device
  action; the bearer token alone cannot restore.
- No path is accepted from the client: the hash must be hex and must name a checkpoint
  Hermes already listed for the bot's own workspace. Workspace resolution comes from
  Hermes's terminal scope, so a caller cannot steer it.
- The event is namespaced and additive; older apps ignore it. The feature is three new
  booleans (`checkpoints`, `checkpoint_diff`, `checkpoint_restore`), all false on a
  server without the real manager; the app hides the entry and the restore button.
  Old servers and old apps keep working; no protocol bump.
- No offline replay: restores use the signed HTTP transport directly, never the
  message outbox, and require a live server. A retried request carries the same
  operation id and returns the recorded result instead of restoring twice.
- Audit rows record `checkpoint.restore` with success, failure or refusal.

## Review correction: safe restore without file-write history (2026-10-24)

Hermes's pinned manager falls back to a full restore when its agent-write ledger is
missing, empty, unreadable or invalid. That could overwrite personal edits despite
Winglet's safe-mode confirmation. Winglet now wraps only the fresh manager instance's
`_safe_restore_plan` and refuses unavailable or malformed safety plans before the
manager takes a safety snapshot or changes workspace files. The guard executes inside
Hermes's existing store lock; there is no global monkeypatch or second lock.

The refusal explains that file-write history is unavailable and names the existing
`Also revert files I edited myself` option. An owner can still explicitly select that
full restore (`safe=False`). Valid write history continues to restore agent changes
and preserve personal edits. HTTP/result shapes and the app protocol are unchanged.

Regression coverage uses the actual Hermes manager for missing, empty, unreadable
(a directory at the ledger path, raising `OSError` on Windows and Unix), and corrupt
ledgers. It verifies personal content and the checkpoint list stay unchanged after
refusal, then verifies explicit full restore succeeds. Additional real-manager tests
cover an unavailable safe planner and a valid agent-authored restore.

Validation on Windows, Python 3.12.14:
- Focused route + real-Hermes checkpoint tests: **40 passed**.
- Complete plugin suite without Hermes installed: **326 passed, 18 skipped**.
- `git diff --check`: passed.

The real checkpoint-manager file used locally has Git blob
`a2081650696043bc031f78ffad11a7ba94042649`, verified equal to the file at the CI pin
`47676981f55de91231fdeef2f0eec47e7c209e78`. The test runner sets
`HERMES_DISABLE_LAZY_INSTALLS=1` to use installed system Git rather than bootstrap
Hermes's separate package-manager runtime. No Android build or device validation was
needed for this server-only correction; CI still verifies the full supported Hermes
environment.

## Integration refresh after projects merge (2026-10-24)

Merged integration commit `ab3a531c38fe01cdac42c8606b123f88934aae24` into
the checkpoint feature branch so PR #45 can run CI against the merged projects work.
Resolved `plugin/hub.py` by retaining both imports, every project's signed route
policy, checkpoint owner/owner-signed policies, and both capability sets. Resolved
`ChatMenu.tsx` by keeping both `Folder` and `FileDiff`; both Move to project and
Workspace checkpoints remain available. Inspected the automatically merged routes,
chat view, and icon exports. The safe-restore guard is unchanged.

Combined validation:

- Complete plugin suite without Hermes installed: **346 passed, 18 skipped**.
- Actual pinned-Hermes checkpoint tests: **10 passed**.
- App `npm run typecheck`: passed.
- App `npm test`: **295 passed**.
- Staged `git diff --check`: passed.

No native build or phone/RDP validation was performed for this integration refresh.

## Integration refresh after execution merge (2026-10-24)

Merged integration commit `99b498d573b2684353e721016a2dd5a6b81ceda2` into
the checkpoint branch. Kept both checkpoint and execution adapter imports, checkpoint
owner/owner-signed route rules, the device task-read rule, all project route rules,
and all three feature capability sets. Inspected the automatically merged tracker
initialization, routes and app state. The safe-restore guard is unchanged.

Validation: the complete plugin suite passed **377 tests, 18 skipped**; app typecheck
passed; all **310 app tests** passed. The focused actual pinned-Hermes run included
checkpoint restore safety, checkpoint routes, execution and adapter authority, and
project routes/transactions: **91 passed**. No focused test hung. The previous
`c66ddcd` CI run also completed successfully, including Hermes. CI configuration was
unchanged; this refresh receives its own exact-head checks.

## Final dependency refresh after branching merge (2026-10-24)

Merged integration commit `03017149185e59c9d4740e55ab1920ae54a64643`, bringing
the reviewed branching feature together with projects, execution and checkpoints.
The only manual conflict was the capability probe/flags in `plugin/hub.py`; retained
both branching and checkpoint capabilities. Inspected the automatic adapter, route,
chat-view and icon merges; all four features remain wired and the safe-restore guard
is unchanged.

Final combined validation: **399 passed, 21 skipped** plugin tests (without Hermes),
**115 passed** focused actual pinned-Hermes/route tests across all four features,
app typecheck passed, **317** app tests passed, and staged diff check passed.
No CI configuration changed; the pushed final head receives fresh CI before merge.

## Known limitations / unresolved risks

- All chats of a bot share the gateway's terminal folder; snapshots are listed per
  workspace, not per chat. Nested project folders keep their own refs and are not
  listed on this screen.
- Checkpoints cover files only. Chat transcript rewind is not part of Hermes's
  checkpoint store and is deliberately not offered; the branch/rewind agent owns
  transcript revisions.
- A preview is capped at 40,000 characters and 400 files. Files past the cap are
  still listed with counts but have no diff lines.
- There is no filesystem lock against an agent writing during a restore: the server
  refuses while any chat is typing, re-checks the revision and busy state inside the
  restore lock, and Hermes takes a safety snapshot first. A write that lands between
  the final check and the checkout is still possible, as it is for Hermes's own
  `/rollback`.
- Operation ids live in memory for 15 minutes; a server restart forgets them. Clients
  never queue restores, so this only affects an in-flight retry.
- Another device's `checkpoint.restored` event is emitted but this app does not
  subscribe to it yet; the list refreshes on focus, pull-to-refresh and after a local
  restore.
- Long diff lines scroll sideways; on desktop browsers the horizontal scrollbar is an
  overlay and may be visible only while scrolling.

## Dependencies and review entry points

No new runtime dependency. Hermes already needs `git` for checkpoints; Winglet uses the
manager in the gateway process.

Read in this order:

1. `plugin/checkpoints.py` — the security and correctness core: hash validation,
   bounded parsing, revisions, refusals, idempotency, outcome wording. Its tests are
   `tests/test_checkpoints.py` (fake Hermes) and `tests/test_checkpoints_hermes.py`
   (real manager).
2. `plugin/hermes_api.py` → "workspace checkpoints" — every Hermes import, the
   config/workspace resolution, and the container refusal.
3. `plugin/hub.py` — the three routes, `ROUTE_POLICY`, capabilities, audit, event
   visibility, `busy_chats()`.
4. `app/src/features/checkpoints/CheckpointSheet.tsx` and `CheckpointsScreen.tsx` —
   the timeline, diff well, confirmation and result states.
5. `app/src/features/checkpoints/format.ts` + `app/tests/checkpoints.test.ts` — the
   wording and gating that must stay honest.

## MOBILE VALIDATION PENDING

**Status:** code implemented; automated/plugin/app/build checks passed; **native build
not run** in this phase; **device validation deferred to the Codex orchestrator**.

### Integration build needed

- Branch `codex/major-03-checkpoints`, HEAD as handed off, merged by Codex into
  `codex/major-features` (no other agent's changes required).
- A signed Android build (Codex owns signing and installation) with the plugin at the
  same commit. No new native modules, permissions or config plugins; a standard
  `expo export` / EAS build is enough.
- Server: Hermes from CI's pin with the Winglet plugin at the same commit.

### Safe local fixture (server side)

1. Use a disposable profile/home (not the user's real chats):
   `HERMES_HOME=/tmp/winglet-cp-home`, `terminal.cwd=/tmp/winglet-cp-work`.
2. In `config.yaml`: `checkpoints: {enabled: true, max_snapshots: 20}` and
   `terminal: {cwd: /tmp/winglet-cp-work}`. Restart the gateway.
3. In a chat, ask the agent to create `notes.txt` with three lines, then append a
   fourth line. Two snapshots should appear ("before write_file notes.txt", …).
4. Optional second file: create `bin.dat` with random bytes and change it, for the
   binary path.

### Steps and expected outcomes

1. Pair the build; Chat → ⋯ → **Workspace checkpoints**.
   Expect: timeline, the exact `~/...` folder, "Files only" note, 1 snapshot per
   change, newest first; owner-only entry visible, absent for a member account.
2. Open the newest snapshot. Expect: file chips (phone) / column (wide), monospace
   diff with green additions and red removals, file counts, "Files only … never
   changes your conversations".
3. Tap **Restore this point**; **Cancel**. Expect: no change to the file; the list
   and snapshot stay.
4. Start a long reply in another chat, then open a snapshot. Expect: the busy banner
   ("A reply is running in …") and no Restore button; the server refuses a restore
   while typing.
5. Restore with safe mode on after editing the file yourself. Expect: a progress
   state (no toast), then a result listing the restored file(s) and the file left
   alone; the edited file keeps the user's content.
6. Confirm the server: the file content matches the snapshot for Hermes-written
   files; the list now starts with "pre-rollback snapshot (restoring to …)".
7. Tap **Undo this restore**; expect the safety snapshot opens; restoring it puts the
   agent's changes back.
8. Stale: open a preview, edit the file on the server, tap Restore. Expect: "The
   folder changed since you looked…" with **Look again**; nothing restored.
9. Failure: `chmod -R a-w /tmp/winglet-cp-work` (restore, then revert) and restore.
   Expect: "Couldn't restore", the actual error, a recovery note naming the safety
   snapshot, and the Undo row.
10. Config off: set `checkpoints.enabled: false`, restart, reopen the screen.
    Expect: "Checkpoints are off" with the config hint and no Restore.
11. Container backend (`terminal.backend: docker`): expect the honest refusal from
    Hermes, no restore.
12. Form factors: 320 and 390 px phones, tablet and ~1440 px desktop; light/dark;
    Android font scale 1.3; TalkBack labels; 44–48 dp targets; Android back closes
    the sheet (except mid-restore, where it deliberately waits for the outcome).
    Expect no clipped controls or document-level horizontal scrolling.

### Checks that genuinely need physical hardware

- Safe-area/notch and gesture-bar padding on the phone sheet.
- Real touch scrolling of the diff (both axes) and the feel of the 38–48 dp targets.
- TalkBack reading order for the timeline, file chips and result lists.
- Android hardware back during a restore and the modal's behaviour after the app is
  backgrounded mid-request.
- Native performance with a 300+ line diff and a 400-file preview.
Everything else (states, copy, authorization, stale/busy/failure) is reproducible in
an emulator or the browser fixture.
