# Conversation branching, edit-and-resend and regeneration — Codex handoff

Branch: `codex/major-02-branching`
Worktree: `C:\Users\vikas\Documents\winglet-agents\02-branching`
Base: `b71d93b459e1645e34cd47c80a392b146dca0e04` (policy revision 3)
Capability keys: `chat_branching`, `message_editing`, `regeneration`
Owned namespace: `branch.*`, `transcript.*`
Feature code: `plugin/branching.py`, `plugin/branching_routes.py`,
`app/src/features/branching/`
Reference: Herald snapshot `95ca999fa48c1c9de232fe499a174900f0d25272`
(pinned Hermes for CI: `47676981f55de91231fdeef2f0eec47e7c209e78`)

**Status: implemented, automated/build checks passed, native build not run, mobile validation
deferred to Codex.**

## What the feature does

The conversation is the source of truth, not the phone's rendered list. Editing an accepted
user message never rewrites the original chat. It creates a new chat (branch) whose Hermes
session is seeded with the parent session's real transcript rows **before** the edited turn,
copies the visible conversation and its attachments, then sends the edited text from that
context. The original chat and its later messages remain untouched.

Regenerating a reply:
- default: create a branch seeded before the prompt that produced the reply, then resend that
  prompt in the branch. The original reply stays readable.
- optional, owner-confirmed and only for the latest settled exchange in an idle chat:
  a true in-place rewind through Hermes `SessionStore.rewind_session` (soft-delete, CAS,
  active-turn-lease refusal), then a new turn from the surviving prompt. This is never
  implemented by deleting UI rows alone.

A branch chat carries a snapshot link (`branch.parent_chat_id`, parent title, from-message,
mode, source revision). One quiet ancestor strip under the header opens the original; a parent
with branches shows a count and a small branch list. No ancestry chrome is added to every
bubble.

## Contract

### Capabilities (additive; false when unavailable)

`features.chat_branching`, `features.message_editing`, `features.regeneration` are true only
when the plugin can reach the pinned Hermes session-store primitives. The bridge verifies
`SessionStore.load_transcript`, `rewind_session`, `switch_session`,
`get_or_create_session`, `peek_session_id`, `get_model_override`, `set_model_override`, and
`SessionDB.create_session`, `append_messages_batch`, `set_session_title`, `get_session`,
`end_session`. If anything is missing the capabilities are false and the app keeps its existing
edit/retry fallbacks. No endpoint is invented and no success is synthesized.

### Routes (device bearer, chat-scope checked)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/branching/chats/{chat_id}` | revision, busy, branch/ancestry, per-message gates, current model |
| POST | `/api/branching/chats/{chat_id}/branch` | create a branch (`mode=edit\|branch\|regenerate`) and optionally start the edited/regenerated turn |
| POST | `/api/branching/chats/{chat_id}/regenerate` | explicit in-place regeneration of the latest settled reply |

POST fields:
- `op_id` — client-generated, 16–96 chars `[A-Za-z0-9._:-]`, idempotency key.
- `message_id` — the Winglet `message.id` boundary.
- `expected_revision` — the `revision` from the state read.
- `mode` — `edit` (branch + send edited `text`), `branch` (copy through the message/exchange,
  no send), `regenerate` (branch + resend the original prompt).
- `text` — required for `edit`, ignored otherwise.
- `title` — optional branch title (trimmed, 80 chars max).
- `in_place` — only the dedicated `/regenerate` route uses this; refused unless the latest
  settled exchange + idle.

Responses:
- 200 `{chat, branch, mode, copies, later, revision, model, message?, warning?, replayed?}`
- 400 invalid field; 404 chat/bot/scope; 409 `{code: "busy"|"stale"|"unsupported"|"op_conflict"|"in_progress"|"not_latest", error}`.
- A completed duplicate `op_id` returns the stored response with `replayed: true`; a running
  duplicate returns 409 `in_progress`; a failed operation may be retried with the same id.
  An operation id is bound to its chat, kind and device.

Members use the same ownership rule as messages (`hub.can_see`): owners see all chats, members
only their own. A chat from another bot scope returns 404. The server derives authority from
the paired scope; no caller-supplied device or bot id is trusted.

