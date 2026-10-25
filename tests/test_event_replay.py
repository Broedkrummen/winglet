"""Resumable events: the journal, the resume handshake and what a reconnect may see.

Two layers are covered on purpose. ``EventStream`` is tested directly for the bounds and refusals
that are expensive to reach through a live server (retention, paging, oversize, a corrupt journal);
the hub is tested through real sockets and requests for the parts only it can get wrong: which
frames carry a seq, what a member may replay, and what a snapshot contains.
"""

import asyncio
import json
import time

import pytest

from plugin.event_replay import JOURNAL_KINDS, EventStream
from plugin.hub import HOME_CHAT_ID, Hub
from plugin.store import Store


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "data.db")
    yield s
    s.close()


class FakeResponse:
    def __init__(self, status=201):
        self.status_code = status


class FakeHTTP:
    async def post(self, url, **kwargs):
        return FakeResponse()

    async def aclose(self):
        pass


@pytest.fixture
def hub(store, tmp_path):
    store.ensure_chat("general", "General")
    return Hub(store, web_root=tmp_path / "web", http_client=FakeHTTP(),
               bot_info=lambda: {"name": "hermes", "title": "Hermes"})


@pytest.fixture
async def client(aiohttp_client, hub):
    return await aiohttp_client(hub.build_app())


async def pair(client, hub, name="Pixel"):
    code = hub.store.create_pair_code()
    resp = await client.post("/api/pair", json={"code": code, "device_name": name, "platform": "android"})
    assert resp.status == 200
    return (await resp.json())["token"]


def message_event(chat_id="c1", message_id="m1"):
    return {"type": "message.new", "chat_id": chat_id, "message": {"id": message_id, "chat_id": chat_id}}


def replay(stream, after=0, epoch=None, visible=None, page=None):
    return stream.replay(None, after=after, epoch=stream.epoch() if epoch is None else epoch,
                         visible=visible or (lambda event: True), page=page)


# -- the journal ---------------------------------------------------------------------------


def test_append_assigns_a_contiguous_seq_and_leaves_other_kinds_alone(store):
    stream = EventStream(store)
    assert stream.head(None) == 0
    assert [stream.append(None, message_event(message_id="m1")),
            stream.append(None, message_event(message_id="m2"))] == [1, 2]
    # Presence is not state: it gets no seq, so it cannot make a cursor look caught up.
    assert stream.append(None, {"type": "typing", "chat_id": "c1", "on": True}) is None
    assert stream.append(None, {"type": "pet.update"}) is None
    assert stream.head(None) == 2
    assert store._one("SELECT COUNT(*) AS n FROM event_log")["n"] == 2


def test_replay_returns_events_after_the_cursor_in_order(store):
    stream = EventStream(store)
    for i in range(3):
        stream.append(None, message_event(message_id=f"m{i}"))
    reply = replay(stream, after=1)
    assert reply["ok"] is True
    assert [e["event_seq"] for e in reply["events"]] == [2, 3]
    assert [e["message"]["id"] for e in reply["events"]] == ["m1", "m2"]
    assert reply["watermark"] == reply["cursor"] == 3 and reply["has_more"] is False
    assert reply["epoch"] == stream.epoch()
    assert reply["retention"] == stream.retention()


def test_replay_is_idempotent_and_consumes_nothing(store):
    stream = EventStream(store)
    stream.append(None, message_event())
    first = replay(stream, after=0)
    second = replay(stream, after=0)
    assert first == second
    assert stream.head(None) == 1


@pytest.mark.parametrize("after, epoch, reason", [
    # A cursor from another generation is not read as a later position.
    (0, "old-epoch", "epoch"),
    # A cursor past the head means this server never issued it (the journal was replaced).
    (99, None, "cursor"),
    (-1, None, "cursor"),
    (None, None, "cursor"),
    (True, None, "cursor"),
])
def test_replay_refuses_what_it_cannot_prove(store, after, epoch, reason):
    stream = EventStream(store)
    stream.append(None, message_event())
    reply = replay(stream, after=after, epoch=epoch)
    assert reply["ok"] is False and reply["reason"] == reason
    assert "events" not in reply


