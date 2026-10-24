"""Session → chat authority for structured task activity, without a gateway install.

Hermes fires hooks for every platform and profile. The tracker must only accept a session whose origin
is a Winglet chat that still exists and whose profile is that chat's bot; these tests exercise the
adapter's resolver directly with small doubles.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

from plugin.hub import Hub
from plugin.store import Store


@pytest.fixture
def adapter(monkeypatch, tmp_path):
    interfaces = {
        "gateway": {}, "gateway.platforms": {},
        "gateway.config": {"Platform": str, "PlatformConfig": object},
        "gateway.platforms._shared": {name: lambda *args, **kwargs: None for name in
                                      ("extra_or_secret", "get_scoped_secret", "seed_extra_from_env")},
        "gateway.platforms.base": {"BasePlatformAdapter": object, "ExecApprovalPrompt": SimpleNamespace,
                                   "SendResult": SimpleNamespace},
        "gateway.platforms.event": {"MessageEvent": SimpleNamespace, "MessageType": SimpleNamespace},
    }
    for name, members in interfaces.items():
        module = ModuleType(name)
        module.__dict__.update(members)
        monkeypatch.setitem(sys.modules, name, module)
    spec = importlib.util.spec_from_file_location("plugin._execution_test_adapter",
                                                 Path(__file__).parents[1] / "plugin" / "adapter.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    instance = module.WingletAdapter.__new__(module.WingletAdapter)
    store = Store(tmp_path / "adapter.db")
    instance.name = "Winglet"
    instance._hub = Hub(store)
    yield instance, store
    store.close()


def entry(chat_id="general", platform="winglet", profile=None):
    return SimpleNamespace(session_id="s1", origin=SimpleNamespace(
        platform=SimpleNamespace(value=platform), chat_id=chat_id, profile=profile))


class Sessions:
    def __init__(self, by_id=None, by_key=None):
        self.by_id = by_id
        self.by_key = by_key

    def lookup_by_session_id(self, session_id):
        return self.by_id

    def lookup_by_session_key(self, session_key):
        return self.by_key


def test_a_winglet_session_maps_to_its_own_chat_and_bot(adapter):
    instance, store = adapter
    store.ensure_chat("general", "General")
    store.ensure_chat("work-chat", "Work", bot="work")
    instance.gateway_runner = SimpleNamespace(session_store=Sessions(by_id=entry()))
    assert instance._session_chat("s1") == {"chat_id": "general", "bot": None}
    instance.gateway_runner.session_store = Sessions(by_id=entry("work-chat", profile="work"))
    assert instance._session_chat("s1") == {"chat_id": "work-chat", "bot": "work"}


def test_other_platforms_profiles_and_removed_chats_produce_nothing(adapter):
    instance, store = adapter
    store.ensure_chat("general", "General")
    store.ensure_chat("work-chat", "Work", bot="work")
    for bad in (entry(platform="telegram"), entry("work-chat", profile=None),
                entry("work-chat", profile="other"), entry("deleted-chat")):
        instance.gateway_runner = SimpleNamespace(session_store=Sessions(by_id=bad))
        assert instance._session_chat("s1") is None
    instance.gateway_runner = SimpleNamespace(session_store=Sessions(by_id=None))
    assert instance._session_chat("s1") is None
    assert instance._session_chat("") is None


def test_a_stopped_turn_is_found_by_its_session_key(adapter):
    instance, store = adapter
    store.ensure_chat("general", "General")
    instance.gateway_runner = SimpleNamespace(session_store=Sessions(by_key=entry()))
    assert instance._session_key_chat("winglet:general:dm") == "general"
    instance.gateway_runner.session_store = Sessions(by_key=entry(platform="discord"))
    assert instance._session_key_chat("winglet:general:dm") is None
