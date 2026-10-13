"""Teamwork: every bot can ask the others, and make a new one with the owner's OK.

Hermes Desktop's Bot Mode gives a bot its teammates only in its one "Bot Chat" session. These tools give
them to every Winglet chat, delivering the same way Bot Mode does: one turn in the teammate's "Bot Chat"
(``hermes -p <bot> chat -c "Bot Chat"``), signed "Message from 🤖 <name>" for the teammate to read and
authored by the sending bot for Hermes (its memory keeps bot-to-bot turns apart from the human's), so the
teammate keeps that conversation in the same place whichever app started it. Making a bot always waits for an
owner's approval.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import subprocess
import tempfile
from typing import Any, Callable, Dict, List, Optional

from . import hermes_api

logger = logging.getLogger(__name__)

TOOLSET = "bots"
ASK_TIMEOUT_SECONDS = 600
MESSAGE_MAX_CHARS = 8000
MAIN_ALIASES = ("default", "hermes", "main")

# Called (from a worker thread) after a bot is made, so phones hear about it at once.
on_bots_changed: Optional[Callable[[], None]] = None


def _me() -> str:
    """The profile this turn runs as ("default" for the main one)."""
    from hermes_constants import get_hermes_home
    home = get_hermes_home()
    return home.name if home.parent.name == "profiles" else "default"


def _roster() -> List[Dict[str, str]]:
    """Every bot on this server, the main one first."""
    from hermes_cli.profiles import _get_default_hermes_home, read_profile_meta
    meta = read_profile_meta(_get_default_hermes_home())
    main = {"name": "default", "title": meta.get("display_name") or meta.get("bot_title") or "Hermes",
            "description": meta.get("description") or "The main bot"}
    return [main] + [{k: b[k] for k in ("name", "title", "description")} for b in hermes_api.list_bots()]


def _resolve(target: str, roster: List[Dict[str, str]]) -> Optional[Dict[str, str]]:
    want = target.strip().lstrip("@").lower()
    if want in MAIN_ALIASES:
        return roster[0]
    return next((b for b in roster if want in (b["name"].lower(), b["title"].lower())), None)


def _error(message: str, **extra: Any) -> str:
    return json.dumps({"error": message, **extra})


def _handle(profile: str) -> str:
    return "hermes" if profile == "default" else profile


def _author(sender: str) -> Dict[str, Any]:
    """The turn's author as Bot Mode sets it for a teammate on the same install."""
    return {"id": f"bot:{sender}", "name": _handle(sender), "is_bot": True}


def can_deliver() -> bool:
    """This Hermes delivers to a teammate the way Bot Mode does, with the sending bot as the turn's author."""
    try:
        from tools.bot_relay import delivery_env, local_delivery_command  # noqa: F401
    except Exception:
        return False
    return True


def _child_env(profile: str, sender: str) -> Dict[str, str]:
    """Hermes's own environment for a delivery turn: the target profile's (never this one's secrets or
    session), with the sending bot as its author."""
    from hermes_cli.profiles import get_profile_dir
    from tools.bot_relay import delivery_env
    return delivery_env(_author(sender), get_profile_dir(profile))


def _turn_lock(profile: str):
    """Hermes's own lock on a profile's Bot Chat turn, so two messages never run at once there."""
    try:
        from tools.bot_mode_probe import _hermes_root
        from tools.bot_relay import acquire_turn_lock
        from hermes_cli.profiles import _get_default_hermes_home
        return acquire_turn_lock(_hermes_root(_get_default_hermes_home()), profile)
    except Exception:
        return contextlib.nullcontext()


def _deliver(profile: str, content: str, sender: str) -> subprocess.CompletedProcess:
    from tools.bot_relay import local_delivery_command
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as fh:
        fh.write(content)
        path = fh.name
    try:
        with _turn_lock(profile):
            return subprocess.run(local_delivery_command(profile, path), stdin=subprocess.DEVNULL, capture_output=True,
                                  text=True, timeout=ASK_TIMEOUT_SECONDS, env=_child_env(profile, sender))
    finally:
        with contextlib.suppress(OSError):
            os.unlink(path)


