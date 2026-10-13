"""More bots on one server: each other Hermes profile the gateway serves is a bot with its own chats.

The hub tests fake Hermes. The adapter tests check that a bot's chat is routed to its profile, and the store
tests at the end go through Hermes's own profile code, running only where Hermes is installed.
"""

import asyncio
import importlib.util
import json

from types import SimpleNamespace

import pytest

from plugin.hub import Hub
from plugin.store import Store
from test_adapter_media import adapter  # noqa: F401  (fixture)
from test_trust import pair_phone, post_signed


class Refused(ValueError):
    pass


class Unavailable(RuntimeError):
    pass


class FakeHermes:
    HermesRefused = Refused
    HermesUnavailable = Unavailable

    def __init__(self):
        self.bot = None
        self.souls = {None: "You are Hermes.", "researcher": "You dig into papers."}
        self.made = []

    def set_bot(self, name):
        previous, self.bot = self.bot, name
        return previous

    def reset_bot(self, token):
        self.bot = token

    def bots_available(self):
        return True

    def read_persona(self):
        return {"content": self.souls[self.bot], "exists": True}

    def write_persona(self, content):
        self.souls[self.bot] = content

    def rename_bot(self, name, title):
        self.renamed = (self.bot, name, title)
        return {"name": name, "title": title, "description": ""}

    def delete_bot(self, name):
        self.deleted = (self.bot, name)

    def create_bot(self, name, title, persona, description=""):
        if name == "bad":
            raise Refused("Profile names can't be 'bad'.")
        self.made.append((name, title, persona))
        return {"name": name, "title": title, "description": description}


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "data.db")
    yield s
    s.close()


@pytest.fixture
def hub(store, tmp_path):
    store.ensure_chat("general", "General")
    h = Hub(store, web_root=tmp_path / "web", bot_info=lambda: {"name": "hermes", "title": "Hermes"})
    h.hermes = FakeHermes()
    h.roster = [{"name": "researcher", "title": "Researcher", "description": "Papers", "served": True}]
    h.bots_provider = lambda: {"bots": [dict(b) for b in h.roster], "multiplex": True, "reason": ""}
    return h


@pytest.fixture
async def client(aiohttp_client, hub):
    return await aiohttp_client(hub.build_app())


async def hello(client, phone, bot=""):
    ws = await client.ws_connect(f"/api/ws?token={phone.token}" + (f"&bot={bot}" if bot else ""))
    return ws, await ws.receive_json()


async def test_each_bot_has_its_own_chats_and_the_main_socket_lists_the_bots(client, hub):
    owner = await pair_phone(client, hub)
    main, main_hello = await hello(client, owner)
    assert main_hello["bots"][0]["name"] == "researcher" and main_hello["bot"]["title"] == "Hermes"
    assert "b-researcher" not in {c["id"] for c in main_hello["chats"]} and main_hello["me"]["home_chat"] == "general"
    side, side_hello = await hello(client, owner, "researcher")
    assert side_hello["bot"]["title"] == "Researcher" and "bots" not in side_hello
    # Its main chat is made on first use, and belongs to it.
    assert side_hello["me"]["home_chat"] == "b-researcher"
    assert [c["id"] for c in side_hello["chats"]] == ["b-researcher"]
    resp = await client.post("/api/chats?bot=researcher", json={"title": "Reading list"}, headers=owner.auth)
    made = (await resp.json())["chat"]
    assert made["bot"] == "researcher"
    listed = await (await client.get("/api/chats?bot=researcher", headers=owner.auth)).json()
    assert {c["id"] for c in listed["chats"]} == {"b-researcher", made["id"]}
    assert made["id"] not in {c["id"] for c in (await (await client.get("/api/chats", headers=owner.auth)).json())["chats"]}
    # A message in a bot's chat reaches only that bot's socket.
    await hub.post_message("b-researcher", "Found three papers.")
    got = await side.receive_json()
    while got["type"] != "message.new":
        got = await side.receive_json()
    assert got["chat_id"] == "b-researcher"
    with pytest.raises(asyncio.TimeoutError):
        while True:
            event = await main.receive_json(timeout=0.3)
            assert event.get("chat_id") != "b-researcher" and event.get("chat", {}).get("id") != made["id"]
    await main.close()
    await side.close()


