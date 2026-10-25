# Routine execution history — implementation handoff

For Codex orchestrator review. **Code implemented; automated checks and rendered web evidence passed. MOBILE VALIDATION PENDING.**

PR: https://github.com/VIKASRP24/winglet/pull/54 · branch `codex/major-10-routine-history`.
Worktree: `C:\Users\vikas\Documents\winglet-agents\10-routine-history`.
Reviewed integration through `91f9db492c3ca5f4b80c1dd9f3e58a900f132de3` is merged.
The PR’s final head/checks are the source of truth for publication status; checkpoint CI below is SHA-specific.
Primary skill role: Backend Architect; architecture, implementation, and a separate lifecycle/security/bounds review completed directly without subagents. The earlier research-only handoff is preserved in a collapsed appendix and its status is superseded.

## Result and UI

Schedule opens a routine detail with current definition, schedule/zone/next run, existing signed Run/Pause/Resume/Edit controls, and paginated attempts. Run again explicitly uses the current definition. Each native execution UUID remains one row through duplicate observations and restart reconciliation. A run page shows its authoritative outcome, timestamps, captured output, provenance, and a genuine read-only session link when supported by evidence. Removed routines remain discoverable under Past routines while retained evidence exists. Updates cards and routine badges retain stable routine IDs and use a matched run link only when retained response evidence is unique.

Rows use Winglet typography/theme tokens, chronological separators, explicit outcomes and progressive output disclosure. Controls wrap on narrow screens and routine-detail mutation targets are at least44px high. Screen reading width stays constrained on desktop. Empty, initial loading, retained-but-stale, member refusal, old-server, removed-bot and offline states are explicit. Offline controls never enqueue operations; already loaded component state remains readable. This does not add a persistent client-side history cache for an offline app restart.

## Contract, source authority, and privacy

- Additive booleans: `routine_history`, `routine_run_detail`; both false unless the current Hermes offers the required native ledger/session APIs and the adapter creates the mirror. Old servers retain Schedule editing; no protocol/minimum-version bump.
- Owner reads: `GET /api/routine-history` (newest100 archived definitions), `GET /api/routine-history/{routine_id}?limit=30&cursor=...`, and `GET /api/routine-history/{routine_id}/run/{run_id}`. Limit is capped50; cursor binds authenticated bot, routine, claim time and run UUID. Ties use `(claim,id)` keyset ordering, including during new arrivals.
- Routes authenticate at middleware entry and freshly recheck bearer identity, current owner role and requested/served bot after every awaited refresh, including stale fallback. Prompts/output never go to members or another bot. Edit/delete preserve evidence before mutation and recheck the actor after that await; source failure refuses before mutation. Successful deletion archives locally without a fallible post-mutation source read.
- Existing signed Schedule routes retain mutation authority and audit behavior. No cancellation, retry executor, resume-as-new-chat operation or offline scheduler outbox is invented.
- `routine.run` is a content-free, bot-scoped owner event emitted through existing `Hub.broadcast`. Global replay, private phone-event interception, context, task, room and process contracts remain intact.

The pin is Hermes `47676981f55de91231fdeef2f0eec47e7c209e78`. `cron/executions.py` creates a durable UUID before builtin/direct/external dispatch, marks running and records immutable terminal status. `scheduler.run_one_job` saves output before delivery and terminal completion. Winglet observes this ledger rather than deriving outcomes from output presence or `last_status`. All Hermes imports remain in `hermes_api.py`.

The observer reads canonical jobs.json bounded4MiB with Hermes read-safe normalization. It deliberately avoids `list_jobs`, which can repair definitions and initialize the native ledger. Execution SQLite uses URI `mode=ro`, `query_only`, and one read transaction for counts/coverage/rows. Native SessionDB opens read-only. Profile routing is inherited from authenticated Hermes scope. Output paths are validated/canonicalized inside the scoped cron output root; disappearing files are skipped. Reads neither tick nor recover nor mutate Hermes storage. Corrupt definitions retain prior mirror evidence and report stale/unavailable state.