### Transcript revision

`revision` is a stable `b-<sha256-prefix>` over the active Winglet message rows (id, role,
status, updated_at, text hash, attachment identities) **and** the Hermes active transcript
(role, platform `message_id`, content hash, tool-call id). It changes when either side changes,
including a streamed edit.

Operations compare the caller's revision with a fresh digest before writing and again after
copying; a mismatch returns 409 `stale` and leaves no branch behind. In-place regeneration
verifies the expected prompt row is still the newest user row **before** Hermes soft-deletes
anything, then relies on `rewind_session`'s active-id CAS and turn-lease refusal. The revision
is exposed to replay/annotation agents as metadata, not as a competing global cursor.

### Message ↔ Hermes row mapping

- User Winglet `message.id` is passed to Hermes as `source.message_id`/`event.message_id`; the
  gateway persists it as `messages.platform_message_id`. Branch mapping uses that exact id.
- Assistant rows have no platform id. A bot boundary is mapped only when it is the last
  non-activity bot message in its exchange and the exchange contains a final assistant row.
- Excluded from boundaries: `meta.hidden` (slash controls), `meta.status_key` / activity
  progress, pickers, inbox cards, routine results, pending/queued/failed/streaming rows, and
  empty rows.
- Tool rows stay in the Hermes prefix (model context) but are never treated as boundaries.
- Branch-from-a-reply stops at the next user turn; it never copies a later prompt without its
  answer.

### Attachments and replies

Branch copies clone the upload row and file so the branch owns its own media; the original
upload cannot be claimed into the branch through the normal upload endpoint. Prefix copies are
claimed by their copied message (the upload janitor must not delete them). Copied `reply_to` ids
are remapped to copied message ids. In-place regeneration is refused when the prompt has
attachments because Hermes' rewind cannot replay media.

### Model and tool authorization

The branch session carries the parent chat's explicit model override (`SessionStore`
per-key override) and the parent's system prompt, and is created with
`model_config={"_branched_from": parent_session_id}` plus `parent_session_id`. Provider/model
choices stay explicit; the branch sheet shows the current model. Tool authorization remains
per-device/per-role: the branch chat inherits the parent chat's `owner_device`, so members'
tool limits and chat ownership are unchanged. Goals, loops and heartbeats are session control
state and are intentionally **not** copied into a branch.

### Concurrency and failure behavior

- One server-held operation per chat (`asyncio` keyed lock + `branch_operations` row).
- Branch creation refuses a busy parent (typing or streaming rows) and re-checks revision
  before touching Hermes.
- In-place regeneration checks idle, revision, latest exchange, then uses Hermes
  `rewind_session` (CAS + turn-lease refusal). If the new turn cannot be started after the
  rewind, the route reports failure and posts a system line; it does not claim success.
- A cancelled client request cleans up a half-made Winglet chat/upload synchronously; a
  half-made Hermes child session is ended best-effort.
- Destructive operations are direct HTTP calls, never the offline outbox and never replayed
  after reconnect.

### Events

- `branch.created` `{chat_id, chat, branch, parent_chat_id, copies, later}` — namespaced,
  ignorable by older clients.
- `transcript.revised` `{chat_id, revision, reason}` — after an in-place rewind.
- Normal `chat.update` is also emitted for old clients on branch creation.
- No global protocol bump; older clients ignore the namespaced events and the optional
  `Chat.branch` field.

### Storage (additive, feature-specific)

`plugin/store.py` creates:
- `chat_branches(chat_id PK, parent_chat_id, parent_title, from_message_id, mode, created_at,
  created_by, source_revision)` with an index on `parent_chat_id`.
- `branch_operations(op_id PK, chat_id, kind, device_id, state, result, error, created_at,
  updated_at)` with an index on `chat_id`.

No global migration version is allocated. The code is `CREATE TABLE IF NOT EXISTS`-safe on
upgrade. Rollback: older code ignores the tables; they can be dropped without touching
`chats`/`messages`. Deleting a chat removes its own branch row but leaves branches made from it
(their parent title is snapshotted).

