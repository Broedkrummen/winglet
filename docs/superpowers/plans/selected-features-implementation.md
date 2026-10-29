# Selected Winglet features: implementation plan

Status: approved by the user for implementation. Tracking issue: https://github.com/Broedkrummen/winglet/issues/13. Merge, installation and production deployment remain separate review steps.

## Scope and evidence

Implement all 18 selected features: **1, 3, 4, 5, 6, 7, 10, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23**. Delivery stages below are dependencies, not permission to omit later features.

Excluded: 2 away digest; 8 phone widget; 9 standalone task-budget screen; 11 expiring approval-grant UI; 13 unified change-review bundles; **24 full-duplex voice**, explicitly skipped. Existing voice remains supported.

Repository baseline: `7179447de1b138e5a1bfcf6c61841e0d9c205ebf`, branch `codex/approved-winglet-improvements`. PR #12's custom abilities and memory controls are already present. Revalidate remote/main and PR state before implementation; do not reuse a merged PR.

Read-only native reference: installed Hermes `bf0203a794a07aac3ff764972ab9087baa4e4f4e` (v0.22.5). Winglet CI currently pins a different Hermes revision, `47676981f55de91231fdeef2f0eec47e7c209e78`. Native API compatibility is therefore a delivery requirement, not an assumption. Never edit the installed Hermes checkout.

Existing product/design authorities: `PRODUCT.md`, `docs/DESIGN.md`, `docs/surfaces/simple-view.md`, `docs/FEATURES.md`, `docs/CUSTOM_ABILITIES.md`. Preserve Simple and Full views, desktop web/iPhone PWA/Android, light and dark themes, semantic tokens and current typography. Do not introduce another design system or treat historical `docs/APP_PLAN.md` as the active plan.

### Confirmed user decisions

- Personal use across desktop and phone; sync all portable app state, including drafts, appearance and settings.
- One designated Hermes server is the sync home. Devices are explicitly linked to a private sync identity; server owner status alone does not establish identity.
- Ask the user to choose for **every true concurrent conflict**. Disjoint edits may merge; competing values never silently win.
- New proactive work runs only within explicitly preapproved categories and limits. At a limit, or when it cannot be verified, pause and ask.
- A separate reviewed Hermes patch is allowed, in an isolated checkout. Production installation remains separately reviewed.
- Handoffs work across independently paired Hermes servers, as well as locally.
- Backup offers both profile and whole-installation scope. Restore supports mixed hosting, including Windows, Linux and Docker, with truthful capability detection.
- Computer control targets the dedicated Hermes Bot Desktop, never the user's everyday desktop.

## Approach and ownership

Extend native Hermes capabilities through Winglet's existing service / native adapter / route pattern. Keep `plugin/hub.py` responsible for wiring, transport and permission enforcement; do not accumulate every feature in it, `plugin/hermes_api.py`, or `app/src/lib/store.ts`.

A UI-only implementation cannot enforce autonomy, restore stopped processes, or provide cross-server execution guarantees. Conversely, rebuilding Hermes memory, Kanban, peer transport and desktop control would create competing authorities. Use native engines, add narrowly scoped native contracts where missing, and expose their real state.

All new paths below are **proposed**. Existing owners include `plugin/store.py`, `plugin/adapter.py`, `plugin/hermes_api.py`, `plugin/projects.py`, `plugin/rooms*.py`, `plugin/execution.py`, `plugin/context_insights*.py`; app `src/lib/{store,prefs,persist,types,crypto,focus,pushPrefs}.ts`, `components/{ChatView,AppNavigation,FilesSheet,MediaViewer}.tsx`, `app/_layout.tsx`, and feature directories for execution, memory and abilities.

### Shared contracts

