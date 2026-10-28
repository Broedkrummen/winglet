"""Disposable, loopback-only Winglet demo. No Hermes imports, CLI, or provider calls."""
from __future__ import annotations

import argparse
import asyncio
import copy
import hashlib
import ipaddress
import json
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from aiohttp import web
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from plugin import execution, keys
from plugin.hub import Hub
from plugin.store import Store

DEMO_TOKEN = "winglet-offline-demo-not-a-real-token"
BOTS = [
    {"name": "atlas", "title": "Atlas", "description": "Research, code, and careful second opinions", "served": True},
    {"name": "nova", "title": "Nova", "description": "Small adventures, good food, and creative ideas", "served": True},
]


def iso(stamp: float) -> str:
    return datetime.fromtimestamp(stamp, timezone.utc).isoformat()


class DemoBackend:
    """The handful of adapter reads the UI needs, backed exclusively by synthetic values."""

    HermesRefused = ValueError
    HermesUnavailable = NotImplementedError

    def __init__(self, hub: Hub, now: float):
        self.hub = hub
        self.routines = {
            None: [self.routine("morning", "Morning briefing", "Every weekday at 08:30", now + 3600,
                                "Review today's priorities, a short reading list, and one thing to look forward to."),
                   self.routine("weekly", "Friday reset", "Every Friday at 16:00", now + 3 * 86400,
                                "Review the week, celebrate progress, and suggest three priorities for next week.")],
            "atlas": [], "nova": [],
        }

    @staticmethod
    def routine(rid, name, schedule, next_run, prompt):
        return {"id": rid, "name": name, "prompt": prompt, "schedule_display": schedule,
                "state": "scheduled", "enabled": True, "next_run_at": iso(next_run),
                "last_run_at": iso(time.time() - (7 if rid == "weekly" else 1) * 86400), "last_status": "ok", "last_error": None,
                "deliver": "Winglet", "kind": "cron", "paused_reason": None}

    def bots_available(self):
        return True

    def configured_model(self):
        return {"model": "demo-local", "provider": "demo", "label": "Offline demo"}

    def list_schedule(self):
        return copy.deepcopy(self.routines.get(self.hub.bot_name(), []))

    def change_routine(self, routine_id, action, fields=None):
        rows = self.routines.get(self.hub.bot_name(), [])
        routine = next((r for r in rows if r["id"] == routine_id), None)
        if routine is None:
            return None
        if action == "delete":
            rows.remove(routine)
            return {"deleted": True}
        if action in ("pause", "resume"):
            routine.update(enabled=action == "resume", state="paused" if action == "pause" else "scheduled")
        elif action == "update":
            values = dict(fields or {})
            if "schedule" in values:
                values["schedule_display"] = values.pop("schedule")
            routine.update(values)
        elif action == "run":
            raise ValueError("Demo routines are display-only; no scheduler or model is running.")
        return copy.deepcopy(routine)

    def create_routine(self, *args):
        raise ValueError("Demo routines are display-only. Restart to restore the sample data.")

    def parse_schedule(self, *args):
        raise ValueError("Schedule parsing is not connected in this offline demo.")

    def model_options(self, **kwargs):
        return {"model": "demo-local", "provider": "demo", "providers": [], "models": []}

    def read_persona(self):
        return {"content": "Be thoughtful, practical, and concise. Ask before taking action. This is a synthetic demo.",
                "exists": True}

    def memory(self):
        return {target: {"entries": [text], "enabled": True, "limit": 4000, "used": len(text)}
                for target, text in {"user": "Prefers short lists and a little breathing room between plans.",
                                     "memory": "Demo workspace only. No real personal data is loaded."}.items()}

    def usage(self, days=30):
        days = max(1, min(90, days))
        today = datetime.now(timezone.utc).date()
        daily = [{"day": str(today - timedelta(days=i)), "input_tokens": 14000 + i * 1700,
                  "output_tokens": 2800 + i * 280, "estimated_cost": round(.04 + i * .009, 3),
                  "sessions": 2 + i % 3} for i in reversed(range(min(days, 7)))]
        totals = {"total_input": sum(r["input_tokens"] for r in daily),
                  "total_output": sum(r["output_tokens"] for r in daily),
                  "total_estimated_cost": sum(r["estimated_cost"] for r in daily),
                  "total_sessions": sum(r["sessions"] for r in daily)}
        return {"daily": daily, "by_model": [{"model": "demo-local", "input_tokens": totals["total_input"],
                "output_tokens": totals["total_output"], "estimated_cost": totals["total_estimated_cost"],
                "sessions": totals["total_sessions"]}], "totals": totals, "period_days": days}

    def paused(self):
        return None

    def system_stats(self):
        return {"system": "Offline demo", "arch": "synthetic", "cpu_count": 4, "cpu_percent": 7,
                "memory": {"total": 8 * 1024**3, "used": 2 * 1024**3, "percent": 25},
                "disk": {"total": 256 * 1024**3, "used": 48 * 1024**3, "percent": 18.75}}

    def set_paused(self, *args):
        raise ValueError("There is no live agent to pause in this demo.")

    async def check_hermes_update(self, **kwargs):
        return {"update_available": False, "can_apply": False, "message": "Offline demo: updates are disabled."}

    def check_winglet_update(self):
        return {"update_available": False, "reason": "Offline demo: updates are disabled."}

    def read_log(self, *args, **kwargs):
        return {"lines": [], "size": 0}


