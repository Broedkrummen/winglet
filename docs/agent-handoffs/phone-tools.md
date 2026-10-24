# Phone tools (Assignment 11)

Status: **STOPPED EARLY — design/contract only, feature not implemented.**
Branch `codex/major-11-phone-tools` has **no commits**; the worktree
`C:\Users\vikas\Documents\winglet-agents\11-phone-tools` is at `b71d93b` with two
uncommitted paths (`plugin/store.py`, this document). No PR exists. Sections 1–9
below are the **planned** contract and are not yet true of the code; section 10
records exactly what is and is not in the tree.

Primary specialist role: Security Engineer. Workflow: architect (this contract) →
implement → separate review pass against the checklist at the end of this document.

This document is the feature contract and ownership record. It is updated as the
implementation lands; the final sections report actual check results and the
MOBILE VALIDATION PENDING recipe.

## 1. What the feature is

Winglet can ask **one paired Android phone** for a small, named set of device
details, only after the user has opted in to that tool. It is off by default.
There is no fan-out to every paired phone: a request is bound to the authenticated
sender of the Hermes turn (device + chat + bot), and the server derives that
binding from its own session/chat rows rather than from anything the caller sends.

Implemented tool subset (all namespaced `phone_*`, Hermes toolset `phone_tools`):

| Tool | What it returns | Sensitive | Default mode |
| --- | --- | --- | --- |
| `phone_status` | Battery level/charging, network (Wi‑Fi/mobile/offline, metered), do-not-disturb, model and Android version. No identifiers. | No | Ask |
| `phone_shared_note` | A short note the user wrote in Winglet for the agent to read. User-authored share data; never inferred. | No | Ask |
| `phone_location` | Last/current fix reduced to latitude/longitude, horizontal accuracy, and a coarse accuracy cap. `precise` is opt-in per request. | Yes | Ask |
| `phone_contacts` | Name, phone numbers and email addresses for a user-supplied query, at most 5 matches. No photos, notes, addresses, birthdays or IDs. | Yes | Ask |
| `phone_calendar` | Title, start/end, all-day flag and calendar name for a user-supplied date range of at most 31 days, at most 50 events. No attendees, descriptions, locations or reminders. | Yes | Ask |

Deliberately **not** advertised and not implemented: screen time, Health Connect,
geofences/background location, alarms, SMS/call log, accessibility services,
device-admin, notifications, clipboard reads, shell/ADB. Unknown tool names are
rejected.

## 2. Capability keys and protocol

`Hub.features()` adds one additive boolean: `phone_tools` (true only when the
adapter installed the bridge). Old clients ignore it; an old server omits it and
the new app hides the feature.

WebSocket (namespaced, ignorable by older clients):

- app → server `phone_tools.hello` `{instance_id}` — sent after `hello` on each
  (re)connect. Until it arrives the server will not dispatch a request to that
  socket. A new `instance_id` (app restart) cancels that device's stale pending
  requests.
- server → app `phone_tool.request`
  `{request: {id, tool, args, mode, sensitive, expires_at, nonce, requested_at,
  bot: {name, title}, chat: {id, title}}}`
- server → app `phone_tool.cancel` `{id, reason}`
- app → server `phone_tool.decision`
  `{id, nonce, allow, remember?}` — `remember: true` turns this tool's mode into
  “while Winglet is open” for the same scope when the user chooses that in the
  sheet.
- app → server `phone_tool.answer`
  `{id, nonce, ok: true, result}` or `{id, nonce, ok: false, error, detail?}`

The answer/decision nonce is random per request and consumed once, so a replay
from the same socket is refused. Requests expire (default 120 s for “ask me every
time”, 20 s for “while Winglet is open”); an answer after expiry is ignored. Only
one answer settles a request.

HTTP routes (feature-local, listed in `ROUTE_POLICY`):

| Route | Policy | Purpose |
| --- | --- | --- |
| `GET /api/phone-tools` | `device` | This phone's grants for the current bot, plus catalog text and recent access. Never another device's grants. |
| `PUT /api/phone-tools` | `signed` | Enable/disable one tool, choose `while_open`/`ask`, choose `bot` or `server` scope. |
| `DELETE /api/phone-tools` | `signed` | One-step revoke-all for this phone (and cancel pending requests). |
| `GET /api/phone-tools/log` | `device` | This phone's own metadata-only access log. |

