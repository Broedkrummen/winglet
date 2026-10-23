"""Conversation branching: real transcript boundaries, revision checks, idempotency and scope.

The mapping tests are pure. The API tests use a fake Hermes session bridge so they prove the
Winglet-side contract (revision, locks, copies, attachments, audit, idempotency). A real-Hermes
test at the bottom runs in CI's `hermes` job and exercises Hermes' own transcript/rewind/copy
primitives; it is skipped on machines without Hermes installed.
"""

from __future__ import annotations

import importlib.util
import json
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from plugin.branching import (
    BranchRefused,
    BranchService,
    HermesBranchBridge,
    Snapshot,
    message_capabilities,
    plan_operation,
    transcript_revision,
    visible_messages,
)
from plugin.hub import Hub
from plugin.store import Store, new_id
from test_trust import pair_phone


# -- fixtures ---------------------------------------------------------------------------------


class FakeBridge:
    def __init__(self):
        self.transcripts: dict[str, list[dict]] = {}
        self.created = []
        self.rewinds = []
        self.fail_create = False

    def available(self):
        return True

    async def snapshot(self, chat_id):
        return Snapshot(chat_id, f"key:{chat_id}", f"sid:{chat_id}", list(self.transcripts.get(chat_id, [])), None)

    async def create_branch_session(self, new_chat, device, title, parent, prefix):
        if self.fail_create:
            raise BranchRefused("unsupported", "Hermes refused the branch session.")
        self.created.append({"chat_id": new_chat["id"], "parent": parent.session_id, "prefix": list(prefix), "title": title})
        self.transcripts[new_chat["id"]] = list(prefix)
        return f"sid:{new_chat['id']}"

    async def end_failed_branch(self, session_id):
        pass

    def source_for(self, chat, device):
        return SimpleNamespace(chat_id=chat["id"], user_id=f"winglet:{device['id']}", chat_type="dm")

    async def rewind_latest(self, chat_id, prompt_text, source, expected_row_index=None):
        self.rewinds.append((chat_id, prompt_text, expected_row_index))
        return {"target_text": prompt_text, "turns_undone": 1, "rewound_count": 2}

    async def create_branch_session_failure(self):
        pass


class FakeAdapter:
    gateway_runner = None

    def __init__(self):
        self.sent = []

    def _session_key(self, chat_id):
        return f"key:{chat_id}"

    def _chat_model(self, chat_id):
        return None


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "data.db")
    yield s
    s.close()


@pytest.fixture
def hub(store, tmp_path):
    store.ensure_chat("general", "General")
    h = Hub(store, web_root=tmp_path / "web", bot_info=lambda: {"name": "hermes", "title": "Hermes"})
    h.received = []

    async def on_user_message(chat, text, device, message, **extra):
        h.received.append((chat["id"], text, device["id"]))

    h.on_user_message = on_user_message
    h.command_resolver = lambda name: name
    adapter = FakeAdapter()

    async def adapter_user_message(chat, text, device, message, **extra):
        await on_user_message(chat, text, device, message, **extra)

    adapter._on_user_message = adapter_user_message
    h.branching = BranchService(h, adapter)
    h.branching.bridge = FakeBridge()
    h.branching.adapter = adapter
    return h


@pytest.fixture
async def client(aiohttp_client, hub):
    return await aiohttp_client(hub.build_app())


def add_exchange(hub: Hub, chat_id: str, user_text: str, bot_text: str, user_id: str = "", attachment=None):
    """A settled user turn + reply in Winglet, and the matching real transcript rows."""
    mid = user_id or new_id()
    meta = {"device": "Phone", "client_id": "c-" + mid}
    if attachment:
        meta["attachments"] = [hub._upload_public(attachment)]
    user = hub.store.add_message(chat_id, "user", user_text, meta=meta, message_id=mid)
    bot = hub.store.add_message(chat_id, "bot", bot_text, meta={"notify": True})
    rows = hub.branching.bridge.transcripts.setdefault(chat_id, [])
    rows.append({"role": "user", "content": user_text, "message_id": mid})
    rows.append({"role": "assistant", "content": bot_text})
    return user, bot


async def state(client, phone, chat_id="general"):
    return await client.get(f"/api/branching/chats/{chat_id}", headers=phone.auth)


async def branch(client, phone, body, chat_id="general"):
    return await client.post(f"/api/branching/chats/{chat_id}/branch", json=body, headers=phone.auth)