def test_replay_refuses_a_gap_the_retention_bound_created(store):
    stream = EventStream(store, keep_events=2)
    for i in range(4):
        stream.append(None, message_event(message_id=f"m{i}"))
    assert stream.head(None) == 4
    assert replay(stream, after=0)["reason"] == "gap"  # rows 1 and 2 are gone
    assert replay(stream, after=2)["ok"] is True       # this cursor still has everything


def test_replay_pages_and_reports_how_far_the_page_reached(store):
    stream = EventStream(store, page=2)
    for i in range(5):
        stream.append(None, message_event(message_id=f"m{i}"))
    first = replay(stream, after=0)
    assert [e["event_seq"] for e in first["events"]] == [1, 2]
    assert first["has_more"] is True and first["cursor"] == 2 and first["watermark"] == 5
    second = replay(stream, after=first["cursor"])
    assert [e["event_seq"] for e in second["events"]] == [3, 4]
    third = replay(stream, after=second["cursor"])
    assert [e["event_seq"] for e in third["events"]] == [5]
    assert third["has_more"] is False and third["cursor"] == third["watermark"] == 5


def test_a_page_of_invisible_events_still_advances_the_cursor(store):
    """Filtering must never stall a client: an empty page says how far it read."""
    stream = EventStream(store, page=2)
    for i in range(3):
        stream.append(None, message_event(message_id=f"m{i}"))
    page = replay(stream, after=0, visible=lambda event: False)
    assert page["ok"] is True and page["events"] == [] and page["has_more"] is True
    assert page["cursor"] == 2
    last = replay(stream, after=page["cursor"], visible=lambda event: False)
    assert last["events"] == [] and last["has_more"] is False and last["cursor"] == 3 == last["watermark"]


def test_an_oversize_payload_is_journaled_as_a_hint_under_the_same_seq(store):
    stream = EventStream(store)
    huge = {"type": "message.update", "chat_id": "c1", "message": {"id": "m1", "text": "x" * 70_000}}
    assert stream.append(None, huge) == 1
    assert replay(stream, after=0)["events"] == [
        {"type": "sync.hint", "chat_id": "c1", "reason": "oversize", "event_seq": 1}]


def test_events_are_kept_per_bot_and_do_not_mix(store):
    stream = EventStream(store)
    stream.append(None, message_event(message_id="main"))
    stream.append("work", message_event(message_id="work"))
    assert stream.head(None) == 1 and stream.head("work") == 1
    assert [e["message"]["id"] for e in stream.replay(None, after=0, epoch=stream.epoch(),
                                                      visible=lambda e: True)["events"]] == ["main"]


def test_a_failed_transaction_leaves_neither_the_change_nor_its_event(store):
    stream = EventStream(store)
    with pytest.raises(RuntimeError):
        with stream.transaction():
            store.add_message("c1", "user", "half written")
            stream.append(None, message_event())
            raise RuntimeError("the process dies here")
    assert store.list_messages("c1") == []
    assert stream.head(None) == 0


def test_trim_drops_rows_but_never_the_head(store):
    stream = EventStream(store, keep_seconds=60)
    stream.append(None, message_event())
    store._exec("UPDATE event_log SET created_at = ?", (time.time() - 600,))
    assert stream.trim() == 1
    assert stream.head(None) == 1
    assert replay(stream, after=0)["reason"] == "gap"


def test_reset_starts_a_new_generation(store):
    stream = EventStream(store)
    stream.append(None, message_event())
    old = stream.epoch()
    stream.reset(None)
    assert stream.epoch() != old and stream.head(None) == 0
    assert replay(stream, after=1, epoch=old)["reason"] == "epoch"
    fresh = replay(stream, after=0)
    assert fresh["ok"] is True and fresh["events"] == []


def test_an_unreadable_journal_asks_for_a_snapshot_instead_of_guessing(store, monkeypatch):
    stream = EventStream(store)
    stream.append(None, message_event())
    real = store._one

    def broken(sql, args=()):
        if "MIN(seq)" in sql:
            raise RuntimeError("database disk image is malformed")
        return real(sql, args)

    monkeypatch.setattr(store, "_one", broken)
    reply = replay(stream, after=0)
    assert reply["ok"] is False and reply["reason"] == "journal"


