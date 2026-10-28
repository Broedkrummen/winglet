# Historical Winglet app plan: v0.1.3 → v0.7

> Historical reference. This plan predates the current implementation and is not the active roadmap.
> See [the issue-based roadmap](ROADMAP.md) for current work and approval status, [FEATURES.md](FEATURES.md)
> for existing capabilities, and [DESIGN.md](DESIGN.md) for current design guidance.

**Goal: everything you normally do with Hermes, from your phone, without opening the server, and
without making the server easier to misuse.**

This was the working plan for those releases. It covers the look and feel, the features, the
server-side work each feature needs, and the security model that server control depends on. Every
item has a priority, every milestone is split into small PRs, and every PR has acceptance criteria.

Priorities used throughout:

| Tag | Meaning |
| --- | --- |
| **P0** | Must have. The app feels broken, unsafe or incomplete without it. |
| **P1** | Should have. Part of "no SSH needed". |
| **P2** | Nice to have. Adds polish or covers rarer tasks. |
| **P3** | Later. Large, risky, or depends on Hermes features that are still moving. |

### Revision 2

This revision follows the first review of the plan. The main changes:

- **Security comes before administration.** Device identity, roles, a command policy that covers
  slash commands as well as endpoints, signed control actions, the audit log and durable jobs now
  ship as their own milestone (M3) before any feature that changes server settings (5.3, M3).
- **The guarantees are stated honestly.** Sealed secrets protect keys you type; signatures protect
  control actions; neither hides what the app displays from a tunnel that terminates TLS. The iPhone
  web app gets its own, weaker threat statement (5.3.6).
- **Reliability moved forward.** M0 now covers connection states, diagnostics, version visibility,
  drafts and a proper outbox, as well as a reconnect design that respects ntfy's limits (5.6, 5.7).
- **Corrected behaviours.** `/pause` is "Pause new work", not an emergency stop. Picker timeouts follow
  Hermes. The model chip says when it can't know the effective model. Approvals have no
  swipe-to-approve. The tool-progress card ships only if Hermes gives a reliable signal; no upstream
  change is required.
- **Accessibility is part of M1's acceptance**, and the colour tokens were re-tuned so every text pair
  passes WCAG AA (3.2).
- **Home leads with work**, the global Inbox stays, and attachments have a full lifecycle.
- **More modern essentials:** offline chat cache, share-to-Winglet, notification controls, an About
  screen, keyboard shortcuts, and fast lists.

---

## 1. What "done" looks like

From the app alone, you can:

1. Chat with Hermes, send it photos, files and voice notes, get them back, and never lose a message
   or a draft to a bad connection.
2. Always know why you're not connected, and what to do about it.
3. See what the agent is doing right now without a flood of messages.
4. Switch the model for one chat, or change the default, and set reasoning effort.
5. Add a new model provider (API key, sign-in, or a custom endpoint) and use it.
6. Read and edit the agent's persona and memory.
7. Give the agent a pet that reacts to what it's doing.
8. Create, pause and run scheduled tasks and long-running goals.
9. Install and toggle skills, tools and MCP servers.
10. Check server health, restart Hermes, update Hermes and Winglet, and read logs.
11. Pair a new phone, give it a role, and remove old ones.

And the server stays safe: a paired phone that isn't an owner can't change server settings by any
path, a captured token can't be replayed to run control actions, and every change is logged.

Anything that still needs a terminal after v0.7 should be the exception, not the rule. The one
deliberate exception is the first pairing: the first owner phone scans a QR from the server
terminal, because that QR is the root of trust (5.3.4).

---

## 2. Where we are (v0.1.2)

Works today: pairing by QR, multiple bots, streaming chat with Markdown, files and images *from* the
agent, a global inbox with approvals and questions, Web Push and ntfy notifications, the automatic
HTTPS tunnel, Android address recovery, and idempotent message sending (each message carries a
`client_id`; a retry reuses it).

Gaps found while reviewing the code:

| Gap | Where |
| --- | --- |
| Agent replies can't be selected or copied. Only code blocks are selectable. | `app/src/components/Markdown.tsx` |
| You can't send photos or files. There's no attach button and no upload endpoint. | `ChatView.tsx` composer, `plugin/hub.py` routes |
| Tool progress arrives as ordinary agent messages, so long tasks flood the chat. | `plugin/adapter.py` `send`/`edit_message` |
| Images are cropped to 280×200 and can't be opened full screen. | `ChatView.tsx` |
| One fixed dark palette. Colours are static constants used in about 200 places across 13 files. | `app/src/lib/theme.ts` |
| No animation or gesture library; only the built-in `Animated` API. | `app/package.json` |
| Address recovery runs when a connection opens, when the app returns to the foreground, and when a failed auth probe isn't a 401. Probes only follow the retry backoff (up to 30 s), so after a server restart with the app already open, finding the new address can take a while. Each recovery request replays the whole topic (`since=all`). | `app/src/lib/store.ts` `Connection`, `app/src/lib/recovery.ts` |
| Connection problems all look like "offline". There's no way to see why, or what version the server runs. | `store.ts` `ConnStatus` |
| Failed messages can be retried by hand, but drafts aren't saved and nothing is queued while offline. Messages aren't cached on the device, so chats are empty until the server answers. | `store.ts` `sendMessage`, `storage.ts` |
| Every device reaches Hermes as the same user (`winglet-owner`, `role_authorized=True`), including slash commands. There's no notion of roles. | `plugin/adapter.py` |
| The WebSocket carries the device token in its URL (`/api/ws?token=…`), where proxies may log it. | `plugin/hub.py`, `app/src/lib/api.ts` |
| Model, provider, persona, schedule, skills, logs and pairing all need the server's terminal. | n/a |

---

## 3. Design direction

### 3.1 Personality

A friendly personal agent, not a dashboard. The home screen tells you what needs you and what the
agent is doing; the agent has a face (its pet), but the face never pushes work off the screen.
Surfaces are calm, shapes are soft and rounded, and motion is lively but quick.

Power-user details stay: a rail of bots on wide screens, `#` side chats, a slash-command palette,
keyboard shortcuts, and an optional compact message layout. These are accents, not the main look.

### 3.2 Themes and colour

Three options in Settings → Appearance: **Light**, **Dark**, and **System** (follows the phone).

- **Dark is true black** (`#000000`) for OLED screens. Elevation comes from hairline borders and
  slightly lighter surfaces, not grey backgrounds.
- **Accent colour** is selectable: Iris (default), Ocean, Mint, Sunset, Rose. Each accent has two
  roles, because one colour can't serve both on true black:
  - `accent`: text, icons and outlines on the background.
  - `accentFill`: filled buttons and your message bubbles, always with white text (`onAccent`).
- **Per-bot colour.** Each bot keeps its own colour (from `botColor`) for its avatar ring and name.
  Bot colours are decoration only; they never carry text.

Semantic tokens (names, not hex values, are used everywhere in code):

| Token | Light | Dark (true black) |
| --- | --- | --- |
| `bg` | `#F6F6F9` | `#000000` |
| `surface` | `#FFFFFF` | `#0B0B0D` |
| `surfaceRaised` | `#FFFFFF` + shadow | `#141417` |
| `glass` | `rgba(255,255,255,0.62)` + blur | `rgba(22,22,26,0.58)` + blur |
| `glassOpaque` (no-blur fallback) | `#FFFFFF` | `#141417` |
| `border` | `rgba(0,0,0,0.08)` | `rgba(255,255,255,0.10)` |
| `text` | `#0B0B0F` | `#F5F5F7` |
| `textSecondary` | `#55555F` (6.8:1) | `#A1A1AA` (8.2:1) |
| `textTertiary` | `#6E6E78` (4.7:1) | `#8E8E96` (6.5:1) |
| `accent` (Iris) | `#5B4BD6` (5.7:1) | `#8B7CFF` (6.4:1) |
| `accentFill` / `onAccent` (Iris) | `#5B4BD6` / white (6.1:1) | `#5B4BD6` / white (6.1:1) |
| `accentSoft` | accent at 12% | accent at 18% |
| `success` | `#15803D` (4.7:1) | `#22C55E` (9.2:1) |
| `warning` | `#B45309` (4.7:1) | `#F59E0B` (9.8:1) |
| `danger` | `#B91C1C` (6.0:1) | `#FB7185` (7.8:1) |
| `codeBg` | `#F1F1F5` | `#0F0F12` |

