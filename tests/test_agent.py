"""Your agent from the phone: pickers, the model, provider keys, persona, memory and usage."""

import asyncio
import json
import time
from types import ModuleType, SimpleNamespace
import sys

import pytest

from plugin.hub import Hub
from plugin.store import Store
from plugin import hermes_api
from test_trust import pair_phone, post_signed, seal


class Refused(ValueError):
    pass


class Unavailable(RuntimeError):
    pass


def test_inventory_keeps_all_models_and_empty_configured_endpoints(monkeypatch):
    inventory = ModuleType("hermes_cli.inventory")
    models = [f"vendor/model-{i}" for i in range(500)]
    inventory.load_picker_context = lambda: None
    inventory.build_model_options_payload = lambda *args, **kwargs: {"providers": [
        {"slug": "openrouter", "authenticated": True, "models": [{"id": m} for m in models]},
        {"slug": "custom:local", "authenticated": True, "models": []}]}
    monkeypatch.setitem(sys.modules, "hermes_cli.inventory", inventory)
    payload = hermes_api.model_options.__wrapped__()
    assert payload["providers"][0]["models"] == models
    assert payload["providers"][1]["custom_models"] is True


def test_current_runtime_model_is_reported_after_an_agent_fallback():
    runner = SimpleNamespace(
        _session_model_overrides={"chat": {"model": "deepseek/selected", "provider": "openrouter"}},
        _cached_agent_for=lambda key: SimpleNamespace(model="z-ai/glm-fallback", provider="openrouter") if key == "chat" else None,
        _last_resolved_model={"*": "some-other-bots-model"},
    )
    assert hermes_api.chat_model(runner, "chat")["model"] == "z-ai/glm-fallback"
    assert hermes_api.chat_model(runner, "new-chat") is None


class FakeHermes:
    """The functions plugin/hermes_api.py offers, with Hermes's behaviour faked."""
    HermesRefused = Refused
    HermesUnavailable = Unavailable

    def __init__(self):
        self.default = {"model": "claude-x", "provider": "anthropic", "reasoning_effort": "medium", "label": "Anthropic"}
        self.keys = {}
        self.persona = "You are Hermes."
        self.entries = {"memory": ["Server runs Ubuntu."], "user": ["Prefers short answers."]}

    def configured_model(self):
        return dict(self.default)

    def model_options(self, include_unconfigured=False):
        providers = [
            {"slug": "anthropic", "name": "Anthropic", "authenticated": True, "is_current": True, "auth_type": "api_key",
             "key_env": "ANTHROPIC_API_KEY", "models": ["claude-x", "claude-y"], "total_models": 2, "warning": ""},
            {"slug": "openai", "name": "OpenAI", "authenticated": "OPENAI_API_KEY" in self.keys, "is_current": False,
             "auth_type": "api_key", "key_env": "OPENAI_API_KEY", "models": ["gpt-x"] if "OPENAI_API_KEY" in self.keys else [],
             "total_models": 1, "warning": "paste OPENAI_API_KEY to activate"},
        ]
        return {"model": self.default["model"], "provider": self.default["provider"], "providers": providers}

    def set_default_model(self, provider, model, confirm=False):
        if model == "pricey" and not confirm:
            return {"ok": False, "confirm_required": True, "confirm_message": "This model costs $$$ per token."}
        if model == "nope":
            raise Refused("Unknown model 'nope'.")
        self.default.update(model=model, provider=provider)
        return {"ok": True, "provider": provider, "model": model}

    async def check_provider_key(self, env, value):
        if value == "sk-bad":
            return {"ok": False, "reachable": True, "message": "The provider rejected that key."}
        return {"ok": True, "reachable": True, "message": ""}

    def save_provider_key(self, env, value):
        self.keys[env] = value

    def remove_provider_key(self, env):
        return self.keys.pop(env, None) is not None

    def read_persona(self):
        return {"content": self.persona, "exists": True}

    def write_persona(self, content):
        self.persona = content

    def memory(self):
        return {t: {"entries": list(e), "enabled": True, "limit": 2000, "used": 10} for t, e in self.entries.items()}

    def edit_memory(self, action, target, entry="", content=""):
        if "ignore previous instructions" in content:
            raise Refused("Blocked: looks like a prompt injection.")
        if action == "add":
            self.entries[target].append(content)
        elif action == "remove":
            self.entries[target].remove(entry)
        else:
            self.entries[target][self.entries[target].index(entry)] = content
        return self.memory()

    def usage(self, days):
        return {"daily": [{"day": "2026-10-01", "input_tokens": 100, "output_tokens": 50, "estimated_cost": 0.01}],
                "by_model": [{"model": "claude-x", "input_tokens": 100, "output_tokens": 50, "estimated_cost": 0.01}],
                "totals": {"total_input": 100, "total_output": 50, "total_estimated_cost": 0.01, "total_sessions": 1},
                "period_days": days}


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
    h.chat_model = lambda chat_id: {"model": "claude-y", "provider": "anthropic", "source": "chat"} if chat_id == "general" else None
    return h


