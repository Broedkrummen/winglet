"""The hub stays quick as chats grow: indexed paging, fewer writes, work shared across sockets, bounded memory."""

import asyncio
import json
import time

import pytest

from plugin import store as store_module
from plugin.hub import Hub
from plugin.store import Store
from test_hub import pair


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "data.db")
    yield s
    s.close()


@pytest.fixture
def hub(store, tmp_path):
    return Hub(store, web_root=tmp_path / "web", media_dir=tmp_path / "media")


@pytest.fixture
async def client(aiohttp_client, hub):
    return await aiohttp_client(hub.build_app())


def plan(store, sql, args):
    return " ".join(row[3] for row in store._db.execute("EXPLAIN QUERY PLAN " + sql, args).fetchall())


def test_a_page_of_messages_reads_only_that_page(store):
    newest = plan(store, "SELECT rowid AS position, * FROM messages WHERE chat_id = ? ORDER BY rowid DESC LIMIT ?",
                  ("general", 60))
    older = plan(store, "SELECT rowid AS position, * FROM messages WHERE chat_id = ? AND rowid < ? "
                        "ORDER BY rowid DESC LIMIT ?", ("general", 100, 60))
    for p in (newest, older):
        assert "messages_chat_rowid" in p and "TEMP B-TREE" not in p
    assert store._db.execute("PRAGMA synchronous").fetchone()[0] == 1  # NORMAL: no disk flush per commit


def test_streaming_edits_leave_the_chat_list_alone_until_the_reply_is_done(store, monkeypatch):
    clock = iter(range(1000, 2000))  # a clock that always moves on (Windows' can repeat a value)
    monkeypatch.setattr(store_module, "_now", lambda: float(next(clock)))
    chat = store.create_chat("Plans")
    reply = store.add_message(chat["id"], "bot", "", status="streaming")
    before = store.get_chat(chat["id"])
    edited = store.update_message(reply["id"], "Half a", meta={"model": "x"})
    assert edited == store.get_message(reply["id"])  # what's returned is what's stored
    assert store.get_chat(chat["id"])["updated_at"] == before["updated_at"]
    store.update_message(reply["id"], "Half an answer.", status="final")
    after = store.get_chat(chat["id"])
    assert after["preview"] == "Half an answer." and after["updated_at"] > before["updated_at"]


def test_last_seen_is_written_at_most_once_a_minute(store, monkeypatch):
    device, token = store.add_device("Pixel")
    writes = []
    real = store._exec
    monkeypatch.setattr(store, "_exec", lambda sql, args=(): writes.append(sql) or real(sql, args))
    clock = [time.time() + 120]
    monkeypatch.setattr(store_module, "_now", lambda: clock[0])
    for _ in range(5):
        assert store.device_for_token(token)["id"] == device["id"]
    assert len([w for w in writes if "last_seen" in w]) == 1
    clock[0] += store_module.LAST_SEEN_EVERY_SECONDS
    store.device_for_token(token)
    assert len([w for w in writes if "last_seen" in w]) == 2


async def test_a_resend_after_days_offline_still_finds_the_original(client, hub, monkeypatch):
    """The phone kept a send it never heard back about and resends it on reconnect, days later: the agent
    mustn't run it twice. The lookup goes through an index, so it stays quick however long the chat is."""
    calls = []

    async def on_user_message(chat, text, device, message):
        calls.append(text)
    hub.on_user_message = on_user_message
    hub.store.ensure_chat("general", "General")
    auth = {"Authorization": f"Bearer {await pair(client, hub)}"}
    body = {"text": "deploy it", "client_id": "retry-after-offline"}
    first = await (await client.post("/api/chats/general/messages", json=body, headers=auth)).json()
    later = time.time() + 2 * 86400
    monkeypatch.setattr(store_module, "_now", lambda: later)
    again = await (await client.post("/api/chats/general/messages", json=body, headers=auth)).json()
    assert again["message"]["id"] == first["message"]["id"] and calls == ["deploy it"]
    lookup = plan(hub.store, "SELECT rowid AS position, * FROM messages WHERE chat_id = ? "
                             "AND json_extract(meta, '$.client_id') = ? AND role = 'user'", ("general", "c"))
    assert "messages_client_id" in lookup


def test_pending_counts_by_bot_and_member_in_one_query(store):
    store.ensure_chat("general", "General")
    store.ensure_chat("b-chef", "Chef", bot="chef")
    mine = store.create_chat("Mine", owner_device="member-1")
    for chat_id in ("general", "general", "b-chef", mine["id"]):
        store.add_inbox("approval", chat_id, "Run it?")
    store.resolve_inbox(store.add_inbox("approval", "general", "Old")["id"], "approved")
    assert store.pending_count_for(None) == 3
    assert store.pending_count_for("chef") == 1
    assert store.pending_count_for(None, "member-1") == 1
    assert store.pending_count_for("chef", "member-1") == 0