Scope: `bot` (default; the current server/bot) or `server` (“every bot on this
server”, owner devices only). The server records the bot it authenticated, never
a bot/device id from the body. A member can enable tools for their own phone but
cannot widen scope beyond the bot they can talk to.

## 3. Authorization and lifecycle

- Requests are accepted only on a Winglet turn: `HERMES_SESSION_PLATFORM` is
  `winglet`, `HERMES_SESSION_USER_ID` is `winglet:<device id>`, the chat row
  belongs to that device (member) or the device is an owner, and the chat's bot
  equals the bot the tool call is running as.
- The server re-checks the app grant **and** the tool's mode when the request is
  created. The app re-checks the OS permission immediately before reading; if it
  is missing or revoked the app answers `permission` and the tool returns an
  error, never a partial/guessed result.
- “While Winglet is open” requests require a foreground, handshaken socket for
  that device and bot. Otherwise the tool fails with `phone_offline` and nothing
  is queued for later.
- Unpair (`DELETE /api/me`), device removal, role change, app revoke-all, socket
  close (last socket for the device) and app-restart `instance_id` change cancel
  pending requests with `phone_tool.cancel` and settle the waiting tool call.
- Pending requests live in memory only. Results are returned to Hermes and are
  never stored by the plugin. Audit rows carry metadata only (tool, outcome,
  duration bucket, reason code) — never location coordinates, contact fields,
  note text or calendar titles.
- The app's request sheet names the bot, chat, tool and exact fields, with
  “Allow once” and “Don't allow”. “Always allow while Winglet is open” is a
  secondary choice that writes the same grant the settings screen writes.
- Web and iOS: the screen renders an explicit “Android only” unsupported state;
  no tool is advertised (`phone_tools` may be true for other phones on the
  server, but this device has no bridge).

## 4. Storage and migration

Additive, idempotent, feature-prefixed tables created by `Store.__init__`:

```sql
CREATE TABLE IF NOT EXISTS phone_tool_grants (
  device_id TEXT NOT NULL, tool TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'ask', enabled INTEGER NOT NULL DEFAULT 1,
  updated_at REAL NOT NULL, PRIMARY KEY (device_id, tool, scope)
);
CREATE INDEX IF NOT EXISTS phone_tool_grants_device ON phone_tool_grants (device_id);

CREATE TABLE IF NOT EXISTS phone_tool_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL,
  device_id TEXT NOT NULL DEFAULT '', bot TEXT NOT NULL DEFAULT '',
  chat_id TEXT NOT NULL DEFAULT '', tool TEXT NOT NULL, event TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS phone_tool_events_device ON phone_tool_events (device_id, ts);
CREATE INDEX IF NOT EXISTS phone_tool_events_ts ON phone_tool_events (ts);
```

No global migration number is allocated. Rollback: stop the gateway, then
`DROP TABLE IF EXISTS phone_tool_events; DROP TABLE IF EXISTS phone_tool_grants;`.
Nothing else reads these tables, so dropping them loses only grants and their
metadata log. `Store.prune()` keeps 30 days / 5000 newest event rows.

## 5. Shared files touched (kept minimal)

- `plugin/hub.py`: feature flag, 4 routes + `ROUTE_POLICY` entries, WS
  dispatch/hello field, device send helper, cancellation hooks on unpair/delete/
  role change/socket close.
- `plugin/store.py`: two tables, grant/event helpers, prune rule.
- `plugin/adapter.py`: construct/install the bridge, clear it on disconnect.
- `plugin/__init__.py` / `plugin/plugin.yaml`: `provides_tools` + tool
  registration.
- `app/src/lib/store.ts`: route `phone_tool.*` events to the feature and send the
  handshake after `hello`.
- `app/src/app/_layout.tsx`, `app/src/app/settings.tsx`: mount the request sheet
  and add the Settings entry.
- `app/app.config.js`: register the config plugin.
- New feature-local code lives in `app/src/features/phone-tools/`,
  `app/modules/winglet-phone-tools/`, `app/plugins/withPhoneTools.js`,
  `plugin/phone_tools.py`, `plugin/tools.py`.

No provider/model, pets, theme, navigation-order, release-workflow or CI-pin
changes.

## 6. UI plan

