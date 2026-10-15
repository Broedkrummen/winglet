<div align="center">

# Winglet

**Your Hermes agents, in your pocket.**

Chat with agents on your own server, follow their work, and answer when they need you.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/VIKASRP24/winglet)](https://github.com/VIKASRP24/winglet/releases/latest)
[![CI](https://github.com/VIKASRP24/winglet/actions/workflows/ci.yml/badge.svg)](https://github.com/VIKASRP24/winglet/actions/workflows/ci.yml)
![Android APK](https://img.shields.io/badge/Android-APK-3DDC84)
![iPhone and desktop](https://img.shields.io/badge/iPhone%20%26%20desktop-web%20app-lightgrey)

[Download](https://github.com/VIKASRP24/winglet/releases/latest) · [Install](#install) · [Release notes](https://github.com/VIKASRP24/winglet/releases) · [Report an issue](https://github.com/VIKASRP24/winglet/issues)

</div>

Winglet is an open-source companion for [Hermes Agent](https://github.com/NousResearch/hermes-agent).
Hermes runs on your machine with your models; Winglet gives it an Android app and an installable web app for iPhone and desktop. No fork of Hermes or app-store account is needed.

## What you can do

- **Keep several bots.** Each Hermes profile has its own persona, memory, chats, skills and pet. Create bots from the phone, pair another server, and let bots ask each other for help.
- **Make one your main bot.** Home opens around its pet, status and message box, with your other bots a tap away. Choose your main bot in the Agent tab.
- **Chat with less clutter.** Streamed Markdown and code, photos, files, voice notes, replies, search and export. Tool activity folds into expandable rows; model and reasoning controls sit beside the message box.
- **Stay connected.** Cached chats, drafts, an offline send queue, Android address recovery, and push notifications through ntfy or Web Push.
- **Answer when needed.** Approvals and questions appear in a shared Inbox. Follow goals and scheduled routines without keeping the chat open.
- **Manage your agent.** Change models, providers, memory, skills, tools and MCP connections. Check usage and server health, read logs, restart, and update Hermes or Winglet.
- **Make it yours.** Animated pets from [petdex](https://petdex.dev), light and dark themes, accent colors, and a wide layout for tablets and desktop.
- **Control access.** Verified pairing, owner and member roles, signed owner actions, device revocation, an activity log, and an optional Android app lock.

## New in v0.4

PRs [#36](https://github.com/VIKASRP24/winglet/pull/36) and [#37](https://github.com/VIKASRP24/winglet/pull/37) bring:

- A simpler Home built around your main bot, selected when the app starts.
- One **Add a bot** sheet for creating a bot, scanning a QR, or pairing with a code.
- Your bot's pet throughout the app, with quieter, lighter avatars in lists.
- Folded tool progress, compact approval cards, and a model/reasoning popup.
- A shared chat menu for rename, mute and export, plus goals and files inside the chat.

See the [release notes](docs/releases/v0.4.0.md) for fixes and testing limits.

## Preview

<p align="center">
  <img src="docs/screenshots/chat.png" width="210" alt="A Winglet chat with highlighted code" />
  <img src="docs/screenshots/agent.png" width="210" alt="Agent settings and abilities" />
  <img src="docs/screenshots/server.png" width="210" alt="Server health and controls" />
</p>

Screenshots show an earlier version; Home, avatars and chat controls have since changed.

## Install

You need [Hermes Agent](https://github.com/NousResearch/hermes-agent) and its messaging gateway on your computer or server.

### 1. Set up the server

```bash
hermes plugins install VIKASRP24/winglet/plugin
hermes plugins enable winglet
hermes winglet setup
```

On a fresh install, setup prepares the dependencies and Cloudflare tunnel client, starts the gateway, and checks the public HTTPS address before showing a pairing QR. No domain, Cloudflare account or inbound port opening is needed. Existing connection settings are preserved.

For replies that stream as they are written, add this to `~/.hermes/config.yaml` and restart the gateway:

```yaml
display:
  platforms:
    winglet:
      streaming: true
```

**Connection privacy:** the automatic Quick Tunnel is a preview service with changing addresses and no uptime guarantee. Cloudflare terminates HTTPS and can read tunneled traffic. For private access or a permanent address, use Tailscale or your own HTTPS endpoint; see [remote access](docs/REMOTE_ACCESS.md).

### 2. Connect your phone or browser

| Platform | Get started |
| --- | --- |
| **Android** | Download `winglet-<version>-arm64-v8a.apk` from the [latest release](https://github.com/VIKASRP24/winglet/releases/latest), install it, and scan the QR. Use `armeabi-v7a` for older 32-bit phones. |
| **iPhone** | Scan the QR with Camera, open it in Safari, choose **Share → Add to Home Screen**, then open Winglet and enter the pairing code. Web Push needs iOS 16.4+ and HTTPS. |
| **Desktop** | Open the link printed by `hermes winglet pair` in your browser. |

Run `hermes winglet pair` again for another device. Android can recover a changed Quick Tunnel address; iPhone needs a fresh pairing and home-screen installation after the hostname changes.

### 3. Enable notifications

- **Android:** open Settings → Notifications → **Set up notifications**, then subscribe in the free [ntfy](https://ntfy.sh) app. Each phone has its own private topic; notifications use generic text.
- **iPhone / desktop:** open Settings → Notifications → **Turn on notifications**. Web Push payloads are encrypted with keys on your server.

Upgrading a very old install that used one shared Android topic? Set up notifications again on each phone and remove the old topic.

## More bots

Open **Add a bot** from Home, the bot switcher, or Your bots. Create a new bot on the current server, or pair one elsewhere. Creating bots needs an owner phone and compatible Hermes support.

Bots on one server share its connection and pairing. Each keeps its own profile; a gateway serving just one profile may need one restart after the first new bot. Older separate gateways can be combined with `hermes gateway migrate --multiplex`.

Choose a bot in **Agent → Main bot** to put it first. For teamwork, enable the **bots** toolset under Tools: `ask_bot` gets help from another bot, and `make_bot` creates one after your approval.

## Updates

- **Android:** newer versions appear in the app's update prompt or About. Winglet downloads the APK for your phone and opens Android's installer; Android may ask you to allow installs from Winglet. Choose Later, skip a version, or disable automatic checks in About. Browser downloads remain available.
- **Server:** run `hermes plugins update winglet`, then restart the gateway. Supported installs also offer updates from the app's Server screen.
- **iPhone / desktop:** the updated plugin serves the new web app.

The APKs use the same release signing key so they can update an existing installation. The in-app download, installer hand-off and first-time install permission still need verification on a real phone.

## Access and compatibility

Only paired devices can connect. Owner actions are signed with the phone's key; members have their own chats and fewer controls. Members still share the bot's memory and permitted tools, so pair people you trust.

Some features depend on your Hermes version. Unsupported controls are hidden or explained. Approval cards require the exact Hermes request ID; when that integration is unavailable, Winglet falls back to Hermes's text approval instructions. See [approval compatibility](docs/APPROVALS.md).

## Development

```bash
# Plugin tests (install the dependencies in plugin/plugin.yaml first)
pip install pytest pytest-aiohttp http_ece pyyaml packaging
pytest -q

# App
cd app
npm ci
npm run typecheck
npm test
npx expo start

# From the repository root: rebuild the web app served by the plugin
./scripts/build-web.sh
```

| Guide | Covers |
| --- | --- |
| [Remote access](docs/REMOTE_ACCESS.md) | HTTPS, tunnels, Tailscale and connection troubleshooting |
| [Approval compatibility](docs/APPROVALS.md) | Request identity, fallbacks and integration tests |
| [History and sync](docs/HISTORY.md) | Pagination, offline history and deletion reconciliation |
| [Releasing](docs/RELEASING.md) | Signing keys, APK builds and release tags |
| [Project plan](docs/APP_PLAN.md) | Longer-term plans and implementation notes |

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues through [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Winglet is an independent community project and is not affiliated with or endorsed by Nous Research or OpenAI. Hermes Agent is a project of Nous Research.