Native claimed/running/completed/failed/unknown map to pending/running/completed/failed/unknown. A provably exited execution owner maps to Interrupted with side effects explicitly unknown; explicit gateway interruption is also distinguished. An active mirror row absent from a complete native scope becomes Unknown, never Completed. Builtin/direct records with a scheduled occurrence are Scheduled; a present null occurrence is Manual; unknown provider semantics remain unknown. A run request is not an execution.

## Storage and correlation bounds

`routine-history.sqlite` lives beside the plugin store. Additive feature-named tables are created idempotently: `routine_history_routines`, `routine_history_runs`, `routine_history_outputs`, with bot/run/output/page indexes. SQLite writes share a lock/transaction; the file is owner-only. A source/commit lock keeps HTTP, delivery and background observations in order. Shutdown removes the monitor callback, cancels/awaits reconciliation, drains any dispatched mirror write, cleans HTTP/Hub resources, then closes the mirror idempotently. Rolling back the feature leaves this isolated file unused; it does not change native Hermes schema or other Winglet tables.

- Retain newest500 terminal rows per routine and5000 per bot; active rows remain until reconciled. Archived definitions without retained runs are removed. Output ownership is one current hash per run and is pruned with rows, including when an artifact changes repeatedly.
- Background observation every30sec, with supported monitoring-emitter lifecycle wakeups; reads also refresh on demand. This covers other worker/process execution sources without replacing or monkey-patching the scheduler. It cannot reconstruct attempts already pruned between observations.
- Source batch:5000 executions,1000 current definitions, newest40 execution job IDs for background artifacts; a requested routine gets its own scoped artifact scan. At most200 documents,50 per job,64KiB each, and500 session records total. UI retains at most200 merged rows; run output initially renders6000 characters before expansion.
- Artifact windows are grouped by job and timestamps parsed once in a sweep, bounded by O((runs+artifacts)log runs). Only one-to-one evidence links an output/session. Incomplete batches/artifact coverage refuse new links. When native terminal retention saturates, the oldest retained terminal finish establishes a trusted floor: native pruning removes older FINISHED rows while retaining active attempts. Only artifact times later than that floor plus the window tolerance can form new associations. The actual native prune-order test verifies this contract.
- Later overlapping evidence revokes a provisional link and restores first-observed definition provenance. Captured output survives normal pruning/deletion. Unmatched surviving output is explicitly Unknown and never a synthetic successful execution. Ledger rows and output-only fallback do not double-count ambiguous documents.
- The pin’s delivery metadata contains job_id, not execution_id. Updates correlation compares exact response text against retained captured run documents; repeated/ambiguous/unavailable matches open routine history. This is bounded retained evidence, not a universal exactly-once delivery identity guarantee. No upstream run or side-effect exactly-once guarantee is claimed.
- Titles/prompts are first-observed snapshots unless a unique run document supplies stronger dispatched provenance. Definitions not observed before deletion are unavailable; renaming cannot fabricate the original. Time zone is the zone observed with the run, not proof of an unrecorded historical configuration. Common credential patterns and control/ANSI bytes are masked/removed; arbitrary output may still contain owner data and remains owner-only.

## Checks actually executed