## UI implementation

Entry points:
1. Long-press / hover More on a message →
   - user text: `Edit in a new branch`
   - settled assistant: `Regenerate reply`
   - any settled message: `Branch from here` / `Branch from this reply`
2. Branch chats show one compact ancestor strip under the header (`Branched from <title>`);
   tap opens the original. A parent with branches shows a count and a small list.
3. A disabled action keeps its explanation visible (offline, busy, stale, not in transcript)
   instead of silently disappearing.

Edit sheet:
- destination card (`New chat`), editable branch title, editable message text, kept-attachment
  note, “N earlier messages copied”, “your original and N later messages stay”, model/tools note,
  Cancel and `Branch and send`.
- after success the branch chat opens; the original is unchanged.

Regenerate sheet:
- primary non-destructive `Branch and regenerate`.
- explicit `Replace this reply` chip only when the latest settled reply has no attachments;
  choosing it reveals a second confirmation with `Keep original` / `Replace reply`.
- an older reply or one with attachments shows the in-place chip disabled with the reason.

States: loading, offline, unsupported/old server (fallback actions), busy, stale with Refresh,
inline error with retry (same op id), success. 44–48px rows, labels/focus, web keyboard,
reduced-motion-aware, safe-area and keyboard-aware bottom sheet. At 320px the sheet scrolls
vertically; no document-level horizontal overflow.

## Reference comparison / reuse provenance

| Reference behavior/source | Winglet result | Matching edge cases/tests | Intentional difference | Gap |
| --- | --- | --- | --- | --- |
| Herald `core/chat/Rewind.kt`: regenerate targets the prompt before an assistant reply; edit requires a rewindable prompt | Same rule, anchored on Winglet id → Hermes `platform_message_id`; branch defaults for edits | mapping, hidden/activity exclusion, partial reply, latest-only in-place | Winglet defaults to a new branch; in-place is opt-in | goals/loop state not copied |
| Herald `core/chat/SessionControl.kt` / `ChatActions.kt`: rewind and chat actions | Winglet More sheet, destination title, revision and copy preview | menu gating, idle/busy, stale revision, duplicate op | winglet-specific ancestry strip | no Herald source copied |
| Winglet existing `/retry` and “Edit and send again” | Replaced by real branch/regenerate when the capability is true; kept as fallback on old servers | old-server feature flag, fallback path | real Hermes rewind instead of only UI rows | none |

No Herald source files were copied or ported in this PR, so no third-party notice is required
for this change. Herald is named here as the behavior reference. If a later patch copies code,
add `third_party/notices/herald-branching.md` with the MIT text and exact commit/files.

## Shared files touched (minimal)

- `plugin/store.py` — two feature-named tables + branch/import/operation methods.
- `plugin/hub.py` — `branching` slot, three capability flags, route registration, three
  `device` policy entries, `app["hub"]`.
- `plugin/adapter.py` — installs `BranchService` on the hub.
- `app/src/lib/types.ts` — optional `Chat.branch`, branch state/result types.
- `app/src/lib/store.ts` — `upsertChat` for the created branch.
- `app/src/components/ChatView.tsx` — menu actions, ancestor strip, sheet wiring.
- `app/src/components/Sheet.tsx` — optional disabled/hint on `SheetAction`.
- `app/src/components/icons.ts` — `GitBranch`.

## Validation — actual results

Python (private `.venv`, lockfile-compatible plugin deps):
- `python -m py_compile plugin/branching.py plugin/branching_routes.py plugin/store.py plugin/hub.py plugin/adapter.py` — passed.
- `pytest -q tests/test_branching.py` — **23 passed** (includes two real-Hermes tests).
- `pytest -q` in the no-Hermes environment — **320 passed, 17 skipped**.
- Full plugin suite after the final changes, with the pinned Hermes checkout installed but
  three Python-3.14-only dependency tests deselected — **336 passed, 1 skipped, 3 deselected**.
- `scripts/check_web_bundle.py` — **28 asset references, 0 missing**.