Entry point: Settings → Agent → **Phone tools** (below Agent settings, above
nothing else), with a status subtitle (“Off”, “3 tools allowed · Pixel 8”).
Primary action on the screen: the master switch. Turning it on does nothing
until a per-tool switch is on; turning it off revokes every tool immediately
(one step) and cancels pending requests.

Hierarchy:
1. Header card: master switch, one-sentence explanation, platform state
   (Android ready / permission needed / Android only), last-used line.
2. Grouped capabilities, one row per tool: title, one-line description, exact
   fields shared, mode segmented control (While open / Ask every time), switch,
   and a permission row when Android still needs it (“Allow Contacts”, “Open
   settings” after a permanent denial).
3. Scope: “This bot” / “Every bot on this server” (owner only), with a plain
   sentence about what that means.
4. Shared note: a small editor for `phone_shared_note` with a character limit.
5. Recent access: the last 20 metadata-only entries with time, tool and outcome;
   pull to refresh; “Clear log” is not offered (server-retained audit).
6. Revoke all: one destructive row with a confirm step.

States: loading skeleton; error with retry; offline banner (“Changes need the
server; the last saved state is shown”); unsupported (web/iOS); permission
missing/denied/permanently denied; no grants (empty state explains off-by-default);
long bot/tool names wrap, never truncate the switch.

Mobile: single column, 44–48 px rows, sheet for the request decision. Wide
(≥900 px): the same content in a centred 680 px column; the request sheet becomes
a centred dialog (existing `Sheet` behavior). Light/dark use theme tokens only.

Request sheet: bot + chat title, “wants to read your …”, a bullet list of exact
fields, a note that nothing is shared until Allow, “Allow once” primary,
“Don't allow” secondary, and “Always allow while Winglet is open” as a text
action. Expired requests close themselves with a short “Request expired” line.
Reduced motion respected by the existing Sheet.

## 7. Reference comparison (Herald)

| Reference (Herald, snapshot `95ca999`) | Winglet result | Edge cases/tests | Intentional difference / gap |
| --- | --- | --- | --- |
| `PhoneTool.kt` enumerates gateway tool ids with title/detail; user settings store enabled ids. | Same idea: `plugin/phone_tools.py` is the single catalog; server stores grants; app renders server text and adds OS state. | Catalog agreement test; unknown tool rejected; UI test that every enabled tool has a description. | Winglet stores grants on the server (per device) so revocation works even if the app cache is stale; Herald keeps them in app settings. |
| `PhoneToolsBridge.kt` polls the gateway and runs calls only for enabled tools. | Winglet is push-style over the existing authenticated WebSocket; one request bound to the originating chat. | Mismatch, replay, expiry, concurrency, restart tests. | No polling: a request for a closed app returns `phone_offline` instead of being picked up later. |
| `PhoneToolAccess.kt` separates “missing permission” from “needs system settings”. | Same: `permissionState`/`requestPermission`/`openSettings`, with repair guidance. | Permission-denied answer path test; UI state test. | Only the four Android permissions the feature uses; no Health Connect/accessibility/notification special access. |
| `PhoneToolsScreen.kt` groups tools with switches and a recent list. | Grouped capability rows + scope + note + recent access + one-step revoke. | Rendered web checks at 320/390/tablet/1440, light/dark. | Winglet uses its own typography/theme and a single master switch, no calls/rings/watch/geofence sections. |
| Herald contact lookup returns a small field set; calendar is range-limited. | Same field caps and range cap, enforced server-side and again in the app. | Bound tests for 5 contacts / 31 days / 50 events. | Winglet does not implement write operations (no create/move event, no calls). |

Reuse note: no Herald source file is copied verbatim. The tool scoping model,
permission-repair split and screen information hierarchy are adapted. A notice
with the upstream license text is included at
`third_party/notices/herald-phone-tools.md`.

## 8. Test plan

Backend (pytest): grant/deny/revoke; mode while-open vs ask; offline phone;
expiry and replayed nonce; bot/device mismatch; member vs owner scope; concurrent
requests; restart (`instance_id`) cancels; unpair/role change cancels; audit
contains no payload; store migration idempotent; tool registry hides tools when
no hub; session-context refusal outside Winglet.

