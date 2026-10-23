# Execution: structured tasks, plans and subagents

Assignment 04 — branch `codex/major-04-execution`, worktree
`C:\Users\vikas\Documents\winglet-agents\04-execution`. Capability ownership: `structured_activity`,
`subagents`, `task_plans`. Namespaces: `task.*`, `subagent.*`, `tool.*`, `plan.*`.

This document is the execution agent's contract and handoff. Other agents may rely on the capability
keys, route and event names below; they must not redefine them.

Feature commits on `b71d93b`: `34a7dea` (contract/notice), `1128b62` (event model), `7253207`
(server hooks and route), `3d83fae` (store wiring), `8706f46` (task sheet), `cbe2994` (last plan across
turns), `091f30b` (unconfirmed strip and non-live plan), `83adefc` (settled child tool rows), `0755ef6`
(session→chat authority tests and this handoff update). The branch was built and tested from the isolated
worktree, not the shared checkout.

## Implementation summary

Winglet no longer infers the current task from Hermes's prose progress lines. The plugin folds
authoritative Hermes plugin-hook facts into one bounded per-chat snapshot and a stream of namespaced
socket events; the app keeps the compact strip, turns its sheet into a calmer task detail, and shows
the plan, nested subagents, tool lifecycle and the turn's actual outcome.

Backend (`plugin/execution.py`, ~700 lines):

- **Turn boundaries** from `pre_llm_call` / `post_llm_call`; **cancellation** from `agent_loop_stopped`
  (using the gateway session key). A turn's `turn_id` is Hermes's; a server-local `turn_index` makes a
  new turn detectable when Hermes supplies none.
- **Tools** from `pre_tool_call` / `post_tool_call`: identity is `tool_call_id`, duration is
  `duration_ms`, status comes from the hook's `status`, and an error line is bounded/redacted. A finish
  whose start was missed still produces one row marked `started_known: false`.
- **Plan** from the `todo_list` / `todo` tool result: `{todos, revision}` is authoritative. A lower
  revision is refused. Items are bounded, statuses validated and parent links preserved.
- **Subagents** from `subagent_start` / `subagent_stop`: parent/child session and subagent ids, role,
  goal, status, summary, duration and the stop hook's metadata-only `tool_call_history`. Nested children
  are resolved through the parent child's session id (they are not gateway sessions). Tool calls from a
  child's session attach to that child, not to the parent's tool list.
- **Honesty rules:** a turn that ends before a child or tool reports marks it `unknown`, never
  `completed`; only the first terminal fact wins (a stop followed by a normal end stays cancelled); if
  Hermes supplies no turn id the field is `null`; no percentage is computed beyond done/total over
  reported plan items.
- **Bounds:** 40 tools, 40 subagents, 256 plan items, 12 activity lines per subagent; goals 500, item
  400, summaries 600, errors 300, previews 160, activity lines 180 characters. 32 chats of state, LRU by
  last update. Tool arguments and results are never stored.
- **Redaction:** `sk-…`, `gh*_…`, `xox?-…`, `Bearer …`, `api_key/token/secret/password=…` and URL
  credentials are replaced before anything is stored or sent.

Wiring:

- `plugin/adapter.py` builds the tracker, resolves a Hermes session through its own `SessionStore`, and
  accepts only entries whose origin platform is `winglet`, whose chat still exists, and whose profile is
  that chat's bot. Hook callbacks publish through `loop.call_soon_threadsafe` onto the hub.
- `plugin/hub.py` adds `features.task_activity`, `GET /api/task?chat=…` (policy `device`, member scope
  via `_visible_chat`), `hub.execution`, and `forget_chat` on chat deletion.
- Hooks are registered only if this Hermes accepts all seven; a Hermes without them leaves the feature
  off rather than showing guesses. Registration is idempotent across plugin reloads.

Frontend:

- `app/src/features/execution/model.ts` — wire types, bounded reducer, snapshot/event ordering,
  plan tree flattening, active-first subagent ordering, unconfirmed-state derivation, labels.
- `app/src/features/execution/TaskDetail.tsx` — state pill + elapsed clock, plan with done/total bar and
  nested steps, expandable nested subagents with activity/result, active tools first with finished tools
  folded, outcome, honest notes, and the whole-task Stop.