Real Hermes (pinned `47676981f55de91231fdeef2f0eec47e7c209e78`, installed editable in the
private venv):
- `tests/test_branching.py::test_real_hermes_transcript_and_rewind` — passed.
- `tests/test_branching.py::test_real_hermes_bridge_seeds_and_routes_a_branch` — passed
  (real seeded child transcript, parent untouched, child route and `parent_session_id`).
- A full-suite run with the minimal local Hermes checkout had three **environment-only**
  failures in pre-existing tests because Python 3.13 skipped Hermes' `python_version >= 3.14`
  optional deps (`dotenv`, and the web-router/`tui_gateway` deps):
  `test_bots.py::test_a_bot_made_here...`, `test_sessions.py::test_real_hermes_sessions`,
  `test_teamwork.py::test_the_roster...`. CI's `hermes` job uses Python 3.14 with full deps.
  The branching tests themselves pass on the pin.

App (private `node_modules` from `package-lock.json`):
- `npx tsc --noEmit` — passed.
- `npm test` — **276 passed, 0 failed**.
- `npx expo export --platform web` — passed.
- `npx expo export --platform android --output-dir dist-android` — passed (JS bundle only,
  **not** a native build).
- PR CI run `40039484513` — all four jobs passed: Plugin tests (ubuntu), Plugin tests
  (windows), Plugin tests with Hermes, App typecheck + web build.

Web UI evidence (Chrome, disposable fixture backend on the assigned preview port; synthetic
data only):
- `docs/agent-handoffs/branching-mobile-menu.png` — phone More menu with Regenerate/Branch.
- `docs/agent-handoffs/branching-mobile-regenerate.png` — 390px regenerate destination sheet.
- `docs/agent-handoffs/branching-mobile-edit.png` — 390px edit preview and copy counts.
- `docs/agent-handoffs/branching-mobile-branch-chat.png` — branch chat ancestor strip.
- `docs/agent-handoffs/branching-mobile-320.png` — 320px narrow sheet (vertical scroll, no
  horizontal overflow).
- `docs/agent-handoffs/branching-desktop-menu.png` — 1440px hover More menu.
- `docs/agent-handoffs/branching-desktop-regenerate.png` — 1440px centred dialog.
- Exercised in the browser: menu gating, edit sheet, branch creation, navigation to the new
  chat, ancestor navigation, parent branch list, 390/320/1440 layouts. The fixture server does
  not generate a real reply, so the post-branch streaming state is covered by tests, not that
  screenshot set.

Not run / not claimed:
- No Gradle/APK build, no emulator, no physical Android device, no live Hermes gateway over a
  tunnel, no TalkBack, no IME/safe-area hardware check. Android export is a bundle check only.
- Real Hermes tests were run against the pin on this machine with a minimal dependency set;
  CI's Python 3.14 `hermes` job is the authoritative full integration run.

## MOBILE VALIDATION PENDING

**Integration commit/build needed:** merge `codex/major-02-branching` into
`codex/major-features` (or test the branch head), let the orchestrator regenerate
`plugin/web`, build a signed APK with the pinned Hermes gateway, and install on the disposable
test device. No version bump or signing change is in this branch.

**Safe local fixture setup:**
1. Run a disposable Winglet gateway/Hermes profile with no personal chats and a throwaway
   pairing code. Do not use the user's real server or phone data.
2. Seed one chat with: user “Help me plan a spring garden…”, assistant reply, user “What about
   tomatoes? I had blossom end rot last year.”, assistant reply, and one activity line.
3. Prepare a second branch chat from the second prompt so ancestor navigation and the parent
   branch count are visible.
4. Use a local address (`http://10.0.2.2:<port>` from the emulator or the Quick tunnel) and a
   disposable paired device.

**Emulator/API/form factors:**
- Android 14 phone, 390×844 logical; Android 13 small phone 320×568; tablet 800×1280 or larger.
- Hermes gateway at the CI pin with WebSocket, branch capabilities true.
- Light and dark themes; default and larger system font; reduced motion on/off.
- TalkBack on the emulator; hardware keyboard on/off.