App (node:test): protocol validation (shape, bounds, unknown tool), answer
nonce/expiry logic, grant merge, permission decision, note limits, calendar range,
expired request cleanup, unsupported platform state, and that a denial never
executes the native bridge.

Rendered: Playwright at 320, 390, tablet (820) and ~1440 px, light/dark, with a
local fixture server on port 9311 and Expo web on 8311.

## 9. MOBILE VALIDATION PENDING

Not run in this phase (deliberately): emulator/physical-device permission
dialogs, real location/contacts/calendar reads, app background/foreground
lifecycle, and native Gradle compilation if the SDK is unavailable. The recipe,
environment, synthetic data and expected outcomes are added in the final section
before handoff.

## 10. Stopped-state record (what is actually in the tree)

The implementation phase was stopped early at the user's request. **Nothing in
sections 1–9 is implemented yet** except the schema below. No commit, no push,
no PR.

Present, uncommitted, on branch `codex/major-11-phone-tools` (HEAD
`b71d93b459e1645e34cd47c80a392b146dca0e04`):

1. `plugin/store.py` (+16 lines): the two `CREATE TABLE IF NOT EXISTS` /
   `CREATE INDEX IF NOT EXISTS` statements for `phone_tool_grants` and
   `phone_tool_events` from section 4. No Python helper methods were added, and
   `Store.prune()` does **not** yet trim `phone_tool_events`. This is inert: no
   route, tool or code path reads or writes either table.
2. `docs/agent-handoffs/phone-tools.md` (this document): the planned contract.
3. `app/node_modules` present from `npm ci` (git-ignored; 624 packages).

Absent (every item still to be built):

- `plugin/phone_tools.py` — catalog, grants, pending requests, decisions,
  validation, audit, thread↔loop bridge.
- `plugin/tools.py` and `provides_tools` in `plugin/plugin.yaml`; registration in
  `plugin/__init__.py`.
- `plugin/hub.py` — `phone_tools` feature flag, `GET/PUT/DELETE /api/phone-tools`,
  `GET /api/phone-tools/log`, `ROUTE_POLICY` entries, WS `phone_tools.hello` /
  `phone_tool.*` dispatch, device-targeted send, cancellation on unpair /
  device delete / role change / socket close.
- `plugin/adapter.py` — bridge construction, install and shutdown.
- `plugin/store.py` — grant and event helper methods, prune rule.
- `app/src/features/phone-tools/` — types, protocol validation, API, native
  bridge, store, request handler.
- `app/src/app/phone-tools.tsx`, the global request sheet, Settings entry,
  `store.ts` wiring (`hello` handshake + `phone_tool.*` events), `_layout.tsx`
  mount, `app.config.js` plugin registration.
- `app/modules/winglet-phone-tools/` (Expo local module: Kotlin status, location,
  contacts, calendar, permission state/request/settings) and
  `app/plugins/withPhoneTools.js` (permissions
  `ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION`, `READ_CONTACTS`,
  `READ_CALENDAR`).
- All pytest and node:test coverage from section 8.
- `third_party/notices/herald-phone-tools.md` (required before any reused
  material lands; nothing has been reused yet, so the notice is not yet
  mandatory, but it is still to be written).
- The MOBILE VALIDATION PENDING recipe.

### Checks actually executed

| Check | Result |
| --- | --- |
| `Store()` creates both tables, columns as designed, and a second open is a no-op — throwaway SQLite file in the OS temp dir, no real data | **Passed** (tables `phone_tool_events`, `phone_tool_grants`; 6 and 8 columns as designed; reopen idempotent) |
| `npm ci` in `app/` | **Passed** (624 packages) |
| `python -m pytest tests/test_hub.py` | **Not a valid run** — three attempts executed from the shared checkout instead of this worktree and failed at collection with `ModuleNotFoundError: No module named 'aiohttp'` (system Python has no plugin dependencies). No temp or cache directories were left behind in either checkout. |
| `npm test`, `npm run typecheck`, `expo export --platform web`, `expo export --platform android` | **Not run** |
| Full plugin pytest suite, route-policy/trust tests | **Not run** (needs a private venv with `aiohttp`, `cryptography`, `httpx`, `qrcode`) |
| Playwright UI checks, screenshots | **Not run** — no UI exists yet |
| Native Gradle compile of the module | **Not run** — module does not exist yet |
