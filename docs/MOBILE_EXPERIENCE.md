# Mobile experience review — 23 October 2026

This review covers conversation controls, delivery and recovery, offline storage, model selection,
navigation, agent management and the larger capabilities a complete mobile client needs. The current
changes keep Winglet's Expo app, plugin protocol, pets, themes and existing server ownership model.
They are implemented independently in Winglet's existing components.

## Implemented in this pass

| Area | Result |
| --- | --- |
| Chat discovery | All, Running and Needs you filters in the sidebar and Chats, with counts and empty states. Active requests remain findable in archived chats. |
| Drafts | Text, completed attachments and reply context flush when the app backgrounds. Draft previews and search work across chats and bots. |
| Current work | Activity stays above the composer; details use the actual current turn. Pending requests open the relevant Inbox item. |
| Stop | A guarded live control remains available while composing a follow-up. It never joins the offline outbox. |
| Model access | Starred models and eight recent successful choices retain exact provider/model IDs. Starring does not select a model. Unavailable providers stay out of shortcuts. |
| Delivery recovery | Failed bubbles show the refusal and expose Retry, Edit and Discard. Retry preserves delivery identity and attachments. Editing cannot overwrite another draft. |
| Acknowledgement races | A failed HTTP response cannot fail or pause a send already confirmed over the socket. A stale retry cannot resend an acknowledged message. |
| Inbox races | A late list response preserves live arrivals and answers received after the request began; overlapping reads apply only the newest result. |
| Native privacy | SQLite cache values use AES-256-GCM with a random per-device key in SecureStore and a fresh nonce for every write. Record identity is authenticated. Existing JSON values migrate in place. |
| Cache ordering | Migration, writes and removal execute in order. Interrupted migration can resume without replacing a newer draft. An unavailable keychain never causes a plaintext save. |
| Bot isolation | Removed bots lose their composer state and cache; late responses cannot recreate their runtime. Chat exports use the selected bot's route. |
| Small screens | Search inputs shrink inside a narrow drawer instead of pushing content sideways. |
| Development updates | Development builds do not offer production APKs as in-place upgrades. |

Native encryption covers cached values, including unsent messages. Media files, exported Markdown,
OS backups and the browser's IndexedDB are outside that protection. If a restored encrypted database
has lost its keychain key, unreadable entries are preserved rather than replaced with new empty data.

## Existing coverage and remaining work

These are separate increments, each requiring its own implementation and validation. A control should
appear only when its real operation is available on the connected server.

| Capability | Current Winglet coverage | Next increment |
| --- | --- | --- |
| Streaming conversations | Markdown, highlighted code, tables, media, activity folding and older history pages | Add structured reasoning/tool events when Hermes exposes them through the plugin. |
| Conversation organization | Main and side chats, bot grouping, pins and device-local archives | Persist projects/folders on the server, including membership and ordering shared across devices. |
| Branch, edit and regenerate | Reply, recover failed text for editing, copy and resend | Add atomic transcript branching/rewind, stable message-row identity and busy-session refusal before exposing destructive edit/regenerate actions. |
| Session recovery | Socket reconnect, heartbeat, history reconciliation, durable outbox and idempotent delivery | Add resumable event cursors/epochs with explicit full-history fallback when replay has gaps. |
| Agent execution | Progress messages, task strip, goals, approvals and questions | Expose structured subagent state, nested activity, cancellation and final outcomes. |
| Background processes | Tool progress is readable in the conversation | Add scoped process listing/output/stop operations to the plugin; verify process ownership and signed stop requests. |
| Checkpoints | No checkpoint interface | Add a capability-gated list/diff/restore contract with explicit scope and restore confirmation. |
| Usage and context | Token/cost charts and chat model controls | Add current-session context breakdown, compression outcome and provider-account limits when supported. |
| Scheduling | Create, edit, run, pause and delete routines; results in Updates | Add durable per-routine run history and links from a run to its output and session. |
| Bots and rooms | Multiple Hermes profiles, bot creation and independent chats | Add multi-bot rooms with membership, routing, mentions and per-member permissions. |
| Voice | Hold-to-record notes, cancel gestures and server transcription | Build an explicit live audio session protocol, interruption, transcript synchronization and reconnect behavior. Keep provider choice visible. |
| Device integrations | Android share target, camera/media uploads, notifications and app lock | Add opt-in phone tools only with per-tool permissions, audit entries and revocation. |
| Wearables and assistant role | No watch client or system assistant role | Treat these as native platform projects with separate pairing, permission and battery testing. |
| Configuration | Providers, persona, memory, skills, tools, MCP, logs, server health and restart/update | Add further settings through typed capability checks and preserve per-bot form isolation. |
| Notifications | Web Push, Android ntfy, per-chat mute/quiet hours and foreground deduplication | Validate real background delivery across vendor battery policies and design encrypted notification envelopes separately from offline cache encryption. |

The dashboard JSON-RPC session protocol and Winglet's messaging-plugin protocol have different
ownership, message identity and lifecycle rules. Importing a dashboard control alone would not give
Winglet the corresponding operation. Backend additions need matching capability flags, permission
checks, cancellation/reconnect behavior and meaningful integration tests.

## Validation

- App suite: **267 passed**, including delivery races, stale Inbox reads, scoped exports, model shortcuts,
  draft flushing, cache migration, tampering, missing keys and ordered removal.
- TypeScript typecheck passed.
- Production web export and Android export with Hermes bytecode passed.
- The bundled web app references 28 assets, with none missing.
- Plugin suite: **296 passed, 17 skipped**; skipped cases need optional Hermes/platform integrations.
- Disposable browser preview: model shortcuts, active-request navigation, running filters, Stop with an
  existing draft, draft reload and draft search. Synthetic services do not call a model provider.
  Narrow drawer search and desktop layout were checked with no document-level horizontal overflow
  or JavaScript exceptions in the tested flows.
- Physical Android: connected through USB; current code ran in the existing development client.
  A separate QA conversation received `WINGLET_OK` through the configured DeepSeek v4.1 Flash model.
  Draft text survived backgrounding and process termination before and after native encryption;
  the model picker showed the current DeepSeek entry in Starred without changing the model.
  A live counting request was stopped from the task strip; Hermes acknowledged the stop and the
  working indicator cleared.

The Android export checks JavaScript and Hermes bytecode; it is not a newly signed APK. Physical
iPhone behavior, real push delivery, prolonged offline operation and the remaining backend features
still need their own validation. The live checks used a separate QA conversation and did not update
the remote Hermes installation or change its provider configuration.
