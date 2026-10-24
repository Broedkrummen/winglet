# Projects, folders and persistent conversation workspaces

Status: **ready for review — MOBILE VALIDATION PENDING**. Branch `codex/major-01-projects` in the
isolated worktree `C:\Users\vikas\Documents\winglet-agents\01-projects`, based on verified commit
`b71d93b459e1645e34cd47c80a392b146dca0e04`. Integration target: `codex/major-features`.

Primary specialist role: Mobile App Builder (architect → implement → distinct review pass). The
review pass found and fixed: a circular import between the navigation shell and the project section,
an offline state that could claim a project was deleted, unconditional section headers, misleading
archive copy, an inaccessible "No project" row while searching, an owner-only create toast shown to
members, and a 370 px project pane that did not match the existing 360 px Chats pane.

## What this feature is

A **project** is a named, server-persisted folder for conversations on one bot. Owner-created
projects are shared by every owner device paired with that bot; a member's own projects are private
to that member device. Renaming, ordering, archiving and moving chats therefore agree across devices.

A Winglet **chat is the persistent thread**. It keeps its name, draft, pins, local archive and
messages across app restarts, and it is the identity Hermes uses for its gateway session. A Hermes
**session** is one execution context inside that chat; work that replaces the execution context does
not replace the chat. Consequently:

- Projects organize chats; they do not create a second chat/session layer.
- There is no working-directory field. The pinned Hermes plugin protocol does not give a chat a
  per-chat `cwd`, so a path in the UI would be decorative and would imply behavior the backend does
  not have. The handoff records that decision rather than shipping a misleading control.
- Removing a chat from a project or deleting a project never deletes messages, drafts, pins, local
  archives or Hermes history.

## Contract

### Capability

- Additive server feature flag: `projects: true` in the existing `features` negotiation.
- Absent/false on an old server: every project control is hidden and the existing chats, pins,
  archives, filters and drafts keep working.
- Wildcard capabilities are unchanged; no protocol bump, no new global replay cursor.

### Routes

All routes are bot-scoped through the existing `?bot=` convention and the existing `ROUTE_POLICY`
gate. Authority comes from the authenticated device, never from a caller-supplied device id.

| Route | Policy | Purpose |
| --- | --- | --- |
| `GET /api/projects` | `device` | Snapshot of projects and chat memberships visible to this device on this bot. |
| `POST /api/projects` | `signed` | Create a project for this device's scope. Body: `{name, client_id?}`. |
| `PATCH /api/projects/{project_id}` | `signed` | Rename or archive/restore. Body: `{name?, archived?, revision, client_id?}`. |
| `PUT /api/projects/order` | `signed` | Reorder projects in this device's scope. Body: `{ids, layout_revision, client_id?}`. |
| `DELETE /api/projects/{project_id}` | `signed` | Delete the project, preserving every chat. Query/body: `revision`, `client_id`. |
| `POST /api/projects/{project_id}/chats` | `signed` | Create a chat inside the project. Body: `{title?, revision, client_id?}`. |
| `POST /api/projects/{project_id}/chats/{chat_id}` | `signed` | Move an accessible chat into a project. Body: `{from_project_id?, from_revision?, revision, client_id?}`. |
| `DELETE /api/projects/{project_id}/chats/{chat_id}` | `signed` | Take an accessible chat out (it stays in Chats). Query/body: `revision`, `client_id`. |
| `GET /api/search?q=…&project_id=…` | `device` | Existing search, narrowed to the project and to chats this device may see. |

Every mutation is signed with the existing device signing key. There is no offline outbox for
projects: a live server is required, a failure is shown, and optimistic client state rolls back.

### Revisions and idempotency

- `project.revision` starts at 1 and increments on rename, archive/restore, and any membership
  change in that project. Rename/archive/delete/new-chat/move requests send the revision they read;
  a mismatch is `409` with the current snapshot, which the client adopts.