# -- the socket ----------------------------------------------------------------------------


async def test_hello_announces_the_stream_and_the_capability(client, hub):
    token = await pair(client, hub)
    ws = await client.ws_connect(f"/api/ws?token={token}")
    hello = await ws.receive_json()
    stream = hello["event_stream"]
    assert hello["features"]["event_replay"] is True
    assert set(stream) == {"epoch", "watermark", "keep_events", "keep_seconds", "scope"}
    assert stream["watermark"] == 0 and stream["epoch"]
    assert stream["keep_events"] > 0 and stream["keep_seconds"] > 0
    await ws.close()


async def test_live_frames_carry_a_seq_and_presence_does_not(client, hub):
    token = await pair(client, hub)
    ws = await client.ws_connect(f"/api/ws?token={token}")
    await ws.receive_json()
    await ws.send_json({"type": "message.send", "chat_id": "general", "text": "one"})
    new = await ws.receive_json()
    chat = await ws.receive_json()
    assert new["type"] == "message.new" and new["event_seq"] == 1
    assert chat["type"] == "chat.update" and chat["event_seq"] == 2

    await hub.set_typing("general", True)
    typing = await ws.receive_json()
    assert typing == {"type": "typing", "chat_id": "general", "on": True}
    assert hub.store._one("SELECT COUNT(*) AS n FROM event_log")["n"] == 2
    await ws.close()


async def test_resume_replays_what_was_missed_while_offline(client, hub):
    token = await pair(client, hub)
    await hub.post_message("general", "first", push=False)
    await hub.post_message("general", "second", push=False)
    ws = await client.ws_connect(f"/api/ws?token={token}")
    hello = await ws.receive_json()
    assert hello["event_stream"]["watermark"] == 4  # two messages, two chat rows

    await ws.send_json({"type": "resume", "scope": hello["event_stream"]["scope"], "cursor": 0, "epoch": hello["event_stream"]["epoch"]})
    reply = await ws.receive_json()
    assert reply["type"] == "resume" and reply["ok"] is True and reply["has_more"] is False
    assert [e["type"] for e in reply["events"]] == ["message.new", "chat.update"] * 2
    assert [e["event_seq"] for e in reply["events"]] == [1, 2, 3, 4]
    assert [e["message"]["text"] for e in reply["events"] if e["type"] == "message.new"] == ["first", "second"]
    assert reply["cursor"] == reply["watermark"] == 4

    # Caught up: the same call is a safe no-op, which is what a reconnect storm sends.
    await ws.send_json({"type": "resume", "scope": hello["event_stream"]["scope"], "cursor": reply["watermark"], "epoch": reply["epoch"]})
    again = await ws.receive_json()
    assert again["ok"] is True and again["events"] == [] and again["watermark"] == 4
    await ws.close()


async def test_a_wrong_epoch_sends_the_phone_to_a_snapshot(client, hub):
    token = await pair(client, hub)
    await hub.post_message("general", "before the restore", push=False)
    hub.events.rotate_epoch()
    ws = await client.ws_connect(f"/api/ws?token={token}")
    hello = await ws.receive_json()
    await ws.send_json({"type": "resume", "scope": hello["event_stream"]["scope"], "cursor": 0, "epoch": "the-old-generation"})
    reply = await ws.receive_json()
    assert reply["ok"] is False and reply["reason"] == "epoch"
    assert reply["epoch"] == hello["event_stream"]["epoch"] and reply["watermark"] == 2
    await ws.close()


async def test_retention_that_ran_out_sends_the_phone_to_a_snapshot(client, hub):
    hub.events = EventStream(hub.store, keep_events=2, page=10)
    await hub.post_message("general", "trimmed", push=False)   # seq 1, 2
    await hub.post_message("general", "still here", push=False)  # seq 3, 4; 1 and 2 trimmed
    token = await pair(client, hub)
    ws = await client.ws_connect(f"/api/ws?token={token}")
    hello = await ws.receive_json()
    await ws.send_json({"type": "resume", "scope": hello["event_stream"]["scope"], "cursor": 0, "epoch": hello["event_stream"]["epoch"]})
    assert (await ws.receive_json())["reason"] == "gap"
    await ws.send_json({"type": "resume", "scope": hello["event_stream"]["scope"], "cursor": 2, "epoch": hello["event_stream"]["epoch"]})
    reply = await ws.receive_json()
    assert reply["ok"] is True and [e["event_seq"] for e in reply["events"]] == [3, 4]
    await ws.close()


