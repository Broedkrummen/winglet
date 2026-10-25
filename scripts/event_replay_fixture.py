"""Disposable, loopback-only replay UI fixture. Never connects to Hermes or push providers.

Run from the repository root: python scripts/event_replay_fixture.py
Open http://127.0.0.1:9308 and pair using the code printed at startup.
Only synthetic messages are seeded; data lives in an automatically removed temporary folder.
"""
import asyncio
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from aiohttp import web
from plugin.hub import Hub, ROUTE_POLICY
from plugin.store import Store


async def main():
    with tempfile.TemporaryDirectory(prefix="winglet-replay-fixture-") as temporary:
        store = Store(Path(temporary) / "fixture.db")
        store.ensure_chat("general", "Replay lab")
        hub = Hub(store, web_root=Path(__file__).resolve().parents[1] / "app/dist-replay-web",
                  bot_info=lambda: {"name": "replay-lab", "title": "Replay lab", "description": "Synthetic local data"})
        await hub.post_message("general", "Replay lab is ready. Drafts stay here while catching up.", push=False)
        code = store.create_pair_code()
        print(f"Local disposable fixture: http://127.0.0.1:9308   Pair code: {code}", flush=True)
        app = hub.build_app()
        # These routes only exist on the fixture, never on a real gateway.
        async def seed(request):
            body = await request.json()
            message = await hub.post_message("general", str(body.get("text") or "Arrived while you were away"), push=False)
            return web.json_response(message)
        async def rotate(request):
            hub.events.rotate_epoch()
            return web.json_response({"ok": True})
        ROUTE_POLICY.update({"seed": "device", "rotate": "device"})
        app.router.add_post("/fixture/message", seed)
        app.router.add_post("/fixture/epoch", rotate)
        runner = web.AppRunner(app)
        await runner.setup()
        await web.TCPSite(runner, "127.0.0.1", 9308).start()
        try: await asyncio.Event().wait()
        finally:
            await runner.cleanup(); store.close()


if __name__ == "__main__":
    try: asyncio.run(main())
    except KeyboardInterrupt: pass