1. Every record/action carries stable server installation, profile, principal and resource identifiers. Bot display names are labels, not identities. Recheck source permissions when listing, opening, acting and delivering events.
2. Mutations use operation IDs, expected revisions and durable receipts. Retrying a transport failure must not create another execution. Unknown external outcomes remain unknown until reconciled.
3. Native adapters expose versioned capabilities with supported/configured/reachable/unknown states. Do not infer success from a configured key or hide an unfinished feature behind an unsupported placeholder.
4. Each feature defines bounded input sizes, retention, quotas, redacted errors and cancellation behavior. Unresolved conflicts, approvals and ambiguous side effects cannot be silently swept away.
5. Separate trusted configuration from imported content. Skill text, project documents, plugin manifests and HTML cannot grant themselves permissions.
6. Proposed route contracts use a closed action vocabulary and typed schemas, not arbitrary native RPC, shell commands or filesystem paths. Signed Winglet owner requests do not automatically authorize native administrator operations.
7. Existing event replay is transport recovery, not the canonical personal-state database or durable execution history.

## Feature specifications

### 1 — Full cross-device sync

Owners: existing local preferences/drafts in `app/src/lib/{prefs,persist,store,storage}.ts`; proposed `plugin/user_sync.py`, `plugin/user_sync_routes.py`, `app/src/features/sync/` and additive store migrations.

- Add private sync principal/group membership, explicit device invitation, revocation and designated-home configuration. Never enroll every owner device automatically.
- Store versioned entities/fields with base revision, operation ID, tombstone and conflict candidates. Resolution is compare-and-set; a stale resolver must refresh instead of erasing a newer candidate. Show both values, devices and timestamps; text may be manually combined.
- Sync drafts, selected attachments, organization, bookmarks, presets, portable preferences and read/resume state. Keep monotonic read watermark separate from nonmonotonic resume anchor. Incoming state never navigates the active device or overwrites active typing.
- Keep pairing credentials, provider secrets, biometric configuration, push tokens, signing keys, physical permissions, active control leases and runnable outboxes device-bound. Sync logical notification preferences, deriving timezone/device delivery details locally.
- Existing staged uploads belong to their uploader and unsent uploads expire. Add sync-group blob ownership, authorized cross-device claims, retention pins and quotas; copying upload IDs is insufficient. Keep local content on failed upload or quota exhaustion.
- Sync composition, not executable outbox entries. Add a shared draft-submission claim/lineage so two devices sending the same synced draft create at most one run, while distinct intentional messages remain possible.
- Home offline: composition and existing local use continue with unsynced status. Membership changes require home verification. Initial device import preserves competing values for user choice.
- Use existing pinned transport and authentication. The trusted sync home can process personal state; this plan does not claim or invent end-to-end group encryption.

Acceptance: two-device concurrent text/settings/delete-versus-edit conflicts always require choice; disjoint fields merge; restart/offline/reconnect retain both candidates; revoked devices cannot fetch state/blobs; simultaneous send is deduplicated; attachment expiration cannot break a live synced draft.

### 3 — Results library

Proposed `plugin/results.py`, `plugin/results_routes.py`, `app/src/features/results/`. Reuse `plugin/adapter.py` attachment ingestion and execution detail links.

- Persist deliverables and immutable versions with source message/run/task, producing bot, content hash, MIME type, visibility and blob reference. Explicitly mark results or consume verified producer metadata; not every tool file is a final deliverable.
- List, filter, open and export results after restart; expose version history and original conversation/task. Show missing, deleted and permission-revoked sources truthfully.
- Implement image, Markdown and PDF previews. Existing `MediaViewer.tsx` is photos-only; opening an external URL is not completion of PDF preview. HTML uses feature 22 and the same result/version authority.

Acceptance: a generated file survives restart, retains versions and opens its precise source; ACL changes remove inaccessible snippets and previews; supported PDF/Markdown/image examples work on Android and web/PWA.

### 4 — Saved answers and bookmarks

Proposed `plugin/bookmarks.py`, `app/src/features/bookmarks/`; personal records use feature 1's canonical sync authority.