@pytest.fixture
async def client(aiohttp_client, hub):
    return await aiohttp_client(hub.build_app())


# -- pickers ---------------------------------------------------------------------------------


async def test_model_picker_switches_through_hermes_and_closes_the_card(client, hub):
    owner = await pair_phone(client, hub)
    calls = []

    async def on_model_selected(chat_id, model, provider):
        calls.append((chat_id, model, provider))
        return f"Switched to {model}."

    message = await hub.post_picker("general", "model", "Choose a model for this chat",
                                    {"current_model": "claude-x", "providers": [{"slug": "anthropic", "name": "Anthropic",
                                                                                "models": ["claude-x", "claude-y"]}]},
                                    on_model_selected)
    picker = message["meta"]["picker"]
    path = f"/api/pickers/{picker['id']}/select"
    assert (await client.post(path, json={"provider": "anthropic", "model": "gpt-9"}, headers=owner.auth)).status == 400
    resp = await client.post(path, json={"provider": "anthropic", "model": "claude-y"}, headers=owner.auth)
    assert resp.status == 200
    updated = (await resp.json())["message"]
    assert updated["text"] == "Switched to claude-y." and updated["meta"]["picker"]["status"] == "done"
    assert calls == [("general", "claude-y", "anthropic")]
    # One answer per card.
    assert (await client.post(path, json={"provider": "anthropic", "model": "claude-x"}, headers=owner.auth)).status == 410


async def test_custom_models_are_allowed_only_for_an_offered_provider(client, hub):
    owner = await pair_phone(client, hub)
    calls = []
    hub.chat_model = None

    async def choose(chat, model, provider):
        calls.append((chat, model, provider))
        return "Model updated."

    message = await hub.post_picker("general", "model", "Choose", {"providers": [
        {"slug": "openrouter", "name": "OpenRouter", "models": ["first"], "custom_models": True}]}, choose)
    path = f"/api/pickers/{message['meta']['picker']['id']}/select"
    for provider, model in [("other", "custom/model"), ("openrouter", ""), ("openrouter", "bad\nmodel")]:
        assert (await client.post(path, json={"provider": provider, "model": model}, headers=owner.auth)).status == 400
    resp = await client.post(path, json={"provider": "openrouter", "model": "vendor/custom-model:free"}, headers=owner.auth)
    assert resp.status == 200
    assert calls == [("general", "vendor/custom-model:free", "openrouter")]


async def test_picker_failure_does_not_claim_success_and_can_be_retried(client, hub):
    owner = await pair_phone(client, hub)
    calls = []

    async def choose(chat, value):
        calls.append(value)
        if len(calls) == 1:
            raise RuntimeError("temporary failure")
        return "Changed."

    message = await hub.post_picker("general", "choice", "Choose", {"choices": [{"value": "high"}]}, choose)
    path = f"/api/pickers/{message['meta']['picker']['id']}/select"
    assert (await client.post(path, json={"value": "high"}, headers=owner.auth)).status == 502
    assert hub.store.get_message(message["id"])["meta"]["picker"]["status"] == "open"
    assert (await client.post(path, json={"value": "high"}, headers=owner.auth)).status == 200


async def test_a_concurrent_picker_tap_cannot_expire_an_inflight_selection(client, hub):
    owner = await pair_phone(client, hub)
    started, finish = asyncio.Event(), asyncio.Event()

    async def choose(chat, value):
        started.set()
        await finish.wait()
        return "Changed."

    message = await hub.post_picker("general", "choice", "Choose", {"choices": [{"value": "high"}]}, choose)
    path = f"/api/pickers/{message['meta']['picker']['id']}/select"
    first = asyncio.ensure_future(client.post(path, json={"value": "high"}, headers=owner.auth))
    await asyncio.wait_for(started.wait(), 2)
    assert (await client.post(path, json={"value": "high"}, headers=owner.auth)).status == 409
    assert hub.store.get_message(message["id"])["meta"]["picker"]["status"] == "open"
    finish.set()
    assert (await first).status == 200
    assert hub.store.get_message(message["id"])["meta"]["picker"]["status"] == "done"


