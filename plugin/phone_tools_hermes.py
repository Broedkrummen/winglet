"""Narrow Hermes plugin tools; context is never accepted from tool arguments."""
import asyncio
import concurrent.futures
import json
import time

_REGISTERED = False


def binding():
    from . import adapter
    from gateway.session_context import get_session_env
    active = adapter._ACTIVE
    if active is None or active._hub is None or active._loop is None or active._hub.phone_tools is None:
        return None
    if get_session_env("HERMES_SESSION_PLATFORM") != "winglet":
        return None
    user, chat = get_session_env("HERMES_SESSION_USER_ID"), get_session_env("HERMES_SESSION_CHAT_ID")
    if not user or not user.startswith("winglet:") or not chat:
        return None
    profile = get_session_env("HERMES_SESSION_PROFILE") or ""
    main = adapter.profile_info()["name"]
    bot = "" if profile in ("", main, "default") else profile
    return active, user[len("winglet:"):], chat, bot


def available(tool):
    try:
        bound = binding()
        if not bound:
            return False
        active, device, chat, bot = bound
        row = active._hub.store.get_chat(chat)
        d = active._hub.store.get_device(device)
        grant = active._hub.phone_tools.grant(device, tool, bot)
        return bool(row and d and d.get("platform") == "android" and active._hub.can_see(d, row) and (row.get("bot") or "") == bot and grant and (grant["scope"] != "*" or d["role"] == "owner"))
    except (ImportError, AttributeError):
        return False


def invoke(tool, args, **kwargs):
    try:
        bound = binding()
        if not bound:
            return json.dumps({"error": "Phone tools require the originating Winglet chat and paired phone."})
        active, device, chat, bot = bound
        try:
            if asyncio.get_running_loop() is active._loop:
                return json.dumps({"error": "Phone tools must run in the Hermes tool worker."})
        except RuntimeError:
            pass
        future = asyncio.run_coroutine_threadsafe(active._hub.phone_tools.request(device, chat, bot, tool, args), active._loop)
        from tools.interrupt import is_interrupted
        deadline = time.monotonic() + 125
        while True:
            if is_interrupted() or bool(getattr(kwargs.get("parent_agent"), "is_interrupted", False)):
                future.cancel()
                return json.dumps({"error": "cancelled"})
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                future.cancel()
                return json.dumps({"error": "expired"})
            try:
                return json.dumps(future.result(timeout=min(.1, remaining)), ensure_ascii=False)
            except concurrent.futures.TimeoutError:
                continue
    except concurrent.futures.CancelledError:
        return json.dumps({"error": "cancelled"})
    except (ValueError, ImportError, AttributeError):
        return json.dumps({"error": "Invalid or unavailable phone tool"})


def register(ctx):
    global _REGISTERED
    if not callable(getattr(ctx, "register_tool", None)):
        return
    try:
        from tools.registry import no_cache_check_fn
    except ImportError:
        return  # This Hermes cannot safely vary discovery by originating phone.
    from .phone_tools import CATALOG
    schemas = {"phone_contacts": {"query": {"type": "string", "minLength": 2, "maxLength": 80}}, "phone_location": {"precise": {"type": "boolean", "description": "Always requires an explicit phone decision; approximate by default."}}, "phone_calendar": {"start_ms": {"type": "integer"}, "end_ms": {"type": "integer"}}}
    for tool, item in CATALOG.items():
        properties = schemas.get(tool, {})
        params = {"type": "object", "properties": properties, "additionalProperties": False}
        if tool in ("phone_contacts", "phone_calendar"):
            params["required"] = list(properties)
        ctx.register_tool(name=tool, toolset="phone_tools", schema={"name": tool, "description": item["description"] + " Returns only: " + item["fields"] + ". Uses this chat sender's single paired Android phone, only while open and unlocked. Calendar times are UTC milliseconds.", "parameters": params}, handler=lambda args, _tool=tool, **kw: invoke(_tool,args,**kw), check_fn=no_cache_check_fn(lambda _tool=tool: available(_tool)), description=item["title"])
    _REGISTERED = True
