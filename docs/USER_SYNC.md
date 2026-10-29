# Personal sync: implementation contract

The approved scope is in `superpowers/plans/selected-features-implementation.md`; actual delivery is tracked in the companion progress ledger. Settings, text/file drafts and reply context are connected to the client. Explicit Composer Send claims the frozen draft before durable local outbox acceptance. Browser/device verification and recovery controls remain; feature #1 is incomplete.

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
| `DELETE /api/chats/{chat}/uploads/hold` | Signed owner; `{hold_id, upload_id, expected_version}` releases one reviewed own hold using compare-and-set. Legacy own release without a version is refused. `{hold_id, source_device}` permits recovery cleanup only after that source pairing was removed. |
| `GET /api/uploads/retained?after=...` | Owner; bounded, bot-scoped recovery listing for files held by removed devices. Export/recover or explicitly discard before releasing. |
| `GET /api/uploads/retained?scope=current&after=...` | Owner; at most 100 own pairing uploads, hold versions and a cursor. Echoes `scope: current`; older responses without that contract require a server update. |
| `POST /api/user-sync/{group}/drafts/{record}/submit` | Signed group member; `{expected_revision}` claims one stable submission ID for the exact conflict-free generation. It enqueues no work. |
| `GET /api/user-sync/{group}/submissions?after=...` | Current owner/group member; at most 20 frozen submission summaries, bounded text preview and file descriptors, plus linked-device confirmation/release status. No executable outbox or credentials. |
| `POST .../drafts/{record}/submissions/{submission}/delivered` | Signed group member; target-bound `{server_id, chat_id, message_id, client_id}` records linked-device confirmation and retires submission pins. |
| `POST .../drafts/{record}/submissions/{submission}/release-files` | Explicit unconfirmed source-retention discard; requires `confirmation: release-retained-files-without-confirmed-delivery`. This does not cancel execution, erase a claim or authorize another run. |

The delivered receipt is a linked device's confirmation of its target message, **not** cryptographic remote-server attestation or proof that Hermes completed execution. The home checks its frozen target snapshot and the exact submission client ID. A conflicting receipt cannot replace the first recorded receipt.

Settings → Sync → Shared submission recovery lists submissions from all explicitly linked devices, including those no longer available locally. Private Download reads authenticated home bytes and verifies their size and digest before exporting. Browser export uses a local object URL; native export uses a unique cache directory cleaned after sharing or failure. Explicit Release shared source retention retires only the submission's home pins. It neither discards local outboxes/holds nor cancels execution, erases the stable ID or authorizes a new send. Live draft references can continue to pin the same blob. Files already reclaimed after release can no longer be downloaded from that source.

## Retention and limits

- Every candidate of a conflicting file list pins its blobs. A resolution releases references only to candidates actually removed.
- A claim additionally pins its frozen files until target-message confirmation or an explicit source-file release decision. Unknown delivery is never treated as expiry authority.
- Unreferenced blobs have a one-day grace period. Live draft or submission references override it. Recovery also removes old unindexed partial bytes left by interrupted commits.
- Default group allowance is 256 MiB, additionally bounded by the configured server upload storage. Per-file, daily-device and total server allowances include the appropriate normal/synced allocations. Immutable retries do not create another allocation.
- Normal and materialized uploads count against the target's allowances. Target copies are pinned while outboxes can need them; message attachment claims atomically remove the hold and keep the message's file.
- Cleanup rechecks claims/holds inside a transaction before deleting. Removing a pairing does not silently delete its retained original; another current owner can inspect and explicitly release it.
- Only the two signed raw-byte routes receive the configured per-file body allowance before signature verification. Ordinary JSON requests keep their existing 2 MiB limit.

Quota, integrity, authorization and transfer failures keep the local/shared source. This is not an unlimited archive or a backup feature.

## Composer integration

Ready manual attachments are staged under a source retention hold. The local strict journal stores home/group-scoped metadata; records contain only immutable manifests. Receiving devices materialize through their own target pairing. Automatic voice sends are excluded. Different incoming text, files or reply context wait while the composer is active; asynchronous completion rechecks local edits, membership context, lock and both endpoint identities before applying. Observed revisions advance only for applied or proven own values.

Explicit Send freezes text, actual steering/queue prefix, reply, target identity and complete manifest. The home supplies a canonical generation on first write and advances it after an already-claimed composition meaningfully changes. An unfinished file preparation or unresolved conflict cannot be claimed. The client validates the exact returned revision/ID and persists its claim before passing that ID and retained target copies into the existing outbox. An unavailable or unverifiable home blocks this shared send; it does not invent another ID.

Typing during preparation is journaled separately until the frozen claim binds, then replayed as subsequent composition changes. On restart, disagreement between the ordinary draft cache and sync journal is submitted as an unobserved recovery candidate with immutable zero field bases, preserving both versions for explicit resolution. Runnable outboxes stay local. A confirmed target user message matching the shared client ID permits settlement and duplicate/source hold release; a merely local pending message does not.

Bulk byte writes happen before SQLite transactions. Final admission rechecks authorization, quota and idempotency; atomic rename and metadata occur under the transaction. Failed commits roll back and remove newly created target copies. Retries repair an existing verified copy without changing its identity.

## Remaining integration and verification

1. Current-device retained-file review, Download and versioned Release are connected. Release checks both live and strict saved draft/outbox references and temporarily guards new local outbox admission. Storage failure preserves retention. Every acquisition renews its version; stale release is refused. Migrated holds receive stable initial versions without losing retention. Final server mutation rechecks chat visibility and bot scope in its transaction. These controls do not cancel execution or immediately delete bytes; the ordinary unclaimed-upload grace period still applies.
2. Complete full restart/file recovery, including stale source uploads already claimed by a previous message and all attachment/reply cache disagreements. Verify claim settlement and unused-copy release across real reconnects.
3. Extend browser verification to all restart/recovery and active-edit cases. Current checks cover settings in light/dark desktop/phone layouts, removed-device Download/Release, receiving a manual attachment, reopening after persistence, and concurrent Send producing one actual target message. Loading/status copy reflects file/reply sync. Physical Android/iPhone checks remain separate from exports.
4. Connect read/resume state and the remaining portable libraries in the approved plan.

These are remaining steps in feature #1, not a reduction of the approved 18-feature scope.

Confirmed-delivery cleanup uses the same versioned, reference-aware path. It separately records home settlement and local retirement, retrying protected copies after draft/outbox persistence catches up without resending the receipt. Each pass examines at most 20 pages (2,000 retained uploads); remaining or refreshed holds stay protected and available for explicit review. Unknown network/storage outcomes never authorize cancellation or a new submission ID.