async def test_hermes_calls_run_as_the_bot_and_members_stay_with_the_main_one(client, hub):
    owner = await pair_phone(client, hub)
    member = await pair_phone(client, hub, "Alex", role="member")
    hub.hermes.read_persona = lambda h=hub.hermes: {"content": h.souls[h.bot], "exists": True}
    data = await (await client.get("/api/identity?bot=researcher", headers=owner.auth)).json()
    assert data["content"] == "You dig into papers." and data["bot"]["title"] == "Researcher"
    assert (await (await client.get("/api/identity", headers=owner.auth)).json())["content"] == "You are Hermes."
    assert hub.hermes.bot is None  # the scope ends with the request
    # A signed change for a bot: `bot=` is inside the path the phone signs, and it lands in that bot.
    path, body = "/api/identity?bot=researcher", json.dumps({"content": "You read everything."}).encode()
    resp = await client.put(path, data=body, headers=owner.signed("PUT", path, body))
    assert resp.status == 200 and hub.hermes.souls["researcher"] == "You read everything."
    assert hub.hermes.souls[None] == "You are Hermes."
    # The same signature doesn't carry over to another bot.
    swapped = await client.put("/api/identity?bot=default", data=body, headers=owner.signed("PUT", path, body))
    assert swapped.status == 403
    assert (await client.get("/api/chats?bot=researcher", headers=member.auth)).status == 403
    assert (await client.get("/api/chats?bot=ghost", headers=owner.auth)).status == 404
    assert (await client.get("/api/chats?bot=../etc", headers=owner.auth)).status == 404
    ws = await client.ws_connect(f"/api/ws?token={owner.token}&bot=ghost")
    await ws.receive()
    assert ws.close_code == 4404


async def test_inbox_counts_and_notifications_follow_the_bot(client, hub):
    owner = await pair_phone(client, hub)
    hub.store.ensure_chat("b-researcher", "Researcher", bot="researcher")
    await hub.add_inbox("approval", "b-researcher", "Run a command?", "rm -rf build", {"command": "rm -rf build"}, push=False)
    assert (await (await client.get("/api/inbox", headers=owner.auth)).json())["pending"] == 0
    side = await (await client.get("/api/inbox?bot=researcher", headers=owner.auth)).json()
    assert side["pending"] == 1 and side["items"][0]["chat_id"] == "b-researcher"
    sid = hub.server_id()
    assert hub.chat_path("b-researcher") == f"/chat/{sid}~researcher/b-researcher"
    assert hub.chat_path("general") == f"/chat/{sid}/general"
    note = hub._inbox_notification(hub.store.pending_items()[0])
    assert note["title"].startswith("Researcher · ") and f"server={sid}~researcher" in note["url"]


async def test_making_a_bot_from_the_phone(client, hub):
    owner = await pair_phone(client, hub)
    events = []
    real = hub.broadcast

    async def broadcast(event):
        events.append(event)
        await real(event)
    hub.broadcast = broadcast
    bad = await post_signed(client, owner, "/api/bots", {"name": "Not OK!", "title": "X", "persona": ""})
    assert bad.status == 400
    taken = await post_signed(client, owner, "/api/bots", {"name": "researcher", "title": "Again", "persona": ""})
    assert taken.status == 409
    real_create = hub.hermes.create_bot

    def create_and_serve(name, title, persona, description=""):
        made = real_create(name, title, persona, description)
        if name == "chef":  # Hermes serves it straight away (it serves every profile)
            hub.roster.append({"name": "chef", "title": "Chef", "description": "", "served": True})
        return made
    hub.hermes.create_bot = create_and_serve
    resp = await post_signed(client, owner, "/api/bots", {"name": "chef", "title": "Chef", "persona": "You cook.",
                                                         "idempotency_key": "b1"})
    assert resp.status == 202
    job_id = (await resp.json())["job"]["id"]
    for _ in range(100):
        job = hub.store.get_job(job_id)
        if job["state"] != "running":
            break
        await asyncio.sleep(0.01)
    assert job["state"] == "succeeded" and job["detail"]["message"] == "Chef is ready." and not job["detail"]["needs_restart"]
    assert hub.hermes.made == [("chef", "Chef", "You cook.")]
    assert any(e["type"] == "system.bots" and any(b["name"] == "chef" for b in e["bots"]) for e in events)
    # Not served yet (Hermes isn't serving every profile): it's made, and the phone is told to restart.
    resp = await post_signed(client, owner, "/api/bots", {"name": "scout", "title": "Scout", "persona": ""})
    job_id = (await resp.json())["job"]["id"]
    for _ in range(100):
        job = hub.store.get_job(job_id)
        if job["state"] != "running":
            break
        await asyncio.sleep(0.01)
    assert job["detail"]["needs_restart"] and "Restart" in job["detail"]["message"]
    refused = await post_signed(client, owner, "/api/bots", {"name": "bad", "title": "Bad", "persona": ""})
    job_id = (await refused.json())["job"]["id"]
    for _ in range(100):
        job = hub.store.get_job(job_id)
        if job["state"] != "running":
            break
        await asyncio.sleep(0.01)
    assert job["state"] == "failed" and "can't be 'bad'" in job["detail"]["message"]
    listing = await (await client.get("/api/bots", headers=owner.auth)).json()
    assert listing["multiplex"] is True and [b["name"] for b in listing["bots"]] == ["researcher", "chef"]
    assert hub.features()["bots"] is True