Ratios are against `bg`. Every listed text colour also passes 4.5:1 on `surface` and
`surfaceRaised`.

| Accent | `accent` light | `accent` dark | `accentFill` (both themes, white text) |
| --- | --- | --- | --- |
| Iris | `#5B4BD6` | `#8B7CFF` | `#5B4BD6` |
| Ocean | `#0369A1` | `#38BDF8` | `#0369A1` |
| Mint | `#047857` | `#34D399` | `#047857` |
| Sunset | `#C2410C` | `#FB923C` | `#C2410C` |
| Rose | `#BE123C` | `#FB7185` | `#BE123C` |

The user bubble may use a subtle two-stop gradient of `accentFill`; the lighter stop must still give
white text 4.5:1. A unit test (`theme.test.ts`) computes the contrast of every text/background pair
for every theme × accent combination, so tuning can't silently break it.

### 3.3 Glass

Frosted glass is for floating chrome only: the tab bar, headers once content scrolls under them, the
composer, sheets, context menus, toasts and the pet's speech bubble. Never behind body text.

- Android: `expo-blur` behind one `<Glass>` component. If blur is slow on a phone, or when "Reduce
  transparency" is on (system or in-app), it renders `glassOpaque` instead.
- iPhone and desktop (web): CSS `backdrop-filter`, which `expo-blur` maps to on web.
- On true black, glass is a dark tint plus a hairline border, so it still reads as a layer.
- Text on glass uses `text`/`textSecondary` only, and is checked against the opaque fallback too.

### 3.4 Motion

Built on `react-native-reanimated` (springs and layout animations on the UI thread) and
`react-native-gesture-handler`.

| Preset | Use |
| --- | --- |
| `spring.snappy` (damping 20, stiffness 300) | Buttons, toggles, chips |
| `spring.soft` (damping 18, stiffness 180) | Sheets, cards, the pet |
| `duration.fast` 150 ms / `base` 250 ms / `slow` 400 ms | Fades, colour changes |

Catalogue:

- Messages fade and rise 8 px on arrival. Your own message slides up from the composer.
- Pressables scale to 0.97 on press.
- Bottom sheets spring open and drag to dismiss. Context menus scale in from the pressed message,
  with the background dimmed and blurred.
- Activity card: steps tick in; the spinner turns into a check.
- Typing indicator: the pet's run animation (falls back to animated dots).
- Skeleton placeholders while lists load. Pull-to-refresh shows the pet.
- Tab bar: the selected icon springs and the pill indicator slides between tabs.
- Goal completed: one short confetti burst.

**Reduce motion** follows the system setting (`AccessibilityInfo.isReduceMotionEnabled` on Android,
`prefers-reduced-motion` on web) and has an in-app override. It turns springs and slides into short
fades, and stops every loop: typing and pet animations show a still frame, skeleton shimmer becomes
a static block, and confetti and pet roaming are off.

### 3.5 Approvals: explicit, never by gesture alone

Approval cards keep the choices Hermes offers (for example *Once*, *This session*, *Always*, *Deny*)
as real buttons. Rules:

- A swipe may *reveal* the action buttons; it never approves by itself. There is no
  "swipe right to approve".
- Session-wide and persistent approvals are never the default or the largest button. *Always*
  needs a second tap on a confirm sheet that names exactly what it allows.
- The card shows the bot, the chat, the full command or request, and how long ago it arrived.
- Buttons act on release, not on press, so a touch can be cancelled by sliding off (WCAG 2.5.2).
- Every answer carries the request ID. A stale or already-answered ID gets "Already answered on
  another device" (the server already returns 409 for this), never a second execution.
- No "undo" after approving: once a command has started, it can't be taken back. The card says so.
- Tests cover two phones answering the same approval at the same moment.

### 3.6 Haptics

`expo-haptics` (already installed) behind one `haptics.ts` map so every screen feels the same:

| Moment | Haptic |
| --- | --- |
| Tab switch, picker change, chip toggle | `selection` |
| Send message, open context menu | `impact light` |
| Approval sent, task or goal completed | `notification success` |
| Denied, or an action failed | `notification error` |
| Pull-to-refresh triggers | `impact soft` |

Settings → Appearance has a haptics switch. The iPhone web app can't vibrate (Safari has no
Vibration API), so haptics are Android-only. Nothing relies on a haptic to convey information.

### 3.7 Shape and type

- Radii: 12 (chips), 16 (cards), 22 (sheets), 28 (composer). Avatars are squircles.
- Inter stays. Headings get tighter tracking; body text stays at 16.
- Text scales with the phone's font-size setting up to at least 200% without clipping or overlap;
  layouts wrap instead of truncating important text.

### 3.8 Accessibility (part of every UI PR's acceptance)

- Every control has an accessible label and role; icons-only buttons have labels; status changes
  (connection, sending failed, approval resolved) are announced to screen readers.
- Touch targets are at least 48×48 dp on Android (44×44 px on web).
- Web: full keyboard use (visible focus ring, logical tab order, Escape closes sheets and menus,
  focus returns to the trigger), and sheets trap focus while open.
- Colour is never the only signal: statuses pair colour with an icon or word.
- Reduce motion and reduce transparency as in 3.3 and 3.4.
- M1 adds automated checks where possible (contrast test, label lint on components) and a manual
  TalkBack and keyboard pass before each release.

### 3.9 Message layout

Two layouts in Settings → Appearance → Chat layout:

- **Bubbles (default).** Your messages are right-aligned accent bubbles. Agent replies are
  full-width, unboxed text next to the agent's avatar. Best for reading long answers on a phone.
- **Compact.** The current layout: everything left-aligned with avatar, name and time headers and
  grouped follow-ups. Denser; good on desktop.

---

## 4. App structure

### 4.1 Phone

A glass tab bar with four tabs. A bot switcher (avatar, name and an unread/pending badge) sits at the
top of each tab. Tapping it shows your bots, each with its pending count, and "Add a bot".

| Tab | Contents |
| --- | --- |
| **Home** | In this order: the main bot up front (its pet, name and one status line) with a message box, then a compact row of your other bots and an Add tile; **Needs you** (approvals and questions for this bot, plus a line like "2 waiting on other bots" that opens the global Inbox); **Working now** (running tasks, with Stop); **Continue** (the last chat you touched, one tap to resume); **Coming up** (next scheduled tasks, active goal); **Recent updates**. A quick composer posts to the main chat. Sections with nothing in them collapse. |
| **Chats** | The main chat pinned at the top, then side chats (`#` channels) with previews, unread counts and times. Search. New chat. |
| **Inbox** | **All bots** by default, with a bot filter. Approvals, questions and routine results. The tab badge counts pending items across every bot, so nothing on another bot goes unseen. |
| **Agent** | **Brain**: model, reasoning, providers, usage. **Identity**: pet, name, persona, memory. **Automations**: goals, schedule. **Abilities**: skills, tools, MCP. **Server**: health, updates, logs, devices, connection, activity. **Settings**: appearance, notifications, security, about. |

Agent sections the server doesn't support are hidden. Sections the server supports but the current
device can't use (a member device, or an unverified one) are shown greyed with one line saying why
and how to fix it. The app never ships a control that does nothing.

### 4.2 Tablet and desktop (wide layout)

Keep the current three columns (bot rail, chat list, chat), restyled. Add an optional right panel with
the agent card (pet, status, active goal) and the files shared in the current chat.
Keyboard shortcuts: `Ctrl/⌘+K` command palette, `Ctrl/⌘+N` new chat, `Ctrl/⌘+[`/`]` switch chats,
`Esc` closes, `Enter` sends and `Shift+Enter` adds a line, `↑` in an empty composer edits the last
message.

---

## 5. Architecture

### 5.1 App foundations

