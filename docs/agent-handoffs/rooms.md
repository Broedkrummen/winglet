# Rooms: contract and implementation status

Base: reviewed integration 4ef6c6e390ba1af06aa90ccb2322f92f8351a12b.
Primary architecture role: Software Architect, following the Agency Agents
architecture -> implementation -> distinct review workflow.

## UI plan

Rooms opens from navigation for the paired gateway. A room list shows title,
participants, unread state and active/archived state. The room screen has one
shared transcript with clear human/bot identities, a compact participant panel,
mention completion, an addressed composer, explicit running/waiting/error state
and a signed room Stop. Manage title, bot roster, archive and member read grants
in one bounded sheet. Narrow phones stack transcript and composer; wide screens
cap readable line length. Reuse Winglet theme, Sheet, pet/avatar and UI tokens.
Offline/unsupported/permission-revoked states disable controls without discarding
typed text. Room controls/sends never enter the private-chat offline outbox.

## Backend contract

Feature-local plugin/rooms*.py and app/src/features/rooms/. Minimal wiring in
hub.py, adapter.py and AppNavigation. Capabilities rooms/room_mentions only when
a real local worker exists. rooms_member_write=false: pinned Hermes hosted-room
turns do not propagate Winglet's member identity/tool limits. Members require an
explicit room read grant; they cannot submit/approve/retry or Stop as an owner.
This limitation must be visible, never an implicit privilege escalation.

Use the real pinned Hermes HostedRoomService/HostedRoomRuntime, own feature DB
and worker lifecycle, hidden bot_room sessions and the canonical profile turn
locks. Never adopt a private session merely because its title matches Group:.
Local served bots only; no peer links/remote gateway routes. Owner-signed writes
preserve actor/audit identity, expected revisions and durable retry receipts.
Only explicit mentions/selected recipients start turns; unaddressed text must
not trigger the upstream default broadcast. Hermes bounds rounds/messages and
uses durable task leases, task-specific cancellation and exact approval IDs.

GET /api/rooms, /api/rooms/{id}, /api/rooms/{id}/log are scoped reads.
POST /api/rooms creates; signed POST /api/rooms/{id}/{action} handles update,
send, seen, stop, retry and approve (seen is paired/signed; all other writes
owner-signed). Log cursors are room-local and epoch-local, not a global replay
protocol. No arbitrary RPC passthrough, profiles, task or session IDs accepted
without verifying room membership and current pending action coordinates.

Feature-specific additive metadata in rooms-meta.sqlite; real upstream room
state in rooms-runtime.sqlite beside it. Immutable upstream rosters change only
after authoritative Stop acknowledgement: allocate a successor epoch, preserve
old transcript and show the membership boundary. Avoid rewriting upstream
schema or forking the scheduler. Removing the plugin preserves both DBs.

## Reference and reuse

Read Herald snapshot95ca999 Rooms.kt, RoomsApi.kt, RoomMentions.kt, RoomTurns.kt
and RoomScreen.kt; actual Hermes pin4767698 hosted room service/driver/RPC and
discussion policy. The reference delegates rooms to groups.* and derives status
from typed events. Winglet uses its authenticated HTTP/signature protocol and
explicit gateway room ACL. No reference code copied or translated so far.

## Status

Architecture recorded; implementation and verification in progress. Member
execution is a genuine pinned-upstream gap. Do not claim all assignment06
acceptance criteria or mobile/provider stability as complete.
