# Background processes: implementation contract

Base: reviewed integration441f26b plus native-polish PR47. Implement in feature-local
plugin/processes.py, plugin/processes_routes.py and app/src/features/processes/.
Capability keys: processes, process_output, process_stop. No new global protocol.

## UI plan

Open Background processes from the current chat menu. Show a compact list with
command, running/exited state, start time and workspace. A bounded detail sheet
shows redacted selectable output, exit code, connection/truncation warnings,
follow/pause scrolling and explicit Stop confirmation. Keep the footer reachable
on native Android with a bounded scroll area. Empty/loading/unsupported/offline/
permission/stale states must explain the next action. Use Winglet theme tokens,
44px controls and the existing Sheet/ui/icon patterns; native and narrow web
share the information hierarchy, wide screens cap the sheet width.

## Backend and authority

Only authenticated owners can list/read/stop; every request also checks visible
chat and selected bot. No arbitrary PID, process ID or command from the phone.
Discover only pinned Hermes registry entries matching the gateway session key
and current session/descendant ancestry. Opaque expiring handles bind exact
registry ID, generation, bot, chat and canonical session. Recheck them on every
read and Stop; a restarted gateway invalidates old handles.

GET /api/processes/chats/{chat_id}: bounded current list and capabilities.
GET /api/processes/chats/{chat_id}/{handle}: current state plus bounded output
with revision cursor. A matching previous revision yields a delta only when its
sanitized prefix still matches; otherwise reset to the bounded tail. Sanitize
the complete retained text before paging, never raw chunks. Do not consume
Hermes completion notifications to show phone output.
POST .../{handle}/stop: signed owner action with operation_id. Start one bounded
feature-local operation, return stopping, and expose the authoritative result
on subsequent reads. Repeated requests cannot launch another concurrent kill;
already-exited processes are reported honestly. Never queue Stop offline.

No database migrations; process handles/output/operations are bounded memory.
Shared wiring: adapter service, hub feature flags/policy/routes, ChatMenu entry
and ChatView sheet. No arbitrary shell/signal/stdin endpoint.

## Reference and implementation evidence

Read Herald95ca999fa48c1c9de232fe499a174900f0d25272 Processes.kt and
ProcessesSheet.kt, plus pinned Hermes47676981f55de91231fdeef2f0eec47e7c209e78
tools/process_registry.py and terminal_tool_background.py. Reference uses a
polled list/detail/Stop. Winglet adds signed operations, scoped opaque handles,
revisioned redacted output and explicit reconnect/reset behavior. No Herald
source is copied or ported in this initial implementation.

Pinned Hermes uses Windows taskkill /T /F (forceful tree stop), with a signal
fallback. POSIX uses a grace period and can escalate surviving descendants;
systemd scope teardown is additive when available. Sandbox termination is
backend-specific and has no host process-tree proof. Preserve these limits in
the handoff and avoid promising graceful stop.

## Bounds, lifecycle and retries

The gateway keeps at most 512 opaque links for one hour of inactivity, returns
the newest 80 scoped jobs, caps concurrent Stop operations at eight and retains
32 operation receipts per link. Failed/uncertain receipts are replayed even
after intervening attempts. At the receipt limit, new attempts fail closed;
reloading the list rotates the exhausted link and invalidates the old one.
Output snapshots have independent ordering: upstream sandbox polling does not
always advance its total-output counter. Slower redaction cannot replace a
newer snapshot. Redaction failure hides output rather than exposing raw text.
Gateway shutdown awaits active stop workers. No controls enter the outbox.

## Reference comparison

| Reference | Winglet behavior | Evidence / difference |
| --- | --- | --- |
| Processes.kt scoped list and Stop | Current canonical session plus descendant ancestry, same gateway/bot only | Exact-ID, generation, cross-chat/bot and session reset regressions |
| ProcessesSheet.kt list/detail polling | Theme-aware bounded sheet, command/workspace/start/exit, selectable output | Actual Android dark; 320/390/1440px web light |
| Live output and Stop feedback | Redacted revision/delta tail, pause/follow, signed asynchronous Stop receipt | Real Hermes output, notification not consumed; phone stopped a real watcher |
| Process controls | Owner-only; no PID, arbitrary command, stdin or signal endpoint | Pairing/signature/member refusal tests; forceful Windows warning |

No upstream source was copied or translated. This is an independent bridge to
the pinned Hermes registry informed by the reference behavior.

## Validation actually performed (24 October 2026)

- Full plugin suite: **411 passed, 22 skipped** in the lightweight environment.
- Feature tests against real pinned Hermes: **16 passed**, including actual
  subprocess output/termination, non-consumption of completion notifications,
  exact IDs/redaction, equal-counter concurrent snapshots and interleaved retry IDs.
- Full app suite: **321 passed**; TypeScript check passed.
- Expo web and Android bytecode exports passed. These are bundle checks, not a
  new native APK build. Final UI mutation/stale-response guards additionally
  passed typechecking; CI rebuilds the final source revision.
- Browser rendering checked 320x568, 390x844 and 1440x900, with 320/320 and
  1440/1440 document widths. Pausing while output arrived preserved scrollTop=40.
- Physical USB Android I2304, serial ending 60003S: existing isolated Winglet
  dev runtime loaded the feature over Metro. Opened real output, confirmed Stop,
  saw the authoritative Stopped result and retained output. Hermes receipt for
  disposable proc_c563691d24dd recorded completion_reason=killed and
  termination_source=winglet.process.stop; a separate Windows process query
  found no remaining synthetic watcher. Production app/pairings were preserved.
- Independent review reproduced two edge cases (sandbox read ordering and
  interleaved Stop retries); both were fixed and regression tested before PR.

Representative synthetic evidence is in [processes/](processes/): native live
output/confirmation/result and the final narrow/wide web sheets. The versioned
`scripts/native_feature_fixture.py` creates an isolated real Hermes gateway,
SQLite store, checkpoint workspace and real watcher; run it using the pinned
Hermes environment. Use a disposable device pairing. Its separate localhost
QA control server is test-only and never part of production API routing.

## Compatibility, rollback and remaining validation

No database migration. Removing this feature leaves existing data intact.
Older clients ignore additive booleans; unsupported Hermes hides controls.
Permission loss clears privileged rows; reconnect/stale links require a new
list instead of replaying a control. A stopped background job is distinct from
the enclosing conversation task and does not cancel it.

Not yet verified: fresh signed native APK build, TalkBack/larger system fonts,
other Android API levels/form factors, physical POSIX/sandbox backends, remote
tunnel reconnect and a live provider run. Backend fixture uses real Hermes but
synthetic conversations, so it does not establish live-model/provider behavior.
Only retained upstream output can be shown; sandbox output rotation may lack
an upstream discarded-character count. No public release was produced.

For Codex orchestrator review: inspect scope/generation binding and bounded
retry receipts first, then native sheet height and stale-poll mutation guards.