- Save a server/profile/chat/message reference with optional notes/tags and explicitly bounded snapshot. Reuse existing focus/pagination to jump to old messages.
- Source edits/deletions and inaccessible sources have explicit states. Never expose a cached private snippet after access is revoked. Concurrent note changes use the conflict chooser.

Acceptance: save on phone, find on desktop, open an old paginated message; deletion and revocation do not leak content; competing notes remain recoverable.

### 5 — Task presets

Proposed `app/src/features/presets/` and typed server-side validation over synced personal records. Reuse composer, slash commands and existing model/reasoning selection.

- Version name, prompt template, typed required inputs, optional model/reasoning, project and capability references.
- Applying a preset creates a reviewable draft. Explicit Send starts work; import/apply never grants permissions, runs automatically or changes global defaults. Snapshot the selected preset version on execution.
- Validate missing inputs and unavailable capabilities; preserve the draft on failure. Editing a preset does not rewrite historical runs.

Acceptance: create/edit/sync/apply a preset, fill inputs and inspect the exact message before sending; stale capability/model references produce actionable errors without losing text.

### 6 — Smarter notifications

Extend current hub/push logic and `app/src/lib/pushPrefs.ts`; proposed `app/src/features/notifications/` for category and delivery controls.

- Deterministic categories, grouping, deduplication, quiet hours and delivery receipts using existing encrypted push. No new push provider or excluded away digest.
- Sync logical preferences while retaining device permissions/subscriptions/timezone. Keep approvals/questions visible in the app even if delivery is muted; any urgent override must be explicit.
- Deep links revalidate access. Notifications never execute an approval/action automatically.

Acceptance: repeated events do not spam; quiet hours respect each device timezone; muted pending approvals remain discoverable; revoked devices receive no further authorized delivery.

### 7 — Expanded keyboard workflow

Proposed `app/src/features/keyboard/` registry mounted through `app/src/app/_layout.tsx`; reuse `AppNavigation` actions and modal focus handling.

- Searchable command/help surface for navigation, search, bots, new chat and selected feature actions. One registry, not a new router or per-screen global listeners.
- Respect editable fields, IME composition, modal priority, lock state, platform modifiers and the desktop viewer's input focus. Preserve existing composer shortcuts and offer touch alternatives.

Acceptance: desktop navigation and action discovery work with keyboard only; typing/IME and nested dialogs do not trigger unintended commands; no shortcut steals Bot Desktop keystrokes.

### 10 — Preapproved autonomy categories

Proposed `plugin/autonomy.py`, native adapter/routes, `app/src/features/autonomy/`, and a required isolated Hermes runtime patch.

- Store explicit opt-in categories with versioned allowed actions, resource scope and verifiable limits. Defaults authorize no new proactive category. Present exactly what approval covers.
- Enforce admission and limits at task, tool and provider-call boundaries in native Hermes. Existing `agent/tool_executor.py::_pre_tool_block` catches hook failures and permits execution; prompt instructions or an ordinary Winglet hook cannot satisfy this feature.
- Required measurement missing, policy mismatch, enforcement error or exhausted limit results in durable per-task pause plus user request. Add real pause/resume acknowledgments; global gateway pause and Stop are not substitutes.
- Cost caps are advertised only where native accounting can enforce them. Raw terminal access is not classified as read-only by a prompt or a loose shell pattern.
- Show pause-requested until native enforcement confirms paused. An already-started external operation may finish; record ambiguity and never automatically replay it.

Acceptance: injected policy/accounting/hook failures pause before the next protected action; restart preserves paused tasks and their request; an approval applies to the exact pending policy/action revision; unrelated tasks continue. No standalone feature 9 or 11 UI is added.

### 12 — Explainable activity history

Proposed `plugin/activity_history.py`, native receipt adapter and `app/src/features/activity/`; link existing execution detail. `plugin/execution.py` currently holds bounded in-memory snapshots, not durable history.

