# Offline Winglet demo

A disposable browser workspace for UI iteration and screenshots. It uses the real Winglet HTTP/WebSocket Hub and an **in-memory** SQLite store, with synthetic adapter reads and replies. It never imports Hermes, invokes its CLI, connects to a model provider, or opens the live Hermes port **8871**. The demo binds only to `127.0.0.1`; passing `--port 8871` is explicitly refused.

## Start

From PowerShell, using the existing environment with aiohttp and cryptography installed:

```powershell
& 'C:/Users/vikas/Documents/winglet/.venv/Scripts/python.exe' -X utf8 'C:/Users/vikas/.codex/worktrees/major-feature-integration/winglet/scripts/demo/demo_server.py'
```

From Git Bash at this repository root:

```bash
"C:/Users/vikas/Documents/winglet/.venv/Scripts/python.exe" -X utf8 scripts/demo/demo_server.py
```

Defaults: `--port 18790 --web-root app/dist`. The web root is resolved relative to the repository, not the shell's current directory; an absolute path also works. For example, append `--port 18791 --web-root C:/path/to/export`.

## Pair the browser

1. Open **http://127.0.0.1:18790/demo**. This prepares the app's origin-local storage with three paired bots, a real signing key for the disposable browser device, and the sample pinned/archived preferences, then redirects to the app.
2. Select a pinned conversation in the sidebar to show a populated transcript. Home shows the three bot avatars and a pending-inbox badge; Inbox has two actionable cards.
3. After restarting the server, open `/demo` again. Every run has a fresh identity and device key. Visiting `/demo` also restores the demo's light theme, bot selection, pins, and archive preferences. Browser storage must be enabled.

The bootstrap replaces Winglet connection/preferences **only for this demo origin**. Use a separate browser profile/private window if desired. It does not read or change storage for port 8871. Old browser caches are not deleted; clear this demo origin's site data if you want to discard them too.

To test the app's normal encrypted pairing instead, open **http://127.0.0.1:18790/demo/pair**. It generates a fresh one-use pairing link including the Hub fingerprint. A one-use code/link, valid for 24 hours, is also printed at startup. Normal pairing discovers all three bots, but cannot seed pins/archives because those preferences live only on the browser; use `/demo` for screenshot setup.

Use `127.0.0.1` consistently, not `localhost`: these are separate browser origins, and bootstrap connections use `127.0.0.1`.

## Seeded content

- **Hermes** (pink), **Atlas** (red), and **Nova** (cyan), using the app's existing name-derived avatar colors.
- **Nine conversations plus Updates**, spanning the last four days:
  - Hermes: A little more space this week; Make the portfolio feel like me; A slow Saturday, mostly outside; Moving-day checklist (archived).
  - Atlas: its main thread; A calmer home for my notes; A safer folder-cleanup script.
  - Nova: its main thread; Dinner for friends, without the fuss.
- Two pinned chats: portfolio and note-taking research.
- Multi-turn transcripts with lists, bold text, a blockquote, code blocks, tables, and folded tool activity.
- Two pending Inbox cards: a cleanup approval and a dinner-allergies question. Responding resolves the card and adds a synthetic acknowledgement; it never runs the displayed command.
- An active portfolio goal with a four-step task plan (two completed, one in progress, one pending) and a completed read-file tool call.
- Two synthetic schedules on Hermes: Morning briefing and Friday reset. Pause/resume works in memory; nothing actually runs on a timer.
- One project, **A lighter week**, grouping the portfolio and Saturday chats.
- Two synthetic devices, sample persona/memory, a routine result in Updates, and seven days of fabricated usage figures (not real spending).
- Sending a message receives a canned reply; all messages and changes disappear when the process exits.

## Export or refresh the browser build

The server serves `app/dist` directly. It does not copy anything into `plugin/web`. Re-export after changing UI source; the server can remain running, then reload the browser.

From Git Bash:

```bash
cd app
npx expo export --platform web --clear --max-workers 1
```

This is the Expo export command used by `scripts/build-web.sh`, with one Metro worker to reduce memory use. **Do not run the full build-web.sh for this demo**: that script also replaces the bundled `plugin/web` files.

If concurrent exports cause Windows Metro temp-cache errors, isolate this export's cache (from the repository root):

```bash
mkdir -p scripts/demo/.cache
cd app
TEMP="$(pwd -W)/../scripts/demo/.cache" TMP="$(pwd -W)/../scripts/demo/.cache" \
  npx expo export --platform web --clear --max-workers 1
```

The isolated cache is ignored by Git. Avoid running two exports to the same `app/dist` simultaneously.

## Verify and stop

API smoke check (Git Bash; use `curl.exe` in PowerShell):

```bash
curl --fail http://127.0.0.1:18790/api/chats \
  -H 'Authorization: Bearer winglet-offline-demo-not-a-real-token'
curl --fail 'http://127.0.0.1:18790/api/chats?bot=atlas' \
  -H 'Authorization: Bearer winglet-offline-demo-not-a-real-token'
```

Hermes-free API/pairing/seed regression tests:

```bash
"C:/Users/vikas/Documents/winglet/.venv/Scripts/python.exe" -X utf8 -m unittest discover -s scripts/demo -v
```

Stop with **Ctrl-C**, or:

```bash
curl --fail -X POST http://127.0.0.1:18790/demo/stop \
  -H 'Authorization: Bearer winglet-offline-demo-not-a-real-token'
```

Normal shutdown closes the Hub and removes the temporary media directory. No persistent database is created. The demo token and browser credentials are intentionally disposable and must never be used on a production server.

## Limitations

- No real inference, tool execution, command execution, scheduled runs, or external network access. Backend outbound HTTP and push delivery are disabled.
- No uploaded files/media, pets, rooms, live processes, checkpoints, transcript branching, context/compression/provider-limit insights, imported sessions, or routine-run history. These screens are empty, unavailable, or hidden by feature flags; Rooms may remain visible in navigation but has no content.
- The task plan is a static synthetic in-progress snapshot, not a running worker. The synthetic schedules are display data, not an installed scheduler. Routine creation and run-now explicitly refuse to execute.
- Logs and provider/model lists are empty. Persona/memory are sample reads, not a full mock of the management/settings APIs; settings that normally change an agent are outside this demo.
- No push notifications, voice, Wear links, tunnels, or address recovery. UI text may still describe the normal production integrations.
- Browser pairing, chat listing/transcripts, project grouping, routine listing, and pending cards use the real app/protocol. No changes to `app/src` or `plugin` are needed for demo pairing.
