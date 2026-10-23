"""Structured execution activity: turns, tools, plans and subagents.

These tests drive the tracker the way Hermes's plugin hooks do (authoritative session/turn/tool/
subagent ids) and check the bounded snapshot plus the namespaced events the app consumes. The route
tests prove members cannot read another member's chat and that the capability stays off without a
tracker.
"""

from __future__ import annotations

import json

import pytest

from plugin import execution
from plugin.execution import Tracker
from plugin.hub import ROUTE_POLICY, Hub
from plugin.store import Store


class Clock:
    def __init__(self, value: float = 1_000.0):
        self.value = value

    def __call__(self) -> float:
        return self.value

    def tick(self, seconds: float = 1.0) -> None:
        self.value += seconds


def make_tracker(chats: dict | None = None):
    """A tracker whose session ids map to chats; unknown sessions belong to no Winglet chat."""
    mapping = chats or {"s1": {"chat_id": "general", "bot": None},
                        "s2": {"chat_id": "side", "bot": None},
                        "child": {"chat_id": "general", "bot": None}}
    published: list = []
    clock = Clock()
    tracker = Tracker(lambda sid: mapping.get(sid), publish=published.append, clock=clock,
                      resolve_key=lambda key: "general" if key == "winglet:general:dm" else None)
    return tracker, published, clock


def todos(*items, revision=1):
    return json.dumps({"todos": [
        {"id": str(i), "content": text, "status": status, **({"parent": parent} if parent else {})}
        for i, (text, status, parent) in enumerate(items)], "revision": revision})


# -- folding facts -----------------------------------------------------------------------------


def test_a_turn_keeps_its_plan_tools_and_outcome_structured():
    tracker, published, clock = make_tracker()
    tracker.turn_started("s1", "t1")
    clock.tick(2)
    tracker.plan_updated("s1", todos(("Read the logs", "completed", None), ("Summarise", "in_progress", None),
                                     revision=4), turn_id="t1")
    tracker.tool_started("s1", "terminal", "call-1", {"command": "journalctl -u hermes"}, turn_id="t1")
    clock.tick(3)
    tracker.tool_finished("s1", "terminal", "call-1", turn_id="t1", status="ok", duration_ms=2500)
    tracker.tool_finished("s1", "todo_list", "call-2", turn_id="t1", status="ok")
    clock.tick(1)
    tracker.turn_finished("s1", "t1")

    snap = tracker.snapshot("general")
    assert snap["state"] == "completed"
    assert snap["turn_id"] == "t1" and snap["task_id"] is None
    assert snap["plan"]["revision"] == 4 and snap["plan"]["live"] is True
    assert [item["status"] for item in snap["plan"]["items"]] == ["completed", "in_progress"]
    assert snap["counts"]["plan_done"] == 1 and snap["counts"]["plan_total"] == 2
    terminal = snap["tools"][0]
    assert terminal["name"] == "terminal" and terminal["status"] == "completed"
    assert terminal["preview"] == "journalctl -u hermes"
    assert terminal["duration_ms"] == 2500 and terminal["started_known"] is True
    assert snap["outcome"] == {"state": "completed", "summary": None}
    assert snap["started_at"] == 1_000.0 and snap["ended_at"] == 1_006.0
    # Events are namespaced, ordered, and carry the turn.
    kinds = [event["event"]["kind"] for event in published if event["type"] == execution.UPDATE_EVENT]
    assert kinds == ["plan.updated", "tool.started", "tool.finished", "tool.finished", "turn.finished"]
    seqs = [event["seq"] for event in published if event["type"] == execution.UPDATE_EVENT]
    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)
    assert all(event["turn_id"] == "t1" for event in published if event["type"] == execution.UPDATE_EVENT)


def test_a_new_turn_does_not_inherit_stale_subtasks_or_tools():
    tracker, _, _ = make_tracker()
    tracker.turn_started("s1", "t1")
    tracker.plan_updated("s1", todos(("Old plan", "completed", None), revision=3), turn_id="t1")
    tracker.subagent_started("s1", "c1", "sa1", goal="Old research", parent_turn_id="t1")
    tracker.tool_started("s1", "web_search", "old", {"query": "old"}, turn_id="t1")
    tracker.turn_started("s1", "t2")
    snap = tracker.snapshot("general")
    assert snap["turn_id"] == "t2" and snap["subagents"] == [] and snap["tools"] == []
    # The plan belongs to the conversation rather than the turn. It stays readable, but no longer live.
    assert snap["plan"]["revision"] == 3 and snap["plan"]["live"] is False
    assert snap["plan"]["items"][0]["content"] == "Old plan"
    # A late stop for the previous turn cannot attach itself to the new one.
    tracker.subagent_finished("s1", child_session_id="c1", status="completed", summary="stale", parent_turn_id="t1")
    tracker.tool_finished("s1", "web_search", "old", turn_id="t1", status="ok")
    assert tracker.snapshot("general")["subagents"] == []
    assert tracker.snapshot("general")["tools"] == []
    # A plan update in the new turn becomes live again without resurrecting the old todos.
    tracker.plan_updated("s1", todos(("New plan", "pending", None), revision=4), turn_id="t2")
    snap = tracker.snapshot("general")
    assert snap["plan"]["revision"] == 4 and snap["plan"]["live"] is True
    assert snap["plan"]["items"][0]["content"] == "New plan"