1. Final feature backend/current-Hermes suite: **43 passed** (`test_routine_history.py`, `test_routine_history_hermes.py`). Covers authoritative states/triggers, real successful/failed no-agent scripts, actual exited child owner, read-only/corrupt native storage, native terminal pruning, late overlap, replaced output hashes, stable pagination/concurrency/retention, archival provenance, source failure, held-source demotion/unpairing and shutdown drain. No live providers or user schedules were used.
2. After91f9 integration merge, combined routine/current-Hermes + phone/current-Hermes + context/current-Hermes + trust + delivery regression: **127 passed** before the final three bounded-storage/coverage cases. Those final cases passed in the43-test feature run.
3. Final merged TypeScript check passed. Seven feature client tests passed, including actual screen lifecycle execution for offline retention/disabled mutations, double Run taps, and demotion.
4. Full client suite: **377 passed** at dd06cbd. One-worker private web export and Android Hermes-bytecode export passed. Web was refreshed after the small unavailable-definition/touch-height adjustment. Final integration exports are also exercised by PR CI; local native build/device execution is deliberately not claimed.
5. PR CI checkpoint `dd06cbd6710e2a02fc91e101d25a29bac89cf3ea`, run40168122307: all4 jobs passed; Ubuntu541passed/27skipped, Windows541passed/27skipped, pinned-Hermes604passed/1skipped, app377passed + typecheck + web/Android exports. Final head triggers CI again; inspect PR checks for its result.
6. Source review/diff check passed. No release/version/CI-pin/generated plugin/web changes, dependency installs, device access or native API/provider calls were introduced.

## Rendered evidence and reproducible fixture

`scripts/routine_history_fixture.py` starts a disposable loopback-only synthetic scheduler/real Hub/mirror at UI8310/API9310. Export web to `app/dist-web-preview`, run the script with the test Python runtime, and pair through the UI using its printed temporary code. Its fake scheduler is explicitly synthetic; the independent current-Hermes tests above verify real semantics. Temp databases are removed when stopped. The validation browser and fixture were stopped after evidence capture.

Playwright CLI checks:320/390phone widths,768tablet,1440desktop; light/dark and reduced motion; long title wrap, output expansion through synthetic check249, run→scoped session transcript, empty/archived state, pagination30→42 with no remaining cursor, and true socket/server disconnect retaining30 rows with Run/Pause/Edit all `aria-disabled=true`. Document scrollWidth matched viewport at320 and768. Expected network errors occurred after deliberately stopping the fixture; initial fixture-only missing-chat/model stubs were corrected. No personal data or tokens appear in screenshots.

Representative captures (earlier captures precede minor unavailable-wording/touch-height/summary refinements; layout remains representative):

| Evidence | Capture |
| --- | --- |
|390px light timeline | [Phone timeline](routine-history/routine-390-light.png) |
|320px dark/reduced-motion | [Small dark timeline](routine-history/routine-320-dark.png) |
|Recorded output/provenance | [Run detail](routine-history/run-320-dark.png) |
|Empty and archived | [Empty](routine-history/empty-320-dark.png), [Archived](routine-history/archived-320-dark.png) |
|Actual disconnected page | [Offline retained timeline](routine-history/offline-390-light.png) |
|Tablet and desktop | [Tablet](routine-history/routine-768-light.png), [Desktop](routine-history/routine-1440-dark.png) |

## Reference comparison and licensing

Reference: Herald95ca999fa48c1c9de232fe499a174900f0d25272. Full MIT notice and reviewed files are in `third_party/notices/herald-routine-history.md`; no reference repository was modified. After integration, rerun the orchestrator’s notice aggregation generator so the new notice reaches APK/About and plugin packaging.

| Reference behavior/source | Winglet result | Edge cases/tests and intentional differences |
| --- | --- | --- |
|core/cron/Routines.kt/CronApi.kt typed schedule/run evidence | Feature-local typed models and scoped read routes | Actual Hermes UUIDs/statuses; no dashboard JSON-RPC assumptions |
|ScheduledPage.kt routine list/detail and run inspection | Schedule→current summary→bounded history→read-only run | Empty/archived/offline, stable tuple pagination, no invented cancellation |
|ScheduledViewModel.kt refresh/control lifecycle | Focus/reconnect polling, request guards and existing signed actions | Double taps, held requests, role change and explicit bot session links tested |
|History/output/session provenance | Durable mirror plus conservative one-to-one native evidence | Overlap, prune coverage, deletion/rename/restart tests; unavailable links stay unavailable |

## Review priorities and remaining limits