async def test_renaming_and_deleting_a_bot(client, hub):
    owner = await pair_phone(client, hub)
    hub.store.ensure_chat("b-researcher", "Researcher", bot="researcher")
    other = hub.store.create_chat("Notes", bot="researcher")
    body = json.dumps({"title": "Scholar"}).encode()
    path = "/api/bots/researcher"
    resp = await client.patch(path, data=body, headers=owner.signed("PATCH", path, body))
    assert resp.status == 200 and hub.hermes.renamed == (None, "researcher", "Scholar")  # done as the main bot
    assert (await client.patch("/api/bots/ghost", data=body, headers=owner.signed("PATCH", "/api/bots/ghost", body))).status == 404
    resp = await client.delete(path, headers=owner.signed("DELETE", path))
    assert resp.status == 200 and hub.hermes.deleted == (None, "researcher")
    # Its chats here go with it; the main bot's stay.
    assert hub.store.get_chat("b-researcher") is None and hub.store.get_chat(other["id"]) is None
    assert hub.store.get_chat("general") is not None
    assert {a["action"] for a in hub.store.list_audit(limit=5)} >= {"bot.rename", "bot.delete"}


# -- the adapter routes a bot's chat to its profile ----------------------------------------------


async def test_a_bots_chat_goes_to_its_profile_only_when_hermes_serves_it(adapter, monkeypatch):  # noqa: F811
    store = adapter._hub.store
    store.ensure_chat("b-researcher", "Researcher", bot="researcher")
    state = {"multiplex": True, "served": ["default", "researcher"], "reason": ""}
    monkeypatch.setattr(adapter.module.hermes_api, "multiplex_state", lambda runner: state)
    device = {"id": "d", "name": "Pixel"}
    await adapter._on_user_message(store.get_chat("b-researcher"), "hi", device, {"id": "m1"})
    assert adapter.handled[-1].source.profile == "researcher"
    await adapter._on_user_message(store.get_chat("general") or {"id": "general", "title": "General"}, "hi", device, {"id": "m2"})
    assert not hasattr(adapter.handled[-1].source, "profile")
    # Hermes would answer as the main bot instead: the chat says what's wrong, nothing is sent.
    state = {"multiplex": False, "served": ["default"], "reason": "only one profile exists"}
    monkeypatch.setattr(adapter.module.hermes_api, "multiplex_state", lambda runner: state)
    await adapter._on_user_message(store.get_chat("b-researcher"), "hi", device, {"id": "m3"})
    assert len(adapter.handled) == 2
    assert "isn't running yet" in store.list_messages("b-researcher")[-1]["text"]
    monkeypatch.setattr(adapter.module.hermes_api, "list_bots", lambda: [{"name": "researcher", "title": "Researcher",
                                                                          "description": ""}])
    assert adapter._bots_state() == {"bots": [{"name": "researcher", "title": "Researcher", "description": "",
                                               "served": False}], "multiplex": False, "reason": "only one profile exists"}


