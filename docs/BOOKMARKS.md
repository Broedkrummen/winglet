# Saved answers and bookmarks

Feature #4 is in progress under issue #15. This checkpoint adds source APIs and typed sync records; the Save action, library, note/tag editor and cross-device UI verification remain to be implemented.

## Storage and access

The sync home's `bookmark` records accept only source identity (`server_id`, installation `server_fingerprint`, `chat_id`, `message_id`), an optional source-local snapshot reference (`id`, `sha256`), title, note, tags and a removal flag. Source message contents, cached previews, credentials and URLs are not accepted as extra fields. Concurrent note changes use the same field conflict/explicit choice protocol as the rest of personal sync.

Snapshots stay on the source server, behind the conversation's current access and bot scope. Each successful source/snapshot response sets `Cache-Control: no-store`. The client must revalidate the matching paired installation before displaying source text and clear transient content on lock, blur, endpoint change or a failed access check. It must not put source snippets into synced fields or persistent caches.

## Source API

- `GET /api/chats/{chat_id}/bookmark-source/{message_id}` returns an available final user/bot message and SHA-256 of its exact UTF-8 text, or a deleted state. Hidden, unfinished, inaccessible and wrong-profile sources are unavailable.
- Signed `PUT /api/chats/{chat_id}/bookmark-snapshots/{bookmark_id}` takes exactly `message_id` and `expected_sha256`. A changed source returns 409 before writing. A matching retry returns the original snapshot; an existing ID with different source/hash returns 409.
- `GET` on the snapshot path rechecks current source access and returns the immutable snapshot with `available`, `edited` or `deleted` source state. Deleting a message preserves its explicitly saved snapshot while the conversation remains accessible. A source hidden after saving is unavailable.
- Signed `DELETE` on the snapshot path releases that source-local snapshot. It neither deletes the source message nor changes any running task.

Snapshots contain at most 8,192 Unicode characters (at most 32 KiB UTF-8) and explicitly report truncation. The installation stores at most 10,000 snapshots. Deleting a conversation atomically removes its snapshots; recreating the same conversation ID cannot expose the old contents. No route enumerates another device's private saved records.

## Remaining UI integration

Use the canonical personal-sync journal for create/edit/remove and explicit concurrent choices. Save from Message options, optionally preview and create a bounded snapshot, then expose a searchable saved library and note/tag editing. Show source unavailable/changed/deleted states without falling back to a cached private snippet. Open a source through the existing focus/pagination path. Add discovery to Commands when the library exists. Verify save-on-phone/open-on-desktop, conflicting notes, source deletion, ACL revocation and offline recovery before calling the feature complete.