async def regenerate(client, phone, body, chat_id="general"):
    return await client.post(f"/api/branching/chats/{chat_id}/regenerate", json=body, headers=phone.auth)


def op():
    return "br-" + new_id() + new_id()


# -- pure mapping -----------------------------------------------------------------------------


def _msg(mid, role, text, status="final", meta=None, position=None):
    return {"id": mid, "role": role, "text": text, "status": status, "meta": meta or {},
            "position": position if position is not None else 1, "created_at": 1, "updated_at": 1}


def test_visible_messages_ignores_offline_activity_hidden_and_cards():
    rows = [
        _msg("u1", "user", "ask", position=1),
        _msg("a1", "bot", "answer", position=2),
        _msg("p", "bot", "🔍 web_search: cats", position=3),
        _msg("h", "user", "/model", meta={"hidden": True}, position=4),
        _msg("s", "system", "status", meta={"status_key": "x"}, position=5),
        _msg("f", "user", "not sent", status="failed", position=6),
        _msg("c", "bot", "card", meta={"picker": {"id": "p"}}, position=7),
        _msg("u2", "user", "next", position=8),
    ]
    assert [m["id"] for m in visible_messages(rows)] == ["u1", "a1", "u2"]


def test_plan_edit_excludes_the_edited_turn_and_keeps_later_messages():
    messages = [
        _msg("u1", "user", "one", position=1), _msg("a1", "bot", "first", position=2),
        _msg("u2", "user", "two", position=3), _msg("a2", "bot", "second", position=4),
    ]
    transcript = [
        {"role": "user", "content": "one", "message_id": "u1"}, {"role": "assistant", "content": "first"},
        {"role": "user", "content": "two", "message_id": "u2"}, {"role": "assistant", "content": "second"},
    ]
    plan = plan_operation(messages, transcript, "u2", "edit", text="changed")
    assert [m["id"] for m in plan.copy] == ["u1", "a1"]
    assert [r["content"] for r in plan.transcript_prefix] == ["one", "first"]
    assert plan.send_text == "changed"
    assert plan.later == 2  # the edited turn and its reply stay in the original


def test_plan_regenerate_anchors_on_the_prompt_and_only_final_replies():
    messages = [
        _msg("u1", "user", "one", position=1), _msg("draft", "bot", "thinking out loud", position=2),
        _msg("a1", "bot", "first", position=3),
        _msg("u2", "user", "two", position=4), _msg("a2", "bot", "second", position=5),
    ]
    transcript = [
        {"role": "user", "content": "one", "message_id": "u1"},
        {"role": "assistant", "content": "thinking out loud"},
        {"role": "assistant", "content": "first"},
        {"role": "user", "content": "two", "message_id": "u2"}, {"role": "assistant", "content": "second"},
    ]
    plan = plan_operation(messages, transcript, "a2", "regenerate")
    assert [m["id"] for m in plan.copy] == ["u1", "draft", "a1"]
    assert plan.send_text == "two"
    assert [r["content"] for r in plan.transcript_prefix] == ["one", "thinking out loud", "first"]
    with pytest.raises(BranchRefused):
        plan_operation(messages, transcript, "draft", "regenerate")


def test_tool_rows_are_context_but_never_boundaries():
    messages = [_msg("u1", "user", "one", position=1), _msg("a1", "bot", "answer", position=2)]
    transcript = [
        {"role": "user", "content": "one", "message_id": "u1"},
        {"role": "assistant", "content": "", "tool_calls": [{"function": {"name": "terminal"}}]},
        {"role": "tool", "content": "ok", "tool_call_id": "t1"},
        {"role": "assistant", "content": "answer"},
    ]
    plan = plan_operation(messages, transcript, "a1", "branch")
    assert [r["role"] for r in plan.transcript_prefix] == ["user", "assistant", "tool", "assistant"]
    caps = message_capabilities(messages, transcript)
    assert caps["a1"]["can_regenerate"] is True and caps["u1"]["can_edit"] is True


def test_abandoned_operation_row_can_be_retried_after_a_crash(store):
    oid = "br-" + new_id() + new_id()
    assert store.claim_branch_op(oid, "c", "branch", "d") == (None, None)
    assert store.claim_branch_op(oid, "c", "branch", "d") == (None, "in_progress")
    store._exec("UPDATE branch_operations SET updated_at = ? WHERE op_id = ?", (time.time() - 300, oid))
    assert store.claim_branch_op(oid, "c", "branch", "d") == (None, None)