**Steps and expected outcomes:**
1. Long-press the second user message → More. Expected: `Edit in a new branch` and `Branch from
   here`, both enabled; hints name the later-message count.
2. Tap `Edit in a new branch` → change the text → `Branch and send`. Expected: a new chat opens,
   header shows `Spring garden · edit` (or the chosen title), ancestor strip says
   `Branched from Spring garden`, the prefix and edited message are present, and the original
   chat still has its original message and later reply.
3. Long-press the latest assistant reply → More → `Regenerate reply` → `Branch and regenerate`.
   Expected: new chat seeded before the prompt, prompt re-sent, original reply untouched.
4. On the latest reply only, choose `Replace this reply` → read the warning → `Replace reply`.
   Expected: old reply disappears, prompt remains once, new stream starts; no duplicate user
   message; the revision event is emitted.
5. While a reply is streaming, open More. Expected: branch/edit/regenerate actions are disabled
   with “Wait for the current reply to finish.”
6. Turn on airplane mode, open More. Expected: actions disabled with “Reconnect…”; no outbox
   entry is created and no operation fires after reconnect.
7. Open More on device A, send a message from device B, then try the action on A. Expected:
   409 stale, `This chat changed`, Refresh, no branch.
8. Kill the app during branch creation or drop the response, then retry. Expected: one branch
   only, `replayed: true` when the operation completed.
9. Attach a photo to a user message, branch from a later message, then delete the original chat.
   Expected: the branch photo still renders (cloned upload); the original upload cannot be
   claimed into the branch.
10. Member device: open their own chat → allowed; request an owner chat or another bot → 404.
    Owner branching a member chat: branch stays visible to that member and owner.
11. Open the edit sheet with the keyboard up at 320px. Expected: field, Cancel and primary action
    remain reachable by scrolling; no horizontal overflow; safe-area padding respected.
12. Enable reduced motion and TalkBack. Expected: no spring animation, actions announce label +
    hint, focus order is title → destination → field → actions.
13. Verify `in_place` failure path: make the prompt have an attachment or a newer turn, choose
    Replace. Expected: disabled chip or 409 `unsupported`/`not_latest`; original unchanged.

**Checks that genuinely require physical hardware:** Android IME/keyboard insets and
edge-to-edge behavior, haptics, TalkBack announcement quality, real touch long-press timing,
camera/file-picker attachment flow, WebSocket over the actual Quick tunnel, battery/performance
on a low-end phone, and the signed APK install. The branch/revision/idempotency logic can be
validated on an emulator with the fixture.

## Unresolved risks / notes for review

- In-place regeneration is inherently destructive after the rewind: if the new turn cannot
  start, the old reply is gone and a system line tells the user to resend. Branch regeneration
  is the safe default.
- Branch copies attachments by copying files (disk use roughly doubles for large media). The
  copy is intentional so deleting the original chat does not break the branch.
- Goals/loops/heartbeats are not copied: they are session control state, not transcript.
- A branch from a user message with no reply ends on a user-only tail; Hermes repairs the next
  user turn. This is allowed but is a mid-turn boundary by design.
- `message_capabilities` is one snapshot decode; very large chats still send a per-message map
  to the app. It is bounded to the newest 4000 messages.
- The feature depends on Hermes' internal session-store API. The capability fails closed when
  the pinned functions are missing; a future Hermes rename needs a bridge update, not a
  protocol change.

## Review entry points

1. `plugin/branching.py` — `plan_operation` boundary rules, `HermesBranchBridge` (real Hermes
   only), `BranchService.branch`/`regenerate` (revision, lock, cleanup).
2. `plugin/branching_routes.py` — auth/scope and wire errors.
3. `tests/test_branching.py` — mapping, revision, idempotency, busy, stale, attachments,
   in-place, real Hermes.
4. `app/src/features/branching/` — `plan.ts`, `useBranching.ts`, `BranchSheet.tsx`,
   `BranchStrip.tsx`.
5. `app/src/components/ChatView.tsx` — More menu and sheet wiring.
6. `docs/agent-handoffs/branching.md` — this contract and MOBILE VALIDATION PENDING recipe.

For Codex orchestrator review.
