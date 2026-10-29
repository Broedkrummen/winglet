# Approved feature delivery ledger

Parent: [#13](https://github.com/Broedkrummen/winglet/issues/13). Scope and acceptance: [implementation plan](selected-features-implementation.md).

This ledger reports actual delivery, not intention. No selected feature is complete yet.

| IDs | Tracking issue | Current evidence / remaining work |
| --- | --- | --- |
| 1 | #14 | Membership, preferences, text/file drafts, reply context and explicit shared-ID Composer Send are connected. Tests cover generation lifecycle, typing during claim/download, strict outbox acceptance, endpoint changes, restart disagreements and failed target commits. Two target pairings using the same home claim produce one message and one synthetic adapter dispatch. Retained-file recovery controls, complete restart/file recovery, read/resume state, remaining libraries and browser/physical-device verification remain. See `docs/USER_SYNC.md`. |
| 3, 4, 5, 7 | #15 | Pending results, bookmarks, presets and keyboard implementation. |
| 6 | #16 | Pending notification implementation. |
| 10, 12 | #17 | Isolated Hermes checkout prepared; native boundary inspection complete. Enforcement, durable pause, receipts and Winglet UI remain. |
| 14, 15 | #18 | Pending lifecycle and health implementation. |
| 16 | #19 | Pending external restore coordinators and Windows/Linux/Docker round trips. |
| 17, 18, 19 | #20 | Pending knowledge, search and provenance implementation. |
| 20, 21 | #21 | Pending Kanban and scoped cross-gateway handoffs. |
| 22, 23 | #22 | Pending isolated artifacts and dedicated desktop viewer/control. |

## Verified native boundary findings

Reference: Hermes `bf0203a794a07aac3ff764972ab9087baa4e4f4e`, isolated branch `codex/winglet-runtime-contracts` in sibling `hermes-selected-features`. The installed runtime is untouched.

- Both ordinary pre-tool hooks and execution middleware can continue after callback errors. Enforcement must live at terminal dispatch/admission boundaries, not solely in a Winglet plugin callback.
- `agent/turn_facade.py` establishes effective task identity and native turn leases. Admission binds the policy there; leases do not grant authorization.
- `agent/tool_executor.py::_dispatch_authorized_once` sees rewritten arguments and shares sequential/concurrent dispatch. Reserve limits atomically at that boundary.
- `agent/turn_api_call.py` covers main calls; `agent/relay_llm.py` and auxiliary paths must also be covered. Main-loop-only accounting misses compression, auxiliary and fallback attempts.
- Codex app-server execution needs proven accounting/admission or must pause bounded tasks explicitly. Missing response usage cannot prove an advance dollar ceiling.
- Typed policy pauses must bypass retry/fallback and Kanban recovery, remain durable through finalization and resume only an exact approved pending action/revision.

## Validation so far

Current checkpoint: **682 Python tests passed, 31 skipped; 483 app tests passed; TypeScript check passed**. Sync tests cover restart, concurrent SQLite connections, pagination, membership, field conflicts, stale resolution, stable submission IDs and signed routes. Client tests cover journal-before-HTTP, immutable retries, storage failures without losing intent, own-edit causality, queued typing, active-draft observation, lock/offline behavior, stale-choice recovery and disconnect storage failure.

Web and Android exports passed. The first Windows Android compiler process crashed; a terminal-confirmed retry with two Metro workers passed and produced native Hermes bytecode. Final web bundle verification found 28 asset references with none missing; all 40 bundled files match the exported files by SHA-256, with no extra files. Notices check passed.

Disposable local browser QA used two isolated Chromium contexts (desktop and phone width), real signed routes, two synthetic owner devices and no provider calls. Linking, explicit theme-conflict selection and subsequent theme propagation passed with no page errors. Batched light/dark screenshots were inspected. The first browser run exposed source metadata accidentally included in a chosen value; request normalization and a regression test fixed it before the passing confirmation. The local QA fixtures/screenshots are ignored under `.pytest_cache/sync-browser-qa`; they are not product data.

Physical Android/iPhone, patched native runtime, Composer attachment/send integration and paid-call verification are not claimed. Feature 1 and the overall 18-feature plan remain incomplete.

## File transport checkpoint

Private bytes are outside the public media directory and reauthorize every group read. Immutable metadata excludes URLs, credentials and auto-send flags. Actual signed HTTP tests cover files above 2 MiB, digest/permission/quota refusals, conflict retention, target copy ownership, same-ID duplicate submissions, safe cleanup and explicit lost-device recovery. Normal uploads now recheck authority and combined quotas at commit; the shared upload helper includes child-profile scope.

The client transport library verifies exact bytes before writing an independently paired target. Binary request signatures use the existing protocol and are tested for non-UTF8 data and typed-array offsets. Target copies carry retention IDs; unconfirmed source files remain pinned until a confirmed target receipt or explicit file-retention discard. Such a discard does not cancel execution.

Final transport checkpoint: **696 Python tests passed (31 skipped), 490 app tests passed, TypeScript passed, web/Android exports passed**. All 40 bundled files match the final web export by SHA-256; bundle and third-party notices checks passed. Signed query components now preserve apostrophes and parentheses without URL-parser rewrites. No new UI surface was changed in this transport step; the previous browser visual evidence remains limited to settings/text sync.

## Composer integration checkpoint

Manual draft files and reply context now replicate through the private transport. Explicit Send freezes the composition, validates a canonical shared submission ID and hands retained target copies to the existing durable local outbox. Continued typing stays journaled separately while the frozen claim is pending. Unverifiable claims do not create fallback IDs. Actual matching target messages permit source/duplicate hold settlement; local pending messages do not.

The server supplies draft generations and rotates them after claimed content changes. Restart cache disagreements preserve both candidates without predecessor rebasing. Receiving files rechecks edits, lock and endpoint identity after asynchronous work. Bulk writes occur outside SQLite; admission and atomic rename remain transactional. Commit failure rolls back and removes the new target copy.

Settings copy/loading-state updates and two-browser file/send verification are still pending. No UI component source changed in this checkpoint. Earlier screenshot evidence does not establish Composer integration behavior. Feature #1 remains incomplete.

Validation: **700 Python tests passed, 31 skipped; 499 app tests passed; TypeScript, web/Android exports, bundle references and third-party notices passed**. All 40 bundled files match the web export by SHA-256. Exports do not establish physical-device behavior; no native runtime installation or paid-call test occurred.

## Recovery controls and browser integration checkpoint

Settings now exposes per-bot removed-device retained files with paginated inspection, Download and explicit Release. Results hide while locked; stale pairings and unavailable connections are rejected. Copy explains that storage release does not cancel a task or prove delivery. Current-device abandoned attachment/claim controls remain pending. Composer shows preparation while the shared claim is verified. Failed-message deletion uses strict serialized outbox persistence and keeps the message when that write fails.

Identical-value retries no longer advance field revisions or add duplicate conflict candidates; a later edit based on the original field does not spuriously conflict with the identical replay. A regression test covers that sequence.

Browser evidence: two isolated Chromium contexts used real signed routes and synthetic owners/files. Settings light/dark desktop/phone layouts and removed-device recovery were inspected in bounded batches. Download and explicit release passed. A manual attachment arrived on the inactive phone, survived reopening after batched persistence committed, and concurrent Send from both clients produced one actual server-confirmed user message (database count verified). An earlier check incorrectly matched the draft preview and navigated before receipt/persistence; the final check waits for both and for an actual target message. These checks do not establish all restart scenarios, live Hermes adapter execution or physical-device behavior. Conservative startup preference recovery can still ask for a choice; it does not silently pick a version.

Current suites: **701 Python tests passed, 31 skipped; 500 app tests passed**. TypeScript and Android export passed. The final web export excludes the temporary local diagnostic hook. Full sync and the other selected features remain incomplete.

## Shared submission recovery checkpoint

Private group members can discover submissions from all linked devices through a bounded 20-item API page. Settings displays frozen previews, file descriptors, target-message confirmation and explicit release state. Downloads reauthorize and verify private bytes; native sharing removes its unique temporary directory even after a failed write. An explicit shared-source release affects only home submission pins, preserving local outbox/holds and the stable submission ID. Current-device removed attachments and unused copies still need their own recovery lifecycle.

Validation: **702 Python tests passed, 31 skipped; 505 app tests passed; TypeScript and web/Android exports passed**. Bundle references/notices passed and all 40 bundled files match the export by SHA-256. Actual signed route tests cover private listing and revocation; service tests cover pagination and release state. Client tests cover stale-home refusal, explicit release without execution, and export cleanup. Two browser contexts discovered an unconfirmed synthetic submission, downloaded exact expected bytes and observed the explicit release across devices with no page errors. Light/dark desktop/phone captures were inspected, spacing fixed once and the bounded confirmation passed. Physical sharing on Android/iPhone and live Hermes execution remain unverified.

## Current-device retention checkpoint

Settings now lists this pairing's retained uploads/copies with Download and explicit versioned Release. Live and strict persisted draft/outbox references protect the file; an admission guard prevents a new local outbox acceptance during release. Each server hold acquisition renews its version. Stale or legacy unversioned own-release requests are refused, and final mutation rechecks chat visibility/bot scope transactionally. Legacy holds migrate without losing retention. Older servers that ignore the requested scope produce an update-required error.

Confirmed-delivery cleanup uses the same guards and distinguishes home settlement from local retirement. Protected or refreshed leases retry later without resending delivery receipts. Bounded passes leave remaining files for later automatic or explicit review. Ordinary unclaimed-file grace periods still govern byte removal; storage release is not cancellation.

Validation: **705 Python tests passed, 31 skipped; 513 app tests passed; TypeScript and web/Android exports passed**. Tests cover migration, owner isolation, stale/legacy release refusal, bot-scope changes while reading a body, saved-only references, unreadable storage, admission races and delayed cleanup retries. Desktop/phone signed-route checks refused release of saved-draft files, exported exact unused bytes and released only unused holds, with no page errors. Light/dark captures were inspected in bounded batches. Sync still needs complete restart/recovery, read/resume and remaining library integration; the other selected features remain pending.

## Restart composition preservation checkpoint

Startup journals local text, reply and attachment snapshots before network refresh can replace them. Uncached ready files stage on reconnect, then submit immutable zero-base branches so competing cache versions become explicit choices. Observed local clears are retained as candidates. The queue survives offline starts and excludes automatic voice sends. Saved files already attached to an actual message may stage through an explicit original-owner/message-backed fallback; the original message and its file claim are unchanged. Missing/unrecoverable source handling remains durably queued and can pause sync; terminal recovery decisions remain pending.

Validation: **706 Python tests passed, 31 skipped; 516 app tests passed; TypeScript and web/Android exports passed**. Desktop and phone browser contexts cold-started offline with disagreeing caches, preserved queued text/files/replies, then reconnected and recovered previously sent source bytes. Actual server records retained baseline and recovered candidates for explicit choice; no page errors. An initial browser run began before the export finished and timed out; the run after confirmed export completion passed. No UI source changed in this checkpoint. Full sync and the approved 18-feature scope remain incomplete.