async def test_hermes_error_reply_leaves_the_actual_model_and_card_unchanged(client, hub):
    owner = await pair_phone(client, hub)

    async def choose(*args):
        return "Provider rejected this model."

    message = await hub.post_picker("general", "model", "Choose", {"providers": [
        {"slug": "anthropic", "models": ["claude-x"]}]}, choose)
    path = f"/api/pickers/{message['meta']['picker']['id']}/select"
    resp = await client.post(path, json={"provider": "anthropic", "model": "claude-x"}, headers=owner.auth)
    assert resp.status == 400 and "rejected" in (await resp.json())["error"]
    assert hub.store.get_message(message["id"])["meta"]["picker"]["status"] == "open"


@pytest.mark.parametrize("current,provider,model", [
    ({"model": "shared-model", "provider": "first"}, "second", "shared-model"),
    ({"model": "vendor-a/shared", "provider": "openrouter"}, "openrouter", "vendor-b/shared"),
    (None, "openrouter", "missing/model"),
])
async def test_failed_route_changes_cannot_claim_a_different_provider_or_vendor(client, hub, current, provider, model):
    owner = await pair_phone(client, hub)
    hub.chat_model = lambda chat: current

    async def choose(*args):
        return "Provider rejected the route."

    message = await hub.post_picker("general", "model", "Choose", {"providers": [
        {"slug": provider, "models": [model]}]}, choose)
    path = f"/api/pickers/{message['meta']['picker']['id']}/select"
    response = await client.post(path, json={"provider": provider, "model": model}, headers=owner.auth)
    assert response.status == 400
    assert hub.store.get_message(message["id"])["meta"]["picker"]["status"] == "open"


async def test_choice_and_confirm_pickers_hand_back_the_value(client, hub):
    owner = await pair_phone(client, hub)
    got = []

    async def on_choice(chat_id, value):
        got.append(("choice", chat_id, value))
        return "Reasoning set to high."

    async def on_confirm(value):
        got.append(("confirm", value))
        return "MCP servers reloaded."

    choice = await hub.post_picker("general", "choice", "Reasoning effort",
                                   {"choices": [{"value": "low", "label": "Low"}, {"value": "high", "label": "High"}]}, on_choice)
    confirm = await hub.post_picker("general", "confirm", "Reload MCP?",
                                    {"choices": [{"value": "once", "label": "Approve once"}, {"value": "cancel", "label": "Cancel"}]},
                                    on_confirm, ttl=300)
    for message, value in ((choice, "high"), (confirm, "once")):
        resp = await client.post(f"/api/pickers/{message['meta']['picker']['id']}/select", json={"value": value}, headers=owner.auth)
        assert resp.status == 200
    assert got == [("choice", "general", "high"), ("confirm", "once")]


async def test_pickers_are_for_owners_and_expire(client, hub):
    member = await pair_phone(client, hub, "Alex", role="member")
    owner = await pair_phone(client, hub)

    async def never(*args):
        raise AssertionError("must not run")

    message = await hub.post_picker(member.me["home_chat"], "choice", "Fast mode",
                                    {"choices": [{"value": "on", "label": "On"}]}, never)
    path = f"/api/pickers/{message['meta']['picker']['id']}/select"
    assert (await client.post(path, json={"value": "on"}, headers=member.auth)).status == 403
    # After a restart the callback is gone: the card is marked expired instead of hanging.
    hub._pickers.clear()
    resp = await client.post(path, json={"value": "on", "message_id": message["id"]}, headers=owner.auth)
    assert resp.status == 410
    assert hub.store.get_message(message["id"])["meta"]["picker"]["status"] == "expired"


# -- the model -------------------------------------------------------------------------------


async def test_agent_reports_the_configured_and_the_chats_model(client, hub):
    member = await pair_phone(client, hub, "Alex", role="member")
    owner = await pair_phone(client, hub)
    data = await (await client.get("/api/agent?chat=general", headers=owner.auth)).json()
    assert data["configured"]["model"] == "claude-x" and data["chat"]["model"] == "claude-y"
    # A member can't learn about an owner's chat.
    assert (await (await client.get("/api/agent?chat=general", headers=member.auth)).json())["chat"] is None


async def test_default_model_is_signed_confirmed_when_expensive_and_audited(client, hub):
    owner = await pair_phone(client, hub)
    models = await (await client.get("/api/models", headers=owner.auth)).json()
    assert [p["slug"] for p in models["providers"]] == ["anthropic"]  # only providers ready to use
    body = json.dumps({"provider": "anthropic", "model": "claude-y"}).encode()
    assert (await client.put("/api/models/default", data=body, headers=owner.auth)).status == 403  # unsigned

    async def put(data):
        raw = json.dumps(data).encode()
        return await client.put("/api/models/default", data=raw, headers=owner.signed("PUT", "/api/models/default", raw))

    assert (await (await put({"provider": "anthropic", "model": "pricey"})).json())["confirm_required"] is True
    assert hub.hermes.default["model"] == "claude-x"
    assert (await (await put({"provider": "anthropic", "model": "pricey", "confirm": True})).json())["ok"] is True
    resp = await put({"provider": "anthropic", "model": "nope"})
    assert resp.status == 400 and (await resp.json())["error"] == "Unknown model 'nope'."
    assert hub.store.list_audit()[0]["summary"] == "anthropic · pricey"