def test_revision_changes_when_either_transcript_or_winglet_changes():
    messages = [_msg("u1", "user", "one", position=1)]
    transcript = [{"role": "user", "content": "one", "message_id": "u1"}]
    first = transcript_revision(messages, transcript)
    messages[0]["text"] = "edited locally"
    second = transcript_revision(messages, transcript)
    transcript[0]["content"] = "different durable text"
    third = transcript_revision(messages, transcript)
    assert len({first, second, third}) == 3


# -- API ---------------------------------------------------------------------------------------


async def test_state_maps_ids_and_exposes_per_message_gates(client, hub):
    phone = await pair_phone(client, hub)
    user, bot = add_exchange(hub, "general", "hello", "hi there")
    response = await state(client, phone)
    data = await response.json()
    assert response.status == 200
    assert data["supported"] is True and data["revision"].startswith("b-")
    assert data["messages"][user["id"]]["can_edit"] is True
    assert data["messages"][user["id"]]["can_branch"] is True
    assert data["messages"][bot["id"]]["can_regenerate"] is True
    assert (await (await client.get("/api/info")).json())["features"]["chat_branching"] is True


async def test_edit_creates_a_branch_and_sends_from_real_context(client, hub):
    phone = await pair_phone(client, hub)
    u1, a1 = add_exchange(hub, "general", "first question", "first answer")
    u2, a2 = add_exchange(hub, "general", "second question", "second answer")
    revision = (await (await state(client, phone)).json())["revision"]
    response = await branch(client, phone, {
        "op_id": op(), "message_id": u2["id"], "expected_revision": revision, "mode": "edit",
        "text": "edited second question", "title": "Try another angle",
    })
    data = await response.json()
    assert response.status == 200, data
    assert data["chat"]["branch"]["parent_chat_id"] == "general"
    assert data["chat"]["branch"]["from_message_id"] == u2["id"]
    assert data["chat"]["title"] == "Try another angle"
    assert data["copies"] == 2
    branch_msgs = hub.store.all_messages(data["chat"]["id"])
    assert [m["text"] for m in branch_msgs] == ["first question", "first answer", "edited second question"]
    assert branch_msgs[0]["meta"]["branch_source_chat_id"] == "general"
    assert branch_msgs[0]["meta"]["branch_source_message_id"] == u1["id"]
    # the original conversation is untouched, including the turn that was not copied
    assert [m["text"] for m in hub.store.all_messages("general")] == [
        "first question", "first answer", "second question", "second answer"]
    assert hub.received == [(data["chat"]["id"], "edited second question", phone.id)]
    assert hub.branching.bridge.created[0]["prefix"][0]["content"] == "first question"
    assert hub.branching.bridge.created[0]["prefix"][-1]["role"] == "assistant"


async def test_duplicate_operation_id_returns_the_same_branch(client, hub):
    phone = await pair_phone(client, hub)
    u1, _ = add_exchange(hub, "general", "hello", "hi")
    revision = (await (await state(client, phone)).json())["revision"]
    body = {"op_id": op(), "message_id": u1["id"], "expected_revision": revision, "mode": "branch"}
    first = await (await branch(client, phone, body)).json()
    again = await branch(client, phone, body)
    data = await again.json()
    assert again.status == 200 and data["replayed"] is True
    assert data["chat"]["id"] == first["chat"]["id"]
    assert len([c for c in hub.store.list_chats() if c.get("branch")]) == 1


async def test_stale_revision_is_refused_without_creating_anything(client, hub):
    phone = await pair_phone(client, hub)
    u1, _ = add_exchange(hub, "general", "hello", "hi")
    revision = (await (await state(client, phone)).json())["revision"]
    hub.store.add_message("general", "user", "another message", meta={"client_id": "c-later"})
    response = await branch(client, phone, {
        "op_id": op(), "message_id": u1["id"], "expected_revision": revision, "mode": "branch"})
    data = await response.json()
    assert response.status == 409 and data["code"] == "stale"
    assert not [c for c in hub.store.list_chats() if c.get("branch")]


async def test_busy_chat_refuses_and_does_not_queue_work(client, hub):
    phone = await pair_phone(client, hub)
    u1, _ = add_exchange(hub, "general", "hello", "hi")
    revision = (await (await state(client, phone)).json())["revision"]
    hub._typing.add("general")
    response = await branch(client, phone, {
        "op_id": op(), "message_id": u1["id"], "expected_revision": revision, "mode": "branch"})
    data = await response.json()
    assert response.status == 409 and data["code"] == "busy"
    assert not [c for c in hub.store.list_chats() if c.get("branch")]