async def test_a_missing_or_unknown_frame_does_not_break_the_socket(client, hub):
    """Old apps talk to new servers; an unrecognised frame is ignored, not fatal."""
    token = await pair(client, hub)
    ws = await client.ws_connect(f"/api/ws?token={token}")
    await ws.receive_json()
    await ws.send_json({"type": "something.from.the.future", "n": 1})
    await ws.send_json({"type": "ping", "t": 7})
    assert (await ws.receive_json()) == {"type": "pong", "t": 7}
    assert ws.closed is False
    await ws.close()


async def test_an_old_client_that_never_resumes_still_works(client, hub):
    """No resume frame at all: hello values and live frames as before, seq simply ignored."""
    token = await pair(client, hub)
    ws = await client.ws_connect(f"/api/ws?token={token}")
    hello = await ws.receive_json()
    assert hello["type"] == "hello" and HOME_CHAT_ID in {chat["id"] for chat in hello["chats"]}
    await hub.post_message("general", "live", push=False)
    assert (await ws.receive_json())["message"]["text"] == "live"
    await ws.close()


# -- who may see what ----------------------------------------------------------------------


async def test_a_member_replays_only_their_own_chats(client, hub):
    owner = await pair(client, hub, "Owner")
    member, member_token = hub.store.add_device("Member", role="member")
    other, other_token = hub.store.add_device("Other", role="member")
    mine = hub.store.create_chat("Mine", owner_device=member["id"])["id"]
    theirs = hub.store.create_chat("Theirs", owner_device=other["id"])["id"]
    await hub.post_message(mine, "for member", push=False)
    await hub.post_message(theirs, "for other", push=False)

    ws = await client.ws_connect(f"/api/ws?token={member_token}")
    hello = await ws.receive_json()
    await ws.send_json({"type": "resume", "scope": hello["event_stream"]["scope"], "cursor": 0, "epoch": hello["event_stream"]["epoch"]})
    reply = await ws.receive_json()
    chats = {e.get("chat_id") or (e.get("chat") or {}).get("id") for e in reply["events"]}
    assert chats == {mine}
    assert [e["event_seq"] for e in reply["events"]] == [1, 2]
    assert reply["watermark"] == 4  # the other member's two rows exist; they were filtered out
    await ws.close()

    ws = await client.ws_connect(f"/api/ws?token={owner}")
    hello = await ws.receive_json()
    await ws.send_json({"type": "resume", "scope": hello["event_stream"]["scope"], "cursor": 0, "epoch": hello["event_stream"]["epoch"]})
    owner_reply = await ws.receive_json()
    assert len(owner_reply["events"]) == 4
    await ws.close()

    ws = await client.ws_connect(f"/api/ws?token={other_token}")
    hello = await ws.receive_json()
    await ws.send_json({"type": "resume", "scope": hello["event_stream"]["scope"], "cursor": 0, "epoch": hello["event_stream"]["epoch"]})
    assert {e["event_seq"] for e in (await ws.receive_json())["events"]} == {3, 4}
    await ws.close()


