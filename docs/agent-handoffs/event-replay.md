# Resumable events, gap recovery and reconnect correctness

Status: implementation in progress. Primary specialist role: SRE (architect → implement → review
phases in this session, no subagents). Branch `codex/major-08-event-replay`, worktree
`C:\Users\vikas\Documents\winglet-agents\08-event-replay`, base `b71d93b`. Capability owner:
`event_replay`. This document owns the global additive event cursor/epoch envelope; feature payloads
stay namespaced to their own features.

## Contract

### Scope and identity

- One stream per `(server, bot)`. Winglet already models each bot as a paired `Server` entry
  (`profile` names the Hermes profile), so a device's cursor is stored per bot entry.
- `epoch`: unpredictable server-wide journal generation (`kv.event_epoch`). A database restore or a
  journal reset changes it, so a cursor from another generation is refused instead of misread.
- `seq`: per-bot, contiguous, monotonic from 1. Assigned and committed with the change, never
  reused. Filtering happens at replay time, so **gaps in the seq a device receives are expected and
  are not errors**; they mean "an event you may not see" or "an event from another member's chat".
- `watermark`: highest seq committed for the bot at the instant the server read the stream head.
  Applying every event through the watermark means the device is caught up to that instant. The
  head is always read **before** the accompanying snapshot (hello or `/api/sync/snapshot`), so an
  event cannot fall into the gap between "snapshot taken" and "live subscription".
- Ordering: journal append and socket broadcast for resumable kinds happen in one publisher critical
  section, so a socket receives resumable events in seq order. A client may therefore advance its
  cursor to the highest seq it applied.

### Delivery guarantee

At-least-once across reconnects, never exactly-once. A live frame and the same event from a replay
can both arrive; clients must treat events as idempotent upserts keyed by `message.id`/`item.id`/
`chat.id` and must ignore a seq that is not greater than their cursor. Deletion events are
authoritative and idempotent. Replay never re-sends a message, never re-runs a control and never
touches the outbox: it only applies state the server already committed.

### Wire protocol (additive; no global protocol bump)

`hello` gains one object, absent from older servers:

```
event_stream: { epoch, watermark, keep_events, keep_seconds }
```

App → server, after hello, only when `features.event_replay` is true and a cursor is stored:

```
{ "type": "resume", "cursor": <int>, "epoch": "<str>" }
```

Server → app:

```
{ "type": "resume", "ok": true, "epoch", "watermark", "events": [...], "has_more": bool, "retention": {...} }
{ "type": "resume", "ok": false, "reason": "epoch"|"cursor"|"gap"|"journal", "epoch", "watermark", "retention" }
```

`has_more` asks for another `resume` from the last applied seq (bounded pages). A refusing reply is
an explicit instruction to take a snapshot, not a transport error. Resumable live frames carry
`seq`; older clients ignore the extra field.

`GET /api/sync/snapshot` (device auth) returns the authoritative scoped state:
`{ server_id, bot, epoch, watermark, chats, inbox, pending, paused, me, deletions, retention }`.
A member only receives their own chats, their own inbox items and the tombstones for those chats.

### What is journaled

`message.new`, `message.update`, `message.delete`, `chat.update`, `chat.delete`, `inbox.new`,
`inbox.update`, `system.paused`, and `sync.hint` (an oversize substitute). Ephemeral or derivable
frames are deliberately not journaled: `typing` (8 s TTL, re-sent while working), `pet.update`,
`system.bots`, `system.job`, `pong`. Their loss on reconnect is harmless because `hello`/refetch
re-establishes them. Typing is also withheld from the journal on purpose: it is presence, not state.

### Retention and bounds

- Newest 1500 events and 3 days per bot, whichever ends first (configurable on `EventStream`).
- A journal row is the event as already broadcast: no media bytes, no tokens, no signing keys, no
  presence, no prompts from other members. Nothing that was not already sent over an authenticated
  socket enters the journal.
- Payloads above 64 KB are journaled as `{type: "sync.hint", chat_id, reason: "oversize"}`; the live
  frame still carries the full payload. A client that replays a hint refetches that chat's newest
  page. This bounds a single row and the replay reply.

### Authorization

Rows are stored once per bot, not per device. `Hub._event_visible` is reused at replay time against
the device record as it is *now*: owners see every chat, members only their own, `chat.delete` rows
only reach the device that owned the chat, `system.*` rows stay owner-only. A revoked token cannot
resume (the socket closes 4401), and a role change changes what the retained journal yields on the
next replay. No caller-supplied bot or device id is trusted; the stream scope is the authenticated
socket's bot and the refreshed device row.

### Not durable upstream (stated, not hidden)

