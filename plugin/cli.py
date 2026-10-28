"""``hermes winglet ...``: setup, pair, devices, unpair, status."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.request
from urllib.parse import urlsplit
from typing import Optional

from .dependencies import ensure_ready

DEFAULT_PORT = 8787


def setup_parser(parser: argparse.ArgumentParser) -> None:
    subs = parser.add_subparsers(dest="winglet_command", required=False)
    p_setup = subs.add_parser("setup", help="Enable Winglet in this profile's gateway")
    p_setup.add_argument("--port", type=int, default=None, help=f"Port to listen on (default {DEFAULT_PORT})")
    p_setup.add_argument("--public-url", default=None,
                         help="URL your phone uses to reach this machine, e.g. https://box.tailnet.ts.net")
    p_setup.add_argument("--connection", choices=("quick", "direct"), default=None,
                         help="Automatic Cloudflare HTTPS for new installs, or your own LAN/VPN/public URL")
    p_setup.add_argument("--no-start", action="store_true", help="Prepare settings without starting/restarting the gateway")
    p_pair = subs.add_parser("pair", help="Show a QR code to pair a phone, or to verify one already paired")
    p_pair.add_argument("--public-url", default=None, help="Override the URL encoded in the QR code")
    p_pair.add_argument("--member", action="store_true",
                        help="Pair as a member: can chat in their own chats, can't approve commands or change settings")
    subs.add_parser("devices", help="List paired phones")
    p_unpair = subs.add_parser("unpair", help="Remove a paired phone")
    p_unpair.add_argument("device_id", help="Device id from `hermes winglet devices`")
    p_role = subs.add_parser("role", help="Make a paired phone an owner or a member")
    p_role.add_argument("device_id", help="Device id from `hermes winglet devices`")
    p_role.add_argument("role", choices=("owner", "member"))
    subs.add_parser("rotate-key", help="Replace the key phones encrypt secrets to (paired phones follow automatically)")
    subs.add_parser("status", help="Show whether Winglet is running and how to reach it")
    parser.set_defaults(func=main)


def main(args: argparse.Namespace) -> int:
    sub = getattr(args, "winglet_command", None) or "status"
    handler = {"setup": cmd_setup, "pair": cmd_pair, "devices": cmd_devices, "unpair": cmd_unpair,
               "role": cmd_role, "rotate-key": cmd_rotate_key, "status": cmd_status}.get(sub)
    if handler is None:
        print(f"unknown subcommand: {sub}", file=sys.stderr)
        return 2
    return handler(args) or 0


# -- helpers -----------------------------------------------------------------------------


def _env(key: str) -> str:
    try:
        from hermes_cli.config import get_env_value
        return (get_env_value(key) or "").strip()
    except Exception:
        return ""


def _port() -> int:
    try:
        return int(_setting("port", "WINGLET_PORT") or DEFAULT_PORT)
    except (TypeError, ValueError):
        return DEFAULT_PORT


def _setting(key: str, env: str):
    """Match the adapter's env-before-YAML settings for the active profile."""
    value = _env(env)
    if value:
        return value
    try:
        from hermes_cli.config import load_config_readonly
        section = load_config_readonly().get("platforms", {}).get("winglet", {})
        value = section.get("extra", {}).get(key, section.get(key))
        return value if value is not None else ""
    except Exception:
        return ""


def _probe_url() -> str:
    host = str(_setting("host", "WINGLET_HOST") or "").strip().strip("[]")
    if host in ("", "0.0.0.0"):
        host = "127.0.0.1"
    elif host == "::":
        host = "::1"
    if ":" in host:
        host = f"[{host}]"
    return f"http://{host}:{_port()}/api/info"


