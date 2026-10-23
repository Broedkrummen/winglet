"""Disposable fixture for the structured execution UI (web and emulator checks).

Serves the exported web app (``app/dist``) and a real Winglet Hub from one port, seeded with one
running turn (plan, tools and nested subagents) plus one finished turn. A second, loopback-only port
exposes controls to finish the turn, raise a pending approval, or reset the fixture.

Everything is synthetic, in memory, and thrown away on exit. There is no Hermes, no provider call,
no user data and no outbox. Use it only on a machine you control.

    cd app && npx expo export --platform web
    python scripts/execution_fixture.py --port 9304
    # open the printed link (and pairing code) on the web app or an emulator

Android emulator: pass ``--host 10.0.2.2`` is not needed; bind ``--bind 0.0.0.0`` and pair with
``http://10.0.2.2:<port>``. Controls stay on 127.0.0.1:<control-port>; reach them with ``adb reverse``
or curl on the host.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from aiohttp import web  # noqa: E402

from plugin import execution  # noqa: E402
from plugin.hub import Hub  # noqa: E402
from plugin.store import Store  # noqa: E402

SESSIONS = {"ms-general": {"chat_id": "general", "bot": None},
            "ms-side": {"chat_id": "side", "bot": None}}


def todos(*items, revision=1):
    return json.dumps({"todos": [
        {"id": str(i), "content": text, "status": status, **({"parent": parent} if parent else {})}
        for i, (text, status, parent) in enumerate(items)], "revision": revision})


def seed(tracker: execution.Tracker) -> None:
    tracker.turn_started("ms-general", "turn-42")
    tracker.plan_updated("ms-general", todos(
        ("Read the release notes and changelog", "completed", None),
        ("Check which fixes touch the phone app", "completed", None),
        ("Summarise the changes people will notice", "in_progress", None),
        ("Look up the two renamed settings screens", "in_progress", "2"),
        ("Draft the short version for the chat", "pending", None),
        ("Confirm the 40-character subject line", "pending", None),
        ("Old approach: copy every heading", "cancelled", None),
        revision=7), turn_id="turn-42")
    tracker.tool_started("ms-general", "read_file", "call-read", {"path": "~/notes/release.md"}, turn_id="turn-42")
    tracker.tool_finished("ms-general", "read_file", "call-read", turn_id="turn-42", status="ok", duration_ms=840)
    tracker.tool_started("ms-general", "web_search", "call-search",
                         {"query": "release notes hidden settings"}, turn_id="turn-42")
    tracker.subagent_started("ms-general", "child-a", "sa-a", goal="Summarise the three biggest user-facing changes",
                             role="leaf", parent_turn_id="turn-42")
    tracker.tool_started("child-a", "read_file", "child-read", {"path": "CHANGELOG.md"}, turn_id="turn-42")
    tracker.tool_finished("child-a", "read_file", "child-read", turn_id="turn-42", status="ok", duration_ms=300)
    tracker.subagent_started("ms-general", "child-b", "sa-b", parent_subagent_id="sa-a",
                             goal="Check the renamed settings screens", parent_turn_id="turn-42")
    tracker.subagent_finished("ms-general", child_session_id="child-b", status="completed",
                              summary="Settings → Tools is now Settings → Capabilities; nothing else moved.",
                              duration_ms=2400, parent_turn_id="turn-42")
    tracker.subagent_started("ms-general", "child-c", "sa-c", goal="Draft the subject line", parent_turn_id="turn-42")
    tracker.subagent_finished("ms-general", child_session_id="child-c", status="failed",
                              summary="The model provider returned 503 twice; the draft is still missing.",
                              duration_ms=5100,
                              tool_call_history=[{"tool_name": "think", "tool_input": "subject line", "status": "error"}],
                              parent_turn_id="turn-42")

    tracker.turn_started("ms-side", "turn-7")
    tracker.plan_updated("ms-side", todos(("Collect the notes", "completed", None),
                                          ("Write the summary", "completed", None), revision=2), turn_id="turn-7")
    tracker.turn_finished("ms-side", "turn-7", outcome="Sent the short summary to the chat.")


async def run(args: argparse.Namespace) -> None:
    workspace = Path(tempfile.mkdtemp(prefix="winglet-execution-"))
    store = Store(workspace / "fixture.db")
    store.ensure_chat("general", "Release review")
    store.ensure_chat("side", "Weekly summary")
    hub = Hub(store, web_root=(ROOT / args.web_root).resolve(),
              bot_info=lambda: {"name": "hermes", "title": "Hermes", "description": "execution fixture"})
    loop = asyncio.get_running_loop()

    def publish(event):
        loop.call_soon_threadsafe(lambda: asyncio.ensure_future(hub.broadcast(event)))

    tracker = execution.Tracker(lambda session_id: SESSIONS.get(session_id), publish=publish)
    hub.execution = tracker
    hub.hermes_version = lambda: "fixture"
    seed(tracker)
    live = {"on": True}

    async def typing() -> None:
        while live["on"]:
            await hub.set_typing("general", True)
            await asyncio.sleep(4)

    asyncio.ensure_future(typing())
    await hub.post_message("general", "What changed in this release that I'll actually notice?", role="user")
    await hub.post_message("general", "Reading the notes now.", role="bot", push=False)

    app = hub.build_app()
    api_runner = web.AppRunner(app)
    await api_runner.setup()
    await web.TCPSite(api_runner, args.bind, args.port).start()

    async def finish(_request):
        live["on"] = False
        await hub.set_typing("general", False)
        current = tracker.snapshot("general") or {}
        tracker.turn_finished("ms-general", current.get("turn_id"),
                              outcome="Summarised the changes; the subject line still needs a retry.")
        return web.json_response({"ok": True}, headers={"Access-Control-Allow-Origin": "*"})

    async def pending(_request):
        live["on"] = False
        await hub.set_typing("general", False)
        item = await hub.add_inbox("approval", "general", "Approval needed", "rm -rf build/cache",
                                   {"command": "rm -rf build/cache", "choices": ["once", "deny"],
                                    "labels": {"once": "Approve once", "deny": "Deny"}, "styles": {},
                                    "session_key": "fixture", "request_id": "fixture-1"})
        return web.json_response({"ok": True, "id": item["id"]}, headers={"Access-Control-Allow-Origin": "*"})

    async def next_turn(_request):
        tracker.turn_started("ms-general", "turn-43")
        live["on"] = True
        asyncio.ensure_future(typing())
        return web.json_response({"ok": True}, headers={"Access-Control-Allow-Origin": "*"})

    control = web.Application()
    control.router.add_get("/finish", finish)
    control.router.add_get("/pending", pending)
    control.router.add_get("/next-turn", next_turn)
    control_runner = web.AppRunner(control)
    await control_runner.setup()
    await web.TCPSite(control_runner, "127.0.0.1", args.control_port).start()

    code = store.create_pair_code()
    shown = "10.0.2.2" if args.bind == "0.0.0.0" else args.bind
    print(f"web app:  http://{shown}:{args.port}/", flush=True)
    print(f"pair:     http://{shown}:{args.port}/#pair={code}&fp={hub.keys.fingerprint}", flush=True)
    print(f"controls: http://127.0.0.1:{args.control_port}/finish  |  /pending  |  /next-turn", flush=True)
    try:
        await asyncio.Event().wait()
    finally:
        await api_runner.cleanup()
        await control_runner.cleanup()
        store.close()
        shutil.rmtree(workspace, ignore_errors=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=9304)
    parser.add_argument("--control-port", type=int, default=9305)
    parser.add_argument("--bind", default="127.0.0.1", help="0.0.0.0 to let an emulator reach it")
    parser.add_argument("--web-root", default="app/dist", help="the exported web app")
    asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    main()