Review the native read-only boundary and retention-floor assumption in `hermes_api.routine_history_source`, then `RoutineHistory.sync` correlation/reconciliation/retention and its tests. Check fresh authorization after awaited reads, observer shutdown, and shared adapter/hub merge hunks. Finally review offline lifecycle, signed current-definition actions, and explicit server scope in the session route. The branch preserves approved speech, context, phone-tool interception and global replay wiring.

Known limits are explicit above: polling can miss already-pruned evidence; output/session IDs are correlated from retained native evidence rather than invented; missing dispatch snapshots, unknown external trigger semantics and missing sessions remain unavailable. There is no new cancellation/continue operation, no durable client history cache, and no claim of native/device stability from browser evidence.

## MOBILE VALIDATION PENDING

Codex should build the final integrated commit containing PR54 plus91f9 (or its later reviewed descendant), regenerate plugin/web and aggregated notices, and sign/install only during the later orchestrator validation phase. This feature adds no native permission/module requirement. Android export validates bundling, not actual navigation, font scaling or platform storage behavior.

Use the disposable fixture script above; expose only its synthetic API to the chosen test emulator/device through the orchestrator’s normal safe test networking. Test320/390-equivalent portrait and tablet/landscape, supported Android API levels, system font scaling, TalkBack, keyboard focus/safe areas and reduced motion. Expected cases:

1. Pair as owner; Schedule opens timeline with42 stable attempts, both trigger kinds and queued/running/failed/unknown/completed states. Open short and long output, expand it and follow the actual read-only session. Back preserves navigation context.
2. Load older history while a synthetic new native run arrives; no duplicate IDs or skipped tied rows. Repeat Run tap quickly: one signed request and a request toast; no fabricated Running/Completed row. Pause/resume/edit reuse existing controls. No historical prompt replay is implied.
3. Disconnect after loading: rows stay readable, controls disabled. Reconnect refreshes. Killing/restarting the app while offline may not retain history because this feature adds no client disk cache; existing drafts/outbox must remain intact.
4. Demote/unpair while a source read is held: no late prompt/output response. Switch bots with identical routine IDs and open session links: no prior-bot evidence. Members cannot read routes or receive routine events.
5. Rename/delete in a disposable synthetic schedule: captured prior title/output survive, Past routines is read-only. Interrupted execution owner yields Interrupted/Unknown with side effects unknown. Pruned/ambiguous evidence never displays a guessed session or successful outcome.

These checks require no microphone/camera/GPS/Bluetooth or physical hardware-specific operation. Physical hardware remains useful for touch targets, TalkBack/font scaling, suspend/resume and network transitions. Native build and mobile execution were not run by this feature agent, by instruction.

---

<details><summary>Preserved prior research handoff (historical status, superseded)</summary>

# Routine history — handoff (STOPPED EARLY: design only, no implementation)

Status: **implementation not started.** This document is the honest state report for assignment 10
(`10-routine-history.md`, policy revision 3) after the session was stopped on request.

| Item | Value |
| --- | --- |
| Branch | `codex/major-10-routine-history` |
| Worktree | `C:\Users\vikas\Documents\winglet-agents\10-routine-history` |
| HEAD | `b71d93b459e1645e34cd47c80a392b146dca0e04` (unmodified base) |
| Commits on branch | **0** (worktree clean apart from this untracked handoff file) |
| Pushed to origin | **no** (`git ls-remote` has no such head) |
| Pull request | **none created** (no draft, no ready PR) |
| PR URL | none |
| Code changes | **none** — no `plugin/routine_history*.py`, no `app/src/features/routine-history/`, no shared-file edits |
| Reference-license notice | not required yet (no reused Herald material has been added to the tree) |

Because nothing is implemented, none of the acceptance behavior is met yet. Everything below is
research, verified upstream facts, the agreed contract, and a file-level work plan so the next agent
does not repeat the investigation.

## 1. What was actually completed