async def test_members_are_scoped_to_their_own_chat_and_bot(client, hub):
    owner = await pair_phone(client, hub, "Owner")
    member = await pair_phone(client, hub, "Member", role="member")
    hub.store.ensure_chat("members", "Members only", owner_device=member.id)
    hub.store.ensure_chat("other-bot", "Other bot", bot="other")
    assert (await state(client, member, "members")).status == 200
    assert (await state(client, member, "general")).status == 404
    assert (await state(client, member, "other-bot")).status == 404
    add_exchange(hub, "general", "hello", "hi")
    assert (await branch(client, member, {"op_id": op(), "message_id": "x", "expected_revision": "b-x",
                                          "mode": "branch"})).status == 404


async def test_attachment_is_copied_into_the_branch(client, hub, tmp_path):
    phone = await pair_phone(client, hub)
    upload_id = new_id()
    folder = Path(hub.media_dir) / upload_id
    folder.mkdir(parents=True)
    (folder / "photo.png").write_bytes(b"png-bytes")
    row = hub.store.add_upload(upload_id, phone.id, "general", "photo.png", "image/png", "image", 9)
    user, bot = add_exchange(hub, "general", "look at this", "nice", attachment=row)
    revision = (await (await state(client, phone)).json())["revision"]
    response = await branch(client, phone, {
        "op_id": op(), "message_id": user["id"], "expected_revision": revision, "mode": "edit", "text": "look again"})
    data = await response.json()
    assert response.status == 200, data
    branch_id = data["chat"]["id"]
    copied = hub.store.all_messages(branch_id)[-1]
    attachment = copied["meta"]["attachments"][0]
    assert attachment["id"] != upload_id
    assert (Path(hub.media_dir) / attachment["id"] / "photo.png").is_file()
    # the branch owns its upload; the original upload can't be claimed here
    assert hub.store.claim_uploads([upload_id], phone.id, branch_id, "m-x") is None


async def test_copied_prefix_attachment_stays_owned_by_its_copied_message(client, hub):
    phone = await pair_phone(client, hub)
    upload_id = new_id()
    folder = Path(hub.media_dir) / upload_id
    folder.mkdir(parents=True)
    (folder / "plan.png").write_bytes(b"png")
    row = hub.store.add_upload(upload_id, phone.id, "general", "plan.png", "image/png", "image", 3)
    u1, a1 = add_exchange(hub, "general", "here is my plan", "looks good", attachment=row)
    u2, _ = add_exchange(hub, "general", "next question", "next answer")
    revision = (await (await state(client, phone)).json())["revision"]
    data = await (await branch(client, phone, {"op_id": op(), "message_id": u2["id"],
                                               "expected_revision": revision, "mode": "branch"})).json()
    copied = hub.store.all_messages(data["chat"]["id"])[0]
    attachment_id = copied["meta"]["attachments"][0]["id"]
    owned = hub.store.get_upload(attachment_id)
    assert owned["message_id"] == copied["id"]
    assert owned["chat_id"] == data["chat"]["id"]


async def test_in_place_regeneration_only_latest_and_rewinds(client, hub):
    phone = await pair_phone(client, hub)
    u1, a1 = add_exchange(hub, "general", "first", "one")
    u2, a2 = add_exchange(hub, "general", "second", "two")
    revision = (await (await state(client, phone)).json())["revision"]
    older = await regenerate(client, phone, {"op_id": op(), "message_id": a1["id"],
                                            "expected_revision": revision})
    assert older.status == 409 and (await older.json())["code"] == "not_latest"
    revision = (await (await state(client, phone)).json())["revision"]
    response = await regenerate(client, phone, {"op_id": op(), "message_id": a2["id"],
                                               "expected_revision": revision})
    data = await response.json()
    assert response.status == 200, data
    assert hub.branching.bridge.rewinds == [("general", "second", 2)]
    texts = [m["text"] for m in hub.store.all_messages("general")]
    assert texts == ["first", "one", "second"]
    assert hub.received[-1][1] == "second"


async def test_branch_failure_leaves_no_partial_chat(client, hub):
    phone = await pair_phone(client, hub)
    u1, _ = add_exchange(hub, "general", "hello", "hi")
    revision = (await (await state(client, phone)).json())["revision"]
    hub.branching.bridge.fail_create = True
    response = await branch(client, phone, {
        "op_id": op(), "message_id": u1["id"], "expected_revision": revision, "mode": "branch"})
    assert response.status == 409
    assert (await response.json())["code"] == "unsupported"
    assert not [c for c in hub.store.list_chats() if c.get("branch")]
    assert [m["text"] for m in hub.store.all_messages("general")] == ["hello", "hi"]