- `layout_revision` is per bot + scope (`shared` for owner projects, the member device id for a
  member's private projects). Create/delete/reorder bump it. Reorder sends it and is refused with
  `409` if another device reordered first.
- Positions are stable integers spaced by 1000. Ordering is `(scope, position, created_at, id)`, so
  concurrent readers see the same deterministic order. Shared projects sort before a member's
  private projects.
- `client_id` is an idempotency key stored with the mutation's result. A retry after a lost reply
  returns the same outcome instead of creating a second project/chat or moving twice. Conflicting
  reuse of a key is refused. Results are pruned to the most recent 500 and 7 days.

### Visibility and permissions

- Projects are per bot. Project ids never resolve across bots.
- Owner-created projects are **shared** with all owner devices of that bot. Members can see shared
  projects and move **their own** chats in and out of them, but cannot rename/archive/reorder/delete
  a shared project. Members can start their own chats inside a shared project.
- Member-created projects are **private** to that member device and are not shown to owners or other
  members. The member may manage them.
- A project never grants read access to a chat. Every chat read/mutation still passes the existing
  `can_see` check (`owner_device`), and search filters by both membership and `can_see`.
- Deleting a project removes only the project and membership rows. Chats remain in Chats, with pins,
  local archives, drafts and messages untouched.
- Archiving hides the project from the active section; chats in it remain in Chats and are not
  archived.

### Storage (SQLite, additive, feature-local)

Created idempotently by `plugin/projects.py` when the hub starts:

- `projects` (`id`, `bot`, `owner_device` nullable, `name`, `position`, `archived`, `revision`,
  `created_by`, `created_at`, `updated_at`), unique case-insensitive name per bot + scope.
- `project_chats` (`chat_id` primary key, `project_id`, `position`, `created_at`, `updated_at`) with
  an index on `(project_id, position)`.
- `project_layout` (`bot`, `scope`, `revision`), primary key `(bot, scope)`.
- `project_ops` (`id`, `bot`, `device_id`, `op`, `payload`, `result`, `created_at`) for bounded
  idempotency results.

No global migration number is allocated and no existing table is rewritten. Existing chats simply
have no `project_chats` row, which is the "ungrouped" state. Rollback: stop the server and drop the
four `project*` tables; chats and messages are unaffected.

### Events

`project.sync` is sent over the existing WebSocket to each paired socket for the affected bot,
tailored to that device (owners do not receive another member's private projects; members receive
shared projects plus their own). Payload:

```json
{ "type": "project.sync", "projects": { "projects": [], "threads": [], "layout_revision": 1 } }
```

`hello` carries the same `projects` snapshot. Older clients ignore both the extra hello key and the
unknown event. There is no new global replay/cursor layer.

### Shared files touched

- `plugin/hub.py`: capability flag, schema bootstrap, eight handlers, search `project_id` filter,
  hello snapshot, per-device `project.sync` broadcast, route-policy entries.
- `plugin/store.py`: unchanged; chat identity and access stay authoritative there.
- `app/src/lib/types.ts`, `store.ts`: project types, state, actions, events, conflict rollback and
  cache.
- `app/src/components/AppNavigation.tsx`: compact collapsible Projects section (passes the drawer
  close callback; no import cycle).
- `app/src/components/ChatMenu.tsx`: "Move to project…" and its in-place picker.
- `app/src/components/ChatView.tsx`: project context chip in the chat header.
- `app/src/app/(tabs)/chats.tsx`: project filter chips, Projects shortcut in the top row, and
  project-aware counts/empty states.
- `app/src/app/projects.tsx`, `app/src/app/project/[serverId]/[projectId].tsx`: feature screens.
- `app/src/components/icons.ts`: folder icons.
- `app/src/lib/actions.ts`: not modified; creating a chat inside a project uses the dedicated store
  action so it can enforce the project revision.

Feature-local code lives in `app/src/features/projects/` and `plugin/projects.py`. Tests live in
`app/tests/projects.test.ts`, `app/tests/store.test.ts` and `tests/test_projects.py`.

## UI plan

Entry points: the compact **Projects** section in the existing sidebar; **All projects** row; a
folder chip in a chat header; a Projects shortcut in Chats; and the existing chat menu's **Move to
project…** action. There is no bottom navigation.

Primary action: **New project** (sidebar and Projects screen). Secondary: **New chat** inside a
project, and **Move to project…** from a chat's existing menu.

Hierarchy:

- Sidebar: collapsible `Projects` group, up to six active project rows with counts, `All projects`,
  editable `New project`. Collapsed state is local presentation only.
- Projects screen: title, search, `Shared projects` / `Only you` sections (rendered only when they
  have rows), archived projects in a collapsible section, create action, empty explanation.
- Project screen: project identity and count, scoped search, New chat, chat rows with pin/activity/
  draft context, archived banner, and a toggle for chats archived on this device. On wide screens
  the project list is a 360 px pane beside the selected chat, matching Chats, so the conversation
  column is not sacrificed.
- Chat header: a small folder + project name chip for a chat that belongs to a project.
- Chats: a horizontally scrolling project chip row, with All chats selected by default, plus a
  Projects shortcut. Existing Running / Needs you / Archived filters and draft search are preserved
  and narrowed to the selected project.

States:

- Loading: skeleton rows (never a blank screen) while the first snapshot is in flight.
- Empty project: "No chats in <name> yet" with New chat and a pointer to move existing chats in.
- Empty search: "Nothing in <name> matches …" with a clear-search action.
- Offline: cached project structure remains readable; mutations are disabled with "Connect to
  change projects"; no queued project mutation. A first load with no cache says projects need a
  connection instead of showing an endless skeleton.
- Unsupported (old server / no `projects`): one explanatory block; existing chats, pins and
  archives keep working.
- Permission: members see shared + their own private projects; shared management actions are absent
  rather than shown and refused.
- Conflict: the server snapshot replaces optimistic state; the failure message is shown.
- Failure: optimistic change rolls back and the server's message is shown.

Mobile vs wide: 320/390 px use a single column with 44–48 px targets, drawer sidebar, and no
document horizontal overflow. Tablet/1440 px use the pinned sidebar where available and a project
list + chat split above the shared 900 px breakpoint. Light, dark, large text and reduced motion use
the existing tokens/components (entering/layout animations are disabled when reduced motion is on).

## Reference comparison and reuse provenance

Reused/adapted material is recorded in `third_party/notices/herald-projects.md`, including the
upstream URL, reviewed snapshot `95ca999fa48c1c9de232fe499a174900f0d25272`, files, modifications and
the full MIT license text. No Herald file was copied verbatim.

| Reference behavior/source | Winglet result | Matching edge cases/tests | Intentional differences | Remaining gaps |
| --- | --- | --- | --- | --- |
| Herald `ProjectIndex`: chat → project lookup, unfiled Home bucket | `threads` membership snapshot plus pure index in `features/projects/logic.ts` | Unknown chats, deleted projects, cross-bot ids, duplicate membership rows | Server-persisted SQLite, not gateway folder discovery; Winglet chats have stable ids, so no compression lineage lookup | No filesystem discovery |
| Herald `ProjectsApi`: project shape, deterministic ordering, user-made vs discovered | `Project`/`ProjectSnapshot` types and `plugin/projects.py` ordering | Shared-before-private order, position ties, archived separation | No `complete.path` folder picker or auto cwd/git-root discovery; explicit revisions and signed device requests | No "discovered" groupings |
| Herald `ProjectDialogs`: new/rename/delete copy and validation | Create/rename sheets, delete confirmation that preserves chats | Blank/duplicate names, 409 stale revisions, archive and delete | No path field; delete explicitly says chats and Hermes sessions stay | No bulk project actions |
| Herald `ThreadsRepository`: persistent thread vs execution session, tolerant order writes, rollback | Winglet chat is the persistent thread; Hermes session is execution context; full-scope reorder guarded by `layout_revision`; optimistic rollback | Move, create-in-project, reorder race, deleted source project, server refusal, draft preservation | Explicit HTTP revisions instead of read-modify-write JSON; no session-swap UI in this increment | "Start fresh thread" remains separate work |
| Herald `Threads.kt` ordering helpers | `movedOrder` and `applyOrder` in `logic.ts` | End-of-list moves, unknown ids, deterministic tie breaking | Reorders project folders, not session threads | No drag-and-drop |
| Herald `ThreadRows.kt`: named threads separated from other chats | Compact collapsible Projects section in the existing sidebar, project screens and header chip | More-than-six projects, archived count, selected state | No separate Threads section or bottom navigation | — |

## Validation

Environment: private `.venv` in the worktree (aiohttp, cryptography, httpx, qrcode, pytest,
pytest-aiohttp, pillow, pyyaml, http_ece, packaging) and the app lockfile's `node_modules`. All
commands were run in the isolated worktree, never the shared checkout.

### Automated checks (passed)

| Check | Command | Result |
| --- | --- | --- |
| Project server tests | `.\.venv\Scripts\python.exe -m pytest tests/test_projects.py -q` | **13 passed** (5.48 s) |
| Full plugin suite | `.\.venv\Scripts\python.exe -m pytest -q` | **314 passed, 16 skipped** (29.72 s) |
| Frontend tests | `npm test` (`app/`) | **281 passed, 0 failed** |
| TypeScript | `npm run typecheck` (`app/`) | **passed** (`tsc --noEmit`) |
| Web export | `npx expo export --platform web` | **passed**; exported `dist` (web entry 3.4 MB + 45 KB) |
| Android bundle export | `npx expo export --platform android --output-dir dist-android` | **passed**; Hermes bytecode 5.8 MB |

GitHub Actions on PR #46 also passed all four jobs: Plugin tests (Ubuntu) 29 s, Plugin tests
(Windows) 1 m 2 s, Plugin tests with Hermes 1 m 7 s, and App typecheck + web build 1 m 59 s
(run `40040933743`).

The project tests cover additive schema and ungrouped existing chats; signed/unsigned policy and
hello snapshot; rename/reorder/archive/delete with chats preserved; duplicate/blank names; stale
project revisions with the current snapshot; reorder races; create/move idempotency and key reuse;
owner/member/other-member visibility; member move attempts against an owner chat; cross-bot ids;
project-scoped search and member search isolation; per-device `project.sync`.

Frontend tests cover malformed snapshots, chat→project indexing, stable project chat order,
up/down ordering, reorderable scopes, archived separation, search matching title/preview/draft,
count labels, store hello/`project.sync` application and cache, stale rename rollback with the server
snapshot, move request `from_*` revisions and rollback, create-in-project revision, and draft
preservation across project events.

### Rendered web checks (passed)

Private disposable fixture on `127.0.0.1:9301` (synthetic chats/projects) and the exported web app
on `127.0.0.1:8301`, driven with Playwright. Checked 1440×900, 1024×1366, 820×1180, 390×844 and
320×700; light and dark; document `scrollWidth === clientWidth` at 390, 320, 820 and 1024 (no
document-level horizontal overflow). Exercised in the UI: create project, delete project (chats
preserved), move a chat Launch → Personal → Launch, archive → restore → archive, project-scoped
search hit and empty state, chat header project chip, Chats project chips/filter, sidebar Projects
section, and the wide project-list + chat split. Console showed only the existing Reanimated
"easing not supported on web" warning (also emitted by the current Chats list); no runtime errors.

Representative synthetic screenshots are committed under `docs/agent-handoffs/projects/`:

- `projects-desktop-light.png` — Projects screen, sidebar section, archived group.
- `project-desktop-light.png` — wide project list + chat column, header chip.
- `projects-mobile-light.png` — 390 px Projects screen.
- `project-mobile-dark.png` — 390 px dark project screen.
- `project-tablet-split.png` — 1024 px tablet split.
- `chats-project-filter.png` — Chats project chips and filtered list.
- `project-search-mobile.png` — scoped search results.

### Not run (deliberately deferred)

- No native Android/iOS build, emulator, physical-device, permission, audio/voice, keyboard/safe-area
  or push test. The Android export verifies bundling only, not native behavior.
- No live Hermes/routine execution test; project operations are hub persistence and do not call
  Hermes APIs.

## Privacy, permissions and safety

- Owner/member scoping is enforced server-side on every read and mutation; project ids never cross
  bots, and a project cannot be used to read another device's chat.
- Search applies both project membership and the existing `can_see` rule, so a member cannot see an
  owner's chat in a shared project.
- Delete is folder-only and confirmed in a separate step; chats, messages, drafts, pins and local
  archives are preserved.
- No working directory or client path is accepted, stored or sent to a shell.
- Screenshots use synthetic fixture conversations only; no personal data, tokens or QR pairing
  material is committed.
- Project mutations require a live, feature-capable bot and never enter the offline outbox.

## Compatibility, dependencies and rollback

- Old clients: ignore the extra `hello.projects` key and `project.sync`; all existing behavior is
  unchanged.
- Old servers: no `projects` capability, so every project control is hidden; direct project routes
  show the unsupported explanation and leave chats intact.
- No new Python runtime dependency and no Hermes API dependency. The feature is available on the
  pinned Hermes version because it is entirely hub-side persistence.
- No protocol bump or global migration number. Schema creation is additive and idempotent.
- Rollback: stop the server and drop `projects`, `project_chats`, `project_layout` and `project_ops`.
  Nothing else is altered. Re-deploying the feature recreates the tables empty; existing chats are
  simply ungrouped.

## Residual risks and limitations

- No drag-and-drop reorder; ordering is through Move up / Move down in the project menu.
- No "start a fresh thread/execution session" UI; a chat remains the persistent thread and Hermes
  session replacement stays separate work.
- No per-chat working directory, by design (see above).
- The project list pane is fixed at 360 px on wide screens. Tested at 1024 and 1440; narrower
  landscape windows around the 900 px breakpoint have a smaller chat column but no overflow.
- Project mutations, revision checks and their durable retry result commit in one SQLite
  transaction. Journal failures roll back chat creation and membership/layout changes. Retry
  identities are bound to the actual route target and current device role.
- Web emits Reanimated's unsupported-easing warning for the shared `easeOut` layout transition; this
  is pre-existing in Chats, not a project regression.
- Native behavior (safe areas, keyboard, rotation, background/reconnect, notification taps) is
  unverified until the Codex mobile phase.

## Integration branch inspection

`origin/codex/major-features` was fetched at handoff time and is still at
`b71d93b459e1645e34cd47c80a392b146dca0e04`, the same verified base as this branch. There are no
integration commits yet and therefore no merge conflicts to resolve now. If other agents land later,
the shared touch points most likely to conflict textually are `plugin/hub.py`,
`app/src/lib/store.ts`, `types.ts`, `AppNavigation.tsx`, `ChatView.tsx`, `ChatMenu.tsx`,
`app/src/app/(tabs)/chats.tsx` and `icons.ts`; the feature-local files are isolated.

## Review entry points

1. `plugin/projects.py` — visibility, revisions, idempotency, storage, chat membership.
2. `tests/test_projects.py` — server contract and isolation tests.
3. `app/src/features/projects/logic.ts` — pure indexing/order/search helpers.
4. `app/src/lib/store.ts` project actions — optimistic update, 409 snapshot adoption, rollback.
5. `app/src/app/project/[serverId]/[projectId].tsx` — narrow/wide project screen states.
6. `app/src/features/projects/ProjectSection.tsx`, `ProjectSheets.tsx`,
   `MoveToProjectSheet.tsx` — sidebar and sheet interactions.
7. `third_party/notices/herald-projects.md` — provenance and license.

## MOBILE VALIDATION PENDING

### Status labels

- Code implemented: **yes**.
- Backend project tests: **passed** (13/13).
- Full backend suite: **passed** (314 passed, 16 intentionally skipped).
- Frontend tests: **passed** (281/281) and **typecheck passed**.
- Web export: **passed**; Android bundle export: **passed**.
- Native Android build: **not run**.
- Emulator/physical-device validation: **deferred to the Codex orchestrator phase**; do not ask the
  implementation user for a phone in this phase.

### Exact integration and build needed

- Feature branch `codex/major-01-projects`, based on `b71d93b459e1645e34cd47c80a392b146dca0e04`;
  PR targets `codex/major-features`.
- Codex should integrate the feature PR (and any required shared-contract resolution), then build
  the signed APK / run the native app from the integration branch. The plugin-side tables are
  created automatically on hub start; no manual migration is required.

### Safe local fixture setup

The fixture is disposable and must stay outside the repository:

1. Create a private venv in the worktree and install `pytest`, `pytest-aiohttp`, `aiohttp`,
   `cryptography`, `httpx`, `qrcode`, `pillow`, `pyyaml`, `http_ece`, `packaging`.
2. Start a Python fixture that constructs `Store(<temp>/preview.db)` and `Hub(store, web_root=…)`,
   creates an owner device plus synthetic chats/projects, prints a one-time pairing code/fingerprint,
   and serves the hub on `127.0.0.1:9301`.
3. Export and serve the app on `127.0.0.1:8301`:
   `npx expo export --platform web` then a static server with SPA fallback to `index.html`.
4. Pair the browser or device with the one-time code. For an Android emulator, point the app at
   `http://10.0.2.2:9301`; for a physical device on the same LAN, use the host's LAN address and the
   fixture's bound interface.
5. Never commit the fixture database, pairing code, fingerprint, tokens or fixture screenshots of
   real data.

### Emulator / API / form-factor requirements

- Android emulator or device on a current supported API (API 34+ preferred) with the Winglet build
  from the integration branch.
- Phone widths 320 and 390 dp; tablet around 1024 dp; portrait and landscape; light and dark themes.
- System font scale at the largest supported setting and reduced-motion enabled for one pass.
- Two owner devices for cross-device sync where available, plus one member device for isolation.

### Steps and expected outcomes

1. **Pair and open the sidebar.** Expect a compact `PROJECTS` section above recent chats; with no
   projects it explains grouping and offers New project. No bottom navigation is added.
2. **Create a project.** Expect the project screen to open, a success toast, and the project to
   appear on a second owner device through `project.sync`.
3. **Rename from two devices.** Rename on device A; on a stale device B the change is refused with a
   conflict message and device B adopts A's snapshot instead of silently overwriting it.
4. **Move a chat in.** From a chat's existing menu choose Move to project…; expect the picker to
   show shared/private scope, the current project checked, and "No project" always available. The
   chat, messages, draft, pin and local archive must be unchanged, and the chat header must show the
   project chip.
5. **Start a chat inside the project.** Expect a normal new chat in the selected project; sending a
   message must reach Hermes exactly as a regular chat does.
6. **Search inside the project.** A title/preview/draft match appears under the list; a message match
   appears under In messages; no result from another project may appear. Clearing search restores
   the full project list.
7. **Archive and restore.** Archive: the project leaves the active section; its chats remain in
   Chats and are not archived. Restore from Archived projects and confirm the project returns with
   the same chats.
8. **Delete a project.** Confirm the copy says chats stay. After deletion, every chat must still be
   in Chats with its messages, draft, pin and Hermes session; only the folder and membership vanish.
9. **Member device.** Expect shared projects plus that member's own private projects only. Shared
   project management actions are absent; the member can move/start their own chats in a shared
   project. An owner chat must never appear in the member's project or scoped search.
10. **Offline and reconnect.** With the bot unreachable, cached project structure stays readable and
    mutations show "Connect to change projects"; no project mutation is queued. Reconnect and confirm
    `project.sync` reconciles project order/counts without touching drafts or unsent messages.
11. **Layout pass.** 320/390 dp single column, 44–48 dp targets, no document horizontal overflow;
    tablet/wide project list + chat split; light/dark contrast; large text does not clip names or
    buttons; reduced motion removes entering/layout animations.
12. **Background/notification pass.** Background and reopen a chat in a project; the chat must
    resume with its draft and session, and notification taps must still open the right chat.

### Reproducible automation and hardware-only checks

- Automated: `tests/test_projects.py`, the full pytest suite, `app/tests/projects.test.ts`,
  `app/tests/store.test.ts`, `npm test`, `npm run typecheck`, web and Android exports. A future
  Playwright recipe can reuse the disposable fixture steps above.
- Requires the native device/emulator (not covered by web): safe-area/keyboard insets, rotation,
  touch target feel, Android back/drawer behavior, background/reconnect timing, notification taps,
  audio/voice and performance on low-end hardware.
- Wear OS does not apply to this feature.

## Codex handoff summary

- **Branch:** `codex/major-01-projects` (isolated worktree above), targeting
  `codex/major-features`. The PR URL and exact HEAD SHA accompany the session handoff; the branch
  has not been merged by this agent.
- **User-visible behavior:** create/rename/reorder/archive/restore/delete server-persisted project
  folders; move chats in/out; start chats inside a project; scoped search; project chip in the chat
  header; project chips/filter and shortcut in Chats; compact sidebar Projects section; owner/member
  sharing rules; cached structure offline with disabled mutations; conflict adoption and rollback.
- **Contract/shared changes:** additive `projects` capability; eight signed/device routes; hello
  snapshot and `project.sync`; additive SQLite tables; search `project_id`; no protocol bump; no
  changes to `plugin/store.py` or Hermes APIs.
- **Checks passed:** 13/13 project pytest, 314 passed / 16 skipped full pytest, 281/281 Node tests,
  typecheck, web export, Android bundle export, all four PR CI jobs, and rendered web checks at
  1440/1024/820/390/320 in light/dark with no document overflow.
- **Checks not run:** native Android build, emulator/device testing, audio/permission/keyboard/
  safe-area/notification tests, live Hermes routine execution.
- **Outstanding:** MOBILE VALIDATION PENDING as above; optional future drag-and-drop and
  session-swap UI; no intentional native blockers known.
- **Review first:** `plugin/projects.py` and `tests/test_projects.py`, then the store project
  actions and `ProjectDetail` offline/conflict states.

**For Codex orchestrator review.**

## Codex review corrections — 24 October 2026

- Made mutation + retry-result persistence atomic and serialized revision checks across connections.
- Bound retry fingerprints to route project IDs and the device's current role.
- Prevented stale reads, failed optimistic updates and old conflict responses from overwriting newer
  socket state. Late responses for removed bots no longer recreate project cache entries.
- Added seven backend regression cases and five app-store race cases.
- Revalidation: project tests 20 passed; full local plugin suite 316 passed / 17 optional skips;
  app suite 286 passed; TypeScript typecheck and production web export passed. Android bundle export
  is checked separately in the PR's latest CI. Existing UI screenshots remain representative because
  these corrections change transaction/state ordering, not layout.
- Physical Android device authorization was verified by Codex; this PR has not yet had its native
  project screens validated. Integrated native testing remains a separate step.
