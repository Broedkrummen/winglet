<div align="center">

<img src="docs/images/logo.svg" width="88" alt="Winglet logo" />

# Winglet

**Your Hermes agents, in your pocket.**

A calm, open-source phone app for [Hermes Agent](https://github.com/NousResearch/hermes-agent).<br/>
Your agents run on *your* server, keep working while you're away,
and tap you on the shoulder when they need you.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/Broedkrummen/winglet?label=release)](https://github.com/Broedkrummen/winglet/releases/latest)
[![CI](https://github.com/Broedkrummen/winglet/actions/workflows/ci.yml/badge.svg)](https://github.com/Broedkrummen/winglet/actions/workflows/ci.yml)
![Android APK](https://img.shields.io/badge/android-APK-3DDC84)
![iPhone PWA](https://img.shields.io/badge/iPhone-web%20app-lightgrey)

<br/>

<a href="docs/media/winglet-explainer.mp4"><img src="docs/media/winglet-explainer.gif" width="720" alt="Winglet in 30 seconds: set up the server, scan the QR code, then chat, approve and switch bots from your phone" /></a>

<sub>30 seconds of Winglet. <a href="docs/media/winglet-explainer.mp4">Watch in full quality</a>.</sub>

**[Get started](#get-started)** · **[Features](#what-it-does)** · **[Tour](#tour)** · **[How it works](#how-it-works)** · **[FAQ](#faq)**

</div>

> [!TIP]
> **New in [v0.9.0](docs/releases/v0.9.0.md):** a cleaner, flat redesign of every screen; switch bots in one tap
> from the landing; charcoal, graphite or true-black dark mode; and a new Mono accent.

## Why Winglet?

OpenAI Dots, Meta Muse and Grok Bot showed what a personal agent on your phone should feel like.
Winglet brings that to Hermes Agent, the open-source agent by Nous Research, without handing your data to anyone.

<table>
  <tr>
    <td width="33%" valign="top">
      <h4>Your server, your models</h4>
      Hermes runs on your own machine with any model provider, local models included.
    </td>
    <td width="33%" valign="top">
      <h4>Pair in one scan</h4>
      One command on the server prints a QR code. Scan it and you're in: no accounts, no ports, no app store.
    </td>
    <td width="33%" valign="top">
      <h4>Not another chat window</h4>
      Each bot has a name and a pet, works on goals and routines, and brings you only what needs you.
    </td>
  </tr>
</table>

<a id="get-started"></a>

## Get started in two minutes

This is the Broedkrummen fork. Android builds install separately from upstream Winglet and need their
own initial pairing. If no signed release is published yet, see [release setup](docs/RELEASING.md).

**1. On your Hermes machine**, with the Hermes messaging gateway installed:

```bash
hermes plugins install Broedkrummen/winglet/plugin
hermes plugins enable winglet
hermes winglet setup          # sets up HTTPS, starts the gateway, shows a QR code
```

Setup gives you a free HTTPS address through Cloudflare. You don't need an account, a domain or any open ports.

**2. On your phone, scan the QR code.**

| Android | iPhone | Desktop |
|---|---|---|
| Install `winglet-<version>-arm64-v8a.apk` from the [latest release](https://github.com/Broedkrummen/winglet/releases/latest), open it and tap **Scan QR code**. | Scan with the Camera app, then **Share → Add to Home Screen** and open Winglet from there. | Open the link from `hermes winglet pair` in any browser. |

**3. Say hello.** Your bot is on the landing screen, ready for a message.

The QR code carries your server key's fingerprint, so the phone checks it's really your server before pairing.
For Tailscale or your own domain, notifications and updates, see the **[setup guide](docs/SETUP.md)**.

<a id="what-it-does"></a>

## What it does

<table>
  <tr>
    <td width="50%" valign="top">
      <h4>Chats</h4>
      A chat for every topic, with streaming replies, code, photos, files and voice notes. Search every chat, share from any Android app, and keep working on a bad connection.
    </td>
    <td width="50%" valign="top">
      <h4>Approvals and questions</h4>
      Approve risky commands and answer questions with one tap, from the app or the notification. The Inbox collects everything waiting on you, across all your bots.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h4>Goals</h4>
      Give a chat an outcome and Hermes keeps working on it, turn after turn, until it's done.
    </td>
    <td valign="top">
      <h4>Routines</h4>
      Schedule work in plain words, like "weekdays at 9am" or "every 2h". Results land in the Updates chat.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h4>Many bots, one tap</h4>
      Add a bot for each job and switch between them from the landing. Give each an animated pet from <a href="https://petdex.dev">petdex</a>. <a href="docs/BOTS.md">More on bots →</a>
    </td>
    <td valign="top">
      <h4>Your agent</h4>
      Switch model and reasoning level per chat. Edit persona and memory, track usage, and manage skills, tools and MCP servers.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h4>Your server</h4>
      Processor, memory and disk at a glance. Pause, restart and update Hermes and Winglet, read logs, and browse past sessions.
    </td>
    <td valign="top">
      <h4>Safe by default</h4>
      Verified QR pairing, signed owner actions, an activity log, members who can't see your chats, and an optional app lock.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h4>Workspaces</h4>
      Projects, branching from any exchange, checkpoints you can diff and restore, rooms with several bots, and hands-free voice.
    </td>
    <td valign="top">
      <h4>Make it yours</h4>
      Light or dark in charcoal, graphite or true black, six accents, bubbles or a compact layout, and a drawer or pinned sidebar.
    </td>
  </tr>
</table>

See **[all features](docs/FEATURES.md)** for the full list.

<a id="tour"></a>

## Tour

<table>
  <tr>
    <td align="center"><img src="docs/screenshots/home.png" width="190" alt="The landing: your bot, a greeting, and one-tap bot chips" /><br/><sub>Start from the landing</sub></td>
    <td align="center"><img src="docs/screenshots/chat.png" width="190" alt="A conversation with your bot" /><br/><sub>Just ask</sub></td>
    <td align="center"><img src="docs/screenshots/inbox.png" width="190" alt="The inbox, where questions and approvals wait" /><br/><sub>One inbox for every bot</sub></td>
    <td align="center"><img src="docs/screenshots/sidebar.png" width="190" alt="The sidebar" /><br/><sub>Everything in one sidebar</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/screenshots/agent.png" width="190" alt="Managing your agent" /><br/><sub>Your agent</sub></td>
    <td align="center"><img src="docs/screenshots/schedule.png" width="190" alt="Routines and ideas for new ones" /><br/><sub>Routines</sub></td>
    <td align="center"><img src="docs/screenshots/usage.png" width="190" alt="Token usage and cost" /><br/><sub>Usage and cost</sub></td>
    <td align="center"><img src="docs/screenshots/appearance.png" width="190" alt="Appearance: theme, dark tone and accent" /><br/><sub>Make it yours</sub></td>
  </tr>
</table>

<sub>Screenshots are from a phone running Winglet against a test Hermes server, in dark mode with the Black tone.</sub>

<a id="how-it-works"></a>

## How it works

<img src="docs/images/how-it-works.svg" alt="Your phone talks to the Winglet plugin inside Hermes on your server over HTTPS. Hermes uses your models, and notifications come back to the phone." />

- **The app** (`app/`) is one [Expo](https://expo.dev) / React Native codebase that builds the Android APK and the iPhone/desktop web app.
- **The plugin** (`plugin/`) adds Winglet to Hermes as a messaging platform, the same way Telegram or Slack plug in. Each chat is a Hermes session, and approvals, questions, goals and routines use Hermes's own mechanisms. **No fork of Hermes.**

<a id="faq"></a>

## FAQ

<details>
<summary><b>Do I need to pay for anything?</b></summary>

No. Winglet is MIT-licensed and needs no App Store or Play Store account. You need a machine that runs
Hermes Agent and whatever model provider you choose (local models work).
</details>

<details>
<summary><b>Does my server need to be public on the internet?</b></summary>

No. Setup uses an outbound Cloudflare tunnel, or you can use a private network such as Tailscale or your own
HTTPS proxy. See the [remote access guide](docs/REMOTE_ACCESS.md).
</details>

<details>
<summary><b>Is it safe?</b></summary>

Only paired devices can talk to your agent. Pairing codes are single-use and expire after 10 minutes, and each
phone gets its own revocable token (`hermes winglet devices` / `unpair`). The QR carries your server key's
fingerprint, so the phone checks it's really your server. Owner actions are signed by a key that never leaves
the phone, so a token copied from a log can chat but can't change anything. Every such action is listed in
Agent → Devices → Activity, and risky commands still need your approval. Prefer Tailscale or another private
network over opening a port to the internet.
</details>

<details>
<summary><b>Can someone else use my agent?</b></summary>

Yes, as a member: Agent → Devices → Add a device → Member (or `hermes winglet pair --member`). Members have
their own chats and can't see yours, approve commands or change settings. They share the agent's memory and,
unless you limit them in Agent → Tools, its tools, so only add people you trust with it.
</details>

<details>
<summary><b>What can I control from my phone?</b></summary>

Owners get Agent → Server: the machine's processor, memory and disk, **Pause new work** (Hermes's `/pause`:
new chats, routines and background tasks wait, anything already running finishes), **Restart**, and updates
for Hermes and Winglet with progress that carries on across the restart. **Logs** shows Hermes's agent,
gateway and error logs with keys and tokens hidden, and **Schedule** takes routines in plain words
("weekdays at 9am", "every 2h", "in 30m") and posts their results to the Updates chat.

In-app updates need Hermes installed from git and Winglet installed with `hermes plugins install`; otherwise
the app shows the command to run on the server. Under Agent → Abilities you manage **Skills**, **Tools**
(including approvals and what members can use) and **MCP servers**. Changes to tools apply from the next
message; MCP changes apply when you tap Reconnect.
</details>

<details>
<summary><b>Why a web app on iPhone?</b></summary>

It lets you use Winglet without a native iOS build or an App Store account. It supports notifications on
iOS 16.4+ when added to the Home Screen over HTTPS.
</details>

## What's next

Ideas for later discussion; each needs its own scope approval.

- [ ] Live screen: watch the agent's computer and take over when it needs you
- [ ] Real-time voice
- [ ] Widgets and backups

The active plan and approval process are in [docs/ROADMAP.md](docs/ROADMAP.md).
The older [v0.1.3→v0.7 plan](docs/APP_PLAN.md) is retained as history.

## Simple view

Choose **Settings → View → Simple** for a bot-first messenger layout. Each row represents a bot;
Settings lets you choose its last conversation, main conversation or conversation list when opening it.
Full view remains available, with the same chats and drafts. Both light and dark themes are supported.

<details>
<summary>Preview Simple view (synthetic demo content)</summary>

![Simple view on desktop, light theme, synthetic demo](docs/screenshots/simple-desktop-light.png)

<img src="docs/screenshots/simple-mobile-dark.png" width="260" alt="Simple view on a phone in dark theme, synthetic demo content" />

</details>

See [verification evidence and device limitations](docs/agent-handoffs/simple-view.md).

## Development

```bash
# Plugin tests
pip install "aiohttp>=3.9,<4" cryptography "httpx>=0.27,<1" qrcode http_ece pyyaml packaging pytest pytest-aiohttp
pytest

# App (Expo)
cd app && npm ci
npx expo start            # press "w" for web, or scan with a development build
npx tsc --noEmit && npm test

# Rebuild the web app bundled into the plugin
./scripts/build-web.sh
```

To try the plugin against your own Hermes, copy `plugin/` to `~/.hermes/plugins/winglet/` and enable it.
The design rules for the app are in [docs/DESIGN.md](docs/DESIGN.md).

## Contributing

Early days, so everything is open: code, design, naming, ideas. See [CONTRIBUTING.md](CONTRIBUTING.md).
Found a security issue? Please read [SECURITY.md](SECURITY.md) first.

---

<sub>Winglet is an independent community project, **not affiliated with or endorsed by Nous Research, OpenAI,
Meta or xAI**. "Hermes Agent" is a project of Nous Research; other product names only describe what Winglet
is similar to. Licensed under [MIT](LICENSE).</sub>