- Persist native lifecycle, authorization and outcome receipts correlated by task/run/turn/tool/approval/policy/actor/cause. Record timestamps, redacted parameters and source links.
- Explain events from recorded evidence, never invented model narration. Interrupted or unobserved historical effects are labelled unknown.
- Use a native admission/outcome journal and reconcile Winglet's durable ACL-filtered projection. Native files and Winglet SQLite are not one atomic transaction.

Acceptance: restart reconstructs an ordered run history; approvals and policy pauses link to their causes; crash between native action and projection converges without duplicate execution or fabricated success.

### 14 — Extension lifecycle manager

Extend current abilities screens and native adapter; proposed `plugin/extensions.py`, routes and `app/src/features/extensions/`.

- Inventory manifests without importing plugin code. Reuse native discovery/status, `dashboard_set_agent_plugin_enabled`, `dashboard_update_user_plugin`, and `dashboard_remove_user_plugin` where supported.
- Inspect, enable/disable, review update and remove through native jobs. Preview dependency and capability changes; pin the reviewed candidate and reject changed payloads. Preserve native scanning and explicit dependency consent.
- Resolve actual scope first: native dashboard mutations can target the serving profile/host environment, while Winglet currently scopes custom-tool operations through the selected profile. Display affected profiles/bots and refuse misleading redirection.
- Distinguish configuration saved, active runtime changed and restart required. Native failed-update rollback is useful; no generic user-accessible previous-version restore API has been verified, so do not promise one.

Acceptance: a disposable plugin can be inspected and updated without inventory imports; new capabilities require review; failed update preserves working state; displayed profile scope matches native filesystem/runtime effects.

### 15 — Capability health

Extend existing MCP checks, abilities/configuration and connection status; proposed `plugin/capability_health.py`, `app/src/features/health/`.

- Report supported, configured, reachable, stale, last tested, restart required, safe error and remedy independently. Change existing key-check fallback behavior to unknown on inspection failure, rather than implying configured.
- Passive inventory is cheap. Explicit probes disclose network use or possible cost before execution; no automatic paid or destructive background probes.

Acceptance: missing credentials, unreachable service, unsupported runtime and stale check produce distinct states; a configured key alone never proves health; remedies link to the correct existing management screen.

### 16 — Backup and recovery across mixed hosting

Proposed `plugin/backup.py`, native adapter/routes, `app/src/features/backup/`, plus deployment-specific external restore coordinators. Reuse native `hermes_cli/backup.py` inventory, locks, SQLite backup and archive validation/import.

- Offer profile and whole-installation scopes with preview of included profiles, data, exclusions, size and credentials. Use the native archive format; encryption of exported archives has not been established. Clearly identify sensitive archives and require protected handling, transport and local permissions; do not claim encrypted-at-rest ZIPs.
- Bound uploads/downloads and confine paths. Restore performs validation, writer quiescence, safety backup, native import, restart and post-restore verification.
- A restore coordinator and its durable receipt/archive must live outside the restored home and writers. Implement supported Windows process/service, Linux process/service and Docker host/sibling coordination paths. A container cannot stop itself and keep its in-process helper alive.
- Docker support uses an explicitly configured, narrowly scoped coordinator for the intended container/volume; never expose an arbitrary Docker socket or command interface to the client. Unsupported host detection must explain the missing coordinator; it is not completion of mixed-host restore.
- Preserve revocation monotonicity: an older archive must not silently restore device access, sync membership, peer grants or control leases. Reauthorize/re-pair when trust cannot be proven. Never automatically replay uncertain external work after restore.

Acceptance: disposable profile and whole-home round trips on Windows, Linux and Docker, including stopped writers and coordinator restart; corrupt/mismatched archives fail before mutation; failure leaves a recoverable safety backup; old credentials cannot regain access unnoticed. A successful backup alone is not a tested restore.

### 17 — Project knowledge packs

