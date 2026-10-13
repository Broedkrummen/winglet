# Winglet plugin for Hermes Agent

This folder is a [Hermes Agent](https://github.com/NousResearch/hermes-agent) plugin. It adds
**Winglet** as a messaging platform, the same way Telegram or Discord plug in, so everything
Hermes already does (sessions, approvals, questions, routines) reaches your phone.

What it adds on your server:

- A small HTTP/WebSocket server for the app (default port `8787`)
- QR-code pairing (`hermes winglet pair`)
- Push notifications: Web Push for the iPhone/desktop web app, ntfy for Android
- One-tap approvals and answers to the agent's questions
- Hosting for the installable web app
- A supervised, account-free Cloudflare HTTPS tunnel (the setup default)

Approval cards capture the exact request ID at current Hermes' notification handoff. If that
handoff is unsupported or the request has expired, Hermes sends its typed approval instructions.
See [approval compatibility](../docs/APPROVALS.md).

## Install

```bash
hermes plugins install VIKASRP24/winglet/plugin
hermes plugins enable winglet
hermes winglet setup          # prepares HTTPS, starts/restarts the gateway and shows a QR
```

Hermes prepares the declared server, push and QR-code dependencies when installing/enabling
the plugin. Accept its dependency preparation prompt. You do not need a separate `pip install`.
`setup` checks every dependency before enabling Winglet and prepares missing packages through
Hermes's package manager. If Hermes needs a fresh process after preparing them, setup tells
you to rerun it and does not report success prematurely.

For an existing installation, run `hermes plugins update winglet` before setup so Hermes can
read the new dependency declaration. Restart the gateway after updating. Updating the plugin
does not update an installed Android APK; install a newer APK separately when available.
Re-running setup preserves a saved connection mode and older direct installs with paired phones.
To switch those installs to automatic HTTPS, use `hermes winglet setup --connection quick` and
re-pair existing phones. Fresh and previously unpaired installs default to automatic HTTPS.

Setup verifies the automatic HTTPS address before pairing. Quick Tunnel addresses change on
recreation: the updated Android app recovers through encrypted ntfy announcements; the iPhone
web app needs a fresh pairing and home-screen install. See [remote access](../docs/REMOTE_ACCESS.md)
for Cloudflare's limits and permanent-address alternatives.

## Commands

| Command | What it does |
|---|---|
| `hermes winglet setup [--port N]` | Prepare dependencies; new/unpaired installs get automatic HTTPS and QR; existing routes are preserved |
| `hermes winglet setup --no-start` | Prepare automatic HTTPS without restarting the gateway |
| `hermes winglet setup --public-url URL` | Use your own address; restart the gateway after changing settings |
| `hermes winglet setup --connection direct` | Opt out of Cloudflare and use LAN/VPN/custom access |
| `hermes winglet setup --connection quick` | Explicitly switch to automatic HTTPS; re-pair existing direct connections |
| `hermes winglet pair` | Show a QR code + one-time code (10 minutes) |
| `hermes winglet devices` | List paired phones |
| `hermes winglet unpair <id>` | Remove a phone |
| `hermes winglet status` | Is it running, and at which URL |

## Settings

Set in `~/.hermes/.env` (or per profile):

| Variable | Default | |
|---|---|---|
| `WINGLET_ENABLED` | – | `true` to start with the gateway |
| `WINGLET_PORT` | `8787` | |
| `WINGLET_CONNECTION` | `quick` on fresh/unpaired setup; `direct` for older paired installs | Saved modes are preserved on subsequent setup runs |
| `WINGLET_HOST` | `127.0.0.1` in quick mode; `0.0.0.0` in direct mode | Explicit bind settings are respected |
| `WINGLET_PUBLIC_URL` | `http://<lan-ip>:8787` in direct mode | Custom address; automatic mode uses the gateway's current verified URL |
| `WINGLET_NTFY_SERVER` | `https://ntfy.sh` | For Android notifications |

For live-typing replies, add to `config.yaml`:

```yaml
display:
  platforms:
    winglet:
      streaming: true
```

## Multiple bots

Each Hermes profile is a bot. When the gateway serves every profile (Hermes's default once there are
two), the other profiles are bots on the same Winglet server: the app lists them, opens a socket per bot
(`/api/ws?bot=<profile>`) and picks the bot with `bot=` on every request, inside the signed path. Chats
belong to a bot, and its messages are routed to its profile (`SessionSource.profile`). `GET /api/bots`
lists them and `POST /api/bots` makes one the way Hermes Desktop does.

A profile can also run its own gateway with its own port
(`hermes -p researcher winglet setup --port 8788`) and be paired on its own.