| Piece | Choice | Notes |
| --- | --- | --- |
| Theme engine | `ThemeProvider` + `useTheme()` + `makeStyles(theme => …)` | Replaces static `colors` imports. Persists the preference. Updates the status bar, the root background (`expo-system-ui`), the Android navigation bar (`expo-navigation-bar`, within SDK 57's edge-to-edge rules), and the web `theme-color`. |
| Motion | `react-native-reanimated`, `react-native-gesture-handler` | Installed with `npx expo install` so versions match the SDK. |
| Lists | `@shopify/flash-list` | Long chats and inbox stay smooth. |
| Sheets | `@gorhom/bottom-sheet` | Model picker, chat menu, attach menu, confirm dialogs. |
| Glass | `expo-blur` behind one `<Glass>` component | Fallback in one place. |
| Local cache | `expo-sqlite` (IndexedDB on web) | Messages, drafts and outbox. SecureStore stays for tokens and keys only; it isn't meant for bulk data. |
| Network state | `expo-network` | Tells "no internet" apart from "server unreachable", and triggers recovery when the network returns. |
| Media | `expo-image-picker`, `expo-document-picker`, `expo-image-manipulator`, `expo-audio`, `expo-video`, `expo-sharing`, `expo-file-system` | Upload, resize, HEIC→JPEG, location stripping, voice notes, playback, sharing. |
| Share into the app | Android share intent (config plugin); Web Share Target in the PWA manifest where supported | Send text, links, images and files from other apps to a chat. |
| Crypto | `@noble/curves` (new: X25519, Ed25519) alongside `@noble/ciphers` (already used for recovery's AES-GCM) | Sealed secrets and signed actions. |
| App lock | `expo-local-authentication` | Optional unlock and confirmation on this phone. A convenience, not a server-side control (5.3.5). |
| QR display | `react-native-qrcode-svg` | Pair another device from the app. |
| Syntax highlighting | A small highlighter with about 15 languages, no WebView | Keep the bundle small. |

New shared components: `Glass`, `Sheet`, `ContextMenu`, `Segmented`, `Chip`, `Skeleton`, `Toast`
(restyled), `Banner` (connection and version notices), `PetSprite`, `ModelChip`, `ActivityCard`,
`AttachmentTile`, `MediaViewer`, `ApprovalCard` (restyled to 3.5).

### 5.2 Plugin foundations

1. **`plugin/hermes_api.py` compatibility layer.** Every import of Hermes internals (`hermes_cli.*`,
   `agent.*`, `cron.*`, `gateway.*`) lives here, wrapped so a missing or changed function turns off
   one capability instead of crashing.
2. **Fail by capability.** Each optional integration registers separately. If one fails to import or
   initialise, it's logged and its flag is off; the platform adapter, chat, inbox and the
   `hermes winglet` command always register.
3. **Capability flags and versions.** `/api/info` gains `protocol` (an integer bumped on breaking
   changes), `min_app_protocol`, `winglet_version`, `hermes_version` and
   `features: {uploads: true, model_picker: true, pets: false, …}`. The app hides what's missing and
   says what to update.
4. **Supported Hermes versions.** The plugin declares a minimum Hermes version. CI runs the plugin
   tests against that minimum and a pinned current release (both must pass) and against upstream
   latest (reported, not blocking), so internal changes are caught early.

### 5.3 Security model

Server control turns a chat app into an admin console, so this section is the contract the control
features must meet. It ships in M3, before any feature that changes server settings.

#### 5.3.1 What we protect against

| Threat | In scope? |
| --- | --- |
| A paired device that shouldn't have admin rights (a family member's phone, an old tablet) | Yes: roles and policy (5.3.2, 5.3.3) |
| Someone who learns a device token, for example from a proxy log | Yes: tokens alone can't run control actions (5.3.5) |
| The tunnel provider or another TLS-terminating intermediary reading traffic | Partly: secrets you type are sealed (5.3.4); everything the app displays is still readable in quick-tunnel mode |
| An active intermediary changing traffic | Partly: signed actions and the QR-anchored key stop forged control actions and key swaps on the native app. The web app can't be protected the same way (5.3.6) |
| A stolen, unlocked phone | Partly: optional app lock; remove the device from another owner phone |
| A member asking the agent itself to do something harmful | No. See 5.3.3 |

In quick-tunnel mode, chat, memory, logs and anything else the app shows pass through Cloudflare in
readable form. For full privacy, use a direct private connection (LAN, or a VPN such as Tailscale).
An end-to-end encrypted transport is on the Later list (X5).

#### 5.3.2 Device identity and roles

- Each device has its own Hermes identity: `user_id = "winglet:<device_id>"`, `user_name` = the
  device name, instead of the shared `winglet-owner`. Hermes builds DM session keys from the chat ID
  and leaves the sender out when a chat ID is present (`gateway/session.py` `build_session_key`), so
  existing chats keep their sessions; a migration test confirms it.
- Two roles: **owner** (full control) and **member** (chat with the agent, answer the agent's
  questions in their own chats). Devices paired before the upgrade become owners, so nothing breaks
  for a one-person setup.
- At least one owner must remain; removing or demoting the last owner is refused.
- Roles are changed only by an owner, with a signed action (5.3.5), and are audited.

#### 5.3.3 One policy for every path

The same policy function decides every request, whichever way it arrives:

| Path | Enforcement |
| --- | --- |
| HTTP control endpoints | Route table marks each route `any`, `owner`, or `owner+signed`. |
| WebSocket messages | Same table, keyed by message type. |
| Slash commands typed in chat | The adapter inspects messages starting with `/` before they reach Hermes. Members may use an allowlist (Appendix C); everything else, including unknown and future commands and skill commands that change settings, is refused with a short explanation. |
| Approvals | By default only owners can approve dangerous commands, even in a member's chat; the request waits in the owners' Inbox. Members can answer the agent's ordinary questions. |
| Native pickers and confirmations | A picker opened by a member's command can only be answered by that member if the command was allowed; model and setting pickers are owner-only. |
| Sign-in flows | The `poll_id` is bound to the device that started the flow and expires with it; other devices get 404. |

**Reads are private too:**

| Data | Who can read |
| --- | --- |
| Chats | Owners see every chat. Members see chats they created. (Owners can share a chat with members.) |
| Inbox items | Items from chats the device can see; approvals go to owners. |
| Memory, persona, logs, audit log, devices list, job results, provider list, usage | Owners only. |
| Health and versions | Everyone (needed for connection diagnostics), without hostnames or paths for members. |

**What a member role is not.** Members talk to the same agent, with the same memory and, unless an
owner limits them (Agent → Tools → Members), the same tools. Anything the agent can do, a member can
ask it to do; the dangerous parts still stop at an owner's approval, and the agent's memory may
surface things an owner told it. The role is for people
you trust to talk to your agent, not a sandbox. The app says this when you make someone a member.

**Acceptance (two devices, in pytest and the e2e harness):** a member is refused on each control
endpoint *and* on the equivalent slash command (`/model`, `/pause`, `/restart`, `/update`,
`/approve`, `/personality`…); a member can't read owner-only data; a member can't answer an
approval; a sign-in `poll_id` from one device is useless on another.

#### 5.3.4 Server key and sealed secrets

- At setup the server creates an X25519 key pair (stored `0600` in the plugin's data directory). The
  pairing QR carries its fingerprint, and the app pins it. Because the QR comes from the server
  terminal (or from another verified owner's screen), this works even if the first network exchange
  is intercepted.
- **Pairing is sealed too.** The new device sends its pairing code and its signing public key
  encrypted to the QR's server key, so an intermediary can't substitute its own device key.
- **Secrets are sealed.** API keys and other credentials are encrypted on the phone to the server key
  (X25519 + HKDF + AES-GCM, with the device ID and purpose in the associated data) and decrypted only
  on the server. They're write-only: no API returns them, only "set" and the last 4 characters. They
  never appear in logs, the audit log or error messages (tests check this).
- **Devices paired before this change** don't have a verified key. They keep chatting, but secret
  entry and owner actions stay locked until the device is verified by scanning a fresh QR: either
  from the server (`hermes winglet pair --verify`) or from another verified owner phone. This is a
  one-time step, and the app explains it.
- **Rotation.** `hermes winglet rotate-key`, or an owner action, creates a new key pair. The new
  public key is announced signed by the old one, so verified devices move over automatically. A key
  change without a valid continuity signature locks secret entry and owner actions and asks for a
  re-scan. A suspected compromise means re-pairing from the terminal.

#### 5.3.5 Signed control actions

The bearer token authenticates the device for chat. It is not enough for control:

- Each device creates an Ed25519 key pair at pairing and keeps the private key in SecureStore. The
  server stores the public key with the device record.
- Every `owner+signed` request carries a signature over the method, path, body hash, device ID,
  timestamp and a random nonce. The server rejects stale timestamps (±60 s), reused nonces (kept for
  the window), unknown keys and non-owner devices.
- So a token captured in transit or from a log can't be replayed or used to forge a control action,
  and an intermediary can't alter a signed request.
- **App lock and biometrics are local.** They stop someone holding your unlocked phone; they do not
  restrict anyone calling the API directly. The server's protection is the signature and the role.
- Hardening that ships alongside: the WebSocket authenticates in its first frame (or a subprotocol
  header) instead of `?token=` in the URL; device tokens can be rotated from the app; pairing codes
  are single-use, short-lived and rate-limited.

#### 5.3.6 The iPhone web app

The web app's code is itself delivered through the tunnel. In quick-tunnel mode, an active
intermediary could serve modified code that reads a key before it's encrypted or signs what it
likes. The web app uses the same protocol (keys held as non-extractable WebCrypto keys), which still
defeats passive reading and token replay, but it can't promise the native app's protection against
an active intermediary.

So, by default, in quick-tunnel mode the web app can be an owner for everyday controls, but entering
provider keys and other secrets from the web app is off, with a setting (Settings → Security → "Allow
entering secrets from web apps") that explains the trade-off. On a direct or private connection the
restriction lifts. The README states this plainly.

#### 5.3.7 Audit log

Every control action (role change, key added or removed, model default changed, persona or memory
edit, restart, pause, update, device paired or removed, schedule change, skill or MCP change) is
written with device, role, time, action, a redacted summary, and outcome. Owners see it under Agent →
Server → Activity. It's append-only from the API and capped by age and size.

### 5.4 Durable jobs

Long actions (update Hermes, update Winglet, restart, pet hatch, skill install) can outlive the
WebSocket, the gateway process, and the reply that started them.

- **Submission is idempotent.** The app sends an `idempotency_key`; a repeat returns the existing
  job. If the reply is lost, the app looks the job up by that key. It never resubmits an update or
  restart on its own.
- **State lives in SQLite** (the plugin's existing store): id, kind, key, device, state
  (`queued`/`running`/`succeeded`/`failed`/`interrupted`/`unknown`), steps, timestamps, target and
  observed versions, and a log tail.
- **Work that restarts the gateway runs outside it**, through Hermes's own lifecycle: the same path as
  `hermes gateway restart`, the service manager when Hermes runs as a service, and `hermes update` /
  the plugin updater as a detached process that writes progress to a file.
- **Startup reconciliation.** When the gateway starts, it checks every job left `running`: if the
  observed versions match the target and the health check passes, it's `succeeded`; if the process
  failed, `failed` with its log tail; if it can't tell, `unknown`, with "Check the server" guidance.
- **Success means verified.** The app shows success only after it reconnects and `/api/info` reports
  the target version and a healthy server.

### 5.5 Using Hermes's own hooks

Hermes lets chat platforms draw native UI for some commands; Telegram, Slack and Matrix use these
hooks. Winglet implements the same ones, so behaviour, validation and permissions stay Hermes's own:

| Hook (on the adapter) | Called by | Winglet renders |
| --- | --- | --- |
| `send_model_picker(chat_id, providers, current_model, current_provider, session_key, on_model_selected, metadata)` | `/model` with no arguments (`gateway/slash_commands_model.py`) | Sheet: provider → model, search, current marked. Selecting calls `on_model_selected`. |
| `send_choice_picker(chat_id, title, choices, session_key, on_choice_selected, metadata)` | `/reasoning`, `/fast` | Segmented control or option list. |
| `send_slash_confirm(chat_id, title, message, session_key, confirm_id, metadata)` | Commands that need confirmation, such as `/reload-mcp` | Confirm sheet with the options Hermes offers. |
| `send_or_update_status(chat_id, status_key, content, metadata=…)` | Status messages (context pressure, compression, fallback) | One status line edited in place. |
| `send_exec_approval` (done), `send_clarify` (done) | Approvals, questions | Inbox cards, restyled to 3.5. |

Pickers are stored as inbox items (`kind: "picker"`) with the callback held in memory. Each keeps the
timeout and resolution contract of the Hermes code that opened it (slash confirmations currently
expire after 300 s, `tools/slash_confirm.py`). After a timeout or restart the card shows "Expired —
run the command again", and Hermes's own text fallback applies.

For everything else, the plugin calls the same library functions Hermes's dashboard uses (Appendix A).

### 5.6 Reconnect and address recovery

One `RecoveryCoordinator` serves all bots, so recovery traffic doesn't grow with the number of bots.

- **Triggers:** the WebSocket closes while the network is up; the app returns to the foreground;
  the network comes back (`expo-network`); a reachability probe fails with anything but 401.
- **Foreground only.** Android suspends background apps, so recovery doesn't try to run in the
  background; it runs the moment the app is opened.
- **Subscribe, don't poll.** While any bot is recovering and the app is visible, open one ntfy
  WebSocket subscription per ntfy server covering every recovering topic
  (`wss://<server>/<topic1>,<topic2>/ws?since=<cursor>`). New announcements arrive instantly with one
  connection. Close it when every bot is back, after 2 minutes, or when the app is backgrounded.
- **Fallback polling** if the subscription can't open: one request per ntfy server for all topics,
  every 15 s with ±30% jitter. HTTP 429 backs off exponentially from 60 s. This stays well inside
  ntfy's per-IP request budget even on shared Wi-Fi.
- **Incremental cursor.** Each bot remembers the ID of the last announcement it *verified*, and asks
  for messages since then. `since=all` is used only for the first recovery or when the cursor has
  expired from ntfy's cache. The cursor advances only past messages that were processed, so an
  authenticated announcement is never skipped.
- **Unchanged safety checks.** Announcements are still decrypted and authenticated (AES-GCM),
  revisions must increase, and the new address must prove the server's identity before the app
  sends its token there.
- **Reconnect backoff** caps at 10 s while visible, with jitter; a manual "Try now" resets it.
- **Target:** on a healthy network, an open Android app is back online within 10 s of the server
  publishing its new address. Measured in the e2e harness (p50/p90 over 20 forced address changes)
  and spot-checked on a real phone.

**Connection states** shown in the header banner, each with one clear action:

| State | Meaning | Action |
| --- | --- | --- |
| Connecting | First attempt | — |
| No internet | The phone is offline | Waits for the network |
| Can't reach *bot* | Network is up, server isn't answering | "Try now"; shows the next retry time |
| Finding *bot*'s new address | Recovery in progress | — |
| Signed out | Token rejected: the device was removed or the token rotated | "Pair again" |
| Update needed | `protocol` outside what the app supports, either way round | Says which side to update and how |
| Online | — | — |

**Diagnostics:** Settings → Connection → "Diagnostics" shows the state history, last error, address
host, recovery status, versions and protocol. "Copy report" produces a redacted text report (no
tokens, no full URLs, no message text, no keys) to share when asking for help.

### 5.7 Reliable sending

- **Drafts** are saved per bot and chat in the local cache as you type, and survive navigation and
  app restarts. Attachments in a draft survive too until sent or removed.
- **Outbox.** Each message shows its state: *queued* (offline), *sending*, *sent*, *failed*.
  Queued messages send in order when the connection returns, reusing their `client_id`, so a retry
  after a lost reply never duplicates a message (the server already deduplicates by `client_id`).
  Failed messages offer Retry, Edit and Delete.
- **Never automatic for control actions.** Model changes, settings, restarts, updates and approvals
  are never queued or replayed after a disconnect; the app asks you to try again, and jobs are looked
  up by their idempotency key (5.4).
- **Offline reading.** The last 200 messages per chat are cached on the device, so chats open
  instantly and can be read with no connection; the server remains the source of truth and the
  cache reconciles on reconnect. "Clear cache" is in Settings → Storage.

### 5.8 Attachments

- **Upload:** streamed to disk under the plugin's data directory, with a server-set size limit, MIME
  sniffing (not trusting the client's type), generated file names, and path-traversal checks.
- **Ownership:** each upload belongs to the device and chat that created it; only that device can
  attach it, and only devices that can see the chat can download it.
- **Quotas:** per-file size, per-device daily total, and a total disk cap, all configurable.
- **Lifecycle:** uploads never attached to a sent message are deleted after 24 hours. Sent
  attachments follow a retention setting (default: keep while the chat exists; deleted with it).
- **Safe serving:** raster images, audio, video and PDF can be shown inline; anything else
  (including HTML, SVG and scripts) is served as a download with `Content-Disposition: attachment`,
  `X-Content-Type-Options: nosniff` and a sandboxing CSP.
- **Privacy:** photos are resized and their location metadata is stripped by default (a switch in the
  attach sheet keeps the original).

### 5.9 Testing

- **Plugin:** pytest for every new endpoint and command path, including the two-device role tests
  (5.3.3), signature and replay rejection, oversized uploads, path traversal, quotas, secret
  redaction, and job reconciliation after a simulated restart.
- **Compatibility:** the minimum and pinned Hermes versions (blocking) and upstream latest
  (non-blocking), as in 5.2.
- **End-to-end:** the fake-model gateway harness moves into `tests/e2e/`. It drives a real Hermes
  gateway with a scripted model and covers uploads, pickers, approvals from two devices, recovery
  timing, and the outbox across a disconnect.
- **App:** unit tests for the theme contrast table, the recovery coordinator (budget, jitter,
  cursor), the outbox state machine and signature construction.
- **Visual:** Playwright screenshots of the web build in light and dark, attached to each UI PR.
- **Device check:** each milestone is tried on a real Android phone (blur performance, haptics,
  TalkBack, camera, voice, large text) before release.

---

## 6. Feature catalogue

### 6.1 Look and feel

| ID | Feature | Pri | Milestone |
| --- | --- | --- | --- |
| L1 | Theme engine with semantic tokens and contrast test | P0 | M1 |
| L2 | Light, true-black Dark, System | P0 | M1 |
| L3 | Accent colour presets | P1 | M1 |
| L4 | Glass chrome with opaque fallback | P0 | M1 |
| L5 | Motion system and catalogue (3.4) | P1 | M1 (base), then each milestone |
| L6 | Haptics map and switch | P1 | M1 |
| L7 | New navigation: tab bar, bot switcher with badges, Home | P0 | M1 |
| L8 | Bubbles / Compact chat layout | P1 | M1 |
| L9 | Skeleton loading, empty states, pull-to-refresh | P1 | M1 |
| L10 | Accessibility baseline (3.8), reduce motion and transparency | P0 | M1 |
| L11 | First-run tour (three screens: chat, inbox, agent) | P2 | M1 |
| L12 | Alternate app icons (Android) | P3 | Later |

### 6.2 Chat

| ID | Feature | Pri | Milestone |
| --- | --- | --- | --- |
| C1 | Selectable agent text and a copy button on code blocks | P0 | M0 |
| C2 | Drafts per bot and chat, kept across restarts | P0 | M0 |
| C3 | Outbox: queued / sending / sent / failed, ordered resend with the same `client_id` | P0 | M0 |
| C4 | Offline chat cache | P1 | M0 |
| C5 | Long-press menu: Copy, Reply, Retry, Edit last message, Share | P0 | M2 |
| C6 | Reply to a message (quoted context sent as Hermes `reply_to_text`) | P1 | M2 |
| C7 | Activity card for tool progress, only with a reliable signal (M2-6) | P1 | M2 |
| C8 | Jump-to-latest button with an unread count | P1 | M2 |
| C9 | Syntax highlighting, collapsible long code, better tables, maths | P1 | M2 |
| C10 | Slash palette fed by the server (role-aware) | P1 | M2 |
| C11 | While the agent works: Steer now (`/steer`), Queue next (`/queue`), Stop (`/stop`) | P1 | M2 |
| C12 | Export a chat as Markdown | P2 | M2 |
| C13 | Keyboard shortcuts on web/desktop (4.2) | P2 | M2 |
| C14 | Message search (server full-text search) | P2 | M6 |
| C15 | Branch a message into a side chat | P2 | M6 |

### 6.3 Media and sharing

| ID | Feature | Pri | Milestone |
| --- | --- | --- | --- |
| U1 | Upload photos (camera, gallery, several at once) with progress and cancel | P0 | M2 |
| U2 | Upload files (any type, within server limits) | P0 | M2 |
| U3 | Paste and drag-and-drop on web/desktop | P1 | M2 |
| U4 | Full-screen image viewer: pinch-zoom, swipe to close, save, share | P0 | M2 |
| U5 | Voice notes: hold to record, transcribed by Hermes | P1 | M2 |
| U6 | Inline audio and video players | P1 | M2 |
| U7 | Share into Winglet from other apps | P1 | M2 |
| U8 | Attachment lifecycle: ownership, quotas, cleanup, safe serving (5.8) | P0 | M2 |
| U9 | Files panel: everything shared in a chat | P2 | M6 |

### 6.4 Notifications

| ID | Feature | Pri | Milestone |
| --- | --- | --- | --- |
| N1 | Tapping a notification opens the exact chat or inbox item | P0 | M1 |
| N2 | Notifications grouped per bot and chat; Android channels per kind (approvals, questions, replies, routines) | P1 | M1 |
| N3 | Mute a bot or chat (1 h, 8 h, until changed) | P1 | M2 |
| N4 | Quiet hours, with approvals optionally still allowed through | P2 | M2 |
| N5 | Inline reply from an Android notification (uses the outbox) | P2 | M6 |
| N6 | Approvals are never approved from a notification; it opens the card | P0 | M1 |

### 6.5 Agent brain

| ID | Feature | Pri | Milestone |
| --- | --- | --- | --- |
| B1 | Model chip: the configured model, marked "may differ" when Hermes can't report the effective one | P0 | M4 |
| B2 | Native model picker for this chat (`send_model_picker`) | P0 | M4 |
| B3 | Default model for new chats | P0 | M4 |
| B4 | Reasoning effort and fast mode pickers | P1 | M4 |
| B5 | Add a provider: API key, sign-in flow, custom OpenAI-compatible endpoint | P0 | M4 |
| B6 | Provider list with status; remove a provider | P1 | M4 |
| B7 | Usage and cost by day and model | P2 | M4 |
| B8 | Fallback and auxiliary model slots | P3 | Later |

### 6.6 Identity and pets

| ID | Feature | Pri | Milestone |
| --- | --- | --- | --- |
| I1 | Pet as the agent's avatar, animated by what the agent is doing | P1 | M4 |
| I2 | Pet gallery: browse, install, choose | P1 | M4 |
| I3 | Hatch a new pet from a description (needs an image-generation provider) | P2 | M6 |
| I4 | Floating pet companion with a status bubble | P2 | M6 |
| I5 | Persona editor (SOUL) and personality presets | P1 | M4 |
| I6 | Memory viewer and editor; pending memory writes in the inbox | P1 | M4 |
| I7 | Bot display name and description | P2 | M4 |

### 6.7 Automations

| ID | Feature | Pri | Milestone |
| --- | --- | --- | --- |
| A1 | Schedule: list, create, edit, pause, resume, run now, history. Plain-language times are confirmed with the parsed schedule, the server's timezone and the next three run times before saving. | P1 | M5 |
| A2 | Goals: set, track progress, add subgoals, finish | P1 | M6 |
| A3 | Suggested automations and templates | P2 | M6 |
| A4 | Heartbeat / loop prompts per chat | P3 | Later |

### 6.8 Abilities

| ID | Feature | Pri | Milestone |
| --- | --- | --- | --- |
| S1 | Skills: list, search, install, enable/disable, read | P1 | M5 |
| S2 | Toolsets: enable/disable; approval mode (strong warning for "always allow") | P1 | M5 |
| S3 | MCP servers: list, add from catalogue, enable/disable, sign in | P2 | M5 |

### 6.9 Security and devices

| ID | Feature | Pri | Milestone |
| --- | --- | --- | --- |
| D1 | Instant reconnect with the recovery coordinator (5.6) | P0 | M0 |
| D2 | Connection states and redacted diagnostics (5.6) | P0 | M0 |
| D3 | About: app, Winglet and Hermes versions, protocol check, update instructions | P0 | M0 |
| D4 | Per-device identity, roles, one policy for every path (5.3.2, 5.3.3) | P0 | M3 |
| D5 | Server key, verified pairing, sealed secrets, key rotation (5.3.4) | P0 | M3 |
| D6 | Signed control actions; token out of the WebSocket URL; token rotation (5.3.5) | P0 | M3 |
| D7 | Audit log (5.3.7) | P0 | M3 |
| D8 | Devices: list, rename, role, last seen, remove; pair another device from the app | P0 | M3 |
| D9 | App lock (local) | P1 | M3 |
| D10 | Connection settings: mode, address, tunnel and notification status | P1 | M5 |
| D11 | Permanent address wizard (own domain via a named tunnel) | P3 | Later |
| D12 | iPhone address recovery | P3 | Later |

### 6.10 Server control

| ID | Feature | Pri | Milestone |
| --- | --- | --- | --- |
| R1 | Durable job runner (5.4) | P0 | M3 |
| R2 | Health: online/uptime, versions, CPU/RAM/disk, connection mode | P0 | M5 |
| R3 | Restart Hermes, showing running work first | P0 | M5 |
| R4 | **Pause new work** / Resume (`/pause`): stops new turns and scheduled runs; work already running continues | P1 | M5 |
| R5 | **Stop current task** in a chat (`/stop`): interrupts that chat's running turn and its background processes | P0 | M2 (in chat), M5 (from Home) |
| R6 | Update Hermes, as a durable job with progress | P1 | M5 |
| R7 | Update Winglet plugin, then restart | P1 | M5 |
| R8 | App update check (new APK on GitHub Releases) | P1 | M5 |
| R9 | Logs: live tail, level filter, search, redacted debug report | P1 | M5 |
| R10 | Hermes sessions browser and search | P2 | M6 |
| R11 | Workspace file browser | P2 | M6 |
| R12 | Backups: create and download | P2 | M6 |
| R13 | Terminal from the phone (off by default, owner, signed, verified native device only) | P3 | Later |

### 6.11 Later

| ID | Feature | Pri |
| --- | --- | --- |
| X1 | Live screen: watch and take over the agent's computer | P3 |
| X2 | Real-time voice call with the agent | P3 |
| X3 | Android home-screen widget (status and quick ask) | P3 |
| X4 | Smaller APK (one per CPU architecture; currently about 75 MB universal) | P2 |
| X5 | End-to-end encrypted transport, so the tunnel sees nothing | P3 |
| X6 | Languages other than English | P3 |

---

## 7. Milestones and PRs

Each PR stays small enough to review in one sitting, with short, focused commits. Each milestone ends
with a release. Visual flourishes are polish layered onto working features, never a prerequisite for
them.

### M0: Reliable basics (v0.1.3)

**PR M0-1: Recovery coordinator and fast reconnect.**
- One coordinator for all bots; triggers, foreground gating, ntfy multi-topic subscription with a
  polling fallback, jitter, 429 backoff, incremental cursor (5.6).
- Backoff capped at 10 s while visible; "Try now".
- Acceptance: the 10 s target in the e2e harness; with five bots recovering, at most one connection
  per ntfy server and no more than one fallback request per 15 s per server; replay and identity
  checks unchanged (existing tests still pass, new tests for the cursor).

**PR M0-2: Connection states, diagnostics, About.**
- The states table in 5.6 with banners and actions; Diagnostics with a redacted report.
- `/api/info` gains `protocol`, versions and `features` (5.2). About screen with update instructions
  when either side is out of date.
- Acceptance: each state can be produced in the harness and shows the right action; the report
  contains no token, URL path, key or message text.

**PR M0-3: Copy text.**
- Selectable agent text; copy button on code blocks with a "Copied" toast.

**PR M0-4: Drafts, outbox and offline cache.**
- Local cache (`expo-sqlite`, IndexedDB on web), drafts, outbox states and ordered resend, offline
  reading (5.7).
- Acceptance: type a draft, kill the app, reopen: the draft is there. Send three messages in
  airplane mode, reconnect: they arrive once each, in order.

### M1: The new look (v0.2.0)

**PR M1-1: Theme engine.**
- Tokens (3.2), `ThemeProvider`, `useTheme`, `makeStyles`; migrate all 13 files; Light / Dark /
  System and accents; status bar, navigation bar and web theme colour.
- Acceptance: switching theme updates every screen live; no hex values outside `theme.ts`; the
  contrast test passes for every theme × accent; screenshots in both themes.

**PR M1-2: Motion, gestures, haptics.**
- Reanimated and gesture-handler; presets; `haptics.ts`; reduce motion stops every loop (3.4).
- Acceptance: APK builds in CI; no visible frame drops on a mid-range phone; reduce motion verified.

**PR M1-3: Core components.**
- `Glass` (with opaque fallback), `Sheet`, `ContextMenu`, `Segmented`, `Chip`, `Skeleton`,
  `Banner`, restyled `Button`/`Row`/`Toast`, `ApprovalCard` to the rules in 3.5.
- Acceptance: a development-only gallery screen shows every component in both themes; each passes
  the accessibility checklist (labels, targets, focus, large text).

**PR M1-4: Navigation and Home.**
- Tab bar, bot switcher with pending badges, Home in the order of 4.1, global Inbox with All bots and
  a bot filter, Agent tab with capability-aware sections.
- Notification taps open the exact item; notification channels and grouping (N1, N2, N6).
- Acceptance: every existing feature is reachable; deep links (`/chat/…`, `/inbox`, `/pair`) and the
  Android back gesture work; an approval on bot B is visible while viewing bot A.

**PR M1-5: Chat restyle.**
- Bubbles and Compact layouts, the new composer, enter animations, skeletons, FlashList.
- Acceptance: a 2,000-message chat scrolls smoothly; streaming still works; screenshots in both
  layouts and themes.

### M2: Chat essentials (v0.3.0)

**PR M2-1: Uploads, server side.**
- `POST /api/chats/{id}/uploads`, `attachments: [upload ids]` on messages, the lifecycle in 5.8.
- The adapter builds a `MessageEvent` with `media_urls`/`media_types` via Hermes's
  `cache_media_bytes` and sets `message_type` (PHOTO, DOCUMENT, VOICE, VIDEO).
- Acceptance: pytest covers limits, quotas, bad types, traversal, ownership, cleanup and safe
  serving; in the e2e harness the agent receives the image.

**PR M2-2: Uploads, app side.**
- Attach sheet (Camera, Photos, Files), thumbnails with progress and cancel, resize, HEIC→JPEG,
  location stripping, paste and drag-and-drop on web; attachments kept in drafts.
- Acceptance: send a gallery photo, a camera photo and a PDF on Android and the iPhone web app.

**PR M2-3: Media viewer and players.**
- Full-screen viewer (zoom, swipe to close, save, share), image grid, inline audio and video.

**PR M2-4: Voice notes.**
- Hold to record, slide to cancel, upload as VOICE; transcript shown under the note.
- Acceptance: works when speech-to-text is configured in Hermes; otherwise the app explains what's
  missing.

**PR M2-5: Message actions, replies and sharing.**
- Context menu (Copy, Reply, Retry, Edit last, Share), reply quoting via `reply_to_text`, syntax
  highlighting and maths, chat export, share-into-Winglet, mute (N3, N4).

**PR M2-6: Activity card (gated).**
- Investigate first: what Hermes passes with tool progress (`metadata` on `send`/`edit_message`,
  message IDs that get edited in place, the status hook). No upstream change is part of this plan.
- Ship the card only if progress can be identified from metadata Hermes sets on purpose. Never
  classify by message text, since a real answer can look like progress.
- If there's no reliable signal, progress stays as ordinary messages and the capability flag stays
  off. `send_or_update_status` (status edited in place) ships either way.
- Acceptance (if shipped): a 10-tool turn shows one card, and a reply that *quotes* tool output is
  still shown as a reply.

**PR M2-7: Composer upgrades.**
- Server-fed, role-aware slash palette (`GET /api/commands`). Steer / Queue / Stop while busy.
  Jump-to-latest. Keyboard shortcuts on web.

### M3: Trust and control foundation (v0.4.0)

Nothing in later milestones that changes server settings may merge before this milestone ships.

**PR M3-1: Device identity and policy.**
- Per-device Hermes identity with session-continuity migration; owner/member roles; the policy
  function and route table; slash-command filtering with the member allowlist (Appendix C);
  owner-only approvals; read permissions (5.3.2, 5.3.3).
- Acceptance: the two-device tests in 5.3.3.

**PR M3-2: Server key, verified pairing, sealed secrets.**
- Key pair, fingerprint in the QR, sealed pairing, sealing helper and server decryption,
  verification of older devices, rotation with continuity (5.3.4).
- Acceptance: a sealed test secret round-trips; a swapped key is detected; secrets never appear in
  any response, log or audit entry.

**PR M3-3: Signed actions and token hardening.**
- Device signing keys, the `owner+signed` check with timestamp and nonce; WebSocket auth without
  the URL token; token rotation; pairing-code limits (5.3.5).
- Acceptance: replayed, altered, stale and unsigned requests are rejected; a stolen bearer token
  can chat but can't run a control action.

**PR M3-4: Audit log and durable jobs.**
- Audit log (5.3.7) and the job runner with reconciliation (5.4).
- Acceptance: a job interrupted by a simulated restart ends `succeeded`, `failed` or `unknown`
  correctly; a lost reply doesn't create a second job.

**PR M3-5: Devices and app lock.**
- Devices list (rename, role, last seen, remove, last-owner guard); "Add a device" mints a
  single-use pairing code and shows the QR on a verified owner phone; optional app lock.
- Acceptance: pair a second phone using only the first; make it a member; it can't use `/model`.

### M4: Your agent (v0.5.0)

**PR M4-1: Native pickers.**
- `send_model_picker`, `send_choice_picker` and `send_slash_confirm` in the adapter, stored as
  `kind: "picker"` items with Hermes's own timeouts; `POST /api/pickers/{id}/select`; a hidden
  command flag so the model chip can send `/model` without a command bubble.
- Acceptance: switching the model from the chip changes that chat only, through Hermes's switch
  logic; `/reasoning` and `/fast` show pickers; an expired picker says so.

**PR M4-2: Model chip and default model.**
- `GET /api/agent` (default model, reasoning, personality, pet, versions).
- The chip shows the effective model only where Hermes exposes it through `hermes_api.py`; otherwise
  the configured model marked "may differ", since a slash command or an automatic fallback can change
  it. Fallback notices from `send_or_update_status` update the chip.
- Default model through the same functions as Hermes's `/api/model/options` and `/api/model/set`,
  including the expensive-model confirmation; signed and audited.

**PR M4-3: Providers.**
- Provider list with status; add an API key (sealed, validated before saving); sign-in flows bound
  to the device; custom endpoint (base URL, sealed key, model discovery); remove a provider.
- Acceptance: add an OpenRouter key from the phone, pick one of its models and chat with it; the key
  never appears in any response or log; the flow is refused from a member device.

**PR M4-4: Identity.**
- Persona (SOUL) editor, personality picker, memory viewer and editor, pending memory writes as
  inbox items, bot name and description. Edits are signed and audited.

**PR M4-5: Pets.**
- Server: installed pets, spritesheet (cached), gallery, install, set active (`display.pet.slug`),
  remove.
- App: `PetSprite` with 192×208 frames, 8×9 sheets (9×8 legacy), 6 frames per state, about 1.1 s
  per loop; still frame when reduce motion is on.
- States follow Hermes's `derive_pet_state` priority: error → failed; goal or todo done → jump;
  reply finished → wave (2.5 s); waiting on approval or question → waiting; tool running → run;
  reasoning → review; busy → run; otherwise idle.
- Port the sprite logic from Hermes Desktop's `pet-sprite.tsx` (MIT, keep the notice).
- Acceptance: install a pet from the phone and watch it change state through a turn with tools and
  an approval.

**PR M4-6: Usage.**
- Tokens and cost by day and model, plus the `/usage` summary.

### M5: Control center (v0.6.0)

**PR M5-1: Health and lifecycle.**
- Health screen. Restart (shows running work first). **Pause new work** / Resume, labelled with what
  it does and doesn't stop. Stop current task from Home. Update Hermes and Winglet as durable jobs.
  App update check.
- Acceptance: update Winglet from the phone; the app reconnects and shows success only after the new
  version and a healthy server are confirmed.

**PR M5-2: Logs.**
- Live tail, level filter, search, redacted debug report. Owner-only.

**PR M5-3: Schedule.**
- List, create, edit, pause/resume, run now, history, delivery to the Updates chat; plain-language
  times confirmed with timezone and next runs (A1).

**PR M5-4: Skills, toolsets, MCP.**
- Skills (list, search, install as a job, toggle, read), toolsets (toggle; approval mode with a
  warning), MCP servers (list, add, toggle, sign in).

**PR M5-5: Connection settings.**
- Mode, address, tunnel status and notification setup in one place.

### M6: Automations and delight (v0.7.0)

Goals, suggested automations, hatching pets, the floating pet, sessions browser and search, workspace
files, backups, message search, files panel, branching side chats, notification inline reply, and
per-CPU APKs.

### Later

Live screen, real-time voice, home-screen widget, phone terminal, end-to-end transport,
permanent-address wizard, iPhone address recovery, alternate icons, auxiliary model slots,
translations.

---

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| Hermes internals change between releases | `hermes_api.py`, fail-by-capability registration, flags, and CI against the minimum, pinned and latest Hermes. Prefer gateway hooks and slash commands over internal functions where both exist. |
| A control path bypasses the policy | One policy function for HTTP, WebSocket, slash commands, approvals and pickers; default deny for unknown commands; two-device tests in CI. |
| Server control over a quick tunnel | Signed actions, sealed secrets, verified pairing, owner role, audit log, and a plain statement of what the tunnel can still see. Recommend a private connection for sensitive use. |
| The web app can't be protected against an active intermediary | Secret entry from web apps off by default on quick tunnels (5.3.6). |
| An update or restart leaves a job in an unknown state | Durable jobs, reconciliation, verified success, no automatic resubmission. |
| Moving to per-device identities changes Hermes sessions | DM session keys ignore the sender when a chat ID is set; a migration test guards it. |
| Recovery traffic hits ntfy limits | One coordinator, subscriptions instead of polling, jitter and 429 backoff. |
| Blur is slow on some Android phones | Opaque fallback and "Reduce transparency". Real-device test each milestone. |
| APK size grows | Track size in CI; per-CPU APKs (X4). |
| Scope creep | Ship in milestone order. Anything new goes into the catalogue with a priority first. |

---

## 9. Decisions needed

| # | Question | Recommendation |
| --- | --- | --- |
| 1 | Default chat layout | Bubbles by default, Compact as an option. |
| 2 | Accent colour | Iris (violet) by default, with presets. |
| 3 | Order | M0 → M6 as written. Uploads (M2) can move before the navigation PR (M1-4) if they matter most; security (M3) can't move later than the first admin feature. |
| 4 | Terminal from the phone | Leave it for later. |
| 5 | How important is iPhone? | Android first; keep the web app working, with the security limits in 5.3.6. |
| 6 | Can members approve dangerous commands? | No by default; owners only. |
| 7 | Secrets from the web app on a quick tunnel | Off by default, with an owner setting. |
| 8 | Existing devices after M3 | Stay owners and keep chatting; a one-time QR re-scan unlocks secret entry and control actions. |

---

## Appendix A: Hermes integration map

Paths are relative to the Hermes repository. Dashboard routes are reference implementations to copy
the logic from; Winglet calls the underlying functions, not the dashboard over HTTP.

| Feature | Hermes mechanism | Reference |
| --- | --- | --- |
| Inbound photo/file/voice | `MessageEvent.media_urls`, `media_types`, `MessageType.PHOTO/DOCUMENT/VOICE/VIDEO`; `cache_media_bytes` | `gateway/platforms/event.py`, `gateway/platforms/base.py` |
| Voice transcription | Gateway speech-to-text on inbound VOICE | `gateway/run_inbound.py` |
| Reply context | `MessageEvent.reply_to_text`, `reply_to_message_id` | `gateway/platforms/event.py` |
| Adapter-granted access | `SessionSource.role_authorized` | `gateway/session.py`, `gateway/authz_mixin.py` |
| Model picker (per chat) | Adapter `send_model_picker` | `gateway/slash_commands_model.py`; example `plugins/platforms/telegram/adapter.py` |
| Reasoning / fast pickers | Adapter `send_choice_picker` | `gateway/slash_commands_model.py` |
| Command confirmation | Adapter `send_slash_confirm`; 300 s default timeout | `gateway/run_busy.py`, `tools/slash_confirm.py` |
| Status edited in place | Adapter `send_or_update_status` | `gateway/run.py` |
| Model list / default model | `hermes_cli.inventory.build_model_options_payload`, `load_picker_context`; assignment as in `POST /api/model/set` | `hermes_cli/web_routers/models.py` |
| Provider keys | `hermes_cli.config.save_env_value_secure`; validation as in `POST /api/providers/validate` | `hermes_cli/config.py`, `hermes_cli/web_routers/config_env.py` |
| Provider sign-in | Logic behind `/api/providers/oauth/{id}/start`, `/poll`, `/submit` | `hermes_cli/web_routers/oauth.py` |
| Custom endpoints | Logic behind `/api/providers/custom-endpoints` | `hermes_cli/web_routers/config_env.py` |
| Persona | Logic behind `GET/PUT /api/profiles/{name}/soul` | `hermes_cli/web_routers/profiles.py` |
| Memory | Logic behind `GET /api/memory`; `tools/memory_tool.py` | `hermes_cli/web_routers/ops.py`, `hermes_cli/web_server_memory.py` |
| Pets | `agent.pet.store`, `agent.pet.manifest`, `agent.pet.generate`, `agent.pet.state.derive_pet_state`; config `display.pet.slug` | `agent/pet/`; renderer `apps/desktop/src/components/pet/` |
| Schedule | `cron/jobs.py`; routes `/api/cron/*` | `hermes_cli/web_routers/cron.py` |
| Goals | `/goal`, `/subgoal` | `hermes_cli/commands.py` |
| Skills / toolsets / MCP | Logic behind `/api/skills*`, `/api/tools/toolsets*`, `/api/mcp/*` | `hermes_cli/web_routers/skills.py`, `tools.py`, `mcp.py` |
| Pause new work | `/pause` (sentinel; new turns and scheduled work skip; in-flight work continues) | `agent/estop.py`, `hermes_cli/commands.py` |
| Stop current task | `/stop` (interrupts the running turn, kills background processes) | `hermes_cli/commands.py` |
| Restart / update Hermes | `/restart`, `/update`; `hermes gateway restart`, `hermes update` | `hermes_cli/commands.py` |
| Update Winglet plugin | `hermes_cli.plugins_cmd.dashboard_update_user_plugin` | `hermes_cli/web_routers/dashboard_ui.py` |
| Usage | Logic behind `/api/analytics/usage`, `/api/analytics/models`; `/usage` | `hermes_cli/web_routers/analytics.py` |
| System stats / update check | Logic behind `/api/system/stats`, `/api/hermes/update/check` | `hermes_cli/web_routers/status.py`, `actions.py` |
| Sessions and search | Logic behind `/api/sessions*` | `hermes_cli/web_routers/sessions.py` |
| Workspace files | Logic behind `/api/files*` | `hermes_cli/web_routers/files.py` |
| Slash command list | `hermes_cli.commands.COMMAND_REGISTRY` (`cli_only`, `gateway_config_gate`) | `hermes_cli/commands.py` |

## Appendix B: New plugin API (draft)

All routes need a paired device. Markers:

- ★ owner role, signed request (5.3.5), written to the audit log.
- ◆ owner role to read.
- ⟳ returns a durable job; takes an `idempotency_key`.

```
GET    /api/info                                protocol, versions, features (no auth details)

POST   /api/chats/{id}/uploads                  multipart → {upload}
POST   /api/chats/{id}/messages                 + attachments[], reply_to, hidden
GET    /api/commands                            gateway commands + skills, filtered by role
POST   /api/pickers/{id}/select                 {value} or {provider, model}

GET    /api/agent                               model (configured / effective if known), reasoning, pet
GET    /api/models                              providers + models
PUT    /api/models/default ★                    {provider, model, confirm?}
GET    /api/providers ◆
POST   /api/providers/{id}/key ★                {sealed}
POST   /api/providers/{id}/signin ★             → {url, code, poll_id} (bound to this device)
GET    /api/providers/{id}/signin/{poll_id} ◆
POST   /api/providers/custom ★                  {base_url, sealed_key}
DELETE /api/providers/{id} ★
GET    /api/usage?days= ◆

GET    /api/identity ◆    PUT /api/identity ★
GET    /api/memory ◆      PUT /api/memory ★

GET    /api/pet                                 the pet showing, for every device
GET    /api/pets ◆                              installed + active
GET    /api/pets/catalog?q=&offset= ◆
POST   /api/pets/{slug}/adopt ★ ⟳ (when not installed)   PUT /api/pets/display ★   DELETE /api/pets/{slug} ★
GET    /api/pets/{slug}/sheet?rev=&sig=   GET /api/pets/{slug}/thumb?sig=   signed links, cached
POST   /api/pets/hatch ★ ⟳

GET    /api/system                              health and versions (details ◆)
POST   /api/system/restart ★ ⟳   /pause ★   /resume ★   /update ★ ⟳   /plugin-update ★ ⟳
GET    /api/jobs/{id} ◆   GET /api/jobs?idempotency_key= ◆
GET    /api/logs?level=&q=&before= ◆            + WS log stream ◆
GET    /api/audit ◆

GET    /api/devices ◆   PATCH/DELETE /api/devices/{id} ★
POST   /api/devices/pairing-code ★              → {code, url, fingerprint, expires_at}
POST   /api/devices/verify                      sealed {pairing code, signing key}
POST   /api/devices/me/rotate-token ★
GET    /api/server-key                          {public key, fingerprint, continuity signature}

GET    /api/schedule ◆   POST /api/schedule ★   PATCH/DELETE /api/schedule/{id} ★
POST   /api/schedule/{id}/run|pause|resume ★    GET /api/schedule/{id}/runs ◆
POST   /api/schedule/parse                      {text} → {cron, timezone, next_runs[]}
GET    /api/skills   POST /api/skills/install ★ ⟳   PUT /api/skills/{name} ★
GET    /api/toolsets ◆   PUT /api/toolsets/{name} ★
GET    /api/mcp ◆   POST /api/mcp ★   PUT/DELETE /api/mcp/{name} ★
```

New WebSocket events: `picker.new`, `picker.update`, `activity.update`, `status.update`,
`job.progress`, `system.status`, `log.line` ◆, `server_key.rotated`, `device.role_changed`.

## Appendix C: Slash commands for members (draft)

Members may use these; everything else, including unknown and future commands, is owner-only. The
list is checked against `COMMAND_REGISTRY` in CI so new Hermes commands default to owner-only.

| Allowed for members | Why |
| --- | --- |
| `/new`, `/retry`, `/undo`, `/title` | Manage their own conversation |
| `/stop`, `/queue`, `/steer`, `/btw`, `/bg` | Control their own running turn |
| `/status`, `/help` | Read-only |
| Prompt-only skill commands (marked as such) | Same as typing the prompt |

Owner-only examples: `/model`, `/reasoning`, `/fast`, `/personality`, `/pause`, `/restart`,
`/update`, `/approve`, `/deny`, `/reload-mcp`, `/memory`, `/skills`, `/goal`, `/usage`.
