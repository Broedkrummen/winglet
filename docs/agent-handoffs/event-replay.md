# Resumable events, gap recovery and reconnect correctness

Status: **server layer complete and green; client layer half-written. Work paused mid-assignment — see
"Handoff status" before writing code.** Primary specialist role: SRE (architect → implement → review
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

## Handoff status: server complete and green, client half-written

Work stopped deliberately before the client was wired, not because it was finished. Read this
section before touching anything.

| Layer | State |
| --- | --- |
| Protocol/contract (this document) | Complete |
| `plugin/event_replay.py` (journal, epoch, retention, replay, snapshot) | Complete, tested |
| `plugin/hub.py` wiring (publish, hello, resume, `/api/sync/snapshot`) | Complete, tested |
| `plugin/store.py` (shared transaction primitive) | Complete, tested |
| `tests/test_event_replay.py` | 33 tests, all green |
| `app/src/features/event-replay/{protocol,session,merge}.ts` | Written, **not typechecked, not tested, not wired** |
| `app/src/lib/store.ts` integration | **Not started** (only imports, `sync?` field, `resyncNow` signature, cursor maps) |
| `app/tests/eventReplay.test.ts` | **Not written** |
| `SyncStatus` chip / Connection screen row | **Not written** |
| Web/native build, screenshots, fixture script | **Not run** |
| PR | **Not opened** |

### What is proven

Commands, all in the worktree `C:\Users\vikas\Documents\winglet-agents\08-event-replay`:

- `python -m pytest -q` (full plugin suite, interpreter `C:\Users\vikas\Documents\winglet\.venv\Scripts\python.exe`,
  the only one on this machine with `aiohttp`/`pytest-aiohttp`): **329 passed, 17 skipped**. Baseline
  before this work was 296 passed / 17 skipped, so the 33 new tests all pass and nothing regressed.
- `python -m pytest tests/test_event_replay.py -q`: 33 passed.
- `python -m pytest tests/test_hub.py -q`: 51 passed (the existing socket/HTTP contract still holds
  with `seq` added to live frames).

Not run, and why:

- `npx tsc --noEmit` / `npm test` / `expo export`: `app/node_modules` does not exist in this worktree
  (`npm ci` never ran here), so `tsc` fails on every file with `Cannot find module 'expo-router'`,
  `Cannot find module 'react'`, `'--jsx' is not set`. That output says nothing about these changes.
  Installing deps is the first step of resuming.
- Any browser/Playwright check, screenshot, or fixture server.
- Any Android build, emulator or phone run.

### Resuming: the exact remaining work

1. `cd app && npm ci` (must succeed before any TypeScript claim is made).
2. `npx tsc --noEmit` — the three new modules have never been compiled. Expect minor type fixes; they
   import only each other and `lib/types`.
3. Wire `store.ts`. The scaffolding already committed is: `sync?: SyncState` on `ServerState`, a
   `resyncNow(serverId)` action signature, and `replayCursors` / `saveCursor` (debounced 400 ms write
   to `cacheSet('replay:<serverId>')`). Still to do:
   - `Connection` owns a `SyncSession` per socket. In `ws.onmessage`, call
     `if (session.intercept(event)) return;` before `cb.onEvent(event)`, then `session.note(event)`
     after. `onclose` and `open()` must call `session.closed()`.
   - The host's `read()` is `replayCursors.get(id)` primed from `cacheGet('replay:<id>')` during
     `hydrateServer`; `write()` is `replayCursors.set` + `saveCursor`; `apply()` reuses `handleEvent`
     (it takes the same event shape, `seq` included); `view()` patches `sync`; `applySnapshot()` is
     `mergeSnapshot(runtime, snapshot)` patched in, then `cacheSet('chats:<id>')`.
   - `send` is `Connection.send({type:'resume',cursor,epoch})`; `fetch` is
     `api(server, '/api/sync/snapshot')` (already allowed: `h_sync_snapshot` is `"device"` policy).
   - `resyncNow` calls the live session's `retry()`.
4. `SyncStatus` chip in `ChatView.tsx` (next to `ConnectionBanner`, below the title row at 320 px) and a
   "Sync" row on `app/src/app/connection/[serverId].tsx`. States and copy are in the UI plan above;
   nothing renders for `unsupported` or `idle`.
5. `app/tests/eventReplay.test.ts` — `node --test`, transpiling the modules with `typescript` like
   `tests/connection.test.ts` does, with a fake host. The cases worth having: pages applied in order,
   a duplicate seq dropped, a held frame applied after the replay, a refusal taking the snapshot path,
   a failed snapshot leaving `blocked` + Retry, and a snapshot merge that leaves drafts and outbox
   alone.
6. Then the full gate: `npm test`, `npx tsc --noEmit`, `npx expo export --platform web` and
   `--platform android`, and the plugin suite again.

### Decisions a reviewer should not have to rediscover

- **Gaps are normal.** The client advances to the server's `watermark` (or a page's `cursor`), never to
  the last seq it saw, because filtering is per device.
- **Filtering happens at replay time** against the refreshed device row, so a promotion, a demotion or
  an unpair applies to rows already in the journal. Tests pin all three.
- **A journal failure rolls the change back** (it raises inside the publisher's transaction). A
  committed change with no replay row would be invisible to a reconnecting phone, which is worse than
  a refused write.
- **`sync.hint`** is stored under the same seq as an oversize payload; the live frame still carries the
  full event, so only replay degrades to "refetch this chat".
- **Not journaled on purpose:** `typing`, `pet.update`, `system.bots`, `system.job`, `pong`.

### Mobile validation pending

No phone, emulator or live server was used. Codex validates mobile. The recipe, once the client lands:

1. Pair a phone against a development gateway from this branch; confirm `hello` carries
   `event_stream` and that `GET /api/sync/snapshot` answers with the phone's own token.
2. Send a message from a second paired device while the first is force-stopped; reopen it and confirm
   the message appears with no full reload and no duplicate.
3. Kill the app mid-stream (a reply in flight), reopen it: the partial reply must be completed by the
   replay, and the chat must not show the message twice.
4. As an owner, run `python -c` to call `hub.events.rotate_epoch()`, then reopen a phone holding a
   cursor: it must take the snapshot path and end up consistent, with the chip saying it caught up.
5. Demote a member while their phone is offline, promote them back, and confirm replay never leaks
   another member's chat in either direction.

## Validation run in this session

Filled in for the server layer only; see the table above for what is deliberately unrun.