def test_nested_subagents_and_their_tool_activity():
    tracker, published, _ = make_tracker()
    tracker.turn_started("s1", "t1")
    tracker.subagent_started("s1", "c1", "sa1", goal="Parent research", role="orchestrator", parent_turn_id="t1")
    # A child of a child: Hermes names the parent subagent's session, not a gateway session.
    tracker.subagent_started("c1", "c2", "sa2", parent_subagent_id="sa1", goal="Nested lookup", parent_turn_id="t1")
    tracker.tool_started("c2", "read_file", "child-call", {"path": "/tmp/report"}, turn_id="t1")
    tracker.tool_finished("c2", "read_file", "child-call", turn_id="t1", status="ok")
    tracker.subagent_finished("c1", child_session_id="c2", status="completed", summary="Found it",
                              duration_ms=1200, tool_call_history=[
                                  {"tool_name": "read_file", "tool_input": "/tmp/report", "status": "ok"}])
    tracker.subagent_finished("s1", child_session_id="c1", status="failed", summary="Parent failed")

    snap = tracker.snapshot("general")
    by_id = {sub["id"]: sub for sub in snap["subagents"]}
    assert by_id["sa2"]["parent_id"] == "sa1"
    assert by_id["sa2"]["status"] == "completed" and by_id["sa2"]["summary"] == "Found it"
    assert by_id["sa2"]["duration_ms"] == 1200
    assert by_id["sa2"]["activity"][0]["name"] == "read_file"
    assert by_id["sa1"]["status"] == "failed"
    # The child's tool does not become a top-level tool of the parent turn.
    assert snap["tools"] == []
    assert any((event.get("event") or {}).get("kind") == "subagent.started" for event in published)


def test_completion_before_start_is_one_honest_row():
    tracker, _, _ = make_tracker()
    tracker.turn_started("s1", "t1")
    tracker.tool_finished("s1", "terminal", "call-9", turn_id="t1", status="error",
                          error_type="TimeoutError", error="timed out after 60s")
    tracker.tool_finished("s1", "terminal", "call-9", turn_id="t1", status="error",
                          error_type="TimeoutError", error="timed out after 60s")
    tools = tracker.snapshot("general")["tools"]
    assert len(tools) == 1
    assert tools[0]["started_known"] is False and tools[0]["started_at"] is None
    assert tools[0]["status"] == "failed" and "timed out" in tools[0]["error"]


def test_repeated_tool_events_do_not_multiply_rows():
    tracker, _, _ = make_tracker()
    tracker.turn_started("s1", "t1")
    for _ in range(3):
        tracker.tool_started("s1", "terminal", "call-1", {"command": "ls"}, turn_id="t1")
        tracker.tool_finished("s1", "terminal", "call-1", turn_id="t1", status="ok", duration_ms=10)
    assert len(tracker.snapshot("general")["tools"]) == 1


def test_the_first_terminal_fact_wins_over_a_later_completion():
    tracker, _, _ = make_tracker()
    tracker.turn_started("s1", "t1")
    tracker.subagent_started("s1", "c1", "sa1", goal="Work", parent_turn_id="t1")
    tracker.tool_started("s1", "terminal", "call-1", {"command": "sleep 99"}, turn_id="t1")
    tracker.loop_stopped("winglet:general:dm", reason="User pressed stop")
    # Hermes may still deliver a normal end after an interrupt: the turn stays cancelled.
    tracker.turn_finished("s1", "t1")
    snap = tracker.snapshot("general")
    assert snap["state"] == "cancelled" and snap["reason"] == "User pressed stop"
    # A child or tool that never reported is not silently successful, and not still running.
    assert snap["subagents"][0]["status"] == "unknown"
    assert snap["tools"][0]["status"] == "unknown" and snap["tools"][0]["ended_at"] is not None


