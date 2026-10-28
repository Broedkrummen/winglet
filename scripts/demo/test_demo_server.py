"""Hermes-free regression checks: python -m unittest discover -s scripts/demo -v."""
import asyncio
import hashlib
import json
import tempfile
import time
import unittest
from pathlib import Path

from aiohttp.test_utils import TestClient, TestServer

from demo_server import BOTS, DEMO_TOKEN, DemoBackend, DemoHub, bootstrap, seed
from plugin.store import Store


class DemoTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="winglet-demo-test-")
        self.store = Store(":memory:")
        self.hub = DemoHub(self.store, media_dir=Path(self.scratch.name))
        self.device, self.token = self.store.add_device("Test browser", "web")
        self.store._exec("UPDATE devices SET token_hash = ? WHERE id = ?",
                         (hashlib.sha256(DEMO_TOKEN.encode()).hexdigest(), self.device["id"]))
        self.hub.hermes = DemoBackend(self.hub, time.time())
        self.hub.bots_provider = lambda: {"bots": BOTS, "multiplex": True}
        seed(self.hub, self.device, time.time())
        self.client = TestClient(TestServer(self.hub.build_app()))
        await self.client.start_server()
        self.auth = {"Authorization": f"Bearer {DEMO_TOKEN}"}

    async def asyncTearDown(self):
        await self.client.close()
        await self.hub.aclose()
        self.store.close()
        self.scratch.cleanup()

    async def get(self, path):
        response = await self.client.get(path, headers=self.auth)
        self.assertEqual(response.status, 200, await response.text())
        return await response.json()

    async def test_chats_and_bot_scoping(self):
        counts = []
        for suffix in ("", "?bot=atlas", "?bot=nova"):
            counts.append(len((await self.get("/api/chats" + suffix))["chats"]))
        self.assertEqual(counts, [5, 3, 2])
        unauthorized = await self.client.get("/api/chats")
        self.assertEqual(unauthorized.status, 401)

    async def test_transcript_markdown_and_tool_activity(self):
        notes = (await self.get("/api/chats/notes/messages?bot=atlas"))["messages"]
        self.assertTrue(any("```text" in m["text"] for m in notes))
        self.assertTrue(any("| Approach |" in m["text"] for m in notes))
        self.assertTrue(any(m["meta"].get("activity") for m in notes))
        self.assertTrue(all(m["created_at"] <= time.time() for m in notes))

    async def test_pending_cards_goals_task_projects_and_schedule(self):
        inbox = await self.get("/api/inbox?bot=atlas")
        self.assertTrue(any(i["status"] == "pending" and i["kind"] == "approval" for i in inbox["items"]))
        question = await self.get("/api/inbox?bot=nova")
        self.assertTrue(any(i["status"] == "pending" and i["kind"] == "question" for i in question["items"]))
        goals = (await self.get("/api/goals"))["goals"]
        self.assertEqual(goals[0]["chat_id"], "portfolio")
        task = (await self.get("/api/task?chat=portfolio"))["snapshot"]
        self.assertEqual(task["state"], "running")
        self.assertTrue(task["plan"])
        projects = await self.get("/api/projects")
        self.assertEqual(projects["projects"]["projects"][0]["chat_count"], 2)
        self.assertEqual(len((await self.get("/api/schedule"))["routines"]), 2)
        self.assertGreater((await self.get("/api/usage"))["totals"]["total_input"], 0)

    async def test_pairing_code_and_socket_startup(self):
        code = self.store.create_pair_code()
        response = await self.client.post("/api/pair", json={"code": code, "device_name": "Pair flow test", "platform": "web"})
        self.assertEqual(response.status, 200)
        pairing = await response.json()
        self.assertTrue(pairing["token"])
        response = await self.client.post("/api/pair", json={"code": code})
        self.assertEqual(response.status, 403)
        ws = await self.client.ws_connect("/api/ws")
        await ws.send_json({"type": "auth", "token": DEMO_TOKEN})
        hello = await ws.receive_json(timeout=5)
        self.assertEqual(hello["type"], "hello")
        self.assertEqual(len(hello["chats"]), 5)
        await ws.close()

    async def test_bootstrap_uses_app_storage_and_disables_network_features(self):
        page = bootstrap(self.hub, self.device, "test-signing-key", 18790)
        self.assertIn('"winglet.servers"', page)
        self.assertIn('"winglet.prefs"', page)
        self.assertIn('"pinnedChats"', page)
        self.assertIn('"archivedChats"', page)
        self.assertIn("winglet.sign.", page)
        self.assertNotIn(":8871", page)
        features = self.hub.features()
        for feature in ("webpush", "ntfy", "encrypted_push", "voice"):
            self.assertFalse(features[feature])
        self.assertTrue(features["bots"])
        with self.assertRaises(Exception) as raised:
            await self.hub._client()
        self.assertEqual(raised.exception.status, 503)


if __name__ == "__main__":
    unittest.main()