def ask_bot(args: dict, **_: Any) -> str:
    """Ask another bot on this server, and get its answer."""
    try:
        roster = _roster()
        me = _me()
    except Exception as exc:
        return _error(f"Couldn't list the bots on this server: {exc}")
    target = str(args.get("bot") or "").strip()
    message = str(args.get("message") or "").strip()
    others = [b for b in roster if b["name"] != me]
    if not target:
        return json.dumps({"bots": others})
    bot = _resolve(target, roster)
    if bot is None:
        return _error(f"There's no bot called {target!r} on this server.", bots=others)
    if bot["name"] == me:
        return _error("That's you. Pick another bot.", bots=others)
    if not message:
        return _error("Say what you want from that bot in `message`.")
    if len(message) > MESSAGE_MAX_CHARS:
        return _error(f"That message is too long ({len(message)} characters, at most {MESSAGE_MAX_CHARS}).")
    sender = next((b for b in roster if b["name"] == me), {"title": me})
    content = f"Message from 🤖 {sender['title']} (@{_handle(me)}): {message}"
    try:
        done = _deliver(bot["name"], content, me)
    except subprocess.TimeoutExpired:
        return _error(f"{bot['title']} didn't answer within {ASK_TIMEOUT_SECONDS // 60} minutes.")
    except Exception as exc:
        logger.warning("[winglet] asking %s failed", bot["name"], exc_info=True)
        return _error(f"Couldn't reach {bot['title']}: {exc}")
    reply = (done.stdout or "").strip()
    if done.returncode != 0 or not reply:
        detail = (done.stderr or done.stdout or "").strip()[-600:]
        return _error(f"{bot['title']} couldn't answer.", detail=detail)
    return json.dumps({"bot": bot["title"], "reply": reply})


def make_bot(args: dict, **_: Any) -> str:
    """Make a new bot on this server, the way Hermes Desktop does (after the owner approved it)."""
    from .hub import _BOT_NAME
    title = str(args.get("title") or "").strip()[:60]
    purpose = str(args.get("purpose") or "").strip()
    name = str(args.get("name") or "").strip().lower() or "-".join(
        "".join(c if c.isalnum() else " " for c in title.lower()).split())[:40]
    if not title:
        return _error("Give the bot a name in `title`.")
    if not _BOT_NAME.fullmatch(name) or name in MAIN_ALIASES:
        return _error("Give it a short name: lowercase letters, numbers and dashes.")
    try:
        bot = hermes_api.create_bot(name, title, f"You are {title}.{f' {purpose}' if purpose else ''}", purpose[:300])
    except hermes_api.HermesRefused as exc:
        return _error(str(exc))
    if on_bots_changed is not None:
        with contextlib.suppress(Exception):
            on_bots_changed()
    return json.dumps({"made": bot, "note": "It shows up in the Winglet app. If Hermes isn't serving every profile yet, "
                                            "the server needs one restart before it can answer."})


def approve_making_bots(tool_name: str = "", args: Optional[dict] = None, **_: Any) -> Optional[dict]:
    """Making a bot copies provider keys into a new profile: the owner approves each one, like a risky command."""
    if tool_name != "make_bot":
        return None
    title = str((args or {}).get("title") or "a new bot").strip()
    return {"action": "approve", "message": f"Make a new bot, {title}, with your provider keys and model?"}


ASK_SCHEMA = {
    "name": "ask_bot",
    "description": (
        "Ask one of your teammates, the other bots on this Hermes server (each is its own agent with its own "
        "persona, memory and skills), to do something or answer a question, and get its reply. Use it when the "
        "user says 'ask <bot>' or 'tell <bot>', or when a teammate is better placed. Compose the message "
        "yourself and say what you need; don't forward private chat content. Call with an empty `bot` to list "
        "the bots and what each is for. Relay the answer to the user, saying which bot replied."),
    "parameters": {"type": "object", "properties": {
        "bot": {"type": "string", "description": "The bot's name ('hermes' for the main bot), or empty to list them."},
        "message": {"type": "string", "description": "What you want from that bot."},
    }, "required": ["bot"]},
}

MAKE_SCHEMA = {
    "name": "make_bot",
    "description": (
        "Make a new bot on this Hermes server for a job the user describes: a new agent with its own persona, "
        "memory, skills and chats, set up like Hermes Desktop's Create bot (your provider keys and model). The "
        "user approves it before it's made. Use it only when the user asks for a new bot."),
    "parameters": {"type": "object", "properties": {
        "title": {"type": "string", "description": "What the bot is called, e.g. 'Chef'."},
        "purpose": {"type": "string", "description": "What it's for, in a sentence or two; this becomes its persona."},
        "name": {"type": "string", "description": "Optional short name (lowercase, dashes); made from the title if left out."},
    }, "required": ["title", "purpose"]},
}


def register(ctx) -> None:
    """Add the tools to Hermes (a "bots" toolset, on by default like other plugin toolsets) and the approval
    gate for making bots. Never fatal: without it, bots still work, they just don't call each other."""
    available = hermes_api.bots_available
    try:
        ctx.register_tool(name="ask_bot", toolset=TOOLSET, schema=ASK_SCHEMA, handler=ask_bot,
                          check_fn=lambda: available() and can_deliver(),
                          description="Ask another bot on this server", emoji="🤝")
        ctx.register_tool(name="make_bot", toolset=TOOLSET, schema=MAKE_SCHEMA, handler=make_bot, check_fn=available,
                          description="Make a new bot on this server", emoji="🐣")
        ctx.register_hook("pre_tool_call", approve_making_bots)
    except Exception:
        logger.warning("[winglet] couldn't add the bot teamwork tools", exc_info=True)