def test_a_stale_plan_revision_cannot_replace_a_newer_one():
    tracker, _, _ = make_tracker()
    tracker.turn_started("s1", "t1")
    tracker.plan_updated("s1", todos(("B", "pending", None), revision=5), turn_id="t1")
    tracker.plan_updated("s1", todos(("A", "pending", None), revision=3), turn_id="t1")
    snap = tracker.snapshot("general")
    assert snap["plan"]["revision"] == 5 and snap["plan"]["items"][0]["content"] == "B"


def test_unknown_statuses_are_not_called_success():
    tracker, _, _ = make_tracker()
    tracker.turn_started("s1", "t1")
    tracker.subagent_started("s1", "c1", "sa1", goal="Work", parent_turn_id="t1")
    tracker.subagent_finished("s1", child_session_id="c1", status="", parent_turn_id="t1")
    tracker.tool_started("s1", "terminal", "call-1", turn_id="t1")
    tracker.tool_finished("s1", "terminal", "call-1", turn_id="t1")
    snap = tracker.snapshot("general")
    assert snap["subagents"][0]["status"] == "unknown"
    assert snap["tools"][0]["status"] == "unknown"


def test_sessions_outside_winglet_produce_nothing():
    tracker, published, _ = make_tracker()
    tracker.turn_started("telegram-user", "t1")
    tracker.tool_started("telegram-user", "terminal", "call-1", {"command": "secret"}, turn_id="t1")
    tracker.subagent_started("telegram-user", "c1", "sa1", goal="hidden")
    assert tracker.snapshot("general") is None and tracker.snapshot("side") is None
    assert published == []


def test_plans_and_payloads_are_bounded_and_redacted():
    tracker, _, _ = make_tracker()
    tracker.turn_started("s1", "t1")
    tracker.tool_started("s1", "terminal", "call-1",
                         {"command": "curl -H 'Authorization: Bearer abcdefghijkl' https://user:pass@example.test/x?api_key=SECRETVALUE"},
                         turn_id="t1")
    tracker.tool_finished("s1", "terminal", "call-1", turn_id="t1", status="error",
                          error="failed with sk-live1234567890 and token=abcdef123456")
    tracker.subagent_started("s1", "c1", "sa1", goal="x" * 2_000, parent_turn_id="t1")
    tracker.subagent_finished("s1", child_session_id="c1", status="completed", summary="y" * 2_000,
                              tool_call_history=[{"tool_name": "read_file", "tool_input": "z" * 500, "status": "ok"}],
                              parent_turn_id="t1")
    snap = tracker.snapshot("general")
    preview = snap["tools"][0]["preview"]
    assert "SECRETVALUE" not in preview and "abcdefghijkl" not in preview and "pass@" not in preview
    assert "sk-live" not in (snap["tools"][0]["error"] or "")
    assert "abcdef123456" not in (snap["tools"][0]["error"] or "")
    assert len(snap["subagents"][0]["goal"]) <= execution.MAX_GOAL
    assert len(snap["subagents"][0]["summary"]) <= execution.MAX_SUMMARY
    assert len(snap["subagents"][0]["activity"][0]["detail"]) <= execution.MAX_ACTIVITY_LINE


def test_lists_stay_bounded():
    tracker, _, _ = make_tracker()
    tracker.turn_started("s1", "t1")
    for i in range(execution.MAX_TOOLS + 7):
        tracker.tool_started("s1", "terminal", f"call-{i}", {"command": f"echo {i}"}, turn_id="t1")
    for i in range(execution.MAX_SUBAGENTS + 5):
        tracker.subagent_started("s1", f"c{i}", f"sa{i}", goal=f"task {i}", parent_turn_id="t1")
    snap = tracker.snapshot("general")
    assert len(snap["tools"]) == execution.MAX_TOOLS
    assert snap["tools"][-1]["preview"] == f"echo {execution.MAX_TOOLS + 6}"
    assert len(snap["subagents"]) == execution.MAX_SUBAGENTS


def test_capabilities_never_claim_a_per_subagent_stop():
    tracker, _, _ = make_tracker()
    assert tracker.capabilities() == {"subagent_stop": False}


def test_reset_drops_state_but_keeps_the_tracker_usable():
    tracker, published, _ = make_tracker()
    tracker.turn_started("s1", "t1")
    tracker.reset()
    assert tracker.snapshot("general") is None
    tracker.turn_started("s1", "t9")
    assert tracker.snapshot("general")["turn_id"] == "t9"


