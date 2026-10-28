# Approved feature delivery ledger

Parent: [#13](https://github.com/Broedkrummen/winglet/issues/13). Scope and acceptance: [implementation plan](selected-features-implementation.md).

This ledger reports actual delivery, not intention. No selected feature is complete yet.

| IDs | Tracking issue | Current evidence / remaining work |
| --- | --- | --- |
| 1 | #14 | Server membership, invitations, field conflicts, CAS resolution, signed routes, durable retries and draft submission IDs implemented. Client sync/conflict chooser, attachment ownership, send integration, complete settings/draft wiring and device verification remain. |
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

Current checkpoint: **680 Python tests passed, 31 skipped**. The focused sync tests include restart, concurrent SQLite connections, pagination, private membership, field conflicts, stale resolution, stable submission IDs and signed HTTP routes. Web bundle verification found 28 asset references with none missing; third-party notices check passed. The initial broad run exposed a missing local `qrcode` dependency; after installing it, the complete rerun passed. No app/device, patched native runtime or paid-call verification is claimed here.
