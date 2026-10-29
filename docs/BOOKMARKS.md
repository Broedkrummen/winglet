# Saved answers and bookmarks

Feature #4 is in progress under issue #15. Source APIs, typed sync records, Save answer, the library and note/tag editing are connected. Signed-route browser checks cover desktop/phone sync, explicit concurrent choices, older-source pagination and revocation. Physical-device and wider interruption checks remain.

## Storage and access

The sync home's `bookmark` records accept only source identity (`server_id`, installation `server_fingerprint`, `chat_id`, `message_id`), an optional source-local snapshot reference (`id`, `sha256`), title, note, tags and a removal flag. Source message contents, cached previews, credentials and URLs are not accepted as extra fields. Concurrent note changes use the same field conflict/explicit choice protocol as the rest of personal sync.

Snapshots stay on the source server, behind the conversation's current access and bot scope. Each successful source/snapshot response sets `Cache-Control: no-store`. The client must revalidate the matching paired installation before displaying source text and clear transient content on lock, blur, endpoint change or a failed access check. It must not put source snippets into synced fields or persistent caches.

## Source API

- `GET /api/chats/{chat_id}/bookmark-source/{message_id}` returns an available final user/bot message and SHA-256 of its exact UTF-8 text, or a deleted state. Hidden, unfinished, inaccessible and wrong-profile sources are unavailable.
- Signed `PUT /api/chats/{chat_id}/bookmark-snapshots/{bookmark_id}` takes exactly `message_id` and `expected_sha256`. A changed source returns 409 before writing. A matching retry returns the original snapshot; an existing ID with different source/hash returns 409.
- `GET` on the snapshot path rechecks current source access and returns the immutable snapshot with `available`, `edited` or `deleted` source state. Deleting a message preserves its explicitly saved snapshot while the conversation remains accessible. A source hidden after saving is unavailable.
- Signed `DELETE` on the snapshot path releases that source-local snapshot. It neither deletes the source message nor changes any running task.

Snapshots contain at most 8,192 Unicode characters (at most 32 KiB UTF-8) and explicitly report truncation. The installation stores at most 10,000 snapshots. Deleting a conversation atomically removes its snapshots; recreating the same conversation ID cannot expose the old contents. No route enumerates another device's private saved records.

## App workflow

Save answer is in Message options. Settings and Commands open a searchable library of personal titles, notes and tags. Editors retain their viewed field bases across background refresh, so competing edits become explicit choices in Sync settings. Incoming state does not replace form text. Offline edits use the canonical durable journal.

The bookmark reference is journaled before any source snapshot is created. An unconfirmed snapshot remains discoverable through that reference, with explicit Retry snapshot creation. Retries use the original hash and ID; an edited source cannot silently become the saved version. Show removed bookmarks permits restoration and separate explicit snapshot release. Releasing text does not delete its original message or run a task.

Original text is transient, scoped to the matching paired installation and checked again on opening or reloading. While visible, checks serialize every 15 seconds; failed access clears the text rather than using a persistent fallback. Lock, background, blur and endpoint changes hide it immediately. Remote revocation is learned on the next check; this is not a claim of instantaneous cross-server invalidation. Open original uses the existing focus/pagination path.

Remaining checks include physical Android/iPhone sheet/sharing behavior, interruption and storage-failure combinations beyond the covered journal and failed-request cases, and broader native accessibility verification. No paid Hermes execution is needed to save or open a bookmark.