async def test_a_role_change_applies_to_rows_already_in_the_journal(client, hub):
    owner_token = await pair(client, hub, "Owner")
    member, member_token = hub.store.add_device("Member", role="member")
    other, _ = hub.store.add_device("Other", role="member")
    theirs = hub.store.create_chat("Theirs", owner_device=other["id"])["id"]
    await hub.post_message(theirs, "another member's message", push=False)

    ws = await client.ws_connect(f"/api/ws?token={member_token}")
    hello = await ws.receive_json()
    epoch = hello["event_stream"]["epoch"]
    await ws.send_json({"type": "resume", "scope": hello["event_stream"]["scope"], "cursor": 0, "epoch": epoch})
    assert (await ws.receive_json())["events"] == []

    hub.store.update_device(member["id"], role="owner")
    await ws.send_json({"type": "resume", "scope": hello["event_stream"]["scope"], "cursor": 0, "epoch": epoch})
    promoted = await ws.receive_json()
    assert promoted["ok"] is False  # role changes invalidate scope, even on an old socket
    await ws.close()
    ws = await client.ws_connect(f"/api/ws?token={member_token}")
    hello = await ws.receive_json()
    await ws.send_json({"type": "resume", "scope": hello["event_stream"]["scope"], "cursor": 0, "epoch": epoch})
    assert [e["event_seq"] for e in (await ws.receive_json())["events"]] == [1, 2]

    hub.store.update_device(member["id"], role="member")
    await ws.close()
    ws = await client.ws_connect(f"/api/ws?token={member_token}")
    hello = await ws.receive_json()
    await ws.send_json({"type": "resume", "scope": hello["event_stream"]["scope"], "cursor": 0, "epoch": epoch})
    assert (await ws.receive_json())["events"] == []
    await ws.close()


async def test_owner_only_detail_is_rewritten_for_a_member_on_replay(client, hub):
    await pair(client, hub, "Owner")
    member, member_token = hub.store.add_device("Member", role="member")
    mine = hub.store.create_chat("Mine", owner_device=member["id"])["id"]
    await hub.publish(lambda: {"paused": {"engaged_at": 10.0, "reason": "the owner's private note"}},
                      lambda body: {"type": "system.paused", **body})
    await hub.add_inbox("question", mine, "Question", "Which?", {}, push=False)

    ws = await client.ws_connect(f"/api/ws?token={member_token}")
    hello = await ws.receive_json()
    await ws.send_json({"type": "resume", "scope": hello["event_stream"]["scope"], "cursor": 0, "epoch": hello["event_stream"]["epoch"]})
    reply = await ws.receive_json()
    paused = next(e for e in reply["events"] if e["type"] == "system.paused")
    assert paused["paused"] == {"reason": None, "engaged_at": 10.0}
    inbox = next(e for e in reply["events"] if e["type"] == "inbox.new")
    assert inbox["pending"] == 1  # this member's own count, not the server's
    await ws.close()


async def test_an_unpaired_device_cannot_resume(client, hub):
    member, member_token = hub.store.add_device("Member", role="member")
    ws = await client.ws_connect(f"/api/ws?token={member_token}")
    hello = await ws.receive_json()
    hub.store.remove_device(member["id"])
    await ws.send_json({"type": "resume", "scope": hello["event_stream"]["scope"], "cursor": 0, "epoch": hub.events.epoch()})
    await ws.receive()
    assert ws.close_code == 4401
    assert (await client.get("/api/sync/snapshot", headers={"Authorization": f"Bearer {member_token}"})).status == 401


# -- snapshot ---------------------------------------------------------------------------------


async def test_the_snapshot_is_scoped_and_carries_the_watermark(client, hub):
    await pair(client, hub, "Owner")
    member, member_token = hub.store.add_device("Member", role="member")
    mine = hub.store.create_chat("Mine", owner_device=member["id"])["id"]
    message = await hub.post_message(mine, "gone later", push=False)
    await hub.delete_message(message["id"])
    await hub.add_inbox("question", mine, "Question", "Which?", {}, push=False)

    ws = await client.ws_connect(f"/api/ws?token={member_token}")
    hello = await ws.receive_json()
    await ws.close()

    auth = {"Authorization": f"Bearer {member_token}"}
    snap = await (await client.get("/api/sync/snapshot", headers=auth)).json()
    assert snap["epoch"] == hello["event_stream"]["epoch"]
    assert snap["watermark"] == hub.events.head(None) == 5
    ids = {c["id"] for c in snap["chats"]}
    assert mine in ids and HOME_CHAT_ID not in ids
    assert [i["chat_id"] for i in snap["inbox"]] == [mine]
    assert snap["deletions"] == {mine: [message["id"]]}
    assert snap["pending"] == 1 and snap["me"]["id"] == member["id"]

    # The watermark is read before the state: take a snapshot, then assert what came after it is
    # still ahead of the phone (it would arrive live or in the next resume).
    later = await hub.post_message(mine, "after the snapshot", push=False)
    assert hub.events.head(None) == 7 > snap["watermark"]
    assert later["text"] == "after the snapshot"