- `app/src/components/TaskProgress.tsx` — keeps the compact strip and one immediate Stop; header reads
  the active plan step/subagent/tool; loads the snapshot on open, work start and reconnect; a finished
  turn's strip lingers for 60 s so its outcome is reachable (Winglet has no transcript delegation cards),
  and an unresolved running snapshot says "Task not confirmed" instead of vanishing; the sheet no longer
  closes the moment the turn ends, so the outcome can be read.
- `app/src/lib/store.ts` — `tasks` per chat, `task.snapshot` / `task.event` handling, `loadTask` with a
  2 s throttle, reset on a new socket hello, cleanup on chat removal.
- `app/src/lib/types.ts` re-exports the feature's snapshot types.

## Contract

### Capabilities

| Key | True when | Meaning |
| --- | --- | --- |
| `task_activity` | All seven observer hooks were accepted and the tracker is live | `GET /api/task` and `task.snapshot` / `task.event` are available. |
| `subagent_stop` | Never on the pinned Hermes | Reserved. Absent means unsupported: the app must not show a per-subagent Stop. `GET /api/task` returns `capabilities.subagent_stop: false`. |

`protocol` / `min_app_protocol` are unchanged. Events are namespaced and ignored by older clients.

### HTTP

`GET /api/task?chat=<chat id>` — policy `device`; members see only chats `can_see` allows, and a chat
they cannot see answers 404 exactly like messages.

```json
{ "available": true, "snapshot": { "...": "..." }, "capabilities": { "subagent_stop": false } }
```

`available` is false and `snapshot` null when the server has no tracker (old server/Hermes). A chat with
no recorded task answers `snapshot: null` with `available: true`.

### Socket events

Both carry the chat's `bot` and are ignored by older clients.

- `task.snapshot` — one bounded snapshot. Sent when a turn starts and when it ends; the HTTP route is
  the authoritative recovery path after a reconnect.
- `task.event` — one incremental fact with `seq` (monotonic per chat per process), `turn_id` (nullable),
  `turn_index`, and `event.kind` in `turn.started`, `turn.finished`, `plan.updated`, `tool.started`,
  `tool.finished`, `subagent.started`, `subagent.updated`, `subagent.finished`.

### Snapshot shape

```jsonc
{
  "chat_id": "general", "bot": null,
  "turn_id": "…", "turn_index": 1, "task_id": null,
  "state": "running",              // running | completed | failed | cancelled | unknown
  "started_at": 1760000000.0, "ended_at": null, "updated_at": 1760000012.4,
  "reason": null, "outcome": null, // {"state", "summary"} after the turn ends
  "plan": { "revision": 7, "live": true,
            "items": [{ "id": "2", "content": "…", "status": "in_progress", "parent": null }] },
  "tools": [{ "id": "…", "name": "terminal", "preview": "…", "status": "running",
              "started_at": 1.0, "ended_at": null, "duration_ms": null,
              "error": null, "started_known": true }],
  "subagents": [{ "id": "…", "parent_id": null, "goal": "…", "role": "leaf", "status": "running",
                  "started_at": 1.0, "ended_at": null, "duration_ms": null, "summary": null,
                  "tool_count": 2, "started_known": true,
                  "activity": [{ "name": "read_file", "detail": "…", "status": "completed" }] }],
  "counts": { "tools": 4, "subagents": 2, "plan_done": 3, "plan_total": 6 },
  "seq": 12
}
```

Status vocabulary app-wide: task `running|completed|failed|cancelled|unknown`; subagent
`queued|running|completed|failed|cancelled|unwatched|unknown`; tool `running|completed|failed|unknown`;
plan item `pending|in_progress|completed|cancelled`. `unwatched`/`unknown` are never successes.

### Ordering and identity

- A new turn starts with no tools or subagents from the last one; hooks carrying an older `turn_id` are
  ignored, so stale children cannot attach to the new turn. The plan belongs to the conversation, so a
  carried plan stays readable as "Last plan" (`live: false`) until the new turn writes its own.
- Tool identity is `tool_call_id`; subagent identity is `child_subagent_id` (with the child session id
  as a secondary key, so a stop arriving before its start still lands on one row). Array positions are
  never used as identities.
- Clients drop events/snapshots that are older than what they hold (`turn_index` then `seq`). `seq` is
  feature-local; the global event cursor belongs to the replay agent.