1. Verified the isolated worktree and base commit; confirmed the shared main checkout
   `C:\Users\vikas\Documents\winglet` was never touched (its dirty `app/tsconfig.json` and
   `AUDIT.md` / `PR1_FIXES.md` / `PR1_REVIEW.md` are unchanged by this session).
2. Private toolchain prepared in-worktree: `.venv` (Python 3.13.14, pytest 9.1.1, pytest-aiohttp,
   aiohttp, cryptography, httpx, qrcode, http_ece, pyyaml, packaging, pillow) and `app/node_modules`
   via `npm ci`. Nothing was run beyond installs; no test/build has been executed for this feature.
3. Read the assignment, `docs/MOBILE_EXPERIENCE.md`, `docs/FEATURES.md`, `app/package.json`,
   `.github/workflows/ci.yml`, and traced the existing routine code end to end
   (`plugin/hermes_api.py` `_cron`/`_job_view`/`list_schedule`/`change_routine`/`_profile_scope`,
   `plugin/hub.py` `ROUTE_POLICY`/`features()`/`h_schedule*`/`_reconcile_loop` hooks,
   `plugin/adapter.py` `send()` cron delivery, `app/src/app/schedule.tsx`, `InboxCards.tsx`
   `ResultCard`, `ChatView.tsx` routine badge, `app/src/app/session/[id].tsx`,
   `app/src/lib/{api,types,store}.ts`, `tests/test_hub.py`, `tests/test_trust.py`).
4. Verified the authoritative upstream scheduler behavior in the pinned Hermes snapshot
   (`47676981f55de91231fdeef2f0eec47e7c209e78`): `cron/executions.py` ledger
   (statuses `claimed|running|completed|failed|unknown`, `MAX_TERMINAL_EXECUTIONS = 1000`,
   newest-first `list_executions(job_id, limit, before_claimed_at)`, immutable terminal rows,
   `source` `builtin` vs `direct`) and `hermes_cli/web_routers/cron.py` correlation helpers
   (`_execution_contains`, `_list_cron_output_runs`, `_reconcile_cron_runs`, `_doc_matches_session`),
   the cron session-id format `cron_{job_id}_{%Y%m%d_%H%M%S}`, output doc path
   `cron/output/<job_id>/<%Y-%m-%d_%H-%M-%S>.md` with 50-file retention, and the ordering
   `create_execution → run → save_job_output → deliver → finish_execution`.
5. Studied the Herald reference (`95ca999fa48c1c9de232fe499a174900f0d25272`) at
   `ui/sessions/ScheduledPage.kt`, `ScheduledViewModel.kt`, `core/cron/Routines.kt`,
   `core/cron/CronApi.kt`.
6. Inspected the current integration branch (see §7).

Not completed: every implementation, test, build, screenshot, commit, push and PR step.

## 2. Agreed contract (designed, not implemented)

Capabilities (additive booleans in existing feature negotiation, absent on old servers):

- `routine_history` — routine detail + paginated run history for a routine.
- `routine_run_detail` — single-run detail with output text and Hermes session link.

Routes (read-only, `owner` policy to match existing `/api/schedule`):

- `GET /api/routine-history/{routine_id}` → routine snapshot, current definition, schedule/next-run
  with timezone, and a page of runs.
- `GET /api/routine-history/{routine_id}/run/{run_id}` → one run: status, trigger, timestamps,
  error summary, output text (capped), session id/link, provenance (archived routine, definition
  changed since run).

Mutations stay on the existing owner-signed endpoints
(`POST /api/schedule`, `PATCH/DELETE /api/schedule/{id}`, `POST /api/schedule/{id}/{action}`).
No cancellation control: upstream has no cancel operation. No destructive scheduler control may enter
the offline outbox or replay after reconnect; triggers require a live connection.

Event namespace: `routine.*` (e.g. `routine.run.completed`) emitted through current infrastructure only;
the event-replay agent owns the global cursor envelope, so no second replay layer.

