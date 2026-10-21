"""Opening model/thinking controls must leave conversation previews and ordering alone."""

import pytest

from plugin.store import Store


@pytest.fixture
def store(tmp_path):
    instance = Store(tmp_path / "state.db")
    yield instance
    instance.close()


def test_hidden_model_controls_do_not_replace_the_last_conversation_preview(store):
    store.add_message("general", "bot", "Your actual answer")
    before = store.get_chat("general")
    store.add_message("general", "user", "/model", meta={"hidden": True})
    card = store.add_message("general", "bot", "Choose a model", meta={"picker": {"kind": "model"}})
    assert store.get_chat("general")["preview"] == before["preview"]
    assert store.get_chat("general")["updated_at"] == before["updated_at"]
    store.update_message(card["id"], "Model changed", meta={"picker": {"kind": "model", "status": "done"}})
    assert store.get_chat("general")["preview"] == before["preview"]
    assert store.get_chat("general")["updated_at"] == before["updated_at"]


def test_reasoning_controls_stay_quiet_but_real_replies_and_confirmations_update_the_preview(store):
    store.add_message("general", "bot", "Ready")
    store.add_message("general", "bot", "Choose thinking", meta={"picker": {"kind": "choice"}})
    assert store.get_chat("general")["preview"] == "Ready"
    store.add_message("general", "bot", "Confirm restart", meta={"picker": {"kind": "confirm"}})
    assert store.get_chat("general")["preview"] == "Confirm restart"
    store.add_message("general", "bot", "Here is your answer")
    assert store.get_chat("general")["preview"] == "Here is your answer"