async def test_a_member_snapshot_has_no_other_members_data(client, hub):
    await pair(client, hub, "Owner")
    member, member_token = hub.store.add_device("Member", role="member")
    other, _ = hub.store.add_device("Other", role="member")
    theirs = hub.store.create_chat("Theirs", owner_device=other["id"])["id"]
    await hub.add_inbox("question", theirs, "Private", "?", {}, push=False)
    snap = await (await client.get("/api/sync/snapshot",
                                   headers={"Authorization": f"Bearer {member_token}"})).json()
    assert theirs not in {c["id"] for c in snap["chats"]}
    assert snap["inbox"] == [] and snap["deletions"] == {}


# -- atomicity and ordering --------------------------------------------------------------------


async def test_a_journal_failure_rolls_the_change_back(client, hub, monkeypatch):
    """No committed change without its replay row: the phone must never miss state silently."""

    def boom(*args, **kwargs):
        raise RuntimeError("no space left on device")

    monkeypatch.setattr(hub.events, "append", boom)
    with pytest.raises(RuntimeError):
        await hub.post_message("general", "lost", push=False)
    assert hub.store.list_messages("general") == []
    assert hub.events.head(None) == 0


async def test_concurrent_writes_get_distinct_ordered_seqs(client, hub):
    await asyncio.gather(*[hub.post_message("general", f"m{i}", push=False) for i in range(10)])
    seqs = [r["seq"] for r in hub.store._all("SELECT seq FROM event_log ORDER BY seq")]
    assert seqs == list(range(1, 21))
    reply = replay(hub.events)
    assert [e["event_seq"] for e in reply["events"]] == seqs


async def test_every_journaled_kind_has_a_shape_the_client_can_apply(client, hub):
    """The journal only takes kinds the app knows how to merge; adding one is a deliberate act."""
    assert JOURNAL_KINDS == {"message.new", "message.update", "message.delete", "chat.update",
                             "chat.delete", "inbox.new", "inbox.update", "system.paused", "sync.hint"}
    await hub.post_message("general", "s", push=False)
    await hub.edit_message(hub.store.list_messages("general")[0]["id"], "s2", final=True)
    await hub.add_inbox("result", "general", "Done", "", {}, push=False)
    kinds = {r["kind"] for r in hub.store._all("SELECT kind FROM event_log")}
    assert kinds <= JOURNAL_KINDS
    assert {"message.new", "message.update", "chat.update", "inbox.new"} <= kinds


def test_internal_hole_and_corrupt_payload_require_snapshot(store):
    stream = EventStream(store)
    for i in range(3): stream.append(None, message_event(message_id=str(i)))
    store._exec("DELETE FROM event_log WHERE seq = 2")
    assert replay(stream)["reason"] == "gap"
    stream.reset()
    stream.append(None, message_event())
    store._exec("UPDATE event_log SET payload = 'broken'")
    assert replay(stream)["reason"] == "journal"


def test_journal_restart_and_threaded_writes_are_durable(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    path = tmp_path / "restart.db"
    first = Store(path)
    stream = EventStream(first)
    epoch = stream.epoch()
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda i: stream.append(None, message_event(message_id=str(i))), range(50)))
    first.close()
    second = Store(path)
    restored = EventStream(second)
    assert restored.epoch() == epoch
    reply = replay(restored)
    assert [e["event_seq"] for e in reply["events"]] == list(range(1, 51))
    second.close()


async def test_namespaced_events_keep_their_own_seq(client, hub):
    token = await pair(client, hub)
    ws = await client.ws_connect(f"/api/ws?token={token}")
    hello = await ws.receive_json()
    await hub.broadcast({"type": "task.event", "chat_id": "general", "seq": 17, "event": {"kind": "todo"}})
    live = await ws.receive_json()
    assert live["seq"] == 17 and live["event_seq"] == 1
    await ws.send_json({"type": "resume", "scope": hello["event_stream"]["scope"], "epoch": hub.events.epoch(), "cursor": 0})
    reply = await ws.receive_json()
    assert reply["events"][0]["seq"] == 17 and reply["events"][0]["event_seq"] == 1
    await ws.close()


