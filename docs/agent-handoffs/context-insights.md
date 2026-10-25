# Context insights contract

Base: integrated features01-06 at87cf626. Primary role: AI Engineer, architecture
then implementation then separate review. The stopped09tree contained no feature
implementation or handoff; its private .venv09 is preserved and never staged.

Entry: chat menu → Context and usage. A bounded sheet separates current model
occupancy, estimated category contributions, session throughput/cost, and account
limits. Numeric uncertainty and freshness stay visible. Existing Usage charts
remain. Owner-only numeric context reads and signed compression; server derives
chat/profile/device scope. No prompt, tool schema, credential or account raw body
is returned. No universal context window, dollars-as-rate-limit or invented zero.

Feature modules plugin/context_insights*.py, app/src/features/context-insights/;
minimal Hub/adapter and chat menu/view wiring. Capabilities session_context,
context_compression, provider_limits and usage_insights independently gated.
GET /api/context/chats/{chat_id}, GET .../limits, signed POST .../compress,
GET .../operations/{operation_id}. context.updated is namespaced; event08 owns
global replay. Readable chat history and drafts are never rewritten by this UI.

Compression uses Hermes's manual compression command in its profile runtime
scope, the canonical session turn lease and shared Winglet branching lock.
Retained feature-local operation receipts prevent network retries from running
compression twice; unfinished receipts become unknown after restart, never
automatic execution. A 202 response is acceptance only; poll the operation for
actual outcome. Before/after revisions and measured/estimated tokens identify
real changes, including partial failures. No model/provider changes.

UI plan: refresh and failure recovery; known/unknown context window; accessible
text alongside a proportional estimated composition bar; account limits load
only on explicit request, owner-only and cached per credential/profile route.
Compression confirms provider work/cost and requires idle, fresh preview and a
live connection. Phone/tablet/wide layouts use existing tokens, Sheet and UI.
Native device checks are deferred until07-11integrated as the user requested.

## Verified implementation and evidence

The model route, transcript revision, profile and credential route bind previews
and account cache entries. Fresh owner/chat checks follow asynchronous reads;
provider changes reject stale work. The account cache is bounded on both success
and failure. Retained receipts recover the most recent operation on panel reopen.
Unsupported Hermes versions report capability absence; unknown model windows
stay unknown instead of adopting Hermes's generic fallback context size.

Validation: full lightweight backend 421 passed / 24 skipped before the last
two service regressions; final focused service/routes 10 passed; actual pinned
Hermes adapter tests 5 passed, including real SessionStore/SessionDB reads,
model switch invalidation, account raw-body exclusion and the real short-history
manual-compression no-change path. Full client 329 passed, typecheck and web /
Android JavaScript exports passed. The local full Hermes suite was interrupted
for machine memory pressure and is NOT a passing result; CI runs that suite.

Browser fixture scripts/context_insights_fixture.py binds loopback9309 and uses
disposable SQLite with synthetic tokens/account balances. Real menu navigation,
explicit account load and signed compression confirmation completed, yielding a
retained completed receipt and 8400 -> 3200 context tokens. No real provider call
or session compression was used in this UI check. Screenshots cover390light
overview,320dark receipt and1440light receipt; responsive runs also cover820.
These are browser renders, not Android runtime evidence. Native/device testing
is pending combined integration. Unknown/failure/identity/restart behavior is
covered by the service and model tests, not claimed from screenshots.

Combined mobile recipe: open a disposable QA chat as owner, inspect known or
unknown context/window labels and long model names; rotate/reopen the sheet;
verify offline reads are labelled cached and compression disabled; regain network
and refresh. Run compression only in a disposable short session with explicit
provider authorization, reopen while running, confirm final receipt and draft
preservation; retry same operation ID observes its receipt. Verify members have
no context/account entry and direct HTTP reads are forbidden. Do not change
providers or touch personal conversations just to create test outcomes.

## Independent review corrections

The independent source review identified three issues, now corrected:
compression could continue after an owner was demoted during awaited preflight;
an identical-content canonical session switch could preserve the old revision
while the old session lease was held; and a rejected stale preview could remain
stuck in the client's pending request. Previews now bind the canonical session
ID in addition to transcript and selected model/route metadata. After preflight
and profile entry, the adapter resolves the session again, verifies that it
matches the held lease and reviewed revision, and checks current authority
immediately before calling the real Hermes manual handler. Definite client
rejections clear the pending request; ambiguous network, timeout and server
failures retain the operation ID for receipt recovery. Settlement cannot clear
a newer request belonging to another view generation.

Focused verification after these corrections: context service/routes plus the
actual pinned-Hermes adapter: 22 passed; context client model/retry policy:
6 passed; TypeScript typecheck passed. Seven new real-Hermes regression cases
cover identical transcript content on another canonical session, and session
switch/demotion while the second snapshot, preflight inspection or command
profile entry is held. Each refusal asserts that the manual handler never ran,
the transcript is unchanged and the original lease was released. The real
short-history manual command path remains covered without a provider call.
The new client test covers definite rejection versus ambiguous receipt recovery.
No new provider request, browser render, native build or device test was run for
this narrow correction; earlier UI/build evidence above remains the baseline.

## Integration refresh

Merged reviewed integration commit fc4df428edb01f4177843f9b82f40d4cf14c41df
(features01-08) as fdd49ebaa36eab6c52a8ad930e934cef257b4a57. Shared ChatView,
Hub and adapter wiring merged without conflicts. ContextSheet, voice controls,
SyncStatus, context send gating and the replay/voice routes remain present.

After that merge, focused context/replay/voice backend checks, including the
real pinned-Hermes adapters: 107 passed. Focused context/replay/voice/audio-mode
client checks: 46 passed. TypeScript typecheck passed. The runtime clone used
by private .venv09 is Hermes47676981f55de91231fdeef2f0eec47e7c209e78.
No full suite or exports were repeated locally for this narrow correction;
final-head CI supplies the complete plugin, real-Hermes and app/export checks.

MOBILE VALIDATION PENDING: the combined feature07-11 integration and its final
native build remain the required device-test target. No ADB or physical phone
access occurred. Use the disposable-chat and owner/member recipe above after
that combined build is ready; browser evidence remains browser-only.