def lan_ip() -> str:
    """Address selected by the local routing table; it can be a public or VPN IP, too.

    No packets are sent and this does not check whether a phone can reach the address.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        try:
            sock.connect(("10.255.255.255", 1))
            return sock.getsockname()[0]
        except OSError:
            return "127.0.0.1"


def public_url(override: Optional[str] = None) -> str:
    if not override and _setting("connection", "WINGLET_CONNECTION") == "quick":
        info = _running() or {}
        return (info.get("connection") or {}).get("url") or ""
    url = str(override or _setting("public_url", "WINGLET_PUBLIC_URL") or "").rstrip("/")
    return url or f"http://{lan_ip()}:{_port()}"


def _start_gateway() -> None:
    """Let Hermes use its own service/profile restart path, with a detached fallback."""
    from hermes_constants import get_hermes_home
    from .adapter import data_dir
    directory = data_dir()
    directory.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "HERMES_HOME": str(get_hermes_home())}
    # Hermes launchers may run a checkout directly instead of installing hermes_cli as a package.
    # Carry its actual import root into the detached interpreter without changing the user's cwd.
    import hermes_cli.config as config_module
    if source := getattr(config_module, "__file__", None):
        root = str(Path(source).resolve().parents[1])
        env["PYTHONPATH"] = root + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    for key in list(env):
        if key.startswith("WINGLET_"):
            del env[key]
    for key in ("WINGLET_ENABLED", "WINGLET_CONNECTION", "WINGLET_PORT", "WINGLET_HOST",
                "WINGLET_PUBLIC_URL", "WINGLET_NTFY_SERVER", "WINGLET_HOME_CHANNEL"):
        if value := _env(key):
            env[key] = value
    home = get_hermes_home()
    selector = home.name if home.parent.name == "profiles" else "default"
    options = ({"creationflags": subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS}
               if os.name == "nt" else {"start_new_session": True})
    # Some Hermes installations run the restart fallback in the foreground. Keep that child
    # alive after this CLI exits, and put startup diagnostics in the active profile's data dir.
    with (directory / "gateway-setup.log").open("ab") as output:
        subprocess.Popen([sys.executable, "-m", "hermes_cli.main", "-p", selector, "gateway", "restart"],
                         stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT, env=env, **options)


def _wait_for_quick(timeout: float = 150) -> Optional[dict]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        info = _running()
        connection = (info or {}).get("connection") or {}
        if connection.get("mode") == "quick" and connection.get("url"):
            return info
        time.sleep(1)
    return None


def _verify_public(url: str, server_id: str) -> bool:
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    try:
        opener = urllib.request.build_opener(NoRedirect())
        with opener.open(url + "/api/info", timeout=8) as response:
            info = json.loads(response.read(65537))
        return isinstance(info, dict) and info.get("app") == "winglet" and info.get("server_id") == server_id
    except Exception:
        return False


def _running() -> Optional[dict]:
    try:
        # This probes a local listener even when it is restricted to a LAN/VPN address.
        # Do not route the readiness check through an HTTP proxy configured for internet traffic.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(_probe_url(), timeout=2) as resp:
            info = json.loads(resp.read().decode("utf-8"))
            if isinstance(info, dict) and info.get("app") == "winglet" and info.get("server_id"):
                return info
            return None
    except Exception:
        return None


def _print_qr(text: str) -> None:
    import qrcode

    qr = qrcode.QRCode(border=4)
    qr.add_data(text)
    qr.make(fit=True)
    qr.print_ascii(invert=True)


def _print_connection_help(url: str) -> None:
    print(f"\nPhone URL: {url}")
    print("Phone connectivity: not verified. Same Wi-Fi is not required.")
    if url.lower().startswith("http://"):
        print("HTTPS: not configured. Use HTTPS for remote access and iPhone features.")
        print("Choose a remote access route:")
        print("  Public HTTPS: a domain/reverse proxy or tunnel; no VPN needed on the phone.")
        print("  Private Tailscale: connect BOTH the Hermes server and phone to the same tailnet.")
        print("Guide: https://github.com/Broedkrummen/winglet/blob/main/docs/REMOTE_ACCESS.md")
    else:
        print("If this is a Tailscale URL, keep your phone connected to the same tailnet.")
    print("--public-url changes the pairing address; it does not create HTTPS or open firewall ports.")


# -- commands ----------------------------------------------------------------------------


def cmd_setup(args: argparse.Namespace) -> int:
    if args.port is not None and not 1 <= args.port <= 65535:
        print("--port must be between 1 and 65535.")
        return 1
    if not ensure_ready(install=True):
        return 1
    from hermes_cli.config import save_env_value
    mode = getattr(args, "connection", None)
    if mode == "quick" and args.public_url:
        print("Choose automatic HTTPS or --public-url, not both.")
        return 1
    if args.public_url:
        parsed = urlsplit(args.public_url)
        if parsed.scheme not in ("https", "http") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            print("--public-url must be an HTTP(S) address without credentials, query, or fragment.")
            return 1
    # Setup is also an upgrade command: never silently change an existing phone's route.
    configured = str(_setting("public_url", "WINGLET_PUBLIC_URL") or "")
    saved_mode = _setting("connection", "WINGLET_CONNECTION")
    preserved_legacy = False
    if not mode:
        if args.public_url:
            mode = "direct"
        elif saved_mode in ("direct", "quick"):
            mode = saved_mode
        elif saved_mode:
            print("Unknown saved connection mode. Choose --connection direct or --connection quick.")
            return 1
        elif configured.lower().startswith("https://"):
            mode = "direct"
        else:
            from .adapter import open_store
            try:
                store = open_store()
                try:
                    preserved_legacy = bool(store.list_devices())
                finally:
                    store.close()
            except Exception as exc:
                print(f"Could not check paired phones: {exc}")
                print("Connection settings were not changed. Fix the device store and retry setup.")
                return 1
            mode = "direct" if preserved_legacy else "quick"
    if preserved_legacy:
        print("Keeping your existing direct connection because phones are already paired.")
        print("To switch explicitly: hermes winglet setup --connection quick (then re-pair existing phones).")
    if mode == "quick":
        from .adapter import data_dir
        from .tunnel import install
        print("Preparing automatic HTTPS (Cloudflare Quick Tunnel)...")
        print("Traffic passes through Cloudflare, which can read it, including messages and device tokens.")
        try:
            install(data_dir())
        except Exception as exc:
            print(f"Could not prepare automatic HTTPS: {exc}")
            return 1
    save_env_value("WINGLET_CONNECTION", mode)
    save_env_value("WINGLET_ENABLED", "true")
    if args.port:
        save_env_value("WINGLET_PORT", str(args.port))
    if args.public_url:
        save_env_value("WINGLET_PUBLIC_URL", args.public_url.rstrip("/"))
    print("Dependencies: ready (server, push notifications, QR pairing).")
    print("🪽 Winglet is enabled for this profile.\n")
    info = _running()
    if mode == "quick":
        print("Cloudflare Quick Tunnels are free, temporary, and have no uptime guarantee.")
        print("Android follows address changes when reconnecting; iPhone needs a new QR after the address changes.")
        if getattr(args, "no_start", False):
            print("Ready. Start/restart the gateway, then run `hermes winglet pair`.")
            return 0
        try:
            if ((info or {}).get("connection") or {}).get("mode") != "quick":
                print("Starting/restarting the gateway for this profile...")
                _start_gateway()
        except Exception as exc:
            print(f"Could not start the gateway: {exc}")
            print("Run `hermes gateway restart` (or `hermes gateway run`), then `hermes winglet pair`.")
            return 1
        print("Waiting for the HTTPS address to answer with this Winglet server...")
        if not _wait_for_quick():
            print("Automatic HTTPS is not ready. No pairing code was created.")
            print("Check the gateway's Winglet startup logs and plugin-data/winglet/gateway-setup.log.")
            print("Outbound HTTPS and Cloudflare TCP port 7844 must be allowed. Then retry `hermes winglet pair`.")
            return 1
        return cmd_pair(argparse.Namespace(public_url=None))
    print("Gateway: running locally." if info else "Gateway: not answering locally yet. Pairing is not ready.")
    print("Next:")
    print("  1. Restart the gateway:   hermes gateway restart   (or start it: hermes gateway run)")
    print("  2. Pair your phone:       hermes winglet pair\n")
    print("Tip: for live-typing replies, add this to config.yaml:")
    print("  display:\n    platforms:\n      winglet:\n        streaming: true")
    _print_connection_help(public_url(args.public_url))
    return 0


def cmd_pair(args: argparse.Namespace) -> int:
    info = _running()
    if info is None:
        print("Pairing is not ready: Winglet isn't answering locally.")
        print("Run `hermes winglet setup`, then `hermes gateway restart` (or `hermes gateway run`).")
        print("If the gateway is already running, check its Winglet startup logs and configured port.")
        return 1
    if not ensure_ready():
        return 1
    url = public_url(args.public_url)
    if _setting("connection", "WINGLET_CONNECTION") == "quick" and not args.public_url:
        from .tunnel import QUICK_URL
        if not url or not QUICK_URL.fullmatch(url) or not _verify_public(url, info["server_id"]):
            print("Pairing is not ready: automatic HTTPS isn't reachable yet. No code was created.")
            print("Wait for the gateway's automatic HTTPS startup, then retry `hermes winglet pair`.")
            return 1
    from .adapter import open_store
    from .keys import ServerKeys
    role = "member" if getattr(args, "member", False) else "owner"
    store = open_store()
    try:
        code = store.create_pair_code(role=role)
        fingerprint = ServerKeys(store).fingerprint
        store.add_audit("pairing_code", summary=f"for a new {role}, from the terminal")
    finally:
        store.close()
    # The fingerprint lets the phone check it's talking to this server, whatever is in between.
    link = f"{url}/#pair={code}&fp={fingerprint}"
    print("\nScan this with your phone's camera (iPhone) or the Winglet app (Android):\n")
    _print_qr(link)
    print(f"\n  Link:  {link}")
    print(f"  Code:  {code[:4]}-{code[4:]}   (expires in 10 minutes, works once; pairs as {role})")
    print("  Already paired? Scan it from Winglet's Devices screen to verify that phone.\n")
    if url.lower().startswith("http://"):
        print("Note: Android can connect from any network that can reach this address; same Wi-Fi is not required.")
        print("Use HTTPS for remote connections and iPhone camera/install/notification features"
              " (see `hermes winglet setup`).")
    return 0


def cmd_devices(args: argparse.Namespace) -> int:
    from .adapter import open_store
    store = open_store()
    try:
        devices = store.list_devices()
    finally:
        store.close()
    if not devices:
        print("No phones paired yet. Run `hermes winglet pair`.")
        return 0
    import datetime as _dt
    for d in devices:
        seen = _dt.datetime.fromtimestamp(d["last_seen"]).strftime("%Y-%m-%d %H:%M")
        status = "verified" if d["verified"] else "not verified"
        print(f"  {d['id']}  {d['name']:<24} {d['platform'] or '':<8} {d['role']:<7} {status:<13} last seen {seen}")
    return 0


def cmd_role(args: argparse.Namespace) -> int:
    from .adapter import open_store
    store = open_store()
    try:
        device = store.update_device(args.device_id, role=args.role)
        if device is not None:
            store.add_audit("device.role", summary=f"{device['name']} → {args.role}, from the terminal")
    except ValueError as exc:
        print(exc)
        return 1
    finally:
        store.close()
    if device is None:
        print("No device with that id.")
        return 1
    print(f"{device['name']} is now {'an owner' if args.role == 'owner' else 'a member'}. It reconnects to pick this up.")
    return 0


def cmd_rotate_key(args: argparse.Namespace) -> int:
    from .adapter import open_store
    from .keys import ServerKeys
    store = open_store()
    try:
        ServerKeys(store).rotate_sealing()
        store.add_audit("server_key.rotated", summary="from the terminal")
    finally:
        store.close()
    print("New encryption key in place. Phones pick it up the next time they send a secret; the old key")
    print("still opens anything sent in the next 24 hours. To replace the server's identity itself, pair again.")
    return 0


def cmd_unpair(args: argparse.Namespace) -> int:
    from .adapter import open_store
    store = open_store()
    try:
        removed = store.remove_device(args.device_id)
        if removed:
            store.add_audit("device.removed", summary=f"{args.device_id}, from the terminal")
    finally:
        store.close()
    print("Removed." if removed else "No device with that id.")
    return 0 if removed else 1


def cmd_status(args: argparse.Namespace) -> int:
    enabled = _env("WINGLET_ENABLED").lower() in ("1", "true", "yes", "on")
    info = _running()
    print(f"Enabled:  {'yes' if enabled else 'no  (run `hermes winglet setup`)'}")
    title = (info.get("bot") or {}).get("title", "Winglet") if info else ""
    print(f"Running:  {'yes — ' + title if info else 'no  (start the gateway: hermes gateway run)'}")
    url = public_url()
    print(f"URL:      {url or 'automatic HTTPS starting/unavailable'}")
    if _setting("connection", "WINGLET_CONNECTION") == "quick":
        verified = bool(url and info and _verify_public(url, info["server_id"]))
        print(f"Automatic HTTPS: {'verified through Cloudflare' if verified else 'not ready'}")
    else:
        print("Phone connectivity: not verified from this machine.")
    return 0
