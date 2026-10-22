"""The adapter hands uploads, voice notes and replies to Hermes the way other platforms do."""

import importlib.util
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

from plugin.hub import Hub
from plugin.store import Store

KINDS = SimpleNamespace(TEXT="text", COMMAND="command", PHOTO="photo", VOICE="voice", DOCUMENT="document",
                        VIDEO="video", AUDIO="audio")


async def test_model_picker_merges_the_full_catalog_without_truncating(adapter, monkeypatch):
    adapter._hub.store.ensure_chat("general", "General")
    models = [f"vendor/model-{i}" for i in range(500)]
    monkeypatch.setattr(adapter.module.hermes_api, "model_options", lambda: {"providers": [
        {"slug": "openrouter", "name": "OpenRouter", "authenticated": True, "models": models}]})

    async def choose(*args):
        return "Changed."

    result = await adapter.send_model_picker("general", [{"slug": "openrouter", "models": models[:50]}],
                                             models[-1], "openrouter", "session", choose)
    picker = adapter._hub.store.get_message(result.message_id)["meta"]["picker"]
    assert picker["providers"][0]["models"] == models
    assert picker["providers"][0]["custom_models"] is True


class Event(SimpleNamespace):
    def __init__(self, **kw):
        super().__init__(media_urls=[], media_types=[], reply_to_message_id=None, reply_to_text=None, **kw)


@pytest.fixture
def adapter(monkeypatch, tmp_path):
    class Base:
        pass

    shared = {name: lambda *a, **k: None for name in ("extra_or_secret", "get_scoped_secret", "seed_extra_from_env")}
    for name, members in {
        "gateway": {}, "gateway.platforms": {},
        "gateway.config": {"Platform": str, "PlatformConfig": object},
        "gateway.platforms._shared": shared,
        "gateway.platforms.base": {"BasePlatformAdapter": Base, "ExecApprovalPrompt": SimpleNamespace,
                                   "SendResult": SimpleNamespace},
        "gateway.platforms.event": {"MessageEvent": Event, "MessageType": KINDS},
    }.items():
        module = ModuleType(name)
        module.__dict__.update(members)
        monkeypatch.setitem(sys.modules, name, module)
    spec = importlib.util.spec_from_file_location("plugin._media_test_adapter", Path(__file__).parents[1] / "plugin" / "adapter.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    instance = module.WingletAdapter.__new__(module.WingletAdapter)
    store = Store(tmp_path / "adapter.db")
    instance.name = "Winglet"
    instance._hub = Hub(store, media_dir=tmp_path / "media")
    instance._status_ids = {}
    instance.handled = []
    instance.build_source = lambda **kw: SimpleNamespace(**kw)

    async def handle_message(event):
        instance.handled.append(event)

    instance.handle_message = handle_message
    cached = []

    async def cache_media(path, name, mime, voice=False):
        cached.append((path, name, mime, voice))
        return f"/hermes/cache/{name}", mime, "audio" if voice else ("image" if mime.startswith("image/") else "document")

    monkeypatch.setattr(module.hermes_api, "cache_media", cache_media)
    instance.cached = cached
    instance.module = module
    yield instance
    store.close()


async def test_photos_documents_and_voice_reach_hermes_with_the_right_type(adapter):
    chat = {"id": "general", "title": "General"}
    device = {"id": "d", "name": "Pixel"}
    await adapter._on_user_message(chat, "what is this?", device, {"id": "m1"},
                                   files=[{"path": "/up/p.png", "name": "p.png", "mime": "image/png", "kind": "image"}])
    event = adapter.handled[-1]
    assert event.message_type == "photo" and event.media_urls == ["/hermes/cache/p.png"] and event.media_types == ["image/png"]
    await adapter._on_user_message(chat, "", device, {"id": "m2"}, files=[
        {"path": "/up/a.png", "name": "a.png", "mime": "image/png", "kind": "image"},
        {"path": "/up/r.pdf", "name": "r.pdf", "mime": "application/pdf", "kind": "file"}])
    assert adapter.handled[-1].message_type == "document"  # documents win, as on other platforms
    await adapter._on_user_message(chat, "", device, {"id": "m3"}, files=[
        {"path": "/up/v.ogg", "name": "v.ogg", "mime": "audio/ogg", "kind": "voice"}])
    assert adapter.handled[-1].message_type == "voice" and adapter.cached[-1][3] is True
    await adapter._on_user_message(chat, "/model", device, {"id": "m4"})
    assert adapter.handled[-1].message_type == "command"


async def test_replies_become_hermes_reply_context(adapter):
    await adapter._on_user_message({"id": "general"}, "the second one", {"id": "d", "name": "Pixel"}, {"id": "m1"},
                                   reply={"id": "b1", "role": "bot", "text": "1. A\n2. B"})
    event = adapter.handled[-1]
    assert event.reply_to_message_id == "b1" and event.reply_to_text == "1. A\n2. B" and event.reply_to_is_own_message


async def test_status_updates_edit_one_line_in_place(adapter):
    first = await adapter.send_or_update_status("general", "context_pressure", "Context 80% full")
    second = await adapter.send_or_update_status("general", "context_pressure", "Context 90% full")
    other = await adapter.send_or_update_status("general", "fallback", "Switched to backup model")
    assert first.message_id == second.message_id != other.message_id
    message = adapter._hub.store.get_message(first.message_id)
    assert message["text"] == "Context 90% full" and message["role"] == "system"
    assert message["meta"]["status_key"] == "context_pressure"


async def test_routine_results_drop_hermes_wrapper_and_carry_the_routine_name(adapter, monkeypatch):
    monkeypatch.setattr(adapter.module, "_routine_name", lambda job_id: "Morning briefing")
    wrapped = ("Cronjob Response: Morning briefing\n(job_id: abc123)\n-------------\n\n"
               "Good morning! **9:30** Standup.\n\n"
               'To stop or manage this job, send me a new message (e.g. "stop reminder Morning briefing").')
    await adapter.send("home", wrapped, metadata={"job_id": "abc123"})
    message = adapter._hub.store.list_messages("home")[-1]
    assert message["text"] == "Good morning! **9:30** Standup."
    assert message["meta"]["routine"] == "Morning briefing"
    assert [i["title"] for i in adapter._hub.store.list_inbox()] == ["Routine finished: Morning briefing"]


def test_routine_text_that_is_not_hermes_wrapper_is_left_alone(adapter):
    unwrap = adapter.module._unwrap_routine
    assert unwrap("Cronjob Response: x\nno divider here") == "Cronjob Response: x\nno divider here"
    assert unwrap("Plain result") == "Plain result"


def test_routine_targets_are_exact_chat_ids_not_name_lookups(adapter):
    parse = adapter.module.parse_target_ref
    assert parse("home") == ("home", None)
    assert parse("general") == ("general", None)
    assert parse("c-89cf8b687c0041c6") == ("c-89cf8b687c0041c6", None)
    assert parse("m-34752f3d49a64e4d") == ("m-34752f3d49a64e4d", None)
    assert parse("Homelab") is None and parse("Lisbon trip") is None