def test_register_hooks_accepts_the_observer_surface_and_reports_refusals():
    class Ctx:
        def __init__(self, allow=True):
            self.hooks = {}
            self.allow = allow

        def register_hook(self, name, callback):
            if not self.allow:
                raise RuntimeError("no hooks")
            self.hooks[name] = callback

    tracker, published, _ = make_tracker()
    ctx = Ctx()
    accepted = execution.register_hooks(ctx, tracker)
    assert set(accepted) == {"pre_llm_call", "post_llm_call", "pre_tool_call", "post_tool_call",
                             "subagent_start", "subagent_stop", "agent_loop_stopped"}
    assert all(accepted.values())
    # Drive a turn through the registered callbacks exactly as Hermes would.
    ctx.hooks["pre_llm_call"](session_id="s1", turn_id="t1", user_message="hi")
    ctx.hooks["pre_tool_call"](session_id="s1", tool_name="terminal", tool_call_id="c1",
                              args={"command": "pwd"}, turn_id="t1")
    ctx.hooks["post_tool_call"](session_id="s1", tool_name="terminal", tool_call_id="c1",
                                turn_id="t1", status="ok", duration_ms=5)
    ctx.hooks["post_llm_call"](session_id="s1", turn_id="t1")
    snap = tracker.snapshot("general")
    assert snap["state"] == "completed" and snap["tools"][0]["name"] == "terminal"
    assert execution.register_hooks(Ctx(allow=False), tracker) == {name: False for name in accepted}


# -- the HTTP route ----------------------------------------------------------------------------


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "data.db")
    yield s
    s.close()


@pytest.fixture
def hub(store, tmp_path):
    store.ensure_chat("general", "General")
    store.ensure_chat("side", "Side")
    return Hub(store, web_root=tmp_path / "web", bot_info=lambda: {"name": "hermes", "title": "Hermes"})


@pytest.fixture
async def client(aiohttp_client, hub):
    return await aiohttp_client(hub.build_app())


def _device_token(store, name="Pixel", role="owner"):
    device, token = store.add_device(name, "android", role=role, verified=True)
    return device, token


async def test_task_route_is_off_without_a_tracker(client, hub):
    _device, token = _device_token(hub.store)
    hub.execution = None
    data = await (await client.get("/api/task?chat=general", headers={"Authorization": f"Bearer {token}"})).json()
    assert data == {"available": False, "snapshot": None, "capabilities": {"subagent_stop": False}}
    info = await (await client.get("/api/info")).json()
    assert info["features"]["task_activity"] is False


async def test_task_route_serves_a_bounded_snapshot_to_a_paired_device(client, hub):
    tracker, _, _ = make_tracker()
    tracker.turn_started("s1", "t1")
    tracker.plan_updated("s1", todos(("One", "completed", None), revision=2), turn_id="t1")
    hub.execution = tracker
    device, token = _device_token(hub.store)
    info = await (await client.get("/api/info")).json()
    assert info["features"]["task_activity"] is True

    resp = await client.get("/api/task?chat=general", headers={"Authorization": f"Bearer {token}"})
    assert resp.status == 200
    data = await resp.json()
    assert data["available"] is True and data["snapshot"]["plan"]["revision"] == 2
    assert data["capabilities"] == {"subagent_stop": False}
    assert (await client.get("/api/task?chat=general")).status == 401


async def test_task_route_never_shows_another_members_chat(client, hub):
    first, first_token = _device_token(hub.store, "First", role="member")
    second, second_token = _device_token(hub.store, "Second", role="member")
    hub.store.ensure_chat("m-first", "First's chat", owner_device=first["id"])
    hub.store.ensure_chat("m-second", "Second's chat", owner_device=second["id"])
    tracker, _, _ = make_tracker({"ms1": {"chat_id": "m-first", "bot": None},
                                  "ms2": {"chat_id": "m-second", "bot": None}})
    tracker.turn_started("ms1", "t1")
    tracker.turn_started("ms2", "t1")
    hub.execution = tracker

    mine = await client.get("/api/task?chat=m-first", headers={"Authorization": f"Bearer {first_token}"})
    assert mine.status == 200 and (await mine.json())["snapshot"]["chat_id"] == "m-first"
    other = await client.get("/api/task?chat=m-second", headers={"Authorization": f"Bearer {first_token}"})
    assert other.status == 404
    _owner, owner_token = _device_token(hub.store, "Owner", role="owner")
    assert (await client.get("/api/task?chat=m-second", headers={"Authorization": f"Bearer {owner_token}"})).status == 200


def test_the_task_route_is_in_the_policy_table():
    assert ROUTE_POLICY["h_task"] == "device"