Extend `plugin/projects.py` with proposed `plugin/project_knowledge.py`, native context adapter and app project knowledge screens. Existing Projects organize chats but do not inject context or grant access.

- Import supported text/Markdown/PDF with source provenance, content hash, immutable versions, extraction state and selected-source controls. Bound files, extraction and URL fetching; reject unsupported types honestly.
- Supply selected project context through a real Hermes context/read boundary with a bounded manifest and source/version citations. Distinguish available, supplied, retrieved and cited; metadata cannot prove the model used a source.
- Revalidate access on import, retrieval and open. Treat imported instructions as untrusted data. Project context is not automatically global memory; source removal affects future retrieval, not already-delivered context.
- Reuse native retrieval capabilities where verified; no speculative vector database dependency.

Acceptance: a task can retrieve the selected version and return an inspectable citation; deselected/revoked sources cannot be newly retrieved; an instruction in a document cannot change execution permissions.

### 18 — Unified search

Extend existing `Store.search_messages`, native session search and focus pagination; proposed `plugin/search.py`, `app/src/features/search/`.

- Typed hits and source-specific cursors for conversations, results, bookmarks and knowledge. Stable identity includes server, profile, kind and ID.
- Bounded client fan-out across paired servers; do not copy their credentials or private session databases into the sync home. Label partial failures, offline cache and source availability.
- Filter permissions before snippets/counts and recheck on open. Start with existing text search; semantic ranking is not required.

Acceptance: one query finds an old message and a result across two servers, opens the precise source, reports one unavailable server and reveals no unauthorized snippets.

### 19 — Memory provenance

Extend current memory/context-insight screens and adapters; proposed native write-receipt journal plus Winglet provenance projection.

- Reuse metadata from `agent/background_review.py::build_memory_write_metadata` and the live memory-write bridge. Capture forward receipts at the actual native mutation boundary for agent, CLI and Winglet edits, with source, actor, time and content version.
- Link observable sources through current ACLs. Existing string memories and unobserved historical/provider writes show provenance unknown; do not invent history from current content or treat pending proposals as permanent audit history.
- Reconcile native receipt and Winglet projection after crashes. Expose provider-specific limitations without promising universal deletion or another memory engine.

Acceptance: agent and manual writes show correct source/version after restart; historical records remain explicitly unknown; revoked source chats do not leak through provenance.

### 20 — Native Hermes Kanban

Proposed `plugin/kanban.py`, `plugin/kanban_hermes.py`, `plugin/kanban_routes.py`, `app/src/features/kanban/` over native `hermes_cli/kanban_db.py` and workflow/worker APIs.

- List/create/edit cards, comments/events, blocks, review transitions, schedule and run status using native rules. Every request identifies the board; do not change a global active board.
- The optional desktop `/api/plugins/kanban/*` backend is absent in the inspected checkout. Use an allowlisted native adapter, not an assumed HTTP route.
- Boards can be profile-agnostic; start with host-owner authorization and show that scope. A bot selector does not imply separate board storage.
- Desktop board plus mobile list/column selector and accessible non-drag movement. Preserve revisions, dependencies, native admission and worker semantics.

Acceptance: UI transitions obey native invalid-transition/block/review rules; concurrent edits reject stale revisions; executing cards use the same autonomy and activity contracts; mobile can move cards without dragging.

### 21 — Structured bot handoffs, including independent servers

Extend `plugin/rooms.py`, `rooms_hermes.py`, `rooms_routes.py` and Rooms UI with typed handoff packets. Existing Rooms accept local members only; removing the nonlocal transport rejection is unsafe.