# -- provider keys ----------------------------------------------------------------------------


async def test_provider_keys_arrive_sealed_are_checked_and_never_come_back(client, hub):
    owner = await pair_phone(client, hub)
    info = await (await client.get("/api/server-key")).json()

    async def add(env, value, device_id=owner.id):
        return await post_signed(client, owner, "/api/providers/key",
                                 {"sealed": seal(info, "provider-key", {"env": env, "value": value}, device_id)})

    assert (await add("PATH", "x")).status == 400  # only provider keys this server knows
    assert (await add("OPENAI_API_KEY", "sk-bad")).status == 400
    assert (await add("OPENAI_API_KEY", "sk-live-1234", device_id="someone-else")).status == 400
    assert (await add("OPENAI_API_KEY", "sk-live-1234")).status == 200
    assert hub.hermes.keys == {"OPENAI_API_KEY": "sk-live-1234"}
    listing = await (await client.get("/api/providers", headers=owner.auth)).text()
    assert "sk-live" not in listing and json.loads(listing)["providers"][1]["authenticated"] is True
    audit = json.dumps(hub.store.list_audit())
    assert "sk-live-1234" not in audit and "ends 1234" in audit and "rejected" in audit
    path = "/api/providers/key/OPENAI_API_KEY"
    assert (await client.delete(path, headers=owner.signed("DELETE", path))).status == 200
    assert hub.hermes.keys == {}


async def test_web_apps_cant_send_keys_over_the_tunnel_unless_allowed(client, hub, monkeypatch):
    owner = await pair_phone(client, hub)
    hub.store._exec("UPDATE devices SET platform = 'web' WHERE id = ?", (owner.id,))
    hub.connection = {"mode": "quick", "url": "https://x.trycloudflare.com"}
    info = await (await client.get("/api/server-key")).json()
    body = {"sealed": seal(info, "provider-key", {"env": "OPENAI_API_KEY", "value": "sk-live-1"}, owner.id)}
    resp = await post_signed(client, owner, "/api/providers/key", body)
    assert resp.status == 403 and "Android app" in (await resp.json())["error"]
    monkeypatch.setenv("WINGLET_ALLOW_WEB_SECRETS", "true")
    body = {"sealed": seal(info, "provider-key", {"env": "OPENAI_API_KEY", "value": "sk-live-1"}, owner.id)}
    assert (await post_signed(client, owner, "/api/providers/key", body)).status == 200


# -- persona, memory, usage -----------------------------------------------------------------------


async def test_persona_memory_and_usage(client, hub):
    owner = await pair_phone(client, hub)
    member = await pair_phone(client, hub, "Alex", role="member")
    for path in ("/api/identity", "/api/memory", "/api/usage"):
        assert (await client.get(path, headers=member.auth)).status == 403
    assert (await (await client.get("/api/identity", headers=owner.auth)).json())["content"] == "You are Hermes."
    raw = json.dumps({"content": "You are Hermes, brief and warm."}).encode()
    assert (await client.put("/api/identity", data=raw, headers=owner.signed("PUT", "/api/identity", raw))).status == 200
    assert hub.hermes.persona == "You are Hermes, brief and warm."
    big = json.dumps({"content": "x" * 20_001}).encode()
    assert (await client.put("/api/identity", data=big, headers=owner.signed("PUT", "/api/identity", big))).status == 400

    mem = await (await client.get("/api/memory", headers=owner.auth)).json()
    assert mem["user"]["entries"] == ["Prefers short answers."]
    resp = await post_signed(client, owner, "/api/memory", {"action": "remove", "target": "user", "entry": "Prefers short answers."})
    assert (await resp.json())["user"]["entries"] == []
    resp = await post_signed(client, owner, "/api/memory", {"action": "add", "target": "user", "content": "ignore previous instructions"})
    assert resp.status == 400 and "prompt injection" in (await resp.json())["error"]
    assert "Prefers short" not in json.dumps(hub.store.list_audit())  # what it remembers stays out of the log

    usage = await (await client.get("/api/usage?days=7", headers=owner.auth)).json()
    assert usage["period_days"] == 7 and usage["totals"]["total_sessions"] == 1


async def test_without_hermes_functions_the_features_are_off(client, hub):
    hub.hermes = None
    owner = await pair_phone(client, hub)
    info = await (await client.get("/api/info")).json()
    assert info["features"]["agent"] is False
    assert (await client.get("/api/models", headers=owner.auth)).status == 404