async def test_history_reopens_with_the_copied_prefix(client, hub):
    phone = await pair_phone(client, hub)
    u1, a1 = add_exchange(hub, "general", "hello", "hi")
    u2, _ = add_exchange(hub, "general", "later", "later reply")
    revision = (await (await state(client, phone)).json())["revision"]
    data = await (await branch(client, phone, {"op_id": op(), "message_id": u1["id"],
                                               "expected_revision": revision, "mode": "branch"})).json()
    page = await (await client.get(f"/api/chats/{data['chat']['id']}/messages", headers=phone.auth)).json()
    assert [m["text"] for m in page["messages"]] == ["hello", "hi"]
    chats = await (await client.get("/api/chats", headers=phone.auth)).json()
    made = next(c for c in chats["chats"] if c["id"] == data["chat"]["id"])
    assert made["branch"]["parent_chat_id"] == "general"


async def test_branch_title_cannot_exceed_80_chars(client, hub):
    phone = await pair_phone(client, hub)
    u1, _ = add_exchange(hub, "general", "hello", "hi")
    revision = (await (await state(client, phone)).json())["revision"]
    data = await (await branch(client, phone, {"op_id": op(), "message_id": u1["id"],
                                               "expected_revision": revision, "mode": "branch",
                                               "title": "x" * 200})).json()
    assert len(data["chat"]["title"]) <= 80


async def test_regenerate_in_a_branch_creates_new_chat_and_keeps_original(client, hub):
    phone = await pair_phone(client, hub)
    u1, a1 = add_exchange(hub, "general", "hello", "hi")
    revision = (await (await state(client, phone)).json())["revision"]
    data = await (await branch(client, phone, {"op_id": op(), "message_id": a1["id"],
                                               "expected_revision": revision, "mode": "regenerate"})).json()
    assert data["mode"] == "regenerate" and data["copies"] == 0
    texts = [m["text"] for m in hub.store.all_messages(data["chat"]["id"])]
    assert texts == ["hello"]  # prompt re-sent into the new branch; no reply yet
    assert hub.received[-1] == (data["chat"]["id"], "hello", phone.id)
    assert [m["text"] for m in hub.store.all_messages("general")] == ["hello", "hi"]


async def test_hidden_and_activity_rows_are_not_copied_into_a_branch(client, hub):
    phone = await pair_phone(client, hub)
    u1, a1 = add_exchange(hub, "general", "hello", "hi")
    hub.store.add_message("general", "user", "/model", meta={"hidden": True})
    hub.store.add_message("general", "bot", "🔍 web_search: cats", meta={"activity": True})
    hub.store.add_message("general", "user", "next", meta={"client_id": "c-next"})
    revision = (await (await state(client, phone)).json())["revision"]
    data = await (await branch(client, phone, {"op_id": op(), "message_id": u1["id"],
                                               "expected_revision": revision, "mode": "branch"})).json()
    assert [m["text"] for m in hub.store.all_messages(data["chat"]["id"])] == ["hello", "hi"]


async def test_branch_routes_are_in_the_policy_table(client, hub):
    from plugin.hub import ROUTE_POLICY
    names = {getattr(route.handler, "__name__", "") for route in hub.build_app().router.routes()}
    assert {"h_branch_state", "h_branch_create", "h_branch_regenerate"} <= names
    for name in ("h_branch_state", "h_branch_create", "h_branch_regenerate"):
        assert name in ROUTE_POLICY


# -- real Hermes (CI's hermes job) --------------------------------------------------------------

hermes = pytest.mark.skipif(importlib.util.find_spec("hermes_state") is None
                            or importlib.util.find_spec("gateway") is None,
                            reason="needs Hermes Agent installed")