- Packet: objective, acceptance criteria, explicitly selected context/source versions, attachments/results and lineage. Preview the exact frozen packet, sender, target installation/profile and requested authority before dispatch.
- Reuse native RoomLink v2/direct HTTPS and scoped peer grants: `gateway/hosted_room_peer*`, `hosted_room_links.py`, peer route registration and durable run receipts. Do not build a new generic RPC proxy or relay.
- Target-side signed Winglet owner consent obtains a narrowly scoped native invitation; verified home registration consumes it. Existing Winglet pairing is not native broad administrator authentication. Extract a native service boundary if needed in the reviewed patch.
- Grants bind room/home/authority epoch/member/target/task/generation and policy/capability digests. Keep grants private and out of sync, logs and status payloads. Recheck room and target permissions at prepare, dispatch, approval, status and exact stop.
- Use native durable idempotency (task and execution generation); ambiguous recovery resumes the same key. Capability/policy drift requires reauthorization. Stable installation/profile IDs distinguish identically named bots.
- Direct reachability through configured RoomLink endpoints is a prerequisite. Authority replica/promotion and invented pull relays are outside this plan.
- Verify bounded native attachment transfer in the first contract probe. If absent, include a reviewed native artifact-transfer contract; never forward inaccessible private URLs, credentials, or silently omit selected files.

Acceptance: two real disposable gateways exchange a packet/result; crash after remote admission does not duplicate work; remote approval and exact stop work; revoked owner/grant and changed policy fail closed; private chats are not adopted into Rooms accidentally.

### 22 — Interactive HTML artifacts

Extend feature 3's durable result/version model; proposed `app/src/features/results/HtmlArtifact.*` and isolated renderer. Native desktop iframe examples are references, not proof of Winglet isolation.

- Render self-contained interactive HTML with bounded packaged assets, version history, reload/error states, accessibility and explicit export. No public hosting, automatic remote network or live Hermes bridge.
- Web: opaque sandboxed iframe/isolated origin, restrictive CSP and navigation/network policy. Android: isolated WebView with file access, mixed content, popups, unsafe navigation and native bridges disabled. No access to app credentials/storage. Do not reuse this untrusted renderer for the trusted desktop viewer.
- Evaluate `react-native-webview` against Expo 57/RN 0.86 first. A disabled unsupported screen does not satisfy this feature; material isolation/compatibility failures require a revised reviewed design.

Acceptance: a working chart/form on desktop web, iPhone PWA and Android; attack fixtures cannot read tokens, navigate the app, open popups, fetch remote data or invoke native tools; offline assets and exact-version export work.

### 23 — Dedicated Bot Desktop view and takeover

Proposed `plugin/bot_desktop.py`, native adapter/routes and `app/src/features/computer-use/`. Reuse native display status/tickets/RFB, `tools/bot_desktop/lease.py`, computer-use fences and `web_routers/display.py`.

- View the dedicated Linux Bot Desktop from web/PWA/Android, including a Windows client. No physical host-desktop control. Runtime availability and installation are explicit; image switching/installing are separate privileged operations.
- Integrate noVNC/RFB with scoped short-lived single-use tickets, server-minted viewer identity, device revocation and the native one-human/agent lease. Client `viewOnly` is not security: preserve server filtering for pointer, keyboard and clipboard.
- Touch pointer/scroll/keyboard, zoom, current controller, explicit acquire/release and native acknowledgement. A request is not a completed takeover until the native fence confirms it.
- Disconnect, lock and revocation invalidate stale input epochs. Distinguish capture/input transport success from confirmed effect. Native fences do not sandbox arbitrary same-user terminal scripts targeting DISPLAY; autonomy policies must not offer that bypass.
- Verify `@novnc/novnc` and trusted native viewer/WebView compatibility in a disposable environment. No WebRTC dependency is needed after skipping 24.

Acceptance: real disposable Linux Bot Desktop viewed and controlled from desktop and Android; agent/human takeover rejects stale frames/input, revoked tickets fail and handback is acknowledged. Native state corruption fails closed.

## Ordered delivery and proposed review units

After approval, first refresh upstream and create fresh `codex/` branches. Create GitHub tracking issues with this plan's acceptance criteria and links before implementation, following the user's issue/review workflow. Do not merge, deploy or modify a live Hermes installation as an automatic consequence of approving this plan.

