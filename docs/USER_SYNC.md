# Personal sync: implementation contract

The approved scope is in `superpowers/plans/selected-features-implementation.md`; actual delivery is tracked in the companion progress ledger. Settings and text drafts are connected to the client today. The file transport described here is implemented and tested at the service/library level; Composer and outbox integration is still pending.

## Authority and bytes

The designated home stores immutable bytes and personal draft references. A group member must also be a current owner device on that server. Reads recheck membership, and mutations require verified owner signatures. No other owner is implicitly a group member.

Current media links are bearer capabilities and must not be copied into synced records. A source device reads its own upload and sends bytes to the home. A receiving device downloads through an authenticated private route, verifies SHA-256 and size, then writes a copy using its own independently paired target credentials. The home never fetches a client-supplied URL, receives another server's token or chooses a target upload identity.

`SyncFile` contains exactly `id`, `sha256`, `name`, `mime`, `kind`, `size`, and `slot`. Slots identify attachment instances; content and metadata are immutable. No URI, signing key, token, device preview path or `autoSend` flag belongs in this manifest. Existing automatic voice-note sending must not be replayed on another device.

## Routes

All paths are relative to their own paired server. Bot selection remains inside the signed path through `bot=` where applicable.

| Route | Authority and effect |
| --- | --- |
| `PUT /api/user-sync/{group}/blobs/{sha256}?name=...&voice=0` | Signed owner plus group membership; raw bytes, sniffed type, deterministic immutable descriptor. |
| `GET /api/user-sync/{group}/blobs/{id}` | Current owner/group member, no public signature bypass; attachment/octet-stream, no-store and sandbox headers. |
| `PUT /api/chats/{chat}/staged-files/{source_id}?slot=...&sha256=...&name=...&voice=0` | Signed target owner; verifies bytes and target scope, creates an uploader-owned retained target copy. Same device/chat/source/slot retries return that copy. |
| `POST /api/chats/{chat}/uploads/hold` | Signed owner; `{upload_ids, hold_id}` retains that device's own unclaimed uploads. A different existing hold cannot be silently replaced. |
| `DELETE /api/chats/{chat}/uploads/hold` | Signed owner; `{hold_id}` releases own retention. `{hold_id, source_device}` permits explicit recovery cleanup only after that source pairing was removed. |
| `GET /api/uploads/retained?after=...` | Owner; bounded, bot-scoped recovery listing for files held by removed devices. Export/recover or explicitly discard before releasing. |
| `POST /api/user-sync/{group}/drafts/{record}/submit` | Signed group member; `{expected_revision}` claims one stable submission ID for the exact conflict-free generation. It enqueues no work. |
| `POST .../drafts/{record}/submissions/{submission}/delivered` | Signed group member; target-bound `{server_id, chat_id, message_id, client_id}` records linked-device confirmation and retires submission pins. |
| `POST .../drafts/{record}/submissions/{submission}/release-files` | Explicit unconfirmed source-retention discard; requires `confirmation: release-retained-files-without-confirmed-delivery`. This does not cancel execution, erase a claim or authorize another run. |

The delivered receipt is a linked device's confirmation of its target message, **not** cryptographic remote-server attestation or proof that Hermes completed execution. The home checks its frozen target snapshot and the exact submission client ID. A conflicting receipt cannot replace the first recorded receipt.

## Retention and limits

- Every candidate of a conflicting file list pins its blobs. A resolution releases references only to candidates actually removed.
- A claim additionally pins its frozen files until target-message confirmation or an explicit source-file release decision. Unknown delivery is never treated as expiry authority.
- Unreferenced blobs have a one-day grace period. Live draft or submission references override it. Recovery also removes old unindexed partial bytes left by interrupted commits.
- Default group allowance is 256 MiB, additionally bounded by the configured server upload storage. Per-file, daily-device and total server allowances include the appropriate normal/synced allocations. Immutable retries do not create another allocation.
- Normal and materialized uploads count against the target's allowances. Target copies are pinned while outboxes can need them; message attachment claims atomically remove the hold and keep the message's file.
- Cleanup rechecks claims/holds inside a transaction before deleting. Removing a pairing does not silently delete its retained original; another current owner can inspect and explicitly release it.
- Only the two signed raw-byte routes receive the configured per-file body allowance before signature verification. Ordinary JSON requests keep their existing 2 MiB limit.

Quota, integrity, authorization and transfer failures keep the local/shared source. This is not an unlimited archive or a backup feature.

## Remaining client integration

1. Add local-only cached shared-file metadata scoped by home/group, source upload and slot. Observe completed draft uploads and reply context as part of one composition; exclude automatic voice work.
2. Stage source bytes with `stageSyncFile`, retaining the source before the first read. Persist manifest changes through the existing strict journal. Failed staging must remain visible and recoverable after restart.
3. Materialize with `materializeSyncFile` using the receiving device's own target pairing. Do not hold the global `applying` flag across network awaits. Recheck local intent, active composer, lock and home identity before applying asynchronous results.
4. Track which file/reply revisions the person actually saw. Defer differing incoming compositions while active; a later edit must not acknowledge unseen remote values.
5. Freeze actual sent body (including Guide/Queue prefix), reply, target and blob manifest before claiming. Implement canonical generation creation/advancement so later intentional drafts get new generations, while concurrent attempts of the same generation reuse its ID.
6. Pass the claimed ID as existing `SendOptions.clientId`. Keep runnable outboxes device-local and clear the composer only after strict local outbox acceptance. An unavailable/unverifiable home cannot authorize a new fallback send ID.
7. Carry existing retention IDs through the local outbox; do not release/reacquire a different hold with a cleanup gap. Settle only after a matching target message is confirmed, release unused duplicate copies, and keep ambiguous outcomes explicit. Local discard persistence must be confirmed before file retention is retired.
8. Connect orphan-file recovery and explicit unconfirmed-retention release to reviewable controls. Source-file release must never be presented as Stop or cancellation of already-admitted work.
9. Before automatic background materialization, move bulk file writes outside long SQLite critical sections, retaining final transactional authority/quota/idempotency checks. Validate restart, revocation and concurrent copies at that boundary.

These are remaining steps in feature #1, not a reduction of the approved 18-feature scope.