def test_old_tombstones_and_answered_inbox_items_are_pruned(store):
    gone = store.add_message("general", "bot", "x")
    store.delete_message(gone["id"])
    pending = store.add_inbox("approval", "general", "Still waiting")
    answered = store.add_inbox("approval", "general", "Done")
    store.resolve_inbox(answered["id"], "approved")
    assert store.prune() == 0  # nothing is old yet
    later = time.time() + store_module.INBOX_KEEP_SECONDS + 60
    assert store.prune(later) == 2
    assert store.deleted_message_ids("general") == []
    assert [i["id"] for i in store.list_inbox()] == [pending["id"]]  # pending items stay until answered


async def test_only_the_newest_page_carries_tombstones(client, hub):
    auth = {"Authorization": f"Bearer {await pair(client, hub)}"}
    first = [hub.store.add_message("general", "bot", f"m{i}") for i in range(70)]
    hub.store.delete_message(first[-1]["id"])
    newest = await (await client.get("/api/chats/general/messages?limit=60", headers=auth)).json()
    assert newest["deleted_ids"] == [first[-1]["id"]]
    older = await (await client.get(f"/api/chats/general/messages?limit=60&before_position={newest['messages'][0]['position']}",
                                    headers=auth)).json()
    assert len(older["messages"]) == 9 and older["deleted_ids"] == []


class Socket:
    closed = False

    def __init__(self):
        self.sent = []

    async def send_str(self, text):
        self.sent.append(json.loads(text))


async def test_a_broadcast_works_things_out_once_for_all_sockets(hub, monkeypatch):
    owners = [hub.store.add_device(f"Owner {i}")[0]["id"] for i in range(3)]
    member = hub.store.add_device("Alex", role="member")[0]["id"]
    hub.store.ensure_chat("general", "General")
    mine = hub.store.create_chat("Mine", owner_device=member)
    hub.store.add_inbox("approval", "general", "Run it?")
    hub.store.add_inbox("approval", mine["id"], "Run mine?")
    sockets = {Socket(): {"device": {"id": d}, "bot": None} for d in owners + [member]}
    hub._sockets.update(sockets)
    lookups, encodes = [], []
    real_get, real_dumps = hub.store.get_chat, json.dumps
    monkeypatch.setattr(hub.store, "get_chat", lambda chat_id: lookups.append(chat_id) or real_get(chat_id))
    monkeypatch.setattr("plugin.hub.json.dumps", lambda value, **kw: encodes.append(1) or real_dumps(value, **kw))
    await hub.broadcast({"type": "message.update", "chat_id": "general", "message": {"id": "m", "chat_id": "general"}})
    assert len(lookups) == 1 and len(encodes) == 1  # not once per socket
    got = [s.sent for s in sockets]
    assert all(len(g) == 1 for g in got[:3]) and got[3] == []  # the member can't see the main chat
    await hub.broadcast({"type": "inbox.new", "item": {"chat_id": mine["id"]}, "pending": 0})
    assert [g[-1]["pending"] for g in got] == [2, 2, 2, 1]


async def test_pushes_go_to_every_phone_at_once(hub, monkeypatch):
    for i in range(4):
        device_id = hub.store.add_device(f"Phone {i}")[0]["id"]
        hub.store.add_push_sub(device_id, "ntfy", f"https://ntfy.sh/t{i}", {"server": "https://ntfy.sh", "topic": f"t{i}"})

    class Slow:
        async def post(self, url, **kw):
            await asyncio.sleep(0.3)
            return type("R", (), {"status_code": 200})()

    hub._http = Slow()
    started = time.monotonic()
    result = await hub.push_now({"title": "t", "body": "b", "kind": "approval", "chat_id": "general"}, tag="x")
    assert result["accepted"] == 4 and time.monotonic() - started < 0.9


async def test_address_recovery_survives_a_failure(hub, monkeypatch):
    calls = []

    async def publish():
        calls.append(1)
        if len(calls) == 1:
            raise KeyError("topic")
        hub._recovery_task.cancel()
    monkeypatch.setattr(hub, "publish_addresses", publish)
    hub._recovery_task = asyncio.create_task(hub._recovery_loop())
    await asyncio.sleep(0)
    hub._recovery_wake.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(hub._recovery_task, 2)
    assert len(calls) == 2


def test_unanswered_cards_and_old_pairing_failures_are_forgotten(hub):
    now = time.monotonic()
    hub._pickers = {"old": {"expires": now - 1}, "open": {"expires": now + 60}}
    hub._pair_failures = {"1.2.3.4": [now - 120], "5.6.7.8": [now]}
    hub._prune_memory()
    assert list(hub._pickers) == ["open"] and list(hub._pair_failures) == ["5.6.7.8"]


async def test_shutdown_clears_the_janitor_without_a_bot_watcher(hub):
    await hub._start_janitor(None)
    assert hub._bots_watch is None
    await hub._close_sockets(None)
    assert hub._janitor is None