async def test_reconnecting_mcp_reloads_the_bot_it_was_asked_for(adapter, aiohttp_client, monkeypatch):  # noqa: F811
    """Phone → hub → adapter → Hermes's own /reload-mcp, which reloads the profile its message is routed to."""
    hub = adapter._hub
    hub.hermes = adapter.module.hermes_api
    hub.bots_provider = lambda: {"bots": [{"name": "researcher", "title": "Researcher", "description": "",
                                           "served": True}], "multiplex": True, "reason": ""}
    hub.reload_mcp = adapter._reload_mcp
    reloaded = []

    async def execute_mcp_reload(event):
        reloaded.append(event)
        return "MCP servers reloaded"
    adapter.gateway_runner = SimpleNamespace(_execute_mcp_reload=execute_mcp_reload)
    state = {"multiplex": True, "served": ["default", "researcher"], "reason": ""}
    monkeypatch.setattr(adapter.module.hermes_api, "multiplex_state", lambda runner: state)
    client = await aiohttp_client(hub.build_app())
    owner = await pair_phone(client, hub)

    resp = await post_signed(client, owner, "/api/mcp/reload?bot=researcher", {})
    assert resp.status == 200 and (await resp.json())["message"] == "MCP servers reloaded"
    source = reloaded[-1].source
    assert reloaded[-1].text == "/reload-mcp" and source.profile == "researcher" and source.chat_id == "b-researcher"
    assert hub.store.get_chat("b-researcher")["bot"] == "researcher"  # its main chat gets the "tools changed" note
    # The main bot's stays the main bot's.
    assert (await post_signed(client, owner, "/api/mcp/reload", {})).status == 200
    assert reloaded[-1].source.chat_id == "general" and not hasattr(reloaded[-1].source, "profile")
    # A bot the gateway doesn't serve yet: say so, and never reload the main bot instead.
    state = {"multiplex": False, "served": ["default"], "reason": "only one profile exists"}
    resp = await post_signed(client, owner, "/api/mcp/reload?bot=researcher", {})
    assert resp.status == 400 and "isn't running yet" in (await resp.json())["error"] and len(reloaded) == 2


async def test_dashboard_routes_get_the_bots_profile_when_they_take_one(monkeypatch):
    import contextlib
    from plugin import hermes_api as h
    monkeypatch.setattr(h, "_bot_scope", lambda name: contextlib.nullcontext())  # the scope itself is Hermes's
    got = []

    async def install(body, profile=None):
        got.append(profile)
        return {"ok": True, "name": "skills-install-x"}

    async def plain(body):
        got.append("plain")
        return {}
    token = h.set_bot("researcher")
    try:
        await h._route(install, "x")
        await h._route(plain, "x")
    finally:
        h.reset_bot(token)
    await h._route(install, "x")
    assert got == ["researcher", "plain", None]


# -- through Hermes's own profile code ------------------------------------------------------------

needs_hermes = pytest.mark.skipif(importlib.util.find_spec("tui_gateway") is None
                                  or importlib.util.find_spec("hermes_cli") is None,
                                  reason="needs Hermes Agent installed")


@needs_hermes
def test_a_bot_made_here_is_a_hermes_profile_with_its_own_persona(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HOME", str(tmp_path))
    (home / "config.yaml").write_text("model:\n  provider: anthropic\n  default: claude-x\n")
    (home / ".env").write_text("ANTHROPIC_API_KEY=sk-test\nTELEGRAM_BOT_TOKEN=123\n")
    (home / "SOUL.md").write_text("You are Hermes.")
    from plugin import hermes_api as h
    assert h.bots_available() and h.list_bots() == []
    made = h.create_bot("chef", "Chef", "You are Chef. You plan meals.", "Plans meals")
    assert made == {"name": "chef", "title": "Chef", "description": "Plans meals"}
    assert h.list_bots() == [made]
    profile = home / "profiles" / "chef"
    env = (profile / ".env").read_text()
    assert "ANTHROPIC_API_KEY=sk-test" in env and "TELEGRAM_BOT_TOKEN" not in env  # keys yes, chat tokens no
    from tools.bot_mode_probe import is_bot_mode_managed
    assert is_bot_mode_managed(str(home))  # a teammate of the other bots, as in Hermes Desktop
    # Hermes calls made for the bot run as its profile, and only for as long as asked.
    token = h.set_bot("chef")
    try:
        assert h.read_persona()["content"] == "You are Chef. You plan meals."
    finally:
        h.reset_bot(token)
    assert h.read_persona()["content"] == "You are Hermes."
    with pytest.raises(h.HermesRefused):
        h.create_bot("chef", "Chef again", "")
    assert h.rename_bot("chef", "Head Chef")["title"] == "Head Chef"
    assert h.list_bots()[0]["title"] == "Head Chef" and h._bot_meta("chef")["created"]  # its other settings stay
    h.delete_bot("chef")
    assert h.list_bots() == [] and not profile.exists()
    with pytest.raises(h.HermesRefused):
        h.delete_bot("chef")