Storage: feature-local SQLite mirror at `data_dir()/routine-history.db` (WAL, busy timeout),
bot-scoped keys, idempotent upserts, bounded retention (~500 runs per routine, output capped ~64 KB).
Tables: `routines`, `runs`, `intents`, `deliveries`, `meta`. Read-only observation of the Hermes
ledger; no writes into Hermes state.

Truth rules:

- Ledger is the source of truth for existence/status. `claimed` renders as "queued"; `unknown` renders
  as "interrupted / unknown after restart". No fabricated history: runs with no evidence read
  "unavailable".
- Trigger: `source == "direct"` ⇒ manual; a Winglet-initiated `POST /api/schedule/{id}/run` writes an
  intent row (`trigger_job` only schedules on the next ticker pass, so `source == "builtin"` alone is
  not enough to call it scheduled); `scheduled_instant`/`builtin` ⇒ scheduled. Raw source retained.
- Output correlation: output docs are mapped to executions by a global one-doc-per-run greedy
  assignment over the claim/finish window plus nearest finish; ambiguous or missing ⇒ output
  unavailable. Older docs with no ledger row become output-only rows with status `unknown`,
  `recorded = 0`, and a "scheduler has no record" note.
- Session correlation: `SessionDB.list_cron_job_runs(job_id, limit, offset)` through
  `_open_session_db_for_profile(profile, read_only=True)`, matched one-to-one to the nearest claimed
  time inside a bounded window; `no_agent` jobs legitimately have no session.
- Rename/delete: history survives because the mirror snapshots title/prompt/output/session at run
  time; upstream `remove_job` deletes the output directory, so snapshots are mandatory. Deleted
  routines render an archived-provenance banner. "Run again" must state whether it uses the current
  definition or the snapshot.
- Idempotency/recovery: unique `run_id` (execution id) makes duplicate callbacks and duplicate inbox
  deliveries harmless; overlap is recorded as two rows; process restart is reconciled from the ledger
  (`unknown` carries the restart reason).

Updates delivery: the adapter records a delivery and attaches a real `run_id` when unambiguous
(delivery happens before `finish_execution`, so link to the newest running run for that job); older
result cards fall back to routine detail via `job_id`. Existing inbox payload
`{"message_id","job_id"}` / meta `{"routine": name}` stays valid for old clients.

## 3. UI plan (designed, not implemented)

- Entry points: Schedule card tap → routine detail; Updates `ResultCard` → run detail; chat routine
  badge → routine detail; run detail → `/session/{id}?server=...`.
- Information hierarchy: summary (name, status, schedule with timezone/DST wording, next run) →
  Run now / Pause (existing signed endpoints) → recent runs → full history with keyset pagination →
  run detail (status, trigger, timings, output, session link, provenance).
- States: empty history, loading, error, offline, unsupported server (feature flag false), member
  (read refusal), archived routine, definition-changed, long name/output, larger text.
- Card tap behavior is feature-aware: opens detail when `routine_history` is true, keeps the existing
  edit sheet on old servers.
- Layouts: 320/390 px phones, tablet, ~1440 px desktop; light/dark from existing tokens; 44–48 px
  targets; keyboard focus and screen-reader labels on web; reduced motion respected.
- Reuse: Herald's summary-plus-runs information architecture only, adapted to Winglet tokens
  (`ui.tsx`, `Screen.tsx`, `theme.ts`, `icons.ts`); keep pets, composer and navigation untouched.

## 4. File-level work plan (all pending)

Backend:

1. `plugin/routine_history.py` — mirror schema, ledger/jobs/output/session sync, trigger
   classification, delivery linkage, retention, keyset pagination, `configure()` / `available()`.
2. `plugin/hermes_api.py` — add `routine_history_available()` and `routine_history_source()` reading
   jobs, executions, output docs and cron session rows inside `_profile_scope()` with the configured
   timezone (read-only `_open_session_db_for_profile`).
