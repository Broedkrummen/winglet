# Setup guide

The [README](../README.md#get-started) has the short version. This page has the details.

- [1. On your Hermes machine](#1-on-your-hermes-machine)
- [2. On your phone](#2-on-your-phone)
- [Reaching your server from anywhere (and HTTPS for iPhone)](#reaching-your-server-from-anywhere-and-https-for-iphone)
- [Notifications](#notifications)
- [Approval compatibility](#approval-compatibility)
- [Updating](#updating)

You need a machine running [Hermes Agent](https://github.com/NousResearch/hermes-agent) with its
messaging gateway (`hermes gateway`), the same one you'd use for Telegram or Slack.

## 1. On your Hermes machine

```bash
hermes plugins install Broedkrummen/winglet/plugin
hermes plugins enable winglet
hermes winglet setup          # prepares HTTPS, starts the gateway, then shows the QR
```

For a new or previously unpaired install, `setup` installs the dependencies and a checksum-verified
Cloudflare tunnel client in your Hermes profile, starts/restarts the gateway, and checks the public HTTPS address against your
server's identity before showing a QR. No Cloudflare account, domain, administrator rights,
inbound port opening, or phone VPN is needed. The server still needs outbound internet access.

The free Quick Tunnel is an early-preview convenience: it has no uptime guarantee and changes
address when recreated. The updated Android app recovers the new address when reconnecting;
iPhone users need a new QR and home-screen installation after an address change. An existing
explicit HTTPS configuration and any saved connection mode are preserved. Older installs with
paired phones keep their direct address and listener, so re-running setup during an upgrade
does not disconnect them or route their traffic through Cloudflare. To switch explicitly, run
`hermes winglet setup --connection quick`, then re-pair those phones. See [remote access](REMOTE_ACCESS.md) for
limits, provider privacy, and permanent-address alternatives.

For live-typing replies, add this to `~/.hermes/config.yaml` and restart the gateway:

```yaml
display:
  platforms:
    winglet:
      streaming: true
```

## 2. On your phone

- **Android:** download `winglet-<version>-arm64-v8a.apk` from the [latest release](https://github.com/Broedkrummen/winglet/releases/latest) (the
  `armeabi-v7a` one is for older 32-bit phones), open it, and allow the install. Scan the QR code from step 1.
  When a new version is out, the app offers to download it and open Android's installer if you tap **Update**.
  You can choose Later, skip that version, or turn automatic checks off in About. Android may ask you
  to allow installs from Winglet. You can also track releases with [Obtainium](https://github.com/ImranR98/Obtainium).
- **iPhone:** scan the QR code with the Camera app. It opens Winglet in Safari: tap
  **Share → Add to Home Screen**, open Winglet from your Home Screen, and enter the pairing code.
  Notifications need iOS 16.4+ and an **https** address (see below).
- **Desktop:** open the link from `hermes winglet pair` in any browser.

## Reaching your server from anywhere (and HTTPS for iPhone)

The default automatic HTTPS address works over Wi-Fi or mobile data. Run `hermes winglet pair`
for another phone or a fresh QR. Cloudflare carries HTTP and WebSocket traffic and terminates
HTTPS; this connection is **not end-to-end encrypted against Cloudflare**. Android address
announcements are separately encrypted before being published through ntfy.

For a permanent address or private access, use `--public-url`. For example, install and connect
[Tailscale](https://tailscale.com) on both the Hermes server and phone, then on the server:

```bash
hermes gateway restart
tailscale serve --bg http://127.0.0.1:8787
hermes winglet setup --public-url https://<your-machine>.<your-tailnet>.ts.net
hermes gateway restart
hermes winglet pair
```

Use the exact HTTPS URL printed by `tailscale serve`; keep Tailscale connected on the phone.
Changing `--public-url` does not create HTTPS or update an already paired app connection. To move a
paired Android phone instead of pairing again, set the new address with `--public-url`, restart, then
open the bot's **Connection** screen and choose **Change address**.
An HTTPS domain with a reverse proxy or a
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
works too. See the [remote access guide](REMOTE_ACCESS.md) for setup and troubleshooting.

## Notifications

- **iPhone / desktop:** Settings → Notifications → *Turn on notifications*. Uses standard Web Push,
  end-to-end encrypted with keys that live on your server.
- **Android:** Settings → Notifications → *Set up notifications*, then subscribe in the free
  [ntfy](https://ntfy.sh) app. ntfy only ever sees "Hermes needs you", never the details.

Upgrading from an installation that shared one Android notification topic between phones?
Winglet retires that topic automatically to stop revoked phones from receiving notifications.
Set up notifications again on **each phone**, subscribe to its new private topic in ntfy, and remove
the old shared topic. Web Push registrations are unaffected.

## Approval compatibility

Interactive approval cards bind to the exact Hermes request ID. Winglet accepts an ID forwarded
with the prompt, or captures it from current Hermes' synchronous approval notifier before the
prompt is scheduled. This compatibility path checks the notifier, adapter, chat, and session;
if Hermes changes that call path or the request has expired, Winglet uses the normal text prompt
with `/approve` and `/deny` instructions. Winglet never guesses an approval identity from the
command or queue order, even when only one request appears to match. See
[approval identity and compatibility](APPROVALS.md) for the integration details and tests.

## Updating

On the server, run `hermes plugins update winglet` and restart the gateway. Supported installs can also
update from Winglet's Server screen. The updated plugin serves the new iPhone/desktop web app.

Android releases use the same signing key and can update the installed app. Phones on v0.3.0 can use
the update prompt for v0.4.0; phones on v0.2.0 use About and a browser download. The in-app download,
installer hand-off and first-time install permission still need verification on a real phone.