async def test_cursor_scope_is_bound_to_device_bot_and_role(client, hub):
    token = await pair(client, hub)
    _, other_token = hub.store.add_device("Other", role="owner")
    first = await client.ws_connect(f"/api/ws?token={token}")
    hello = await first.receive_json()
    second = await client.ws_connect(f"/api/ws?token={other_token}")
    other = await second.receive_json()
    assert other["event_stream"]["scope"] != hello["event_stream"]["scope"]
    await second.send_json({"type": "resume", "scope": hello["event_stream"]["scope"], "epoch": hub.events.epoch(), "cursor": 0})
    assert (await second.receive_json())["reason"] == "cursor"
    await first.close(); await second.close()


async def test_rotated_token_cannot_replay_on_existing_socket(client, hub):
    token = await pair(client, hub)
    device = hub.store.device_for_token(token)
    ws = await client.ws_connect(f"/api/ws?token={token}")
    hello = await ws.receive_json()
    hub.store.rotate_token(device["id"])
    await ws.send_json({"type": "resume", "scope": hello["event_stream"]["scope"], "epoch": hub.events.epoch(), "cursor": 0})
    await ws.receive()
    assert ws.close_code == 4401


async def test_unknown_unscoped_namespaced_events_are_owner_only(client, hub):
    member, token = hub.store.add_device("Member", role="member")
    await hub.broadcast({"type": "context.private", "secret": "owner only"})
    ws = await client.ws_connect(f"/api/ws?token={token}")
    hello = await ws.receive_json()
    await ws.send_json({"type": "resume", "scope": hello["event_stream"]["scope"], "epoch": hub.events.epoch(), "cursor": 0})
    assert (await ws.receive_json())["events"] == []
    await ws.close()


async def test_replay_never_resurrects_deleted_text_or_old_inbox_status(client, hub):
    token = await pair(client, hub)
    message = await hub.post_message("general", "old private text", push=False)
    await hub.delete_message(message["id"])
    ws = await client.ws_connect(f"/api/ws?token={token}")
    hello = await ws.receive_json()
    await ws.send_json({"type": "resume", "scope": hello["event_stream"]["scope"], "epoch": hub.events.epoch(), "cursor": 0})
    reply = await ws.receive_json()
    assert "old private text" not in json.dumps(reply["events"])
    assert reply["events"][0]["type"] == "message.delete"
    await ws.close()


async def test_slow_socket_is_closed_with_resync_instead_of_blocking_publication(hub):
    device, token = hub.store.add_device("Slow", role="owner")
    class SlowSocket:
        closed = False
        code = None
        async def send_str(self, text): await asyncio.Event().wait()
        async def close(self, *, code, message): self.closed = True; self.code = code
    ws = SlowSocket()
    hub._sockets[ws] = {"device": device, "bot": None, "auth_token": token}
    await asyncio.wait_for(hub.post_message("general", "durable despite a slow phone", push=False), timeout=4)
    assert ws.closed and ws.code == 1013 and ws not in hub._sockets
    assert hub.events.head(None) == 2


def test_scope_changes_with_bot_and_role(hub):
    device, _ = hub.store.add_device("Owner", role="owner")
    main = hub._replay_scope(device)
    with hub._bot_context("other"):
        assert hub._replay_scope(device) != main
    assert hub._replay_scope({**device, "role": "member"}) != main


async def test_reference_expansion_cannot_exceed_the_replay_payload_bound(client, hub):
    token = await pair(client, hub)
    message = await hub.post_message("general", "small", push=False)
    hub.store.update_message(message["id"], "x" * (70 * 1024))
    ws = await client.ws_connect(f"/api/ws?token={token}")
    hello = await ws.receive_json()
    await ws.send_json({"type": "resume", "scope": hello["event_stream"]["scope"], "epoch": hub.events.epoch(), "cursor": 0})
    reply = await ws.receive_json()
    assert reply["events"][0]["type"] == "sync.hint"
    assert len(json.dumps(reply).encode()) < 512 * 1024 + 1024
    await ws.close()