1. **Contracts and compatibility:** build an acceptance ledger for all selected IDs; verify native signatures/scopes at pinned revisions; prove Expo/WebView/noVNC/PDF renderer compatibility; probe peer attachment transfer and external restore coordinator contracts. Record exact tested dependency versions and runtime capabilities. Resolve material discoveries before committing to a changed design.
2. **Native prerequisites:** isolated Hermes checkout and separate reviewed patch for fail-closed task/provider/tool enforcement, durable pause/receipts, mutation provenance and any missing peer/context/restore boundaries. Native tests must run without importing the installed agent. Publish a patch/branch against a known base for review; do not assume a fork destination.
3. **Personal state foundation:** feature 1 identity/membership/revision/conflict/blob/submission model and migrations, followed by two-device client synchronization and recovery. Preserve existing local drafts before enrollment.
4. **Everyday workflows:** 3 results, 4 bookmarks, 5 presets, 7 keyboard, 6 notifications. Use canonical sync records and shared result ownership rather than parallel local stores.
5. **Execution control and evidence:** complete 10 and 12 against the patched runtime; integrate task details and pending requests. Reuse their admission and correlation contracts in every later execution surface.
6. **Operations:** 14 lifecycle and 15 health, then 16 backup/restore coordinators and disposable platform round trips. Establish trust-safe restore before relying on it for recovery.
7. **Knowledge:** 17 context packs, 19 provenance, 18 federated search; finish cross-links to existing memory, projects and chat sources.
8. **Native workflows:** 20 Kanban and 21 same-/cross-server handoffs, including remote policies, approvals, cancellation and file transfer.
9. **Rich surfaces:** 22 isolated artifacts and 23 trusted desktop viewer/control; complete platform security and actual-device checks.
10. **Integration and finish:** full selected-scope regression, migration/rollback rehearsal, bundled web parity, documentation and review. A feature remains incomplete until its acceptance evidence exists; a capability badge is not delivery.

Split issue/PR units along these boundaries, reducing further when native and client changes need independent review. Each PR lists selected IDs, native prerequisites, migrations, test evidence and remaining incomplete acceptance items. Keep native and Winglet releases compatible through negotiated capabilities.

## UI integration and quality checks

- Simple view keeps its bot list, bubbles and composer calm. New management surfaces appear through existing options/settings/navigation; active approvals, failures and Stop remain visible. Full view offers denser discovery without a second data model.
- Retain current themes, typography, spacing and grouped rows. Use 44–48 dp touch targets, visible focus, accessible labels, reduced motion and non-drag alternatives. Wide results/boards/viewers may use deliberate wider surfaces instead of forcing the normal narrow settings column.
- Each screen designs loading, empty, partial, stale, offline, permission denied, unsupported and recoverable-error states. Native error text is sanitized and paired with a concrete remedy.
- Conflict resolution is durable and discoverable; incoming conflicts do not interrupt typing or steal navigation. The queue preserves unresolved candidates and shows when a choice is stale.
- Run Impeccable's relevant craft/review workflow during UI implementation, then a bounded review/fix pass per coherent feature batch and final finish review. Do not introduce speculative animation, branding or a palette redesign.

## Migrations, rollout and rollback

- Add versioned SQLite migrations and typed personal-record schemas. Preserve existing local preferences/drafts until successful reconciliation; export/recover local data before destructive migration. Do not turn device credentials into shared records.
- Introduce runtime contracts backward-compatibly. Old runtimes retain existing functionality and explicit unsupported messages for new contracts; this is compatibility behavior, not completion against those runtimes.
- Roll out disabled new proactive categories and explicit sync enrollment. No automatic execution on import, restore, preset application or UI startup.
- Receipts and unresolved operations survive process restart. Specify retention/quota policy before deleting event/source/blob data; retain enough lineage to reconcile uncertain work.
- App rollback stops new mutations and preserves forward-version records read-only or exports them; do not downgrade/drop schemas blindly. Native patch rollback must quiesce its tasks and preserve receipts. External actions cannot be rolled back by reverting a database.
- Restore recovery material stays outside the target home/container. Verify device/peer revocations before bringing a restored server online; unresolved trust fails closed.

