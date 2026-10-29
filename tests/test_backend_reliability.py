import pytest
from aiohttp.test_utils import make_mocked_request

from plugin.hub import HOME_CHAT_ID, Hub, VERSION
from plugin.store import Store


@pytest.fixture
async def hub(tmp_path):
    store = Store(tmp_path / "state.db")
    instance = Hub(store, web_root=tmp_path / "web")
    yield instance
    await instance.aclose()
    store.close()


@pytest.mark.parametrize("metadata", [{"owner_device": "member"}, {"bot": "researcher"}])
async def test_deleted_chat_rejects_late_output_and_expires_inbox(hub, metadata):
    store = hub.store
    chat = store.create_chat("Working", **metadata)
    other = store.create_chat("Other", owner_device="other")
    old = store.add_message(chat["id"], "bot", "stream", status="streaming")
    approval = await hub.add_inbox("approval", chat["id"], "Approval", "", {}, push=False)
    question = await hub.add_inbox("question", chat["id"], "Question", "", {}, push=False)
    unrelated = await hub.add_inbox("question", other["id"], "Other", "", {}, push=False)
    hub._require = lambda request: {"id": "owner", "name": "Owner", "role": "owner"}
    request = make_mocked_request("DELETE", "/api/chats/" + chat["id"], match_info={"chat_id": chat["id"]})
    with hub._bot_context(metadata.get("bot")):
        assert (await hub.h_chat_delete(request)).status == 200
    assert store.get_inbox(approval["id"])["status"] == "expired"
    assert store.get_inbox(question["id"])["status"] == "expired"
    assert await hub.add_inbox("question", chat["id"], "Late", "", {}, push=False) is None
    await hub.post_message(chat["id"], "Late reply", push=False)
    assert await hub.edit_message(old["id"], "late edit") is None
    assert store.get_chat(chat["id"]) is None
    assert store.list_messages(chat["id"]) == []
    assert store.get_inbox(approval["id"])["status"] == "expired"
    assert store.get_inbox(question["id"])["status"] == "expired"
    assert store.get_inbox(unrelated["id"])["status"] == "pending"
    assert store.get_chat(other["id"])["owner_device"] == "other"
    assert not hub.can_see({"id": "member", "role": "member"}, store.get_chat(other["id"]))


@pytest.mark.parametrize("chat_id,scope", [("m-member", "member"), ("b-researcher", "researcher"), ("general", "general")])
async def test_explicit_home_creation_restores_deleted_fixed_ids(hub, chat_id, scope):
    store = hub.store
    member = {"id": "member", "name": "Member", "role": "member", "verified": True}
    if scope == "member":
        store.ensure_chat(chat_id, "Member", owner_device=member["id"])
    elif scope == "researcher":
        store.ensure_chat(chat_id, "Researcher", bot=scope)
    else:
        store.ensure_chat(chat_id, "General")
    hub._require = lambda request: {"id": "owner", "name": "Owner", "role": "owner"}
    request = make_mocked_request("DELETE", "/api/chats/" + chat_id, match_info={"chat_id": chat_id})
    with hub._bot_context("researcher" if scope == "researcher" else None):
        assert (await hub.h_chat_delete(request)).status == 200
    assert await hub.post_message(chat_id, "Late", push=False) is None
    assert store.get_chat(chat_id) is None
    if scope == "member":
        assert hub.me(member)["home_chat"] == chat_id
    elif scope == "researcher":
        with hub._bot_context("researcher"):
            assert hub.home_chat({"id": "owner", "role": "owner"}) == chat_id
    else:
        store.ensure_chat(chat_id, "General")  # Adapter startup.
    restored = store.get_chat(chat_id)
    assert restored is not None
    assert restored["owner_device"] == ("member" if scope == "member" else None)
    assert restored["bot"] == ("researcher" if scope == "researcher" else None)
    assert await hub.post_message(chat_id, "New turn", push=False) is not None


async def test_deleted_chat_expires_pending_inbox(hub):
    chat = hub.store.create_chat("Gone")
    item = await hub.add_inbox("approval", chat["id"], "Approval", "", {}, push=False)
    assert hub.store.delete_chat(chat["id"])
    assert hub.store.get_inbox(item["id"])["status"] == "expired"


async def test_deleted_chat_drops_late_inbox(hub):
    chat = hub.store.create_chat("Gone")
    assert hub.store.delete_chat(chat["id"])
    assert await hub.add_inbox("question", chat["id"], "Late", "", {}, push=False) is None
    assert hub.store.pending_count() == 0


async def test_deleted_chat_tombstone_survives_store_reopen(hub):
    chat = hub.store.create_chat("Gone")
    assert hub.store.delete_chat(chat["id"])
    other = Store(hub.store.path)
    try:
        assert other.add_message(chat["id"], "bot", "late") is None
        assert other.get_chat(chat["id"]) is None
    finally:
        other.close()


async def test_implicit_chats_remain_available(hub):
    for chat_id in (HOME_CHAT_ID, "general", "agent-created", "cron-result"):
        message = await hub.post_message(chat_id, "Hello", push=False)
        assert message and hub.store.get_chat(chat_id)


@pytest.mark.parametrize("starting,expected", [(VERSION, "failed"), ("older-version", "succeeded"), ("", "unknown")])
async def test_winglet_update_reconciliation_requires_version_change(hub, starting, expected):
    job, _ = hub.store.create_job("winglet_update", detail={"boot": "old", "from": starting})
    await hub.reconcile_jobs()
    result = hub.store.get_job(job["id"])
    assert result["state"] == expected
    assert result["detail"].get("message")


@pytest.mark.parametrize("outcome,exit_code,current,expected", [
    ("failure", 1, "new", "failed"),
    ("success", 0, "old", "succeeded"),
    (None, 1, "new", "failed"),
    (None, 0, "old", "succeeded"),
    (None, None, "new", "succeeded"),
    (None, None, "old", "unknown"),
])
async def test_hermes_matching_receipt_outcome(hub, outcome, exit_code, current, expected):
    class Hermes:
        async def hermes_update_status(self):
            return {"action_id": "same", "exit_code": exit_code, "lines": ["update log"],
                    "receipt": {"outcome": outcome}}
    hub.hermes = Hermes()
    hub.hermes_version = lambda: current
    job, _ = hub.store.create_job("hermes_update", detail={"boot": "old", "action_id": "same", "from": "old"})
    await hub.reconcile_jobs()
    result = hub.store.get_job(job["id"])
    assert result["state"] == expected
    assert result["detail"]["lines"] == ["update log"]