## Storage and rollback

None. The tracker is in-memory and bounded; no SQLite table, migration or version bump. Restarting the
gateway drops the snapshot, and the app shows an empty/`unknown` state rather than stale data. Removing
`plugin/execution.py` and its three wiring edits restores the baseline exactly.

## Authority, scope and privacy

- Hook payloads are resolved through Hermes's own `SessionStore`; only `winglet` sessions whose chat
  still exists and whose profile matches the chat's bot produce anything. Telegram, other profiles,
  CLI and removed chats produce no events and no snapshot.
- The HTTP route is `device`; members are limited to their own chats. No caller-supplied bot/chat scope
  is trusted. Responses contain no tokens, tool arguments/results, hidden reasoning or message text
  beyond the subagent goal/summary Hermes explicitly supplied.
- The top-level Stop is unchanged: `/stop`, live connection only, never in the offline outbox.
- A per-subagent Stop is impossible on this Hermes (the stop hook is an observer, and the public
  lifecycle service launches plugin-owned children rather than interrupting the agent's own delegates),
  so neither a control nor a capability is invented. The sheet says the whole task is what stops.

## Shared files touched

`plugin/adapter.py` (tracker construction, resolvers, publish), `plugin/hub.py` (feature, route, policy,
`forget_chat`), `app/src/lib/store.ts` (state, events, `loadTask`), `app/src/lib/types.ts` (re-exports),
`app/src/components/TaskProgress.tsx` (strip/sheet), `app/src/components/icons.ts` (four icons).
Untouched: message identity/position, signing, pairing, member chat ownership, drafts/outbox, goals,
process/checkpoint namespaces, and the global replay envelope.

## Tests and actual results

Plugin (`pytest`, private venv, `--basetemp` inside the worktree):

- `tests/test_execution.py`: **19 passed**. Covers structured turn/plan/tools/outcome; a new turn
  clearing stale subtasks, carrying the plan as a non-live "Last plan", and ignoring late events for the
  old turn; nested subagents and child tool activity (one settled row per child tool); completion-before-
  start; repeated events; the first terminal fact winning (stop vs later completion) and unresolved
  children/tools becoming `unknown`; stale plan revisions; unknown statuses; non-Winglet sessions
  producing nothing; redaction and bounds; list caps; capabilities; reset; hook registration/refusal; the
  HTTP route off without a tracker; a paired device reading a snapshot; a member refused another
  member's chat while an owner can read it; the route's policy entry.
- `tests/test_execution_adapter.py`: **3 passed** — a Winglet session maps to its own chat and bot; a
  Telegram origin, a mismatched profile, a removed chat or no entry produces nothing; a stopped turn is
  found by its gateway session key.
- Full suite: **323 passed, 16 skipped** (skips are the pre-existing optional Hermes/platform cases).
  `tests/route policy` coverage and trust tests pass with the new route.

App:

- `app/tests/execution.test.ts`: **14 passed** — live event folding and duplicate/late events, new-turn
  reset, unconfirmed children/tools at turn end, snapshot ordering, plan revisions, plan tree cycles and
  cancelled steps, active-first subagents and nesting, unconfirmed state after staleness, strip
  visibility for running/terminal/pending/expired states, elapsed/duration formatting, identity
  fallback, hostile-server bounds, unfinished plan labels. `store.test.ts` also checks that task events
  stay per chat, a stale refetch cannot undo a live tool fact, and a fresh `hello` clears the snapshots.
- Full app suite: **284 passed, 0 failed**.
- `npx tsc --noEmit`: passed.
- `npx expo export --platform web`: passed (27 assets).
- `npx expo export --platform android --output-dir dist-android`: passed; Hermes bytecode
  `entry-acc197bace..hbc` (5.8 MB).

Web UI evidence (synthetic fixture, no user data; committed under `output/playwright/`):

- `execution-strip-390-light.png` — compact strip reading the active plan step, Stop present.
- `execution-sheet-390-light.png` — plan with done/total, nested steps, status labels.
- `execution-sheet-320-light.png` — 320 px phone, wrapped text, no clipped controls.
- `execution-sheet-390-dark.png` — true-black dark theme.
- `execution-sheet-1440-light.png` — desktop centred dialog and sidebar.
- `execution-outcome-390-light.png` — finished turn: plan steps left in progress read "Unfinished", the
  unresolved tool shows as finished, the parent subagent says "Not confirmed", Outcome visible.
- `execution-last-plan-390-light.png` — a new turn with the carried plan labelled "Last plan", unused
  steps dashed, no stale subagents or tools.
- `execution-pending-approval-390-light.png` — approval strip with the command, distinct shield icon and
  text rather than colour alone.

All measurements showed `document.documentElement.scrollWidth - innerWidth === 0` at 320, 390 and 1440;
no console errors in the tested flows. The last-plan state was re-checked at 390 px after the final
change. The fixture never calls a provider.

## Reference comparison (Herald, `95ca999…`)

| Reference behavior / source | Winglet result | Matching edge cases / tests | Intentional difference / gap |
| --- | --- | --- | --- |
| `Subagents.kt` status vocabulary, bounded activity, nested rows, first-terminal-wins | Same vocabulary and bounds, rewritten in Python/TS | nesting, child tools, stop-then-complete, unknown states | No transcript `delegate_task` reconciliation: Winglet takes facts only from hooks; a tool call whose start/stop hooks were missed stays a single honest row |
| `Todo.kt` revisioned plan, order-preserving tree with cycle fallback | Same tree/order/cycle rules; revision enforced server- and client-side | stale revision, cycle, cancelled excluded from progress | Plan comes from the `todo_list` result, not transcript parsing; `live` marks whether this turn wrote it |
| `SubagentCard.kt` disc + goal + meta, glance line, nested rule, folded detail | Same hierarchy in the Winglet sheet, theme tokens and icons | expanded/collapsed rows, long goals, 320 px | Per-subagent Stop removed (no backend operation); finished rows remain in the section (ordered after active) rather than being hidden from the transcript |
| `TodoPanel.kt` progress panel, plan bar, running clock, Stop | Strip keeps the baseline plus the active step, elapsed time and outcome | strip labels, 60 s linger, stop gating | No in-stream shimmer (Winglet's restrained motion); terminal strip lingers briefly so outcomes are discoverable |
| `SessionControlPanel.kt` sheet composition, confirmations, section headings | Calm sectioned sheet; whole-task Stop only | pending approval/question sheets | No goal/loop controls here (owned by another feature) |
| Herald dashboard JSON-RPC session events | Winglet plugin observer hooks + `task.*` socket events + `/api/task` | plugin hook tests, route scope tests | Protocol deliberately not imported: Winglet is a messaging platform, not the dashboard |

Reuse notice: `third_party/notices/herald-execution.md` (source URL, snapshot, files, what was ported,
modifications, full MIT text). Upstream file-specific headers were checked; no additional terms.

## Compatibility, dependencies and limitations

- Old servers: no `task_activity`; the sheet falls back to today's prose activity and says the server
  does not report structured details. Old clients ignore `task.*`.
- Old Hermes: if the host refuses any hook, the feature stays off (no fake data).
- Pinned Hermes: hook names and payload contracts were read from
  `hermes_cli/plugins.py` (`VALID_HOOKS`), `website/docs/user-guide/features/hooks.md`,
  `agent/subagent_lifecycle.py`, `tools/todo_tool.py` and `gateway/stream_events.py` at
  `47676981f55de91231fdeef2f0eec47e7c209e78`. **Not executed against a live Hermes in this session**:
  Hermes is not installed on this machine and phone/live-server testing is deferred. CI's Hermes job
  imports the plugin against the pin but does not run a real delegated turn. This is the main residual
  integration risk; the exact test is in MOBILE VALIDATION PENDING.
- A turn that fails without `post_llm_call` cannot be known failed from hooks; the app shows it as
  running until the chat stops being busy, then `Not confirmed`. No failure is inferred.
- Outcome summaries only appear when Hermes supplies them; plans may legitimately end with steps still
  in progress, which show as `Unfinished`.
- No persistence across a gateway restart; snapshots are re-fetched per chat.

## Review entry points

1. `plugin/execution.py` — folding, honesty rules, bounds/redaction, hook registration.
2. `plugin/adapter.py` `_chat_for_entry` / `_publish_task_event` — session→chat authority and thread
   hand-off.
3. `plugin/hub.py` `h_task`, `features`, route policy — scope and negotiation.
4. `app/src/features/execution/model.ts` — ordering rules and reducer.
5. `app/src/features/execution/TaskDetail.tsx` and `TaskProgress.tsx` — information hierarchy, states,
   accessibility.
6. `tests/test_execution.py`, `tests/test_execution_adapter.py`, `app/tests/execution.test.ts`.

## MOBILE VALIDATION PENDING

Status labels: **code implemented**; **automated/build checks passed** (pytest 323, app 284, typecheck,
web and Android bundle exports); **native build not run** in this agent phase; **mobile validation
deferred to Codex**.

- **Build needed:** this branch HEAD after review fixes. Android APK built by the orchestrator (the
  normal signed branch build). No native dependency, permission or manifest change is introduced.
- **Safe local fixture:** `python scripts/execution_fixture.py --bind 0.0.0.0 --port 9304` after
  `cd app && npx expo export --platform web`. Synthetic data only. It prints a pairing link with the
  server fingerprint and a control URL. Android emulator reaches the API at `http://10.0.2.2:9304`.
  Controls stay loopback-only (`127.0.0.1:9305`); use `adb reverse tcp:9305 tcp:9305` if driving them
  from the device-side browser, or curl from the host.
- **Emulator/API/form factor:** Android 13+ API 34, 390×844 portrait, font scale 1.0 then 2.0, dark and
  light, reduced motion on/off; tablet/wide at 1024+; web at 320 and 1440 (already covered).
- **Steps and expected outcomes:**
  1. Pair with the printed link, open the main chat. Expect the strip: "Working on your request" with
     the active plan step, one 44 px Stop, no clipped text at 320–390.
  2. Open the strip. Expect a sheet with Working pill + elapsed clock; plan 2 of 6 with nested step
     indentation; subagents "1 working · 1 done · 1 failed"; failed row expands to Activity/What went
     wrong; tools show the running search first and "1 finished" folded; Stop at the bottom.
  3. Tap a subagent. Expect expansion without layout jump, 44 px target, TalkBack reading goal, state,
     duration and summary; no per-subagent Stop.
  4. Tap the failed row, then a finished tool. Expect red error text rendered as plain selectable text,
     with no Markdown or link execution from tool content; finished tools stay folded until asked.
  5. `GET /127.0.0.1:9305/finish`. Expect the sheet to stay open and show Completed, "Unfinished" for
     steps left in progress, the straggler tool as finished/unknown, the parent subagent "Not
     confirmed", and the Outcome summary. Close it: the strip lingers as "Task completed" and
     disappears after about a minute.
  6. `GET /127.0.0.1:9305/pending`. Expect the strip to become "Approval needed" with the command (shield
     icon + text, not colour alone), Inbox badge; tapping opens the request sheet. Members should see
     "Waiting for an owner" instead.
  7. Rotate, background/foreground, and kill/relaunch: no crash; the task sheet re-fetches the snapshot
     on reconnect; no stale children appear in a new turn.
  8. `GET /127.0.0.1:9305/next-turn`. Expect tools and subagents to clear while the previous plan is
     labelled "Last plan", not live, with unused steps dashed rather than spinning. Restart the fixture
     to confirm a fresh chat starts empty.
- **Physical hardware only:** real Hermes with delegation (validates the pinned hook payloads),
  multi-profile bot isolation with a member device, TalkBack/font-scale rendering, process death of a
  real server, and Android keyboard/safe-area behaviour over the sheet.
- **Not required for this feature:** audio, camera, Bluetooth, Wear OS.

## Known merge surface

At handoff, `origin/codex/major-features` was fetched and still sits at `b71d93b`; this branch is 5
commits ahead and 0 behind, so there is no current conflict. When the other major-feature branches
land, shared-file conflicts are most likely in `plugin/hub.py` (`features()`, `ROUTE_POLICY`, routes,
chat delete) and `app/src/lib/store.ts` (`ServerState`, `handleEvent`, `loadTask`). The feature is
additive; resolve by keeping both features' keys and cases. `TaskProgress.tsx` may conflict with
another agent's control work; keep the baseline strip semantics and this sheet.

## For Codex orchestrator review

Everything above is ready for code review. Do not merge this branch from the agent; the orchestrator
owns integration, the final plugin/web bundle regeneration, the signed APK and device validation.