## Verification and evidence

For this planning change, verify only the document and diff; historical test counts are not fresh validation. During implementation, run targeted suites first and the required repository CI checks before review.

Known commands from repository conventions (PowerShell, correct working directory):

```powershell
# Repository root
python -m pytest tests
python scripts/generate_third_party_notices.py --check
python scripts/check_web_bundle.py

# app/
npm test
npx tsc --noEmit
npx expo export --platform web
npx expo export --platform android
```

Confirm the package scripts and CLI flags at execution time. The web build uses the repository build process to copy the newly exported app into `plugin/web`; verify source/export/bundled hashes and notices rather than leaving an old bundled UI. Exports are not physical-device verification.

Extend relevant existing tests: `test_projects.py`, `test_goals_search.py`, `test_execution.py`, `test_execution_adapter.py`, `test_encrypted_push.py`, `test_adapter_media.py`, `test_trust.py`, `test_control.py`, `test_abilities.py`, `test_custom_abilities_memory.py`, `test_advanced_config.py`, `test_rooms_routes.py`, `test_rooms_hermes.py`; app store/cache/projects/navigation/chat-organization/execution/push/rooms/configuration tests. Preserve existing voice regression coverage although feature 24 is excluded.

Add meaningful feature tests for concurrency, native boundaries and failure behavior, not snapshots that merely mirror implementation:

| Area | Required evidence |
| --- | --- |
| Sync | Two clients, offline/restart, every true conflict, stale resolution, delete/edit, attachment retention/claims, revoked identity, simultaneous draft send |
| Runtime | Tool/provider/admission failures, unknown accounting, durable pause, exact approval revision, crash/outcome reconciliation, no duplicate effect |
| Data | Source ACL at list/open/export, revoked snippets, source deletion, native provenance unknowns, context injection and citation versions |
| Operations | Plugin scope and update races, passive health failures, Windows/Linux/Docker profile and whole-home restore, revocation-safe old archives |
| Workflows | Native Kanban rules; two independent gateways with scoped grants, restart after admission, remote approval/stop and file transfer |
| Render/control | HTML attack fixtures on web/Android, PDF/Markdown previews, real RFB viewer, stale lease epochs, clipboard/input filtering and device revoke |
| UX | Desktop keyboard/IME/modals, Android touch and offline recovery, iPhone PWA, both themes and views, screen reader and reduced motion |

Run native Hermes tests in the isolated checkout for backup, plugin lifecycle, memory writes, Kanban workflow/admission, two-gateway scoped peers and display/lease/input fences. Extend CI with an explicit old-compatible versus proposed-patched runtime matrix; do not silently repin all compatibility coverage to the installed revision.

Final review checks issue/PR state, clean intended diff, native patch base and dependencies, all 18 acceptance rows, no secrets or generated junk, current app bundle, migrations and recovery instructions. Use disposable hosts only for restore, plugin execution and desktop tests; paid calls or production operations are not implied by this plan.

## Approval and remaining technical gates

No further product choice is currently required. These are explicit engineering gates, not claims already verified: exact new dependency compatibility; native peer file transfer; host-specific external restore lifecycle; complete native enforcement/mutation receipts; and supported knowledge extraction/context interfaces. If a gate requires a material scope, trust or interaction change, return with concrete evidence and a revised proposal.

Approval would authorize implementing this 18-feature plan through reviewed issues/PRs and an isolated Hermes patch. It would not authorize feature 24, production restore/deployment, arbitrary additional server access or edits to the installed Hermes agent.
