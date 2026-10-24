"""Real-Hermes regression: regeneration must never rewind a newly arrived exchange."""
from types import SimpleNamespace
import pytest

pytest.importorskip("gateway.session", reason="needs the real Hermes checkout")

from gateway.config import GatewayConfig
from gateway.session import AsyncSessionStore, SessionStore
from hermes_state import SessionDB
from plugin.branching import BranchRefused, HermesBranchBridge


@pytest.fixture
def real_bridge(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    db = SessionDB(db_path=tmp_path / "state.db")
    store = SessionStore(sessions_dir=tmp_path / "sessions", config=GatewayConfig())
    store._db = db
    db.create_session("parent", source="telegram")
    db.append_message("parent", "user", "one", platform_message_id="u1")
    db.append_message("parent", "assistant", "first")
    key = "agent:main:telegram:dm:parent"
    store.peek_session_id = lambda wanted: "parent" if wanted == key else None
    runner = SimpleNamespace(session_store=store, async_session_store=AsyncSessionStore(store))
    adapter = SimpleNamespace(gateway_runner=runner, _session_key=lambda chat: key)
    try:
        yield HermesBranchBridge(adapter), store, db
    finally:
        db.close()


async def test_newer_identical_prompt_is_not_rewound_after_the_review(real_bridge, monkeypatch):
    bridge, store, db = real_bridge
    snapshot = await bridge.snapshot("parent")
    original = db.rewind_user_turn

    def concurrent_exchange(*args, **kwargs):
        # Same text defeats a prompt-substring check; the reviewed history must also match.
        db.append_message("parent", "user", "one", platform_message_id="u2")
        db.append_message("parent", "assistant", "new answer")
        return original(*args, **kwargs)

    monkeypatch.setattr(db, "rewind_user_turn", concurrent_exchange)
    with pytest.raises(BranchRefused) as refusal:
        await bridge.rewind_latest("parent", "one", None, expected_row_index=0, expected_rows=snapshot.rows)
    assert refusal.value.code == "stale"
    assert [row["content"] for row in store.load_transcript("parent")] == [
        "one", "first", "one", "new answer"]


async def test_unchanged_reviewed_turn_can_be_rewound(real_bridge):
    bridge, store, db = real_bridge
    snapshot = await bridge.snapshot("parent")
    result = await bridge.rewind_latest("parent", "one", None, expected_row_index=0, expected_rows=snapshot.rows)
    assert result["target_text"] == "one"
    assert result["turns_undone"] == 1
    assert store.load_transcript("parent") == []