class DemoHub(Hub):
    def features(self):
        features = super().features()
        # Keep the app from offering integrations that could initiate external calls.
        features.update({name: False for name in ("abilities", "voice", "webpush", "ntfy",
                                                  "encrypted_push", "wear_relay", "wear_reply")})
        return features

    async def _client(self):
        # A hard backstop, even if someone manually invokes a push/tunnel endpoint.
        raise web.HTTPServiceUnavailable(text=json.dumps({"error": "External network is disabled in the demo."}),
                                         content_type="application/json")

    async def push_now(self, *args, **kwargs):
        return None


def seed(hub: DemoHub, device: dict, now: float) -> None:
    store = hub.store

    def conversation(chat_id, title, bot, age_hours, turns):
        store.ensure_chat(chat_id, title, bot=bot)
        start = now - age_hours * 3600
        for index, turn in enumerate(turns):
            role, text, *extra = turn
            row = store.add_message(chat_id, role, text, meta=extra[0] if extra else {})
            stamp = start + index * 75
            store._exec("UPDATE messages SET created_at = ?, updated_at = ? WHERE id = ?", (stamp, stamp, row["id"]))
        store._exec("UPDATE chats SET created_at = ?, updated_at = ? WHERE id = ?",
                    (start, start + (len(turns) - 1) * 75, chat_id))

    conversation("general", "A little more space this week", None, 1, [
        ("user", "Help me make this week feel a little less crowded."),
        ("bot", "Let's protect your attention before adding more tasks.\n\n1. Pick **one important outcome** for each day.\n2. Keep two evenings free.\n3. Put the small errands in a single 45-minute block."),
        ("user", "The portfolio refresh is the one thing I really want to finish."),
        ("bot", "Then that's our anchor. I've broken the refresh into a small plan, and kept the rest of the week deliberately light.\n\n**Today:** choose the three projects you want to show. Tomorrow we can shape their stories."),
    ])
    conversation("portfolio", "Make the portfolio feel like me", None, .4, [
        ("user", "Can you help me refresh my portfolio without turning it into a huge project?"),
        ("bot", "Absolutely. A focused refresh, not a rebuild:\n\n- Lead with three projects you're proud of.\n- Replace long process essays with a clear before-and-after.\n- End each case study with what you learned.\n\nI'll start with the project descriptions."),
        ("bot", "Read notes/portfolio.md and compared the three case-study outlines.", {"activity": True}),
        ("user", "Keep the tone warm. I don't want it to sound like a pitch deck."),
        ("bot", "Good constraint. The opening now reads:\n\n> I make useful things, with a soft spot for the details that make them feel easy.\n\nThe first two case studies are ready. I'm shaping the final one next."),
    ])
    conversation("weekend", "A slow Saturday, mostly outside", None, 20, [
        ("user", "Plan a low-key Saturday. A walk, a good lunch, no rushing."),
        ("bot", "A gentle outline:\n\n| Time | Plan |\n| --- | --- |\n| 09:30 | Coffee and a riverside walk |\n| 12:00 | Lunch at the market |\n| 14:00 | Bookshop, then home |\n\nLeave the afternoon open. The best part of a slow day is having room to change your mind."),
        ("user", "That sounds right. Keep lunch flexible."),
        ("bot", "Done. The walk is the only fixed point; everything after that is optional."),
    ])
    conversation("archive", "Moving-day checklist", None, 94, [
        ("user", "Let's wrap up the moving-day checklist."),
        ("bot", "Everything is checked off:\n\n- Keys collected\n- Utilities confirmed\n- Boxes recycled\n- First-night essentials unpacked\n\nYou're settled in. This one can go in the archive."),
    ])
    conversation("b-atlas", "Atlas", "atlas", 5, [
        ("user", "Give me a quick overview of what you're looking into."),
        ("bot", "Two threads today: a quieter note-taking setup, and a tiny script for keeping project folders tidy. Both are ready for a closer look."),
    ])
    conversation("notes", "A calmer home for my notes", "atlas", 3, [
        ("user", "Compare plain Markdown notes with a database-style notes app."),
        ("bot", "I reviewed the sample requirements and compared three lightweight workflows.", {"activity": True}),
        ("bot", "For your setup, **start with Markdown**.\n\n| Approach | Best at | Trade-off |\n| --- | --- | --- |\n| Markdown folder | Portability, fast capture | Fewer structured views |\n| Linked notes | Discovering connections | Needs consistent habits |\n| Database app | Sorting and filtering | More setup and maintenance |"),
        ("user", "What would the folder structure look like?"),
        ("bot", "Keep it small:\n\n```text\nnotes/\n  inbox/\n  projects/\n  reference/\n  archive/\n```\n\nCapture first; organize during a ten-minute Friday review. You can always add structure later."),
    ])
    conversation("cleanup", "A safer folder-cleanup script", "atlas", 2, [
        ("user", "Can you tidy the generated previews in the demo workspace?"),
        ("bot", "I found 12 generated preview files. The script uses a dry run by default:\n\n```python\nfrom pathlib import Path\n\nfor preview in Path('demo-previews').glob('*.tmp'):\n    print(f'Would remove: {preview.name}')\n```\n\nI'll ask before changing anything."),
        ("user", "Show me the dry-run summary first."),
        ("bot", "The summary is ready. Nothing has been changed. You can review the approval in your inbox."),
    ])
    conversation("b-nova", "Nova", "nova", 26, [
        ("user", "I want a few small things to look forward to this week."),
        ("bot", "Three easy wins: cook something colorful, take a different route home, and leave one evening completely unplanned. Which should we start with?"),
    ])
    conversation("dinner", "Dinner for friends, without the fuss", "nova", 1.8, [
        ("user", "Four friends for dinner. Mostly vegetarian, and I want to enjoy the evening too."),
        ("bot", "Let's make nearly everything ahead of time:\n\n- **Main:** roasted tomato and white-bean tray bake\n- **Side:** lemony couscous and a crunchy green salad\n- **Dessert:** yogurt, berries, and a little dark chocolate\n\nOne oven tray, no last-minute juggling."),
        ("user", "Could we make the main fully vegan?"),
        ("bot", "Already there. Use olive oil throughout, keep the yogurt on the side, and offer coconut yogurt too. One question before I make the shopping list: any allergies?"),
    ])
    conversation("home", "Updates", None, 7, [
        ("bot", "## Your morning briefing\n\nThe portfolio refresh is moving along. Two case studies are ready, and your Friday reset is scheduled.\n\n**A small suggestion:** leave 30 minutes between the last task and your evening plans.",
         {"routine": {"job_id": "morning", "name": "Morning briefing"}}),
    ])
    for kind, chat_id, title, body, payload in [
        ("approval", "cleanup", "Ready to run the preview cleanup?", "Review the dry run before removing 12 generated preview files. This demo never executes commands.",
         {"command": "python tidy_previews.py --apply", "choices": ["once", "deny"],
          "labels": {"once": "Approve once", "deny": "Keep the files"}, "styles": {"once": "primary"}}),
        ("question", "dinner", "Any allergies for Friday's dinner?", "Before I finish the shopping list, is there anything to avoid?",
         {"question": "Any allergies or ingredients to avoid?", "choices": ["No allergies", "Nut-free", "Gluten-free"], "multi_select": False}),
    ]:
        item = store.add_inbox(kind, chat_id, title, body, payload)
        stamp = now - 12 * 60 if kind == "approval" else now - 8 * 60
        store._exec("UPDATE inbox SET created_at = ?, updated_at = ? WHERE id = ?", (stamp, stamp, item["id"]))
        row = store.add_message(chat_id, "bot", body, meta={"inbox_id": item["id"], "kind": kind})
        store._exec("UPDATE messages SET created_at = ?, updated_at = ? WHERE id = ?", (stamp, stamp, row["id"]))
        store._exec("UPDATE chats SET updated_at = ? WHERE id = ?", (stamp, chat_id))

    project = hub.projects.create(device, None, {"name": "A lighter week", "client_id": "demo-project-create"})["project"]
    for chat_id in ("portfolio", "weekend"):
        project = hub.projects.move_chat(device, None, project["id"], chat_id,
                                        {"revision": project["revision"], "client_id": "demo-project-" + chat_id})["project"]
    goal = {"goal": "Publish a portfolio that feels thoughtful, clear, and genuinely mine", "status": "active",
            "turns_used": 3, "max_turns": 8, "subgoals": ["Choose three projects", "Write short case studies", "Polish and publish"],
            "last_verdict": "continue", "last_reason": "Two case studies are ready; the final story is in progress.",
            "paused_reason": None, "waiting_reason": None, "created_at": now - 2 * 86400, "last_turn_at": now - 1200}
    hub.chat_goal = lambda chat_id: copy.deepcopy(goal) if chat_id == "portfolio" else None
    tracker = execution.Tracker(lambda sid: {"chat_id": "portfolio", "bot": None} if sid == "demo-portfolio" else None)
    tracker.turn_started("demo-portfolio", "demo-review")
    tracker.plan_updated("demo-portfolio", {"revision": 1, "todos": [
        {"id": "1", "content": "Choose three projects", "status": "completed"},
        {"id": "2", "content": "Write the first two case studies", "status": "completed"},
        {"id": "3", "content": "Shape the final project story", "status": "in_progress"},
        {"id": "4", "content": "Review the layout and publish", "status": "pending"},
    ]}, turn_id="demo-review")
    tracker.tool_started("demo-portfolio", "read_file", "demo-read", {"path": "notes/portfolio.md"}, turn_id="demo-review")
    tracker.tool_finished("demo-portfolio", "read_file", "demo-read", turn_id="demo-review", status="ok", duration_ms=320)
    hub.execution = tracker