3. `plugin/hub.py` — conditional route registration for the two GETs, `ROUTE_POLICY` owner entries,
   `routine_history` / `routine_run_detail` in `features()`, adapter-held history instance, 60 s gated
   `asyncio.to_thread(history.sync, bots)` inside the existing `_reconcile_loop` (janitor's 3600 s
   cadence is too slow), `run_id`/`routine_id` in inbox payload/meta.
4. `plugin/adapter.py` — construct/configure the history store, record deliveries, include link ids.
   Sync bot list: default `("", None)` plus `hermes_api.multiplex_state(...)["served"]`.

Frontend:

5. `app/src/features/routine-history/` — types, api helpers, formatting/pure logic, card, detail,
   history list, run detail.
6. Routes `app/routine/[serverId]/[routineId]/` (detail) and run detail; optional `?server=` on
   `app/session/[id].tsx`.
7. Minimal wiring: `app/src/app/schedule.tsx` (extract `EditSheet`, link cards), `InboxCards.tsx`
   result card, `ChatView.tsx` badge, `api.ts`, `types.ts`, `store.ts` feature negotiation.

Tests:

8. Node unit tests for pure formatting/pagination/trigger labeling; pytest for manual vs scheduled,
   overlap, duplicate delivery, restart `unknown`, rename/delete provenance, output/session links,
   bot scope, member refusal, retention, pagination under new arrivals.
9. `third_party/notices/herald-routine-history.md` with source URL, exact commits/files, modifications
   and the full Herald license text — required in the same PR that first adds reused material.

## 5. Validation status

| Check | Result |
| --- | --- |
| `npm test` (app) | **not run** |
| `npm run typecheck` | **not run** |
| `npx expo export --platform web` | **not run** |
| `npx expo export --platform android --output-dir dist-android` | **not run** |
| pytest (targeted / full plugin suite / trust+route-policy) | **not run** |
| Real pinned Hermes integration check | **not run** (pin `47676981f55de91231fdeef2f0eec47e7c209e78` not exercised) |
| Web UI screenshots at 320/390/tablet/1440, light/dark | **none produced** |
| Android build / device | not attempted (out of scope in this phase) |
| PR CI | no PR, so no CI |

Setup that exists and can be reused: worktree `.venv`, `app/node_modules`.

## 6. MOBILE VALIDATION PENDING (recipe for Codex; nothing executed)

- Integration commit: this branch once implemented, merged on top of `codex/major-features`; backend
  needs the pinned Hermes `47676981f55de91231fdeef2f0eec47e7c209e78` with at least one saved job.
- Local fixture: plugin on the assignment's API port 9310, disposable data dir, two saved routines
  (one `direct` manual run, one ticker scheduled run), one `no_agent` job, one renamed and one deleted
  routine with prior runs, and one intentionally interrupted run to produce `unknown`.
- UI: web export on port 8310 for layout checks; native checks on an emulator/device only in that
  later phase.
- Steps/expected outcomes: Schedule card → detail shows schedule + timezone + next run; Run now
  produces a `claimed` then `completed` row with output and a session link opening the real cron
  session; history pagination loads older pages without duplicates; deleted routine shows archived
  provenance; long names/output wrap without horizontal overflow; member account is refused;
  offline trigger is blocked rather than queued.
- Genuinely hardware-only: Android runtime permissions, audio/composer behavior, Wear OS, system
  back/gesture handling, real safe-area/notch geometry, real-device performance.
- Automation to prepare: a pytest fixture that seeds the ledger/output/session shapes above, plus a
  repeatable web screenshot script at the four widths in both themes.

## 7. Integration-branch inspection (done at handoff time)

`origin/codex/major-features` is now `87cf626` ("Merge pull request #49 … rooms"), **67 commits ahead**
of base `b71d93b`. No `routine_history` identifier exists anywhere on that branch, so the capability
keys, route names and table names above do not collide.

Shared files my plan must touch have all moved substantially since the base commit, so expect textual
merge conflicts (not semantic ones) in:

| File | Change on integration branch |
| --- | --- |
| `plugin/hub.py` | +278/− (rooms, checkpoints, processes, projects, branching routes and `ROUTE_POLICY` entries) |
| `plugin/hermes_api.py` | +210 |
| `plugin/adapter.py` | +140 (also the `_reconcile_loop` area I would edit) |
| `plugin/store.py` | +108 |
| `app/src/lib/store.ts` | +278 |
| `app/src/lib/types.ts` | +80 |
| `app/src/components/ChatView.tsx` | +90 |

`app/src/lib/api.ts` and `app/src/app/schedule.tsx` are unchanged on the integration branch, so those
edits should apply cleanly. Feature-local directories already used:
`branching/`, `checkpoints/`, `execution/`, `processes/`, `projects/`, `rooms/` — `routine-history/`
is free and does not clash with any existing `third_party/notices/herald-*.md`
(`checkpoints`, `execution`, `projects` exist).

## 8. Reference comparison (planned vs Herald — design level, nothing implemented)

| Reference behavior (Herald) | Winglet plan | Matching edge cases planned | Intentional difference | Remaining gap |
| --- | --- | --- | --- | --- |
| `ScheduledPage.kt` summary block with schedule + enable/pause | Same hierarchy with Winglet tokens and existing signed actions | archived routine, missing schedule | Winglet keeps pets/composer identity | not implemented |
| Run rows: status, start time, duration, output link | Status chip (`claimed`→queued, `unknown`→interrupted), trigger, duration, output + session link | overlap, duplicate callbacks, restart `unknown` | Trigger label derives from ledger `source` plus Winglet intent row, not a UI guess | not implemented |
| `Routines.kt` / `CronApi.kt` job + run models | Read-only Hermes ledger observation plus local mirror | retention, pagination, deleted jobs | Winglet mirrors snapshots so history survives upstream pruning/deletion | not implemented |
| Run detail opens the cron session | Link to `/session/{id}?server=` | `no_agent` jobs without sessions | Winglet never fakes a session | not implemented |
| Re-run from history | "Run again" states current-definition vs snapshot | edited definition, deleted routine | No cancellation control (upstream lacks it) | not implemented |

## 9. Risks and open questions for the next agent

- Correlation heuristics (output doc ↔ execution, session ↔ execution) are inherently approximate; the
  design degrades to "unavailable" instead of guessing, but this needs tests proving no double
  assignment under overlap and restart.
- Delivery-before-`finish_execution` means a run id attached at delivery time can point at the newest
  running run; ambiguity must fall back to `job_id`-based navigation.
- The 60 s sync inside `_reconcile_loop` adds I/O to a 5 s loop; it must stay non-blocking
  (`asyncio.to_thread`) and must not run when the ledger is unimportable (feature stays false).
- Hub route registration must be conditional (history instance set before `build_app()`), otherwise old
  servers advertise nothing but the routes still exist.
- Two-agent overlap risk: only additive edits to the shared files listed in §7; rebase after
  `codex/major-features` moves again.

## 10. Review entry points (once implemented)

`docs/agent-handoffs/routine-history.md` (this file), `plugin/routine_history.py`,
`plugin/hermes_api.py` `routine_history_source`, `plugin/hub.py` route/feature/policy wiring,
`app/src/features/routine-history/`, `app/src/app/routine/`, the new pytest/Node tests,
`third_party/notices/herald-routine-history.md`.

## 11. Bottom line for Codex

- Delivered in this session: verified research, the upstream/ledger/trigger/correlation contract above,
  a file-level plan, an integration-branch conflict map, and a mobile validation recipe.
- Not delivered: any code, test, build, screenshot, commit, push or PR. The feature is **not started**
  in the tree; `codex/major-10-routine-history` is still at the untouched base commit and must be
  implemented from scratch (or the assignment reassigned) before review.

For Codex orchestrator review.


</details>
