"""Bots ask each other, and make new ones with the owner's approval (plugin/teamwork.py)."""

import importlib.util
import json
import subprocess
from types import SimpleNamespace

import pytest

from plugin import teamwork

ROSTER = [{"name": "default", "title": "Hermes", "description": "The main bot"},
          {"name": "chef", "title": "Chef", "description": "Plans meals"},
          {"name": "scout", "title": "Scout", "description": "Finds things"}]


@pytest.fixture
def team(monkeypatch):
    sent = []
    state = SimpleNamespace(me="default", result=subprocess.CompletedProcess([], 0, stdout="Pasta on Tuesday.\n", stderr=""),
                            sent=sent)
    monkeypatch.setattr(teamwork, "_roster", lambda: [dict(b) for b in ROSTER])
    monkeypatch.setattr(teamwork, "_me", lambda: state.me)

    def deliver(profile, content):
        sent.append((profile, content))
        if isinstance(state.result, Exception):
            raise state.result
        return state.result
    monkeypatch.setattr(teamwork, "_deliver", deliver)
    return state


def test_asking_a_teammate_returns_its_answer(team):
    listing = json.loads(teamwork.ask_bot({"bot": ""}))
    assert [b["name"] for b in listing["bots"]] == ["chef", "scout"]  # never itself
    reply = json.loads(teamwork.ask_bot({"bot": "Chef", "message": "What's for dinner this week?"}))
    assert reply == {"bot": "Chef", "reply": "Pasta on Tuesday."}
    # Signed the way Hermes's Bot Mode signs a teammate's message, into the teammate's own profile.
    assert team.sent == [("chef", "Message from 🤖 Hermes (@hermes): What's for dinner this week?")]


def test_a_teammate_can_ask_the_main_bot(team):
    team.me = "chef"
    json.loads(teamwork.ask_bot({"bot": "@hermes", "message": "Is Tuesday free?"}))
    assert team.sent[-1] == ("default", "Message from 🤖 Chef (@chef): Is Tuesday free?")
    assert "That's you" in json.loads(teamwork.ask_bot({"bot": "chef", "message": "hi"}))["error"]


def test_asking_goes_wrong_in_plain_words(team):
    assert "no bot called" in json.loads(teamwork.ask_bot({"bot": "ghost", "message": "hi"}))["error"]
    assert "message" in json.loads(teamwork.ask_bot({"bot": "chef"}))["error"]
    assert "too long" in json.loads(teamwork.ask_bot({"bot": "chef", "message": "x" * 9000}))["error"]
    team.result = subprocess.CompletedProcess([], 1, stdout="", stderr="No inference provider configured")
    failed = json.loads(teamwork.ask_bot({"bot": "chef", "message": "hi"}))
    assert failed["error"] == "Chef couldn't answer." and "No inference provider" in failed["detail"]
    team.result = subprocess.TimeoutExpired("hermes", 600)
    assert "didn't answer within 10 minutes" in json.loads(teamwork.ask_bot({"bot": "chef", "message": "hi"}))["error"]


def test_making_a_bot_needs_the_owners_ok(monkeypatch):
    made, changed = [], []
    monkeypatch.setattr(teamwork.hermes_api, "create_bot",
                        lambda name, title, persona, description="": made.append((name, title, persona)) or
                        {"name": name, "title": title, "description": description})
    monkeypatch.setattr(teamwork, "on_bots_changed", lambda: changed.append(True))
    assert teamwork.approve_making_bots(tool_name="make_bot", args={"title": "Chef"}) == {
        "action": "approve", "message": "Make a new bot, Chef, with your provider keys and model?"}
    assert teamwork.approve_making_bots(tool_name="ask_bot", args={}) is None
    out = json.loads(teamwork.make_bot({"title": "Meal Planner", "purpose": "Plans the week's meals."}))
    assert out["made"]["name"] == "meal-planner" and changed == [True]
    assert made == [("meal-planner", "Meal Planner", "You are Meal Planner. Plans the week's meals.")]
    assert "short name" in json.loads(teamwork.make_bot({"title": "X", "name": "Not OK", "purpose": ""}))["error"]
    assert "short name" in json.loads(teamwork.make_bot({"title": "Main", "name": "default", "purpose": ""}))["error"]
    assert "title" in json.loads(teamwork.make_bot({"purpose": "x"}))["error"]


def test_the_tools_and_the_approval_gate_are_registered():
    tools, hooks = [], []
    ctx = SimpleNamespace(register_tool=lambda **kw: tools.append(kw), register_hook=lambda name, fn: hooks.append((name, fn)))
    teamwork.register(ctx)
    assert [t["name"] for t in tools] == ["ask_bot", "make_bot"] and {t["toolset"] for t in tools} == {"bots"}
    assert hooks == [("pre_tool_call", teamwork.approve_making_bots)]
    teamwork.register(SimpleNamespace())  # a Hermes without plugin tools: never fatal


needs_hermes = pytest.mark.skipif(importlib.util.find_spec("tui_gateway") is None, reason="needs Hermes Agent installed")


@needs_hermes
def test_the_roster_and_delivery_come_from_hermes(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-main")  # the main bot's key, loaded into the gateway's environment
    (home / "config.yaml").write_text("model:\n  provider: anthropic\n  default: claude-x\n")
    (home / ".env").write_text("ANTHROPIC_API_KEY=sk-main\n")
    from plugin import hermes_api
    hermes_api.create_bot("chef", "Chef", "You are Chef.", "Plans meals")
    assert [b["name"] for b in teamwork._roster()] == ["default", "chef"] and teamwork._me() == "default"
    from tools.bot_relay import local_delivery_command
    argv = local_delivery_command("chef", "/tmp/q.txt")
    assert argv[1:4] == ["-p", "chef", "chat"] and "Bot Chat" in argv and argv[-2:] == ["--query-file", "/tmp/q.txt"]
    # The teammate's turn runs as its own profile and never inherits this one's secrets.
    env = teamwork._child_env("chef")
    assert env["HERMES_HOME"].endswith("profiles/chef") and "ANTHROPIC_API_KEY" not in env