Hermes turn execution is not journaled. Streaming text arrives as ordinary `message.update` events,
so intermediate deltas beyond the retention window can be absent after a long disconnect; the
authoritative transcript remains `GET /api/chats/{id}/messages`, which the snapshot path refetches
for the open chat and which every chat refetches when opened (tombstones included). Winglet makes
no exactly-once promise for upstream task events.

## UI plan

Entry point: nothing new to open. A restrained sync chip appears in the chat header area only while
something is actually happening (`Catching up…` with a count, `Back in sync` briefly), and an
actionable row appears when catching up is impossible (`Couldn't catch up · Retry`). The
Connection screen gets a short "Sync" row with the current state, the reason and a **Resync now**
action for owners and members alike. Cached chats, drafts, attachments, reply context and the
outbox stay readable and editable throughout: no full-screen spinner, no blocked composer.

Information hierarchy: icon + one word + one line of detail at most; the technical reason (epoch,
cursor, retention) lives on the Connection screen, never in the chat. Wide screens keep the chip on
the right of the chat title; 320 px keeps it below the title row so nothing clips. Uses existing
theme tokens, 44 px touch targets, `accessibilityLiveRegion="polite"`, reduced-motion aware
transitions and no colour-only meaning.

States: unsupported (old server: nothing rendered), idle/live (nothing rendered), catching up
(count), snapshot (loading, non-blocking), back in sync (2 s), unrecoverable (`Retry` action),
offline (the existing connection banner owns that message; the sync chip stays quiet).

## Storage

Feature-local tables created idempotently by `plugin/event_replay.py` (`ensure_schema`). No global
migration version is allocated and no existing table is rewritten:

- `event_streams(bot TEXT PRIMARY KEY, next_seq INTEGER, created_at REAL)`
- `event_log(id INTEGER PRIMARY KEY AUTOINCREMENT, bot, seq, kind, chat_id, created_at, payload,
  UNIQUE(bot, seq))` with `event_log_bot_seq` and `event_log_created` indexes.

Rollback: dropping both tables removes the feature's data; existing chats, messages, inbox and
devices are untouched. Clients with a stale cursor then get `ok:false` and take a snapshot.

## Shared files touched

- `plugin/hub.py`: import + `EventStream` instance, publisher for resumable kinds, hello
  `event_stream`, `resume` frame handler, `GET /api/sync/snapshot` route and policy entry, one
  capability key, atomic append next to the existing store writes.
- `app/src/lib/store.ts`: socket hook + cursor persistence + snapshot application (kept small; all
  decision logic lives in `app/src/features/event-replay/`).
- `app/src/lib/types.ts`: `SyncState` type only.
- `app/src/components/ChatView.tsx` and `app/src/app/connection/[serverId].tsx`: render the chip /
  sync row.
- Everything else is feature-local: `app/src/features/event-replay/`, `plugin/event_replay.py`,
  `tests/test_event_replay.py`, `app/tests/eventReplay.test.ts`.

Not touched: `Hermes` sources, other agents' modules, generated `plugin/web` assets, the CI pin.

## Reference comparison

| Reference (Herald 95ca999) | Winglet result | Evidence / difference |
| --- | --- | --- |
| `EventReplay.kt`: `session.events.since` ring, `latest_seq`, `truncated`, per-run `epoch`, reload on any hole | `plugin/event_replay.py` replay with per-bot seq, epoch, `ok:false` reasons and bounded pages | Same refusals (hole, truncation, restart, wrong session) implemented as an explicit protocol reply plus tests |
| `event_replay.py` ring of ~512 per runtime session | Durable SQLite journal, 1500 events / 3 days per bot | Winglet restarts far more often than a dashboard session; a ring would lose a phone's overnight disconnect |
| Client parses reply, drops already-applied seq, falls back to transcript refetch | `app/src/features/event-replay/protocol.ts` validates and orders; snapshot fallback refetches scoped state and the open chat | Reference trusts the reply; Winglet also proves the cursor/watermark relationship before advancing |
| "Reconnecting…/Waiting for network…" chat banner | Sync chip + Connection screen row, cached chats stay usable | No full-screen spinner in either; Winglet adds an explicit blocked state with Retry |
| Per-runtime-session event log | Per `(server, bot)` log, filtered per device at replay time | Necessary because Winglet's authority is the plugin, and members share a server |

Reuse provenance: the replay *semantics* (seq monotonicity, epoch on restart, refuse on hole or
truncation, skip already-applied seqs, fall back to the transcript) are adapted from Herald's
MIT-licensed `EventReplay.kt` / `EventReplayTest.kt`. The implementation is a Python/TypeScript
adaptation for Winglet's plugin protocol; no Kotlin is copied verbatim. The required notice, the
exact upstream commit and the full MIT licence text are in
`third_party/notices/herald-event-replay.md`.

## Validation (to be completed)

Filled in after the checks run.
