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