def bootstrap(hub: Hub, device: dict, signing_secret: str, port: int) -> str:
    """Use the app's documented storage shapes, including its device-only pin/archive preferences."""
    server_id = hub.server_id()
    base = {"id": server_id, "url": f"http://127.0.0.1:{port}", "token": DEMO_TOKEN,
            "deviceId": device["id"], "bot": hub.bot(), "addedAt": int(time.time() * 1000),
            "fingerprint": hub.keys.fingerprint, "wsAuth": True}
    servers = [base] + [{**base, "id": f"{server_id}~{b['name']}", "profile": b["name"],
                         "parent": server_id, "bot": {k: b[k] for k in ("name", "title", "description")}} for b in BOTS]
    chat_key = lambda sid, cid: json.dumps([sid, cid], separators=(",", ":"))
    values = {"winglet.servers": servers, "winglet.selection": {"serverId": server_id, "chatId": "general"},
              "winglet.prefs": {"theme": "light", "sounds": False, "updateCheck": False, "mainBot": server_id,
                                "pinnedChats": [chat_key(server_id, "portfolio"), chat_key(server_id + "~atlas", "notes")],
                                "archivedChats": [chat_key(server_id, "archive")]}}
    # All values originate in this file; escape '<' so generated HTML cannot accidentally close script.
    data = json.dumps(values).replace("<", "\\u003c")
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>Winglet offline demo</title></head>
<body><p>Opening your disposable Winglet workspace...</p><script>
try {{
  const values = {data};
  for (const [key, value] of Object.entries(values)) localStorage.setItem(key, JSON.stringify(value));
  localStorage.setItem({json.dumps('winglet.sign.' + server_id)}, {json.dumps(signing_secret)});
  location.replace('/');
}} catch (error) {{ document.body.textContent = 'Allow local site storage, then reload /demo. ' + error.message; }}
</script><noscript>Enable JavaScript to open Winglet.</noscript></body></html>"""


async def run(args) -> None:
    web_root = (ROOT / args.web_root).resolve()
    if not (web_root / "index.html").is_file():
        raise SystemExit(f"No exported web app at {web_root}. Run: cd app && npx expo export --platform web --clear")
    with tempfile.TemporaryDirectory(prefix="winglet-offline-demo-") as scratch:
        store = Store(":memory:")
        hub = DemoHub(store, web_root=web_root, media_dir=Path(scratch) / "media",
                      bot_info=lambda: {"name": "hermes", "title": "Hermes", "description": "A thoughtful hand with everyday life"})
        now = time.time()
        private = Ed25519PrivateKey.generate()
        raw = serialization.Encoding.Raw
        secret = keys.b64e(private.private_bytes(raw, serialization.PrivateFormat.Raw, serialization.NoEncryption()))
        public = keys.b64e(private.public_key().public_bytes(raw, serialization.PublicFormat.Raw))
        device, _ = store.add_device("Demo browser", "web", sign_key=public, verified=True)
        store._exec("UPDATE devices SET token_hash = ? WHERE id = ?",
                    (hashlib.sha256(DEMO_TOKEN.encode()).hexdigest(), device["id"]))
        store.add_device("Sample phone", "android")
        hub.hermes = DemoBackend(hub, now)
        hub.hermes_version = lambda: "offline demo (no Hermes)"
        hub.bots_provider = lambda: {"bots": copy.deepcopy(BOTS), "multiplex": True, "reason": "Synthetic demo bots"}
        hub.connection = {"mode": "direct", "url": f"http://127.0.0.1:{args.port}"}
        hub.listen = f"127.0.0.1:{args.port}"
        seed(hub, device, now)

        async def reply(chat, text, device, message, **extra):
            await hub.set_typing(chat["id"], True)
            try:
                await asyncio.sleep(.25)
                await hub.post_message(chat["id"], "This is a synthetic demo reply. Your message is saved for this run only.\n\n"
                                       "- No model provider was called.\n- No command was executed.\n- Restart the demo to reset the workspace.", push=False)
            finally:
                await hub.set_typing(chat["id"], False)

        async def resolve(item, choice):
            await hub.post_message(item["chat_id"], "Thanks, noted for this demo. Nothing was executed or sent anywhere.", push=False)
            return True

        hub.on_user_message, hub.on_approval, hub.on_answer = reply, resolve, resolve
        stop = asyncio.Event()

        @web.middleware
        async def demo_routes(request, handler):
            # These local-only demo routes run ahead of normal Hub authentication. Never add them to production.
            if request.path.startswith("/demo"):
                if not ipaddress.ip_address(request.remote or "0.0.0.0").is_loopback:
                    raise web.HTTPForbidden()
                headers = {"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"}
                if request.method == "GET" and request.path in ("/demo", "/demo/"):
                    return web.Response(text=bootstrap(hub, device, secret, args.port), content_type="text/html", headers=headers)
                if request.method == "GET" and request.path == "/demo/pair":
                    code = store.create_pair_code(ttl=86400)
                    raise web.HTTPFound(f"/#pair={code}&fp={hub.keys.fingerprint}", headers=headers)
                if request.method == "POST" and request.path == "/demo/stop":
                    if request.headers.get("Authorization") != f"Bearer {DEMO_TOKEN}":
                        raise web.HTTPUnauthorized()
                    asyncio.get_running_loop().call_later(.1, stop.set)
                    return web.json_response({"stopping": True}, headers=headers)
                raise web.HTTPNotFound()
            return await handler(request)

        app = hub.build_app()
        app.middlewares.insert(0, demo_routes)
        runner = web.AppRunner(app, access_log=None)
        try:
            await runner.setup()
            await web.TCPSite(runner, "127.0.0.1", args.port).start()
            code = store.create_pair_code(ttl=86400)
            print(f"\nWinglet OFFLINE DEMO (in-memory; resets on exit)\n"
                  f"Open paired workspace: http://127.0.0.1:{args.port}/demo\n"
                  f"Normal pairing link:   http://127.0.0.1:{args.port}/#pair={code}&fp={hub.keys.fingerprint}\n"
                  f"Fresh pairing link:    http://127.0.0.1:{args.port}/demo/pair\n"
                  f"API bearer token:      {DEMO_TOKEN}\n"
                  f"Web root:              {web_root}\n"
                  "9 conversations + Updates, 3 bots, 2 pending cards, 1 goal, 2 routines, 1 project.\n"
                  "Open /demo after each restart to refresh disposable credentials and demo preferences.\n"
                  "Ctrl-C stops this server. No Hermes, provider, scheduler, or external network.\n", flush=True)
            await stop.wait()
        finally:
            await runner.cleanup()
            await hub.aclose()
            store.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=18790, help="loopback port (default: 18790; live Hermes port 8871 is refused)")
    parser.add_argument("--web-root", default="app/dist", help="exported app, relative to repo root or absolute")
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535 or args.port == 8871:
        parser.error("Use an unprivileged demo port other than 8871. The live Hermes port is never used.")
    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