@hermes
def test_real_hermes_transcript_and_rewind(tmp_path, monkeypatch):
    """The pinned Hermes primitives this feature depends on: platform ids, active transcript,
    and the CAS rewind."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    (tmp_path / "home").mkdir()
    from gateway.config import GatewayConfig
    from gateway.session import SessionStore
    from hermes_state import SessionDB

    db = SessionDB(db_path=tmp_path / "state.db")
    store = SessionStore(sessions_dir=tmp_path / "sessions", config=GatewayConfig())
    store._db = db
    try:
        db.create_session("gw-branch", source="winglet")
        db.append_message("gw-branch", "user", "one", platform_message_id="winglet-u1")
        db.append_message("gw-branch", "assistant", "first")
        db.append_message("gw-branch", "user", "two", platform_message_id="winglet-u2")
        db.append_message("gw-branch", "assistant", "second")
        rows = store.load_transcript("gw-branch")
        assert [r.get("message_id") for r in rows if r["role"] == "user"] == ["winglet-u1", "winglet-u2"]
        from plugin.branching import plan_operation
        messages = [
            {"id": "winglet-u1", "role": "user", "text": "one", "status": "final", "meta": {}, "position": 1},
            {"id": "winglet-a1", "role": "bot", "text": "first", "status": "final", "meta": {}, "position": 2},
            {"id": "winglet-u2", "role": "user", "text": "two", "status": "final", "meta": {}, "position": 3},
            {"id": "winglet-a2", "role": "bot", "text": "second", "status": "final", "meta": {}, "position": 4},
        ]
        plan = plan_operation(messages, rows, "winglet-a2", "regenerate")
        assert [r["content"] for r in plan.transcript_prefix] == ["one", "first"]
        # a seeded child session really gets the prefix rows
        db.create_session("gw-branch-child", source="winglet", parent_session_id="gw-branch",
                          model_config={"_branched_from": "gw-branch"})
        db.append_messages_batch("gw-branch-child", [
            {k: r.get(k) for k in ("role", "content", "tool_calls", "tool_call_id", "timestamp")}
            for r in plan.transcript_prefix])
        child = store.load_transcript("gw-branch-child")
        assert [r["content"] for r in child] == ["one", "first"]
        # in-place rewind removes only the latest user turn and is compare-and-swapped
        result = store.rewind_session("gw-branch", 1)
        assert result and result["target_text"] == "two"
        assert [r["content"] for r in store.load_transcript("gw-branch")] == ["one", "first"]
    finally:
        db.close()


@hermes
async def test_real_hermes_bridge_seeds_and_routes_a_branch(tmp_path, monkeypatch):
    """The actual bridge: a new Winglet chat gets a real seeded Hermes session, routed to its
    own session key, while the parent transcript is untouched."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    (tmp_path / "home").mkdir()
    from gateway.config import GatewayConfig
    from gateway.platforms.base import Platform, SessionSource
    from gateway.session import AsyncSessionStore, SessionStore
    from hermes_state import SessionDB

    db = SessionDB(db_path=tmp_path / "state.db")
    store = SessionStore(sessions_dir=tmp_path / "sessions", config=GatewayConfig())
    store._db = db
    try:
        db.create_session("parent", source="telegram")
        db.append_message("parent", "user", "one", platform_message_id="u1")
        db.append_message("parent", "assistant", "first")
        db.append_message("parent", "user", "two", platform_message_id="u2")
        db.append_message("parent", "assistant", "second")
        parent_key = "agent:main:telegram:dm:parent"
        store.peek_session_id = lambda key: "parent" if key == parent_key else None

        class Runner:
            session_store = store
            async_session_store = AsyncSessionStore(store)
            def _evict_cached_agent(self, key):
                pass

        runner = Runner()

        class Adapter:
            gateway_runner = runner
            def build_source(self, **kw):
                return SessionSource(platform=Platform.TELEGRAM, chat_id=kw["chat_id"], chat_type="dm",
                                     user_id=kw["user_id"])
            def _session_key(self, chat_id):
                return f"agent:main:telegram:dm:{chat_id}"
            def _chat_model(self, chat_id):
                return None

        bridge = HermesBranchBridge(Adapter())
        assert bridge.available() is True
        snap = await bridge.snapshot("parent")
        assert [r["content"] for r in snap.rows] == ["one", "first", "two", "second"]
        new_sid = await bridge.create_branch_session(
            {"id": "child", "title": "Child", "bot": None}, {"id": "dev", "name": "Phone"}, "Child",
            snap, snap.rows[:2])
        assert [r["content"] for r in store.load_transcript(new_sid)] == ["one", "first"]
        assert store._entries["agent:main:telegram:dm:child"].session_id == new_sid
        child_row = db.get_session(new_sid)
        assert child_row["parent_session_id"] == "parent"
        assert [r["content"] for r in store.load_transcript("parent")] == ["one", "first", "two", "second"]
    finally:
        db.close()
