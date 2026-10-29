# Approved feature delivery ledger

Parent: [#13](https://github.com/Broedkrummen/winglet/issues/13). Scope and acceptance: [implementation plan](selected-features-implementation.md).

This ledger reports actual delivery, not intention. No selected feature is complete yet.

| IDs | Tracking issue | Current evidence / remaining work |
| --- | --- | --- |
| 1 | #14 | Server membership, invitations/revocation, field conflicts, CAS resolution, durable retries and submission IDs implemented. Settings now links a home; portable preferences and text drafts sync through a durable client journal with explicit conflict choices and active-composer deferral. Two isolated browser clients verified linking, choosing a theme conflict and later theme propagation. Attachment ownership, target-chat send integration, reply/read/resume state, remaining libraries and physical-device verification remain. |
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

Physical Android/iPhone, patched native runtime, attachment/send integration and paid-call verification are not claimed. Feature 1 and the overall 18-feature plan remain incomplete.
