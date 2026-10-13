"""Winglet hub: the HTTP/WebSocket server the app talks to, plus push delivery.

Independent of Hermes internals so it can be tested on its own. The platform adapter
(``adapter.py``) owns a Hub and plugs Hermes into it through a few callbacks.

Wire protocol (JSON over one WebSocket at ``/api/ws``; the app's first frame is
``{"type": "auth", "token"}`` so the token never sits in a URL; ``?token=`` still works for older apps):

server -> app  ``{"type": "hello" | "message.new" | "message.update" | "message.delete" | "typing" |
                  "chat.update" | "chat.delete" | "inbox.new" | "inbox.update" | "system.paused" |
                  "system.job" | "pong", ...}``
app -> server  ``{"type": "message.send", "chat_id", "text", "client_id"}``,
               ``{"type": "inbox.respond", "id", "choice" | "answer"}``, ``{"type": "ping"}``
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import hashlib
import hmac
import ipaddress
import json
import logging
import math
import mimetypes
import re
import os
import secrets
import shutil
import time
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional, Set
from urllib.parse import quote, unquote, urlsplit

from aiohttp import WSMsgType, web

from . import keys, recovery, uploads, webpush
from .store import ROLES, Store, new_id

logger = logging.getLogger(__name__)

VERSION = "0.2.0"
# Wire protocol: bumped only for breaking changes. The app compares these to its own and asks for
# whichever side is out of date to be updated.
PROTOCOL = 2
MIN_APP_PROTOCOL = 1
HOME_CHAT_ID = "home"
RESTART_DELAY_SECONDS = 0.8
UPDATE_TIMEOUT_SECONDS = 30 * 60
UPDATE_CHECK_SECONDS = 10 * 60
MAX_ROUTINE_PROMPT = 8000
# Installing a skill or an MCP server that has to download and build first.
ACTION_TIMEOUT_SECONDS = 15 * 60
ACTION_POLL_SECONDS = 1.5
# What a member may use when an owner limits their tools, until the owner picks.
MEMBER_TOOLSETS = ("web", "vision", "image_gen", "tts", "todo", "clarify")
_ABILITY_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_CALLBACK_BASE = re.compile(r"^https?://[^\s/?#@]+(/[^\s?#]*)?$")
SIGN_IN_PAGE = ("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>"
                "<meta name=color-scheme content='light dark'>"
                "<title>Winglet</title><body style='font:17px system-ui;margin:40px 24px;text-align:center'>"
                "<h2>{title}</h2><p>{body}</p>")
PUSH_DEBOUNCE_SECONDS = 2.5
MAX_TEXT = 16_000
PUSH_SUBJECT = "https://github.com/VIKASRP24/winglet"
PAIR_FAILURES_PER_MINUTE = 10
ALIVE_CACHE_SECONDS = 2.0
MAX_ATTACHMENTS = 10
UNSENT_UPLOAD_SECONDS = 24 * 3600
JANITOR_SECONDS = 3600
REPLY_EXCERPT = 280
# How long a model/choice/confirm picker stays answerable (Hermes's own slash confirmations time out
# after five minutes; the card says so when it's too late).
PICKER_SECONDS = 10 * 60
MAX_PERSONA = 20_000
_KEY_ENV = re.compile(r"^[A-Z][A-Z0-9_]{1,62}(_API_KEY|_KEY|_TOKEN)$")
VERIFY_FIRST = "Verify this device first: scan a new pairing code from your server or another owner's phone."
BAD_SIGNATURE = "The request's signature doesn't match this device."
# The bot (Hermes profile) a request or socket is about, from its `bot` query parameter. None is the main
# bot, the profile this gateway runs as. The parameter sits in the signed path, so it can't be swapped.
_BOT: contextvars.ContextVar = contextvars.ContextVar("winglet_hub_bot", default=None)
_BOT_NAME = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")
BOTS_CACHE_SECONDS = 10
_ANY_BOT = object()
BOTS_WATCH_SECONDS = 30
# petdex slugs, and the ones Hermes gives pets it hatches: one plain path segment.
_PET_SLUG = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,79}")
# Thumbnails of pets not installed yet mean a petdex download each; a few at a time.
PET_THUMB_FETCHES = 3
# Seconds the gallery waits for petdex before answering "still loading" (the app gives up at 10).
PET_CATALOG_WAIT = 8
# Idempotency keys of recent instant pet switches (a pet already installed starts no job to hold one).
PET_CHOICES_KEPT = 100
REPLY_CONTEXT = 4000
# Raster formats only: SVG is a document that can carry script.
INLINE_IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"}

InboundFn = Callable[..., Awaitable[None]]
ResolveFn = Callable[[Dict[str, Any], Any], Awaitable[bool]]


class MessageRejected(ValueError):
    """A message the server won't accept (bad attachments, reply to a missing message, ...)."""


class Forbidden(PermissionError):
    """The device is paired but its role doesn't allow this."""


# Who may call each route; the policy middleware enforces it before any handler runs, and a test checks
# that every route is listed. A route missing from the table needs an owner's signed request.
#   public        no token; the handler checks anything it needs itself
#   device        any paired device (handlers still limit members to their own chats)
#   owner         an owner device
#   signed        any verified device, with a signed request
#   owner_signed  an owner's verified device, with a signed request: every control action
ROUTE_POLICY = {
    "h_info": "public", "h_pair": "public", "h_ws": "public", "h_static": "public", "h_media": "public",
    "h_vapid": "public", "h_inbox_respond": "public", "h_server_key": "public", "h_address_check": "public",
    "h_me": "device", "h_connection": "device", "h_connection_status": "device", "h_unpair": "device", "h_chats": "device",
    "h_chat_create": "device", "h_chat_rename": "device", "h_chat_delete": "device", "h_messages": "device",
    "h_message_send": "device", "h_upload": "device", "h_export": "device", "h_commands": "device",
    "h_push_prefs": "device", "h_push_prefs_put": "device", "h_inbox": "device", "h_webpush_subscribe": "device",
    "h_webpush_unsubscribe": "device", "h_ntfy": "device", "h_push_test": "device", "h_device_verify": "device",
    "h_devices": "owner", "h_audit": "owner",
    "h_agent": "device", "h_picker_select": "owner",
    "h_chat_goal": "device", "h_goals": "device", "h_search": "device", "h_chat_files": "device",
    "h_models": "owner", "h_providers": "owner", "h_identity": "owner", "h_memory": "owner", "h_usage": "owner",
    "h_model_default": "owner_signed", "h_provider_key": "owner_signed", "h_provider_key_delete": "owner_signed",
    "h_identity_put": "owner_signed", "h_memory_edit": "owner_signed",
    "h_bots": "owner", "h_bot_create": "owner_signed",
    "h_pet": "device", "h_pet_sheet": "public", "h_pet_thumb": "public", "h_pets": "owner", "h_pet_catalog": "owner",
    "h_pet_display": "owner_signed", "h_pet_adopt": "owner_signed", "h_pet_remove": "owner_signed",
    "h_system": "owner", "h_system_updates": "owner", "h_jobs": "owner", "h_job": "owner", "h_logs": "owner",
    "h_schedule": "owner", "h_schedule_parse": "owner",
    "h_pause": "owner_signed", "h_restart": "owner_signed", "h_update": "owner_signed",
    "h_routine_create": "owner_signed", "h_routine_edit": "owner_signed", "h_routine_delete": "owner_signed",
    "h_routine_action": "owner_signed",
    "h_sessions": "owner", "h_session_search": "owner", "h_session": "owner",
    "h_skills": "owner", "h_skill_catalog": "owner", "h_skill_content": "owner", "h_toolsets": "owner",
    "h_mcp": "owner", "h_mcp_catalog": "owner", "h_mcp_sign_in_status": "owner", "h_mcp_callback": "public",
    "h_skill_toggle": "owner_signed", "h_skill_install": "owner_signed", "h_skill_uninstall": "owner_signed",
    "h_toolset_toggle": "owner_signed", "h_approvals": "owner_signed", "h_member_tools": "owner_signed",
    "h_mcp_install": "owner_signed", "h_mcp_toggle": "owner_signed", "h_mcp_remove": "owner_signed",
    "h_mcp_test": "owner_signed", "h_mcp_reload": "owner_signed", "h_mcp_sign_in": "owner_signed",
    "h_mcp_sign_in_cancel": "owner_signed",
    "h_rotate_token": "signed",
    "h_device_update": "owner_signed", "h_device_delete": "owner_signed", "h_pairing_code": "owner_signed",
}

# Slash commands a member may send: their own conversation and turn, and read-only help. Everything
# else, including unknown and future commands and skills, is for owners. Names are Hermes's canonical
# command names; aliases resolve to them.
MEMBER_COMMANDS = frozenset({"new", "retry", "undo", "title", "stop", "queue", "steer", "btw", "background",
                             "status", "help"})


def _env_mb(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name) or default)) * 1024 * 1024
    except ValueError:
        return default * 1024 * 1024


def _json(data: Any, status: int = 200) -> web.Response:
    return web.json_response(data, status=status, dumps=lambda o: json.dumps(o, separators=(",", ":")))


def _error(status: int, message: str) -> web.Response:
    return _json({"error": message}, status=status)


def _iso_ts(value: Any) -> float:
    """Seconds since the epoch for an ISO timestamp, or 0 when there isn't a readable one."""
    from datetime import datetime
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return 0.0


def _snippet(text: str, query: str, before: int = 50, after: int = 110) -> str:
    """The part of a message around the first match (the whole query, else its earliest word), on one
    line, with … where it was cut."""
    flat = " ".join((text or "").split())
    lower, q = flat.lower(), query.lower()
    at, size = lower.find(q), len(q)
    if at < 0:
        at, size = min(((lower.find(w), len(w)) for w in q.split() if w in lower), default=(-1, 0))
    if at < 0:
        return _clip(flat, before + after)
    start, end = max(0, at - before), min(len(flat), at + size + after)
    if start:
        space = flat.find(" ", start, at)
        start = space + 1 if space != -1 else start
    return ("…" if start else "") + flat[start:end] + ("…" if end < len(flat) else "")


def _clip(text: str, n: int) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= n else text[: n - 1] + "…"


class Hub:
    def __init__(self, store: Store, *, web_root: Optional[Path] = None,
                 bot_info: Optional[Callable[[], Dict[str, Any]]] = None,
                 ntfy_server: str = "https://ntfy.sh", http_client: Any = None,
                 media_dir: Optional[Path] = None):
        self.store = store
        self.web_root = web_root
        self.media_dir = media_dir or Path(store.path).parent / "media"
        self._bot_info = bot_info or (lambda: {"name": "Hermes", "title": "Hermes", "description": ""})
        self.ntfy_server = (ntfy_server or "https://ntfy.sh").rstrip("/")
        self._http = http_client
        self._sockets: Dict[web.WebSocketResponse, Dict[str, Any]] = {}
        self._push_tasks: Dict[str, asyncio.Task] = {}
        self._typing: Set[str] = set()
        self._pair_failures: Dict[str, List[float]] = {}
        self._alive_cache: Dict[str, tuple] = {}
        self.connection = {"mode": "direct", "url": None}
        # Set by the adapter for the Connection screen: the automatic tunnel (its .status), the address
        # phones were told to use on a direct connection, and where the hub listens.
        self.tunnel: Any = None
        self.public_url: Optional[str] = None
        self.listen = ""
        # The latest delivery to each push or address-recovery subscription, since this start: {at, ok}.
        self._delivered: Dict[str, Dict[str, Any]] = {}
        # cloudflared overrides Host with this private marker on origin requests. Never expose
        # it in /api/info: client-IP headers from ordinary/direct callers are untrusted.
        self.tunnel_host = "winglet-" + secrets.token_hex(24) + ".invalid"
        self._recovery_task = None
        self._recovery_due = {}
        self._recovery_wake = asyncio.Event()
        self._recovery_lock = asyncio.Lock()
        self._janitor: Optional[asyncio.Task] = None
        self._bots_watch: Optional[asyncio.Task] = None
        # Upload limits: one file, one device per day, and everything stored. Overridable in .env.
        self.max_upload_bytes = _env_mb("WINGLET_MAX_UPLOAD_MB", 50)
        self.device_daily_upload_bytes = _env_mb("WINGLET_DAILY_UPLOAD_MB", 500)
        self.total_upload_bytes = _env_mb("WINGLET_UPLOAD_STORAGE_MB", 4096)
        # Optional providers installed by the adapter (the hub never imports Hermes).
        self.commands_provider: Optional[Callable[[], List[Dict[str, Any]]]] = None
        # Resolves a typed command or alias to Hermes's canonical name ("" when unknown).
        self.command_resolver: Optional[Callable[[str], Optional[str]]] = None
        self.keys = keys.ServerKeys(store)
        # Hermes functions for model, providers, persona, memory and usage (plugin/hermes_api.py),
        # installed by the adapter; None turns those features off.
        self.hermes: Any = None
        # chat id -> the model that chat is really using, when Hermes knows (installed by the adapter).
        self.chat_model: Optional[Callable[[str], Optional[Dict[str, Any]]]] = None
        # chat id -> the standing goal (/goal) its Hermes session is working on (installed by the adapter).
        self.chat_goal: Optional[Callable[[str], Optional[Dict[str, Any]]]] = None
        self._pickers: Dict[str, Dict[str, Any]] = {}
        # Restarts and updates outlive this process; jobs started by this one carry its boot id.
        self.boot_id = new_id()
        self.started_at = time.time()
        self._tasks: Set[asyncio.Task] = set()
        self._update_check: Dict[str, Any] = {}
        self._pet_thumbs = asyncio.Semaphore(PET_THUMB_FETCHES)
        # The other bots this gateway serves (Hermes profiles), installed by the adapter:
        # () -> {"bots": [{name, title, description, served}], "multiplex": bool, "reason": str}.
        self.bots_provider: Optional[Callable[[], Dict[str, Any]]] = None
        self._bots_cache: Optional[tuple] = None
        self._pet_choices: Dict[str, Dict[str, Any]] = {}
        # Reconnects MCP servers (Hermes's /reload-mcp), installed by the adapter. Server changes wait for it.
        self.reload_mcp: Optional[Callable[[], Awaitable[str]]] = None
        self.mcp_changed = False
        # Set by the adapter when it can cap every turn's final toolsets, which members' tool limits need.
        self.limits_members = False
        # Hermes-side callbacks, installed by the adapter.
        self.on_user_message: Optional[InboundFn] = None
        self.on_approval: Optional[ResolveFn] = None
        self.on_answer: Optional[ResolveFn] = None
        # Installed by the adapter; the hub itself never imports Hermes.
        self.hermes_version: Callable[[], str] = lambda: ""
        self.store.ensure_chat(HOME_CHAT_ID, "Updates", kind="home")

    # -- lifecycle -------------------------------------------------------------------

    def build_app(self) -> web.Application:
        app = web.Application(client_max_size=2 * 1024 * 1024, middlewares=[self._cors, self._policy])
        r = app.router
        r.add_get("/api/info", self.h_info)
        r.add_post("/api/pair", self.h_pair)
        r.add_get("/api/ws", self.h_ws)
        r.add_get("/api/me", self.h_me)
        r.add_get("/api/connection", self.h_connection)
        r.add_get("/api/connection/status", self.h_connection_status)
        r.add_delete("/api/me", self.h_unpair)
        r.add_get("/api/chats", self.h_chats)
        r.add_post("/api/chats", self.h_chat_create)
        r.add_patch("/api/chats/{chat_id}", self.h_chat_rename)
        r.add_delete("/api/chats/{chat_id}", self.h_chat_delete)
        r.add_get("/api/chats/{chat_id}/messages", self.h_messages)
        r.add_post("/api/chats/{chat_id}/messages", self.h_message_send)
        r.add_post("/api/chats/{chat_id}/uploads", self.h_upload)
        r.add_get("/api/chats/{chat_id}/export", self.h_export)
        r.add_get("/api/chats/{chat_id}/goal", self.h_chat_goal)
        r.add_get("/api/chats/{chat_id}/files", self.h_chat_files)
        r.add_get("/api/goals", self.h_goals)
        r.add_get("/api/search", self.h_search)
        r.add_get("/api/commands", self.h_commands)
        r.add_get("/api/push/prefs", self.h_push_prefs)
        r.add_put("/api/push/prefs", self.h_push_prefs_put)
        r.add_get("/api/inbox", self.h_inbox)
        r.add_post("/api/inbox/{item_id}/respond", self.h_inbox_respond)
        r.add_get("/api/push/vapid", self.h_vapid)
        r.add_post("/api/push/webpush", self.h_webpush_subscribe)
        r.add_delete("/api/push/webpush", self.h_webpush_unsubscribe)
        r.add_get("/api/push/ntfy", self.h_ntfy)
        r.add_post("/api/push/test", self.h_push_test)
        r.add_get("/api/media/{media_id}/{name}", self.h_media)
        r.add_get("/api/server-key", self.h_server_key)
        r.add_get("/api/address-check", self.h_address_check)
        r.add_get("/api/devices", self.h_devices)
        r.add_patch("/api/devices/{device_id}", self.h_device_update)
        r.add_delete("/api/devices/{device_id}", self.h_device_delete)
        r.add_post("/api/devices/pairing-code", self.h_pairing_code)
        r.add_post("/api/devices/verify", self.h_device_verify)
        r.add_post("/api/devices/me/rotate-token", self.h_rotate_token)
        r.add_get("/api/audit", self.h_audit)
        r.add_get("/api/agent", self.h_agent)
        r.add_post("/api/pickers/{picker_id}/select", self.h_picker_select)
        r.add_get("/api/models", self.h_models)
        r.add_put("/api/models/default", self.h_model_default)
        r.add_get("/api/providers", self.h_providers)
        r.add_post("/api/providers/key", self.h_provider_key)
        r.add_delete("/api/providers/key/{env}", self.h_provider_key_delete)
        r.add_get("/api/identity", self.h_identity)
        r.add_put("/api/identity", self.h_identity_put)
        r.add_get("/api/memory", self.h_memory)
        r.add_post("/api/memory", self.h_memory_edit)
        r.add_get("/api/usage", self.h_usage)
        r.add_get("/api/bots", self.h_bots)
        r.add_post("/api/bots", self.h_bot_create)
        r.add_get("/api/pet", self.h_pet)
        r.add_get("/api/pets", self.h_pets)
        r.add_get("/api/pets/catalog", self.h_pet_catalog)
        r.add_put("/api/pets/display", self.h_pet_display)
        r.add_post("/api/pets/{slug}/adopt", self.h_pet_adopt)
        r.add_delete("/api/pets/{slug}", self.h_pet_remove)
        r.add_get("/api/pets/{slug}/sheet", self.h_pet_sheet)
        r.add_get("/api/pets/{slug}/thumb", self.h_pet_thumb)
        r.add_get("/api/system", self.h_system)
        r.add_get("/api/system/updates", self.h_system_updates)
        r.add_post("/api/system/pause", self.h_pause)
        r.add_post("/api/system/restart", self.h_restart)
        r.add_post("/api/system/update", self.h_update)
        r.add_get("/api/jobs", self.h_jobs)
        r.add_get("/api/jobs/{job_id}", self.h_job)
        r.add_get("/api/logs", self.h_logs)
        r.add_get("/api/schedule", self.h_schedule)
        r.add_post("/api/schedule", self.h_routine_create)
        r.add_post("/api/schedule/parse", self.h_schedule_parse)
        r.add_patch("/api/schedule/{routine_id}", self.h_routine_edit)
        r.add_delete("/api/schedule/{routine_id}", self.h_routine_delete)
        r.add_post("/api/schedule/{routine_id}/{action}", self.h_routine_action)
        r.add_get("/api/sessions", self.h_sessions)
        r.add_get("/api/sessions/search", self.h_session_search)
        r.add_get("/api/sessions/{session_id}", self.h_session)
        r.add_get("/api/skills", self.h_skills)
        r.add_get("/api/skills/catalog", self.h_skill_catalog)
        r.add_post("/api/skills/install", self.h_skill_install)
        r.add_get("/api/skills/{name}/content", self.h_skill_content)
        r.add_put("/api/skills/{name}", self.h_skill_toggle)
        r.add_delete("/api/skills/{name}", self.h_skill_uninstall)
        r.add_get("/api/toolsets", self.h_toolsets)
        r.add_put("/api/toolsets/{name}", self.h_toolset_toggle)
        r.add_put("/api/approvals", self.h_approvals)
        r.add_put("/api/members/tools", self.h_member_tools)
        r.add_get("/api/mcp", self.h_mcp)
        r.add_post("/api/mcp", self.h_mcp_install)
        r.add_get("/api/mcp/catalog", self.h_mcp_catalog)
        r.add_post("/api/mcp/reload", self.h_mcp_reload)
        r.add_get("/api/mcp/sign-in/{flow_id}", self.h_mcp_sign_in_status)
        r.add_delete("/api/mcp/sign-in/{flow_id}", self.h_mcp_sign_in_cancel)
        r.add_get("/api/mcp/oauth/{name}", self.h_mcp_callback)
        r.add_put("/api/mcp/{name}", self.h_mcp_toggle)
        r.add_delete("/api/mcp/{name}", self.h_mcp_remove)
        r.add_post("/api/mcp/{name}/test", self.h_mcp_test)
        r.add_post("/api/mcp/{name}/sign-in", self.h_mcp_sign_in)
        r.add_get("/{tail:.*}", self.h_static)
        app.on_startup.append(self._start_janitor)
        app.on_shutdown.append(self._close_sockets)
        return app

    async def _start_janitor(self, _app: web.Application) -> None:
        if self._janitor is None:
            self._janitor = asyncio.create_task(self._janitor_loop())
        if self._bots_watch is None and self.bots_provider is not None:
            self._bots_watch = asyncio.create_task(self._watch_bots())

    async def _watch_bots(self) -> None:
        """Tell owners' phones when bots come and go, wherever they were made (Hermes Desktop, the CLI, the
        agent itself), or the gateway starts or stops serving one."""
        last = None
        while True:
            await asyncio.sleep(BOTS_WATCH_SECONDS)
            try:
                state = await asyncio.to_thread(self.bots_state, True)
                if last is not None and state["bots"] != last:
                    await self.broadcast({"type": "system.bots", "bot": None, "bots": state["bots"]})
                last = state["bots"]
            except Exception:
                logger.debug("[winglet] bot watch failed", exc_info=True)
            self._spawn(self.reconcile_jobs())

    async def _janitor_loop(self) -> None:
        while True:
            try:
                self.sweep_uploads()
                self.expire_jobs()
            except Exception:
                logger.warning("[winglet] cleanup failed", exc_info=True)
            await asyncio.sleep(JANITOR_SECONDS)

    def _spawn(self, coro) -> asyncio.Task:
        """A background task the hub keeps a reference to, so it isn't collected mid-run."""
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    def sweep_uploads(self, now: Optional[float] = None) -> int:
        """Delete uploads that were never sent within a day: drafts abandoned, sends that never happened."""
        removed = 0
        for row in self.store.stale_uploads((now or time.time()) - UNSENT_UPLOAD_SECONDS):
            self._remove_upload(row)
            removed += 1
        return removed

    def _remove_upload(self, row: Dict[str, Any]) -> None:
        directory = (self.media_dir / row["id"]).resolve()
        if self.media_dir.resolve() in directory.parents:
            shutil.rmtree(directory, ignore_errors=True)
        self.store.delete_upload(row["id"])

    async def _close_sockets(self, _app: web.Application) -> None:
        for ws in list(self._sockets):
            with contextlib.suppress(Exception):
                await ws.close()
        for task in self._push_tasks.values():
            task.cancel()
        self._push_tasks.clear()
        if self._janitor is not None:
            self._janitor.cancel()
        if self._bots_watch is not None:
            self._bots_watch.cancel()
            self._janitor = None
        for task in list(self._tasks):
            task.cancel()

    @web.middleware
    async def _cors(self, request: web.Request, handler):
        # The native app calls from its own origin-less context; browsers use the same origin as the
        # server. Allowing any origin is safe because every API call needs a bearer token (no cookies).
        if request.method == "OPTIONS":
            resp: web.StreamResponse = web.Response(status=204)
        else:
            resp = await handler(request)
        if request.path.startswith("/api/"):
            resp.headers["Access-Control-Allow-Origin"] = "*"
            resp.headers["Access-Control-Allow-Headers"] = ("Authorization, Content-Type, X-Winglet-Device, "
                                                            "X-Winglet-Time, X-Winglet-Nonce, X-Winglet-Signature")
            resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
            resp.headers.setdefault("Cache-Control", "no-store")
        return resp

    # -- auth ------------------------------------------------------------------------

    def _device(self, request: web.Request) -> Optional[Dict[str, Any]]:
        auth = request.headers.get("Authorization", "")
        token = auth[7:].strip() if auth.lower().startswith("bearer ") else request.query.get("token", "")
        return self.store.device_for_token(token)

    def _require(self, request: web.Request) -> Dict[str, Any]:
        device = request.get("device") or self._device(request)
        if device is None:
            raise web.HTTPUnauthorized(text=json.dumps({"error": "not paired"}), content_type="application/json")
        return device

    @web.middleware
    async def _policy(self, request: web.Request, handler):
        if request.match_info.http_exception is not None:
            return await handler(request)  # 404/405: nothing to protect
        name = getattr(request.match_info.route.handler, "__name__", "")
        level = ROUTE_POLICY.get(name, "owner_signed")
        if level == "public":
            return await handler(request)
        device = self._device(request)
        if device is None:
            return _error(401, "not paired")
        if level in ("owner", "owner_signed") and device["role"] != "owner":
            return _error(403, "Only an owner can do that.")
        bot, problem = self._requested_bot(request, device)
        if problem is not None:
            return problem
        if level in ("signed", "owner_signed"):
            problem = await self._signature_problem(request, device)
            if problem:
                logger.warning("[winglet] refused %s %s from %s: %s", request.method, request.path, device["name"], problem)
                self.store.add_audit("refused", device=device, summary=f"{request.method} {request.path}: {problem}",
                                     outcome="refused")
                # The app offers to verify the phone instead of only showing the error.
                needs = {"needs": "verify"} if problem in (VERIFY_FIRST, BAD_SIGNATURE) else {}
                return _json({"error": problem, **needs}, status=403)
        request["device"] = device
        with self._bot_context(bot):
            try:
                return await handler(request)
            except Forbidden as exc:
                return _error(403, str(exc))

    async def _signature_problem(self, request: web.Request, device: Dict[str, Any]) -> Optional[str]:
        """Why a control request can't run, or None when it's signed by this device's verified key, fresh,
        and never seen before. A bearer token alone never passes."""
        sign_key = self.store.device_sign_key(device["id"])
        if not sign_key:
            return VERIFY_FIRST
        h = request.headers
        stamp, nonce, signature = h.get("X-Winglet-Time", ""), h.get("X-Winglet-Nonce", ""), h.get("X-Winglet-Signature", "")
        if not (stamp and nonce and signature) or h.get("X-Winglet-Device") != device["id"]:
            return "This action needs a signed request from the app."
        try:
            skew = abs(time.time() - float(stamp))
        except ValueError:
            return "This action needs a signed request from the app."
        if not math.isfinite(skew) or skew > keys.CLOCK_SKEW_SECONDS:
            return "This request has expired. Check that this device's clock is right, then try again."
        if not 16 <= len(nonce) <= 64:
            return "This action needs a signed request from the app."
        payload = keys.signing_payload(request.method, request.raw_path, await request.read(), device["id"], stamp, nonce)
        if not keys.verify_device_signature(sign_key, payload, signature):
            return BAD_SIGNATURE
        if not self.store.use_nonce(nonce, keys.CLOCK_SKEW_SECONDS):
            return "This request was already used."
        return None

    # -- who sees what -------------------------------------------------------------------

    @staticmethod
    def can_see(device: Optional[Dict[str, Any]], chat: Optional[Dict[str, Any]]) -> bool:
        """Owners see every chat; a member sees the chats they started."""
        if chat is None or device is None:
            return False
        return device.get("role") == "owner" or chat.get("owner_device") == device["id"]

    def _visible_chat(self, device: Dict[str, Any], chat_id: str) -> Dict[str, Any]:
        chat = self.store.get_chat(chat_id)
        if not self.can_see(device, chat):
            raise web.HTTPNotFound(text=json.dumps({"error": "This chat was deleted."}), content_type="application/json")
        return chat

    def visible_chats(self, device: Dict[str, Any]) -> List[Dict[str, Any]]:
        """The current bot's chats this device may see."""
        return [c for c in self.store.list_chats(bot=_BOT.get()) if self.can_see(device, c)]

    def _in_bot(self, chat_id: str) -> bool:
        """Whether a chat belongs to the current bot."""
        chat = self.store.get_chat(chat_id)
        return chat is not None and (chat.get("bot") or None) == _BOT.get()

    def pending_for(self, device: Dict[str, Any]) -> int:
        return sum(1 for i in self.store.pending_items()
                   if self._in_bot(i["chat_id"]) and self.can_see(device, self.store.get_chat(i["chat_id"])))

    def home_chat(self, device: Dict[str, Any]) -> str:
        """Owners share the main chat; each other bot has one too. Each member gets one of their own, made on
        first use."""
        bot = _BOT.get()
        if bot:
            chat_id = "b-" + bot
            self.store.ensure_chat(chat_id, self.bot()["title"], bot=bot)
            return chat_id
        if device.get("role") == "owner":
            return "general"
        chat_id = "m-" + device["id"]
        self.store.ensure_chat(chat_id, device["name"], owner_device=device["id"])
        return chat_id

    def me(self, device: Dict[str, Any]) -> Dict[str, Any]:
        return {"id": device["id"], "name": device["name"], "role": device["role"], "verified": device["verified"],
                "home_chat": self.home_chat(device)}

    def audit(self, action: str, device: Optional[Dict[str, Any]], summary: str = "", outcome: str = "ok") -> None:
        self.store.add_audit(action, device=device, summary=summary, outcome=outcome)

    def action_signature(self, item_id: str, choice: str) -> str:
        """HMAC used for one-tap notification action links (no bearer token available there)."""
        key = self.store.secret("action_key").encode()
        return hmac.new(key, f"{item_id}:{choice}".encode(), hashlib.sha256).hexdigest()[:32]

    # -- info & pairing ------------------------------------------------------------------

    def bot(self) -> Dict[str, Any]:
        """Who the current bot is: the profile this gateway runs as, or another one it serves."""
        name = _BOT.get()
        if name:
            row = next((b for b in self.bots() if b["name"] == name), None) or {"name": name, "title": name}
            return {"name": row["name"], "title": row.get("title") or row["name"], "description": row.get("description") or ""}
        info = dict(self._bot_info() or {})
        info.setdefault("name", "Hermes")
        info.setdefault("title", info["name"])
        info.setdefault("description", "")
        return info

    def server_id(self) -> str:
        return self.store.secret("server_id", lambda: secrets.token_hex(6))

    # -- bots: other Hermes profiles this gateway serves ---------------------------------------

    def bots_state(self, fresh: bool = False) -> Dict[str, Any]:
        """{bots: [{name, title, description, served}], multiplex, reason}, read again every few seconds so a bot
        made in Hermes Desktop or the CLI shows up without a restart."""
        if self.bots_provider is None:
            return {"bots": [], "multiplex": False, "reason": ""}
        now = time.monotonic()
        if fresh or self._bots_cache is None or now - self._bots_cache[0] > BOTS_CACHE_SECONDS:
            try:
                state = self.bots_provider() or {}
            except Exception:
                logger.debug("[winglet] couldn't list bots", exc_info=True)
                state = self._bots_cache[1] if self._bots_cache else {}
            self._bots_cache = (now, {"bots": list(state.get("bots") or []), "multiplex": bool(state.get("multiplex")),
                                      "reason": str(state.get("reason") or "")})
        return self._bots_cache[1]

    def bots(self) -> List[Dict[str, Any]]:
        return self.bots_state()["bots"]

    def _requested_bot(self, request: web.Request, device: Dict[str, Any]):
        """(bot, None) for the request's `bot` parameter, or (None, error response). Members talk to the main
        bot only."""
        raw = request.query.get("bot", "").strip()
        if not raw or raw == "default":
            return None, None
        if device.get("role") != "owner":
            return None, _error(403, "Only an owner can talk to other bots.")
        if not _BOT_NAME.fullmatch(raw) or not any(b["name"] == raw for b in self.bots_state(fresh=raw not in
                                                                                        {b["name"] for b in self.bots()})["bots"]):
            return None, _error(404, "That bot isn't on this server any more.")
        return raw, None

    @contextlib.contextmanager
    def _bot_context(self, bot: Optional[str]):
        """Hub and Hermes calls inside are about this bot (Hermes calls run as its profile)."""
        token = _BOT.set(bot)
        scoped = bool(bot) and self._has_attr(self.hermes, "set_bot")
        hermes_token = self.hermes.set_bot(bot) if scoped else None
        try:
            yield
        finally:
            if scoped:
                self.hermes.reset_bot(hermes_token)
            _BOT.reset(token)

    @staticmethod
    def _has_attr(obj: Any, name: str) -> bool:
        return obj is not None and callable(getattr(obj, name, None))

    def current_device(self, device_id: str) -> Optional[Dict[str, Any]]:
        """A device as it is now, or None once unpaired. Unpairing or a role change can happen in
        another process (the CLI), so this reads the database, cached for a moment to keep streaming
        broadcasts cheap."""
        now = time.monotonic()
        cached = self._alive_cache.get(device_id)
        if cached and now - cached[1] < ALIVE_CACHE_SECONDS:
            return cached[0]
        device = self.store.get_device(device_id)
        self._alive_cache[device_id] = (device, now)
        return device

    def device_alive(self, device_id: str) -> bool:
        return self.current_device(device_id) is not None

    def features(self) -> Dict[str, bool]:
        """What this server can do. The app hides anything that isn't listed as true."""
        return {"webpush": True, "ntfy": True, "approvals": True, "questions": True, "uploads": True, "voice": True,
                "replies": True, "export": True, "mute": True, "status_updates": True, "roles": True,
                "signed_actions": True, "ws_auth": True, "pickers": True, "agent": self.hermes is not None,
                "control": self.hermes is not None, "goals": self.chat_goal is not None, "search": True, "files": True,
                "abilities": self.hermes is not None, "commands": self.commands_provider is not None,
                "sessions": self.hermes is not None and self._has(self.hermes, "sessions_available"),
                "pets": self.hermes is not None and self._has(self.hermes, "pets_available"),
                "bots": self.bots_provider is not None and self.hermes is not None and self._has(self.hermes, "bots_available"),
                "connection_status": True}

    def about(self) -> Dict[str, Any]:
        return {"version": VERSION, "protocol": PROTOCOL, "min_app_protocol": MIN_APP_PROTOCOL,
                "hermes_version": self.hermes_version() or "", "features": self.features()}

    async def h_info(self, request: web.Request) -> web.Response:
        return _json({"app": "winglet", "server_id": self.server_id(), "bot": self.bot(),
                      "connection": self.connection, **self.about()})

    def _pair_peer(self, request: web.Request) -> str:
        peer = request.remote or "?"
        try:
            if (self.connection["mode"] == "quick" and ipaddress.ip_address(peer).is_loopback
                    and request.headers.get("Host") == self.tunnel_host):
                return str(ipaddress.ip_address(request.headers.get("CF-Connecting-IP", "")))
        except ValueError:
            pass  # Missing/malformed proxy headers use the socket's address.
        return peer

    def _pair_throttled(self, key: str) -> bool:
        """True once ``key`` (a peer or a device) has guessed wrong too often in the last minute."""
        now = time.monotonic()
        recent = [t for t in self._pair_failures.pop(key, []) if now - t < 60]
        if recent:
            self._pair_failures[key] = recent
        return len(recent) >= PAIR_FAILURES_PER_MINUTE

    def _pair_failed(self, key: str) -> None:
        self._pair_failures.setdefault(key, []).append(time.monotonic())

    async def h_pair(self, request: web.Request) -> web.Response:
        peer = self._pair_peer(request)
        if self._pair_throttled(peer):
            return _error(429, "Too many attempts. Wait a minute and try again.")
        try:
            body = await request.json()
        except Exception:
            return _error(400, "invalid JSON")
        if not isinstance(body, dict):
            return _error(400, "expected a JSON object")
        sign_key, verified = "", False
        if body.get("sealed"):
            # Current apps seal the request to the server key whose fingerprint was in the QR code, so
            # nobody in between can swap in their own signing key.
            try:
                body = self.keys.unseal_json(str(body["sealed"]), "pair")
            except (keys.SealError, ValueError):
                self._pair_failed(peer)
                return _error(400, "This pairing request couldn't be opened. Scan a new code and try again.")
            sign_key = str(body.get("sign_key") or "")
            if sign_key and not keys.valid_public_key(sign_key):
                return _error(400, "invalid signing key")
            verified = bool(sign_key) and body.get("pinned") is True
        role = self.store.redeem_pair_code(str(body.get("code") or ""))
        if role is None:
            self._pair_failed(peer)
            return _error(403, "This pairing code is invalid or expired. Run `hermes winglet pair` for a new one.")
        self._pair_failures.pop(peer, None)
        device, token = self.store.add_device(str(body.get("device_name") or ""), str(body.get("platform") or ""),
                                              role=role, sign_key=sign_key, verified=verified)
        logger.info("[winglet] paired new device %s (%s) as %s", device["name"], device["platform"] or "unknown", role)
        self.audit("device.paired", device, f"{device['name']} ({device['platform'] or 'unknown'}) as {role}"
                   + ("" if verified else ", not verified"))
        address = self._recovery_credentials(device) if device["platform"] == "android" else None
        return _json({"token": token, "device": device, "me": self.me(device), "server_id": self.server_id(),
                      "bot": self.bot(), "recovery": address})

    async def h_server_key(self, request: web.Request) -> web.Response:
        return _json(self.keys.public_info())

    def addresses(self) -> List[str]:
        """Where this server says phones can reach it: the tunnel's address, or the one set for direct use."""
        url = self.connection.get("url") if self.connection.get("mode") == "quick" else self.public_url
        return [url] if url else []

    async def h_address_check(self, request: web.Request) -> web.Response:
        """Public: a phone checks a new address with this before sending its token there. It names one
        address and gets a signed yes or no, so the list itself (maybe a private network's name) stays private."""
        url = request.query.get("url", "").strip()
        if not url or len(url) > 2048:
            return _error(400, "url is required")
        listed = url.rstrip("/") in [a.rstrip("/") for a in self.addresses()]
        return _json(self.keys.sign_address(self.server_id(), url, listed))

    def _recovery_credentials(self, device: dict) -> Optional[dict]:
        if self.connection["mode"] != "quick" or not self.ntfy_server.startswith("https://"):
            return None
        mine = next((s for s in self.store.list_push_subs("recovery") if s["device_id"] == device["id"]), None)
        if mine is None:
            data = recovery.credentials(self.ntfy_server)
            self.store.add_push_sub(device["id"], "recovery", data["server"] + "/" + data["topic"], data)
            self._recovery_wake.set()
        else:
            data = mine["data"]
        # The revision at enrollment is already current. Only later addresses may replace it.
        return {**data, "revision": int(self.store.get_kv("connection_revision") or 0)}

    async def h_connection(self, request: web.Request) -> web.Response:
        device = self._require(request)
        return _json({"recovery": self._recovery_credentials(device) if device["platform"] == "android" else None})

    async def h_connection_status(self, request: web.Request) -> web.Response:
        """How this server is reached, and whether this device's notifications and address recovery work."""
        device = self._require(request)
        owner = device.get("role") == "owner"
        quick = self.connection.get("mode") == "quick"
        mine = [sub for sub in self.store.list_push_subs() if sub["device_id"] == device["id"]]

        def latest(kinds):
            seen = [self._delivered[sub["id"]] for sub in mine if sub["kind"] in kinds and sub["id"] in self._delivered]
            return max(seen, key=lambda d: d["at"]) if seen else None

        tunnel = None
        if quick:
            status = dict(getattr(self.tunnel, "status", None) or {"state": "starting", "since": self.started_at})
            if not owner:
                status["error"] = None  # Errors can name paths on the server.
            tunnel = status
        address_at = self.store.get_kv("connection_url_at") if quick else None
        result = {
            "mode": "quick" if quick else "direct",
            "url": (self.addresses() or [None])[0],
            "address_since": float(address_at) if address_at and self.connection.get("url") else None,
            "address_changes": int(self.store.get_kv("connection_revision") or 0) if quick else None,
            "tunnel": tunnel,
            "recovery": {"enrolled": any(sub["kind"] == "recovery" for sub in mine), "last": latest(("recovery",))}
            if quick and device["platform"] == "android" else None,
            "push": {"ntfy": sum(sub["kind"] == "ntfy" for sub in mine),
                     "webpush": sum(sub["kind"] == "webpush" for sub in mine),
                     "last": latest(("ntfy", "webpush")), "ntfy_server": urlsplit(self.ntfy_server).hostname or ""},
        }
        if owner:
            result["listen"] = self.listen
            result["web_keys"] = self._secrets_refused({"platform": "web"}) is None
        return _json(result)

    async def set_connection(self, url: Optional[str]) -> None:
        self.connection = {"mode": "quick", "url": url}
        if url:
            if self.store.get_kv("connection_url") != url:
                self.store.set_kv("connection_revision", str(int(self.store.get_kv("connection_revision") or 0) + 1))
                self.store.set_kv("connection_url", url)
                self.store.set_kv("connection_url_at", str(time.time()))
                self._recovery_due.clear()
                self._recovery_wake.set()
            if self._recovery_task is None:
                self._recovery_task = asyncio.create_task(self._recovery_loop())

    async def _recovery_loop(self) -> None:
        while True:
            self._recovery_wake.clear()
            await self.publish_addresses()
            try:
                await asyncio.wait_for(self._recovery_wake.wait(), timeout=300)
            except asyncio.TimeoutError:
                pass

    async def publish_addresses(self) -> None:
        async with self._recovery_lock:
            await self._publish_addresses()

    async def _publish_addresses(self) -> None:
        url = self.connection.get("url")
        if not url or self.connection["mode"] != "quick":
            return
        revision = int(self.store.get_kv("connection_revision") or 0)
        for sub in self.store.list_push_subs("recovery"):
            if self.connection.get("url") != url:
                return  # A rotated URL supersedes the remainder of this batch.
            if self._recovery_due.get(sub["id"], 0) > time.monotonic():
                continue
            if not self.store.get_device(sub["device_id"]):
                continue
            try:
                message = recovery.encrypt(sub["data"], self.server_id(), sub["device_id"], url, revision)
                client = await self._client()
                response = await client.post(sub["data"]["server"], json={
                    "topic": sub["data"]["topic"], "message": message}, timeout=15)
                # Refresh every six hours so phones returning after ntfy's cache expires can recover.
                if self.connection.get("url") == url:
                    self._recovery_due[sub["id"]] = time.monotonic() + (6 * 3600 if response.status_code < 300 else 300)
                self._delivered[sub["id"]] = {"at": time.time(), "ok": response.status_code < 300}
                if response.status_code >= 300:
                    logger.warning("[winglet] address recovery publish rejected: HTTP %s", response.status_code)
            except Exception:
                if self.connection.get("url") == url:
                    self._recovery_due[sub["id"]] = time.monotonic() + 300
                self._delivered[sub["id"]] = {"at": time.time(), "ok": False}
                logger.warning("[winglet] address recovery publish failed; will retry")

    async def h_me(self, request: web.Request) -> web.Response:
        device = self._require(request)
        return _json({"device": device, "me": self.me(device), "bot": self.bot(), "server_id": self.server_id()})

    async def h_unpair(self, request: web.Request) -> web.Response:
        device = self._require(request)
        self.store.remove_device(device["id"])
        self._alive_cache.pop(device["id"], None)
        for ws, meta in list(self._sockets.items()):
            if meta["device"]["id"] == device["id"]:
                await ws.close()
        return _json({"ok": True})

    # -- chats & messages ----------------------------------------------------------------

    async def h_chats(self, request: web.Request) -> web.Response:
        device = self._require(request)
        return _json({"chats": self.visible_chats(device)})

    async def h_chat_create(self, request: web.Request) -> web.Response:
        device = self._require(request)
        body = await self._body(request)
        chat = self.store.create_chat(str(body.get("title") or ""),
                                      owner_device=None if device["role"] == "owner" else device["id"], bot=_BOT.get())
        await self.broadcast({"type": "chat.update", "chat": chat})
        return _json({"chat": chat})

    async def h_chat_rename(self, request: web.Request) -> web.Response:
        device = self._require(request)
        self._visible_chat(device, request.match_info["chat_id"])
        body = await self._body(request)
        chat = self.store.rename_chat(request.match_info["chat_id"], str(body.get("title") or ""))
        if chat is None:
            return _error(404, "no such chat")
        await self.broadcast({"type": "chat.update", "chat": chat})
        return _json({"chat": chat})

    async def h_chat_delete(self, request: web.Request) -> web.Response:
        device = self._require(request)
        chat_id = request.match_info["chat_id"]
        if chat_id == HOME_CHAT_ID:
            return _error(400, "the Updates chat can't be deleted")
        chat = self._visible_chat(device, chat_id)
        if device["role"] != "owner" and chat_id == self.home_chat(device):
            return _error(400, "This is your main chat; it can't be deleted.")
        files = self.store.chat_uploads(chat_id)
        if not self.store.delete_chat(chat_id):
            return _error(404, "no such chat")
        for row in files:
            self._remove_upload(row)
        await self.broadcast({"type": "chat.delete", "chat_id": chat_id, "owner_device": chat.get("owner_device"),
                              "bot": chat.get("bot")})
        return _json({"ok": True})

    async def h_messages(self, request: web.Request) -> web.Response:
        device = self._require(request)
        chat_id = request.match_info["chat_id"]
        self._visible_chat(device, chat_id)
        try:
            before = float(request.query["before"]) if request.query.get("before") else None
            before_position = int(request.query["before_position"]) if request.query.get("before_position") else None
            limit = int(request.query.get("limit") or 50)
            if before_position is not None and before_position < 1:
                raise ValueError
        except ValueError:
            return _error(400, "before and limit must be numbers; before_position must be a positive integer")
        messages = self.store.list_messages(chat_id, before_position=before_position,
                                            before_id=request.query.get("before_id") or None,
                                            before=before, limit=limit)
        return _json({"messages": messages, "deleted_ids": self.store.deleted_message_ids(chat_id)})

    async def h_message_send(self, request: web.Request) -> web.Response:
        device = self._require(request)
        body = await self._body(request)
        self._visible_chat(device, request.match_info["chat_id"])
        attachments = body.get("attachments") or []
        if not isinstance(attachments, list) or not all(isinstance(a, str) for a in attachments):
            return _error(400, "attachments must be a list of upload ids")
        try:
            message = await self.user_message(device, request.match_info["chat_id"], str(body.get("text") or ""),
                                              str(body.get("client_id") or ""), attachments=attachments,
                                              reply_to=str(body.get("reply_to") or ""),
                                              hidden=body.get("hidden") is True)
        except MessageRejected as exc:
            return _error(400, str(exc))
        if message is None:
            return _error(400, "empty message")
        return _json({"message": message})

    async def user_message(self, device: Dict[str, Any], chat_id: str, text: str,
                           client_id: str = "", *, attachments: Optional[List[str]] = None,
                           reply_to: str = "", hidden: bool = False) -> Optional[Dict[str, Any]]:
        text = (text or "").strip()[:MAX_TEXT]
        attachments = list(dict.fromkeys(attachments or []))
        if (not text and not attachments) or not chat_id:
            return None
        if len(attachments) > MAX_ATTACHMENTS:
            raise MessageRejected(f"At most {MAX_ATTACHMENTS} attachments per message.")
        if client_id:
            # A retry of something we already have (the reply to the first try was lost): don't run it twice.
            existing = self.store.find_user_message(chat_id, client_id)
            if existing is not None:
                return existing
        chat = self.store.get_chat(chat_id)
        if not self.can_see(device, chat):
            return None  # deleted (or never created, or someone else's): don't bring it back
        if device["role"] != "owner" and not self.limits_members and self.member_tools()["limited"]:
            # Limits were set, but this Hermes can't apply them any more (an update removed the step).
            raise MessageRejected("An owner limited what members can use, and this server can't apply that "
                                  "right now, so your message wasn't sent. Ask an owner to update Hermes.")
        refused = self._refused_command(device, text)
        meta: Dict[str, Any] = {"device": device["name"], "client_id": client_id}
        if hidden and text.startswith("/") and not attachments:
            # A command the app sent for a control (the model chip's /model): kept for the record, not shown.
            meta["hidden"] = True
        reply = None
        if reply_to:
            quoted = self.store.get_message(reply_to)
            if quoted is None or quoted["chat_id"] != chat_id:
                raise MessageRejected("The message you replied to no longer exists.")
            reply = {"id": quoted["id"], "role": quoted["role"], "text": quoted["text"][:REPLY_CONTEXT]}
            meta["reply_to"] = {"id": quoted["id"], "role": quoted["role"], "text": _clip(quoted["text"], REPLY_EXCERPT)}
        message_id = new_id()
        files: List[Dict[str, Any]] = []
        if attachments:
            rows = self.store.claim_uploads(attachments, device["id"], chat_id, message_id)
            if rows is None:
                raise MessageRejected("An attachment is missing, expired, or was already sent. Attach it again.")
            meta["attachments"] = [self._upload_public(row) for row in rows]
            files = [{"path": str(self.media_dir / row["id"] / row["name"]), "name": row["name"], "mime": row["mime"],
                      "kind": row["kind"]} for row in rows]
        message = self.store.add_message(chat_id, "user", text, meta=meta, message_id=message_id)
        await self.broadcast({"type": "message.new", "chat_id": chat_id, "message": message})
        await self.broadcast({"type": "chat.update", "chat": self.store.get_chat(chat_id)})
        if refused:
            # Hermes never sees it: members can't change settings or approve through a slash command either.
            await self.post_message(chat_id, f"Only an owner can use {refused}.", role="system", push=False)
            return message
        if self.on_user_message is not None:
            extra: Dict[str, Any] = {}
            if files:
                extra["files"] = files
            if reply:
                extra["reply"] = reply
            try:
                await self.on_user_message(chat, text, device, message, **extra)
            except Exception:
                logger.exception("[winglet] failed to hand message to Hermes")
                await self.post_message(chat_id, "⚠️ Couldn't reach the agent. Check the gateway logs.",
                                        role="system", push=False)
        return message

    def _refused_command(self, device: Dict[str, Any], text: str) -> str:
        """The slash command a member typed that's for owners only, or "" when the message may go through."""
        if device.get("role") == "owner" or not text.startswith("/"):
            return ""
        typed = text[1:].split(maxsplit=1)[0].split("@")[0].lower() if text[1:].strip() else ""
        if not typed:
            return ""
        name = typed
        if self.command_resolver is not None:
            try:
                name = self.command_resolver(typed) or ""
            except Exception:
                name = ""
        return "" if name in MEMBER_COMMANDS else f"/{typed}"

    # -- uploads, export, commands ---------------------------------------------------------

    def _upload_public(self, row: Dict[str, Any]) -> Dict[str, Any]:
        """What the app sees about an upload: never the server path."""
        return {"id": row["id"], "name": row["name"], "mime": row["mime"], "kind": row["kind"], "size": row["size"],
                "url": f"/api/media/{row['id']}/{quote(row['name'])}?sig={self.media_signature(row['id'])}"}

    async def h_upload(self, request: web.Request) -> web.Response:
        """Receive one file for a chat. It's held for a day until a message attaches it."""
        device = self._require(request)
        chat_id = request.match_info["chat_id"]
        self._visible_chat(device, chat_id)
        day_used = self.store.upload_bytes_since(device["id"], time.time() - 86400)
        day_left = self.device_daily_upload_bytes - day_used
        store_left = self.total_upload_bytes - self.store.total_upload_bytes()
        if day_left <= 0:
            return _error(429, "You've reached today's upload limit for this device. Try again tomorrow.")
        if store_left <= 0:
            return _error(507, "The server's upload storage is full. Delete old chats or raise WINGLET_UPLOAD_STORAGE_MB.")
        limit = min(self.max_upload_bytes, day_left, store_left)
        try:
            reader = await request.multipart()
        except Exception:
            return _error(400, "expected a multipart upload")
        voice = False
        upload_id = secrets.token_urlsafe(12)
        directory = self.media_dir / upload_id
        try:
            async for part in _parts(reader):
                if part.name == "kind":
                    voice = (await part.text()).strip() == "voice"
                    continue
                if part.name != "file":
                    continue
                # Some clients percent-encode the name (RFC 5987); decode before stripping directories.
                name = uploads.safe_name(unquote(part.filename or ""), "voice-note" if voice else "file")
                directory.mkdir(parents=True, exist_ok=True)
                partial = directory / ".partial"
                size, head = 0, b""
                with open(partial, "wb") as out:
                    while chunk := await part.read_chunk(256 * 1024):
                        size += len(chunk)
                        if size > limit:
                            raise _TooLarge()
                        if len(head) < 512:
                            head += chunk[: 512 - len(head)]
                        out.write(chunk)
                if size == 0:
                    raise MessageRejected("That file is empty.")
                mime = uploads.sniff_mime(head, name)
                if voice:
                    mime = uploads.voice_mime(mime)
                partial.rename(directory / name)
                row = self.store.add_upload(upload_id, device["id"], chat_id, name, mime, uploads.kind_of(mime, voice), size)
                return _json({"upload": self._upload_public(row)})
        except _TooLarge:
            shutil.rmtree(directory, ignore_errors=True)
            mb = limit // (1024 * 1024)
            reason = "the per-file limit" if limit == self.max_upload_bytes else "what's left of today's or the server's allowance"
            return _error(413, f"That file is larger than {mb} MB, {reason}.")
        except MessageRejected as exc:
            shutil.rmtree(directory, ignore_errors=True)
            return _error(400, str(exc))
        except Exception:
            shutil.rmtree(directory, ignore_errors=True)
            logger.warning("[winglet] upload failed", exc_info=True)
            return _error(400, "The upload was interrupted. Try again.")
        return _error(400, "no file in the upload")

    async def h_export(self, request: web.Request) -> web.Response:
        """The whole chat as Markdown, to save or share."""
        device = self._require(request)
        chat = self._visible_chat(device, request.match_info["chat_id"])
        bot = self.bot()["title"]
        title = "Updates" if chat["kind"] == "home" else chat["title"]
        lines = [f"# {title}", "", f"_Exported from Winglet · {bot}_", ""]
        for m in self.store.all_messages(chat["id"]):
            if (m.get("meta") or {}).get("hidden"):
                continue
            when = time.strftime("%Y-%m-%d %H:%M", time.localtime(m["created_at"]))
            if m["role"] == "system":
                lines += [f"> {m['text']}", ""]
                continue
            who = bot if m["role"] == "bot" else "You"
            lines += [f"**{who}** · {when}", "", m["text"] or ""]
            for a in (m.get("meta") or {}).get("attachments") or []:
                lines.append(f"- 📎 {a.get('name', 'attachment')}")
            lines.append("")
        safe = uploads.safe_name(f"{title}.md", "chat.md")
        return web.Response(text="\n".join(lines), content_type="text/markdown", charset="utf-8",
                            headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(safe)}"})

    # -- goals, search and files ----------------------------------------------------------------

    def _goal_for(self, chat_id: str) -> Optional[Dict[str, Any]]:
        if self.chat_goal is None:
            return None
        try:
            return self.chat_goal(chat_id)
        except Exception:
            logger.debug("[winglet] goal unavailable for %s", chat_id, exc_info=True)
            return None

    async def h_chat_goal(self, request: web.Request) -> web.Response:
        """The goal (/goal) this chat is working toward, if any. Changing it is a /goal message."""
        device = self._require(request)
        chat = self._visible_chat(device, request.match_info["chat_id"])
        return _json({"goal": await asyncio.to_thread(self._goal_for, chat["id"])})

    async def h_goals(self, request: web.Request) -> web.Response:
        """Every chat you can see that has a goal, for the home screen."""
        device = self._require(request)
        if self.chat_goal is None:
            return _json({"goals": []})
        chats = self.visible_chats(device)

        def collect():
            out = []
            for chat in chats:
                goal = self._goal_for(chat["id"])
                if goal is not None:
                    out.append({"chat_id": chat["id"], "title": chat["title"], "goal": goal})
            return out
        goals = await asyncio.to_thread(collect)
        order = {"active": 0, "paused": 1, "done": 2}
        goals.sort(key=lambda g: (order.get(g["goal"]["status"], 3), -(g["goal"].get("last_turn_at") or 0)))
        return _json({"goals": goals})

    async def h_search(self, request: web.Request) -> web.Response:
        """Messages in your chats that contain the words, newest first, with the matching part."""
        device = self._require(request)
        query = " ".join((request.query.get("q") or "").split())[:200]
        if len(query) < 2:
            return _json({"results": []})
        chats = {c["id"]: c for c in self.visible_chats(device)}
        found = self.store.search_messages(query, list(chats), limit=60)
        results = [{"message": {k: m[k] for k in ("id", "chat_id", "role", "created_at", "position")},
                    "chat": {"id": m["chat_id"], "title": chats[m["chat_id"]]["title"], "kind": chats[m["chat_id"]]["kind"]},
                    "snippet": _snippet(m["text"], query)} for m in found]
        return _json({"results": results})

    async def h_chat_files(self, request: web.Request) -> web.Response:
        """Everything shared in a chat, both ways, newest first."""
        device = self._require(request)
        chat = self._visible_chat(device, request.match_info["chat_id"])
        return _json({"files": self.store.chat_attachments(chat["id"])})

    async def h_commands(self, request: web.Request) -> web.Response:
        """Slash commands this Hermes accepts from the app, with their hints."""
        device = self._require(request)
        commands: List[Dict[str, Any]] = []
        if self.commands_provider is not None:
            try:
                commands = list(self.commands_provider() or [])
            except Exception:
                logger.debug("[winglet] command list unavailable", exc_info=True)
        commands = commands or _DEFAULT_COMMANDS
        if device["role"] != "owner":
            commands = [c for c in commands if not self._refused_command(device, str(c.get("cmd") or ""))]
        return _json({"commands": commands})

    async def h_push_prefs(self, request: web.Request) -> web.Response:
        device = self._require(request)
        return _json({"prefs": self.store.get_push_prefs(device["id"])})

    async def h_push_prefs_put(self, request: web.Request) -> web.Response:
        """This device's notification preferences: muted chats and quiet hours."""
        device = self._require(request)
        body = await self._body(request)
        try:
            prefs = _clean_push_prefs(body.get("prefs") if isinstance(body.get("prefs"), dict) else body)
        except ValueError as exc:
            return _error(400, str(exc))
        return _json({"prefs": self.store.set_push_prefs(device["id"], prefs)})

    # -- inbox ---------------------------------------------------------------------------

    async def h_inbox(self, request: web.Request) -> web.Response:
        device = self._require(request)
        status = request.query.get("status") or None
        if status == "pending":
            items = self.store.pending_items()
        elif status:
            items = self.store.list_inbox(status=status)
        else:
            # Everything still waiting for an answer, however old, plus recent history.
            pending = self.store.pending_items()
            seen = {i["id"] for i in pending}
            items = pending + [i for i in self.store.list_inbox() if i["id"] not in seen]
        items = [i for i in items if self._in_bot(i["chat_id"]) and self.can_see(device, self.store.get_chat(i["chat_id"]))]
        return _json({"items": items, "pending": self.pending_for(device)})

    async def h_inbox_respond(self, request: web.Request) -> web.Response:
        item_id = request.match_info["item_id"]
        body = await self._body(request)
        choice = str(body.get("choice") or request.query.get("choice") or "")
        answer = body.get("answer")
        device = self._device(request)
        if device is None:
            # Older notifications carried signed action links. Only "deny" is honoured from one: an
            # approval must be given from the card itself, where the whole command is visible.
            sig = str(body.get("sig") or request.query.get("sig") or "")
            if not (choice == "deny" and hmac.compare_digest(sig, self.action_signature(item_id, choice))):
                return _error(401, "not paired")
        try:
            ok, item = await self.respond(item_id, choice=choice, answer=answer, device=device)
        except Forbidden as exc:
            return _error(403, str(exc))
        if item is None:
            return _error(404, "no such item")
        return _json({"ok": ok, "item": item}, status=200 if ok else 409)

    async def respond(self, item_id: str, *, choice: str = "", answer: Any = None,
                      device: Optional[Dict[str, Any]] = None) -> tuple[bool, Optional[Dict]]:
        """Answer an inbox card. ``device`` is who's answering; None only for an old notification's
        deny link, which the caller has already checked."""
        item = self.store.get_inbox(item_id)
        if item is None or (device is not None and not self.can_see(device, self.store.get_chat(item["chat_id"]))):
            return False, None
        if item["status"] != "pending":
            return False, item
        if item["kind"] == "approval" and device is not None and device["role"] != "owner":
            raise Forbidden("Only an owner can approve or deny commands. It's waiting in their inbox.")
        ok = False
        if item["kind"] == "approval":
            if choice not in (item["payload"].get("choices") or []):
                return False, item
            ok = bool(self.on_approval and await self.on_approval(item, choice))
            resolution = choice
            if ok:
                self.audit("approval", device, f"{choice}: {_clip(item['payload'].get('command') or item['title'], 120)}")
        elif item["kind"] == "question":
            if isinstance(answer, list):  # multi-select: the labels the user ticked
                picked = [str(a).strip() for a in answer if str(a).strip()]
                if not picked:
                    return False, item
                reply: Any = picked
                resolution = ", ".join(picked)
            else:
                reply = resolution = str(answer if answer is not None else choice).strip()
                if not reply:
                    return False, item
            ok = bool(self.on_answer and await self.on_answer(item, reply))
        else:  # results are simply acknowledged
            ok, resolution = True, "seen"
        updated = self.store.resolve_inbox(item_id, "resolved" if ok else "expired", resolution if ok else "")
        item = updated or self.store.get_inbox(item_id)
        await self.broadcast({"type": "inbox.update", "item": item, "pending": self.store.pending_count()})
        return ok, item

    async def expire_item(self, item_id: str, note: str = "") -> Optional[Dict[str, Any]]:
        """Mark a pending card dead (its request ended without an answer from Winglet)."""
        item = self.store.resolve_inbox(item_id, "expired", note[:500])
        if item is not None:
            await self.broadcast({"type": "inbox.update", "item": item, "pending": self.store.pending_count()})
        return item

    async def add_inbox(self, kind: str, chat_id: str, title: str, body: str, payload: Dict[str, Any], *,
                        push: bool = True) -> Dict[str, Any]:
        # Results are informational: they land in the inbox history but never count as "needs you".
        status = "resolved" if kind == "result" else "pending"
        item = self.store.add_inbox(kind, chat_id, title, body, payload, status=status)
        await self.broadcast({"type": "inbox.new", "item": item, "pending": self.store.pending_count()})
        if push:
            await self.push_now(self._inbox_notification(item), tag=f"inbox-{item['id']}",
                                urgency="normal" if kind == "result" else "high", item=item)
        return item

    def _inbox_notification(self, item: Dict[str, Any]) -> Dict[str, Any]:
        chat = self.store.get_chat(item["chat_id"]) or {}
        with self._bot_context(chat.get("bot") or None):
            bot = self.bot()["title"]
        server = self.server_id() + (f"~{chat['bot']}" if chat.get("bot") else "")
        # Tapping it opens exactly this card in the app.
        url = f"/inbox?server={quote(server, safe='')}&item={quote(item['id'], safe='')}"
        return {"title": f"{bot} · {item['title']}", "body": _clip(item["body"], 180),
                "url": url, "kind": item["kind"], "item_id": item["id"],
                "chat_id": item["chat_id"], "chat_title": chat.get("title", "")}

    # -- outbound (called by the adapter) ------------------------------------------------------

    async def post_message(self, chat_id: str, text: str, *, role: str = "bot", status: str = "final",
                           meta: Optional[Dict[str, Any]] = None, push: bool = True) -> Dict[str, Any]:
        message = self.store.add_message(chat_id, role, text, status=status, meta=meta)
        await self.broadcast({"type": "message.new", "chat_id": chat_id, "message": message})
        await self.broadcast({"type": "chat.update", "chat": self.store.get_chat(chat_id)})
        if push and role == "bot":
            self.schedule_push(chat_id, message["id"], final=status == "final")
        return message

    async def edit_message(self, message_id: str, text: str, *, final: bool = False) -> Optional[Dict[str, Any]]:
        message = self.store.update_message(message_id, text, status="final" if final else "streaming")
        if message is None:
            return None
        await self.broadcast({"type": "message.update", "chat_id": message["chat_id"], "message": message})
        if message["role"] == "bot":
            self.schedule_push(message["chat_id"], message_id, final=final)
        return message

    async def delete_message(self, message_id: str) -> bool:
        message = self.store.delete_message(message_id)
        if message is None:
            return False
        await self.broadcast({"type": "message.delete", "chat_id": message["chat_id"], "message_id": message_id})
        return True

    async def set_typing(self, chat_id: str, on: bool) -> None:
        """``on`` is re-sent every few seconds while the agent works; the app expires it after ~8s."""
        if not on and chat_id not in self._typing:
            return
        (self._typing.add if on else self._typing.discard)(chat_id)
        await self.broadcast({"type": "typing", "chat_id": chat_id, "on": on})
        if not on:
            # A turn ended: anything still marked as streaming (e.g. a tool-progress bubble) is done.
            for message in self.store.streaming_messages(chat_id):
                await self.edit_message(message["id"], message["text"], final=True)

    def add_media(self, path: str, name: Optional[str] = None) -> Dict[str, Any]:
        """Copy a local file the agent produced into Winglet's media store; returns an attachment."""
        src = Path(path)
        name = Path(name or src.name).name or "file"
        media_id = secrets.token_urlsafe(12)
        dest_dir = self.media_dir / media_id
        dest_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest_dir / name)
        mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
        kind = "image" if mime in INLINE_IMAGE_TYPES else mime.split("/")[0] if mime.split("/")[0] in (
            "audio", "video") else "file"
        # The link carries a signature for this one file, never the device's bearer token.
        return {"url": f"/api/media/{media_id}/{quote(name)}?sig={self.media_signature(media_id)}", "name": name,
                "mime": mime, "kind": kind, "size": (dest_dir / name).stat().st_size}

    def media_signature(self, media_id: str) -> str:
        key = self.store.secret("media_key").encode()
        return hmac.new(key, media_id.encode(), hashlib.sha256).hexdigest()[:32]

    async def h_media(self, request: web.Request) -> web.StreamResponse:
        media_id, name = request.match_info["media_id"], request.match_info["name"]
        sig = request.query.get("sig", "")
        if not (sig and hmac.compare_digest(sig, self.media_signature(media_id))):
            self._require(request)  # older links used the device token
        path = (self.media_dir / media_id / name).resolve()
        if self.media_dir.resolve() not in path.parents or not path.is_file():
            return _error(404, "not found")
        # Uploads were sniffed on arrival; never trust a file's extension over its bytes.
        upload = self.store.get_upload(media_id)
        mime = upload["mime"] if upload else mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        inline = mime in INLINE_IMAGE_TYPES or mime.startswith(("audio/", "video/"))
        # Agent output is untrusted: an HTML or SVG file must never run as part of the app's origin.
        # Anything that isn't plain media downloads, and the sandbox CSP neuters it even if opened.
        headers = {
            "Cache-Control": "private, max-age=86400",
            "Content-Type": mime if inline else "application/octet-stream",
            "Content-Disposition": f"{'inline' if inline else 'attachment'}; filename*=UTF-8''{quote(path.name)}",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "X-Content-Type-Options": "nosniff",
        }
        return web.FileResponse(path, headers=headers)

    # -- websocket -------------------------------------------------------------------------

    async def h_ws(self, request: web.Request) -> web.StreamResponse:
        legacy = bool(request.query.get("token")) or request.headers.get("Authorization", "").lower().startswith("bearer ")
        device = self._device(request) if legacy else None
        if legacy and device is None:
            return _error(401, "not paired")
        ws = web.WebSocketResponse(heartbeat=25, max_msg_size=1024 * 1024)
        await ws.prepare(request)
        if device is None:
            # Current apps authenticate in the first frame, so the token never appears in a URL that a
            # proxy or tunnel might log.
            try:
                first = await ws.receive(timeout=10)
                data = json.loads(first.data) if first.type == WSMsgType.TEXT else {}
            except (asyncio.TimeoutError, ValueError, TypeError):
                data = {}
            if isinstance(data, dict) and data.get("type") == "auth":
                device = self.store.device_for_token(str(data.get("token") or ""))
            if device is None:
                await ws.close(code=4401, message=b"not paired")
                return ws
        bot, problem = self._requested_bot(request, device)
        if problem is not None:
            await ws.close(code=4404, message=b"no such bot")
            return ws
        self._sockets[ws] = {"device": device, "bot": bot}
        try:
            with self._bot_context(bot):
                hello = {"type": "hello", "server_id": self.server_id(), "bot": self.bot(), "device": device,
                         "me": self.me(device), **self.about(), "chats": self.visible_chats(device),
                         "typing": sorted(c for c in self._typing if self._in_bot(c)
                                          and self.can_see(device, self.store.get_chat(c))),
                         "pending": self.pending_for(device), "paused": self.paused_for(device)}
                if device.get("role") == "owner" and bot is None:
                    hello["bots"] = self.bots()
                await ws.send_json(hello)
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    data = json.loads(msg.data)
                except ValueError:
                    continue
                with self._bot_context(bot):
                    await self._on_ws(ws, device, data)
        finally:
            self._sockets.pop(ws, None)
        return ws

    async def _on_ws(self, ws: web.WebSocketResponse, device: Dict[str, Any], data: Dict[str, Any]) -> None:
        device = self.store.get_device(device["id"])
        if device is None:
            await ws.close(code=4401, message=b"unpaired")
            return
        kind = data.get("type")
        if kind == "ping":
            await ws.send_json({"type": "pong", "t": data.get("t")})
        elif kind == "message.send":
            with contextlib.suppress(MessageRejected):
                await self.user_message(device, str(data.get("chat_id") or ""), str(data.get("text") or ""),
                                        str(data.get("client_id") or ""))
        elif kind == "inbox.respond":
            try:
                await self.respond(str(data.get("id") or ""), choice=str(data.get("choice") or ""),
                                   answer=data.get("answer"), device=device)
            except Forbidden as exc:
                await ws.send_json({"type": "error", "message": str(exc)})
        elif kind == "presence":
            self._sockets[ws]["visible"] = bool(data.get("visible", True))

    def live_clients(self) -> int:
        """Sockets whose app is in the foreground (a backgrounded PWA may keep its socket briefly)."""
        return sum(1 for ws, meta in self._sockets.items() if not ws.closed and meta.get("visible", True))

    def _event_visible(self, device: Dict[str, Any], event: Dict[str, Any]) -> bool:
        """Members only hear about their own chats; owners hear everything."""
        if device.get("role") == "owner":
            return True
        if event.get("type") == "system.paused":
            return True
        if str(event.get("type") or "").startswith("system."):
            return False
        if event.get("type") == "chat.delete":
            return event.get("owner_device") == device["id"]
        chat_id = event.get("chat_id")
        if chat_id is None:
            for key in ("chat", "item", "message"):
                value = event.get(key)
                if isinstance(value, dict):
                    chat_id = value.get("id") if key == "chat" else value.get("chat_id")
                    break
        return chat_id is None or self.can_see(device, self.store.get_chat(chat_id))

    def _event_bot(self, event: Dict[str, Any]):
        """The bot an event is about (None: the main bot), or _ANY_BOT for server-wide events."""
        if "bot" in event:
            return event["bot"] or None
        chat = event.get("chat") if isinstance(event.get("chat"), dict) else None
        if chat is not None:
            return chat.get("bot") or None
        chat_id = event.get("chat_id")
        for key in ("item", "message"):
            if chat_id is None and isinstance(event.get(key), dict):
                chat_id = event[key].get("chat_id")
        if chat_id is None:
            return _ANY_BOT
        row = self.store.get_chat(chat_id)
        return (row.get("bot") or None) if row else _ANY_BOT

    async def broadcast(self, event: Dict[str, Any]) -> None:
        dead = []
        for ws, meta in list(self._sockets.items()):
            device = self.current_device(meta["device"]["id"])
            if device is None:
                dead.append(ws)
                with contextlib.suppress(Exception):
                    await ws.close(code=4401, message=b"unpaired")
                continue
            if not self._event_visible(device, event):
                continue
            event_bot = self._event_bot(event)
            if event_bot is not _ANY_BOT and event_bot != meta.get("bot"):
                continue
            out = event
            if "pending" in event:
                with self._bot_context(meta.get("bot")):
                    out = {**event, "pending": self.pending_for(device)}
            if event.get("type") == "system.paused" and device.get("role") != "owner":
                out = {**event, "paused": self._member_pause(event.get("paused"))}
            try:
                await ws.send_json(out)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._sockets.pop(ws, None)

    # -- devices, verification, audit ---------------------------------------------------------

    async def _close_device_sockets(self, device_id: str, code: int, reason: bytes) -> None:
        self._alive_cache.pop(device_id, None)
        for ws, meta in list(self._sockets.items()):
            if meta["device"]["id"] == device_id:
                with contextlib.suppress(Exception):
                    await ws.close(code=code, message=reason)

    async def h_devices(self, request: web.Request) -> web.Response:
        me = self._require(request)
        return _json({"devices": [{**d, "current": d["id"] == me["id"]} for d in self.store.list_devices()]})

    async def h_device_update(self, request: web.Request) -> web.Response:
        me = self._require(request)
        device_id = request.match_info["device_id"]
        body = await self._body(request)
        role = body.get("role")
        if role is not None and role not in ROLES:
            return _error(400, "role must be owner or member")
        before = self.store.get_device(device_id)
        if before is None:
            return _error(404, "no such device")
        try:
            after = self.store.update_device(device_id, name=str(body["name"]) if "name" in body else None, role=role)
        except ValueError as exc:
            return _error(400, str(exc))
        if after["name"] != before["name"]:
            self.audit("device.renamed", me, f"{before['name']} → {after['name']}")
        if after["role"] != before["role"]:
            self.audit("device.role", me, f"{after['name']}: {before['role']} → {after['role']}")
            if after["role"] == "member":
                self.home_chat(after)
            # Its view of chats and the inbox changes: make it reconnect and load them again.
            await self._close_device_sockets(device_id, 4000, b"role changed")
        return _json({"device": after})

    async def h_device_delete(self, request: web.Request) -> web.Response:
        me = self._require(request)
        device = self.store.get_device(request.match_info["device_id"])
        if device is None:
            return _error(404, "no such device")
        try:
            self.store.remove_device(device["id"], keep_an_owner=True)
        except ValueError as exc:
            return _error(400, str(exc))
        self.audit("device.removed", me, f"{device['name']} ({device['role']})")
        await self._close_device_sockets(device["id"], 4401, b"unpaired")
        return _json({"ok": True})

    async def h_pairing_code(self, request: web.Request) -> web.Response:
        """A single-use code for another phone, shown as a QR on this one."""
        me = self._require(request)
        body = await self._body(request)
        role = str(body.get("role") or "member")
        if role not in ROLES:
            return _error(400, "role must be owner or member")
        code = self.store.create_pair_code(role=role)
        self.audit("pairing_code", me, f"for a new {role}")
        return _json({"code": code, "role": role, "fingerprint": self.keys.fingerprint,
                      "expires_at": time.time() + 600})

    async def h_device_verify(self, request: web.Request) -> web.Response:
        """A phone paired before verified pairing (or by typing a code) proves it scanned a fresh code
        from this server, and registers the key it signs owner actions with."""
        device = self._require(request)
        # Redeems the same codes as /api/pair, so wrong guesses count against the same limit.
        throttle = "device:" + device["id"]
        if self._pair_throttled(throttle):
            return _error(429, "Too many attempts. Wait a minute and try again.")
        body = await self._body(request)
        try:
            data = self.keys.unseal_json(str(body.get("sealed") or ""), "verify", device["id"])
        except (keys.SealError, ValueError):
            self._pair_failed(throttle)
            return _error(400, "This verification couldn't be opened. Scan a new code and try again.")
        sign_key = str(data.get("sign_key") or "")
        if data.get("pinned") is not True or not keys.valid_public_key(sign_key):
            return _error(400, "Verify by scanning a code, so this phone can check the server's key.")
        if self.store.redeem_pair_code(str(data.get("code") or "")) is None:
            self._pair_failed(throttle)
            return _error(403, "This code is invalid or expired. Make a new one and try again.")
        self._pair_failures.pop(throttle, None)
        device = self.store.set_device_key(device["id"], sign_key)
        self.audit("device.verified", device, device["name"])
        return _json({"device": device, "me": self.me(device)})

    async def h_rotate_token(self, request: web.Request) -> web.Response:
        device = self._require(request)
        token = self.store.rotate_token(device["id"])
        if token is None:
            return _error(404, "no such device")
        self.audit("token.rotated", device, device["name"])
        return _json({"token": token})

    async def h_audit(self, request: web.Request) -> web.Response:
        self._require(request)
        try:
            before = int(request.query["before"]) if request.query.get("before") else None
            limit = int(request.query.get("limit") or 100)
        except ValueError:
            return _error(400, "before and limit must be numbers")
        return _json({"entries": self.store.list_audit(before=before, limit=limit)})

    # -- pickers (/model, /reasoning, /fast, command confirmations) ------------------------------

    async def post_picker(self, chat_id: str, kind: str, title: str, data: Dict[str, Any],
                          callback: Callable[..., Awaitable[Any]], ttl: float = PICKER_SECONDS) -> Dict[str, Any]:
        """A card in the chat the owner taps to answer. ``callback`` gets the choice and returns the
        reply, which replaces the card's question."""
        picker_id = new_id()
        meta = {"picker": {"id": picker_id, "kind": kind, **data, "status": "open", "expires_at": time.time() + ttl}}
        message = await self.post_message(chat_id, title, role="bot", meta=meta, push=False)
        self._pickers[picker_id] = {"callback": callback, "chat_id": chat_id, "message_id": message["id"],
                                    "kind": kind, "expires": time.monotonic() + ttl}
        return message

    async def _close_picker(self, message_id: str, text: Optional[str], **change: Any) -> Optional[Dict[str, Any]]:
        message = self.store.get_message(message_id)
        if message is None or "picker" not in (message.get("meta") or {}):
            return None
        meta = dict(message["meta"])
        meta["picker"] = {**meta["picker"], **change}
        updated = self.store.update_message(message_id, text if text is not None else message["text"], meta=meta)
        await self.broadcast({"type": "message.update", "chat_id": updated["chat_id"], "message": updated})
        return updated

    async def h_picker_select(self, request: web.Request) -> web.Response:
        device = self._require(request)
        picker_id = request.match_info["picker_id"]
        body = await self._body(request)
        entry = self._pickers.get(picker_id)
        if entry is None or time.monotonic() > entry["expires"]:
            self._pickers.pop(picker_id, None)
            message_id = str(body.get("message_id") or (entry or {}).get("message_id") or "")
            message = self.store.get_message(message_id) if message_id else None
            if message and (message.get("meta") or {}).get("picker", {}).get("id") == picker_id \
                    and self.can_see(device, self.store.get_chat(message["chat_id"])):
                await self._close_picker(message_id, None, status="expired")
            return _error(410, "This choice has expired. Run the command again for a new one.")
        message = self.store.get_message(entry["message_id"])
        if message is None or not self.can_see(device, self.store.get_chat(entry["chat_id"])):
            return _error(404, "no such picker")
        picker = message["meta"]["picker"]
        kind = entry["kind"]
        if kind == "model":
            provider, model = str(body.get("provider") or ""), str(body.get("model") or "")
            allowed = {(p.get("slug"), m) for p in picker.get("providers") or [] for m in p.get("models") or []}
            if (provider, model) not in allowed:
                return _error(400, "pick one of the models offered")
            args, label = (entry["chat_id"], model, provider), model
        else:
            value = str(body.get("value") or "")
            choices = {str(c.get("value")): str(c.get("label") or c.get("value")) for c in picker.get("choices") or []}
            if value not in choices:
                return _error(400, "pick one of the options offered")
            args, label = ((entry["chat_id"], value) if kind == "choice" else (value,)), choices[value]
        self._pickers.pop(picker_id, None)  # one answer per card
        try:
            reply = await entry["callback"](*args)
        except Exception:
            logger.warning("[winglet] picker callback failed", exc_info=True)
            reply = "That didn't work. Try the command again."
        updated = await self._close_picker(entry["message_id"], str(reply or message["text"]), status="done",
                                           selected=label, by=device["name"])
        self.audit("picker", device, f"{kind}: {label}")
        return _json({"message": updated})

    # -- your agent: model, providers, persona, memory, usage ------------------------------------

    def _need_hermes(self):
        if self.hermes is None:
            raise web.HTTPNotFound(text=json.dumps({"error": "This server can't do that yet."}), content_type="application/json")
        return self.hermes

    async def _call(self, fn, *args, **kwargs):
        """Run a Hermes function off the event loop; its refusals become 400s with Hermes's message."""
        h = self._need_hermes()
        try:
            if asyncio.iscoroutinefunction(fn):
                return await fn(*args, **kwargs)
            return await asyncio.to_thread(fn, *args, **kwargs)
        except h.HermesRefused as exc:
            raise web.HTTPBadRequest(text=json.dumps({"error": str(exc)}), content_type="application/json")
        except h.HermesUnavailable:
            raise web.HTTPNotFound(text=json.dumps({"error": "This Hermes version can't do that."}), content_type="application/json")

    async def h_agent(self, request: web.Request) -> web.Response:
        """The configured model, and the one a chat is really using when Hermes knows it."""
        device = self._require(request)
        h = self._need_hermes()
        configured = await self._call(h.configured_model)
        chat_id = request.query.get("chat") or ""
        chat = None
        if chat_id and self.chat_model is not None and self.can_see(device, self.store.get_chat(chat_id)):
            chat = self.chat_model(chat_id)
        return _json({"configured": configured, "chat": chat})

    async def h_models(self, request: web.Request) -> web.Response:
        self._require(request)
        data = await self._call(self._need_hermes().model_options)
        data["providers"] = [p for p in data["providers"] if p["authenticated"] and p["models"]]
        return _json(data)

    async def h_model_default(self, request: web.Request) -> web.Response:
        device = self._require(request)
        body = await self._body(request)
        provider, model = str(body.get("provider") or "").strip(), str(body.get("model") or "").strip()
        if not provider or not model:
            return _error(400, "provider and model are required")
        result = await self._call(self._need_hermes().set_default_model, provider, model, confirm=bool(body.get("confirm")))
        if result.get("ok"):
            self.audit("model.default", device, f"{result['provider']} · {result['model']}")
        return _json(result)

    async def h_providers(self, request: web.Request) -> web.Response:
        self._require(request)
        data = await self._call(self._need_hermes().model_options, include_unconfigured=True)
        providers = [{k: p[k] for k in ("slug", "name", "authenticated", "is_current", "auth_type", "key_env", "total_models", "warning")}
                     for p in data["providers"]]
        return _json({"providers": providers, "current": {"model": data["model"], "provider": data["provider"]}})

    async def h_provider_key(self, request: web.Request) -> web.Response:
        """Save a provider's API key. It arrives sealed to the server key and is never sent back."""
        device = self._require(request)
        h = self._need_hermes()
        refused = self._secrets_refused(device)
        if refused is not None:
            return refused
        body = await self._body(request)
        try:
            data = self.keys.unseal_json(str(body.get("sealed") or ""), "provider-key", device["id"])
        except (keys.SealError, ValueError):
            return _error(400, "The key couldn't be opened. Make sure the app is up to date and try again.")
        env, value = str(data.get("env") or ""), str(data.get("value") or "").strip()
        known = {p["key_env"] for p in (await self._call(h.model_options, include_unconfigured=True))["providers"] if p.get("key_env")}
        if env not in known or not _KEY_ENV.match(env):
            return _error(400, "That isn't a provider key this server knows.")
        if not value or len(value) > 4096 or any(c.isspace() for c in value):
            return _error(400, "That doesn't look like an API key.")
        check = await h.check_provider_key(env, value)
        if not check["ok"] and check["reachable"]:
            self.audit("provider.key", device, f"{env} rejected by the provider", outcome="refused")
            return _error(400, check["message"])
        await self._call(h.save_provider_key, env, value)
        self.audit("provider.key", device, f"{env} set (ends {value[-4:]})")
        return _json({"ok": True, "note": check.get("message", "")})

    async def h_provider_key_delete(self, request: web.Request) -> web.Response:
        device = self._require(request)
        env = request.match_info["env"]
        if not _KEY_ENV.match(env):
            return _error(400, "That isn't a provider key.")
        found = await self._call(self._need_hermes().remove_provider_key, env)
        if not found:
            return _error(404, "That key isn't set.")
        self.audit("provider.key", device, f"{env} removed")
        return _json({"ok": True})

    async def h_identity(self, request: web.Request) -> web.Response:
        self._require(request)
        persona = await self._call(self._need_hermes().read_persona)
        return _json({**persona, "bot": self.bot()})

    async def h_identity_put(self, request: web.Request) -> web.Response:
        device = self._require(request)
        body = await self._body(request)
        content = body.get("content")
        if not isinstance(content, str) or len(content) > MAX_PERSONA:
            return _error(400, f"The persona must be text, at most {MAX_PERSONA:,} characters.")
        await self._call(self._need_hermes().write_persona, content)
        self.audit("persona", device, f"edited ({len(content):,} characters); applies to new chats")
        return _json({"ok": True})

    async def h_memory(self, request: web.Request) -> web.Response:
        self._require(request)
        return _json(await self._call(self._need_hermes().memory))

    async def h_memory_edit(self, request: web.Request) -> web.Response:
        device = self._require(request)
        body = await self._body(request)
        action, target = str(body.get("action") or ""), str(body.get("target") or "")
        data = await self._call(self._need_hermes().edit_memory, action, target,
                                str(body.get("entry") or ""), str(body.get("content") or ""))
        what = "about you" if target == "user" else "in its notes"
        self.audit("memory", device, {"add": "added", "replace": "edited", "remove": "removed"}.get(action, action)
                   + f" an entry {what}")
        return _json(data)

    async def h_usage(self, request: web.Request) -> web.Response:
        self._require(request)
        try:
            days = int(request.query.get("days") or 30)
        except ValueError:
            return _error(400, "days must be a number")
        return _json(await self._call(self._need_hermes().usage, days))

    # -- bots: other Hermes profiles on this server ----------------------------------------------

    async def h_bots(self, request: web.Request) -> web.Response:
        """The bots on this server, and whether the gateway serves them all (Hermes's multi-profile mode)."""
        self._require(request)
        return _json(await asyncio.to_thread(self.bots_state, True))

    async def h_bot_create(self, request: web.Request) -> web.Response:
        """Make a new bot the way Hermes Desktop does, as a job (Hermes seeds its skills and tells the gateway)."""
        device = self._require(request)
        h = self._need_hermes()
        if _BOT.get():
            return _error(400, "Make new bots from the main bot.")
        body = await self._body(request)
        name = str(body.get("name") or "").strip().lower()
        title = str(body.get("title") or "").strip()[:60]
        persona = str(body.get("persona") or "").strip()
        if not _BOT_NAME.fullmatch(name) or name == "default":
            return _error(400, "Give it a short name: lowercase letters, numbers and dashes.")
        if not title:
            return _error(400, "Give it a name to show.")
        if len(persona) > MAX_PERSONA:
            return _error(400, f"The persona must be at most {MAX_PERSONA:,} characters.")
        if any(b["name"] == name for b in self.bots_state(fresh=True)["bots"]):
            return _error(409, f"There's already a bot called {name}.")
        job = await self._begin_job(request, device, "bot_create", {"bot": name, "message": f"Making {title}…"}, body=body)
        if isinstance(job, web.Response):
            return job
        self.audit("bot.create", device, f"made {title} ({name})")
        self._spawn(self._create_bot(job["id"], name, title, persona, str(body.get("description") or "").strip()[:300]))
        return _json({"job": job}, status=202)

    async def _create_bot(self, job_id: str, name: str, title: str, persona: str, description: str) -> None:
        h = self._need_hermes()
        try:
            await asyncio.to_thread(h.create_bot, name, title, persona, description)
        except h.HermesRefused as exc:
            await self._finish_job(job_id, "failed", _clip(str(exc), 300))
            return
        except Exception:
            logger.warning("[winglet] bot creation failed", exc_info=True)
            await self._finish_job(job_id, "failed", "The bot couldn't be made. The server log has the details.")
            return
        state = await asyncio.to_thread(self.bots_state, True)
        served = any(b["name"] == name and b.get("served") for b in state["bots"])
        await self._finish_job(job_id, "succeeded", f"{title} is ready." if served else
                               f"{title} is made. Restart the server to start it.", bot=name, needs_restart=not served)
        await self.broadcast({"type": "system.bots", "bot": None, "bots": state["bots"]})

    # -- the agent's pet: its animated face, from Hermes's pet store and petdex.dev ---------------

    def pet_signature(self, slug: str) -> str:
        """Pet images load in image views that can't send the device token, so their links are signed."""
        key = self.store.secret("media_key").encode()
        return hmac.new(key, f"pet:{slug}".encode(), hashlib.sha256).hexdigest()[:32]

    def _pet_thumb_url(self, slug: str) -> str:
        return f"/api/pets/{quote(slug)}/thumb?sig={self.pet_signature(slug)}"

    def _pet_view(self, sheet: Dict[str, Any]) -> Dict[str, Any]:
        """A pet as the app draws it: its spritesheet is a signed link, never a path on the server."""
        slug = sheet["slug"]
        view = {k: v for k, v in sheet.items() if k != "path"}
        view["sheet_url"] = f"/api/pets/{quote(slug)}/sheet?rev={sheet['revision']}&sig={self.pet_signature(slug)}"
        view["thumb_url"] = self._pet_thumb_url(slug)
        return view

    def _pet_slug(self, request: web.Request) -> str:
        slug = request.match_info["slug"]
        if not _PET_SLUG.fullmatch(slug):
            raise web.HTTPNotFound(text=json.dumps({"error": "No such pet."}), content_type="application/json")
        return slug

    def _pet_link_ok(self, request: web.Request, slug: str) -> bool:
        return self.hermes is not None and hmac.compare_digest(request.query.get("sig", ""), self.pet_signature(slug))

    async def _pet_changed(self) -> None:
        """Every phone redraws the agent's face: members see the same pet as owners."""
        await self.broadcast({"type": "pet.update", "bot": _BOT.get()})

    async def h_pet(self, request: web.Request) -> web.Response:
        """The pet showing for this bot, or none."""
        self._require(request)
        h = self.hermes
        if h is None or not self._has(h, "pets_available"):
            return _json({"pet": None})
        try:
            sheet = await asyncio.to_thread(h.active_pet)
        except Exception:
            logger.debug("[winglet] couldn't read the active pet", exc_info=True)
            sheet = None
        return _json({"pet": self._pet_view(sheet) if sheet else None})

    async def h_pets(self, request: web.Request) -> web.Response:
        self._require(request)
        h = self._need_hermes()
        # The gallery comes next and its first fetch from petdex is slow: start it now.
        with contextlib.suppress(Exception):
            h.prefetch_pet_catalog()
        data = await self._call(h.pets)
        for pet in data["pets"]:
            pet["thumb_url"] = self._pet_thumb_url(pet["slug"])
        return _json(data)

    async def h_pet_catalog(self, request: web.Request) -> web.Response:
        self._require(request)
        try:
            offset = max(0, int(request.query.get("offset") or 0))
        except ValueError:
            return _error(400, "offset must be a number")
        query = request.query.get("q", "").strip()[:100]
        try:
            # Within the app's request timeout. The fetch carries on and Hermes caches it, so asking
            # again in a moment gets the gallery.
            data = await asyncio.wait_for(self._call(self._need_hermes().pet_catalog, query, offset), PET_CATALOG_WAIT)
        except asyncio.TimeoutError:
            return _json({"loading": True, "total": 0, "pets": []})
        for pet in data["pets"]:
            pet["thumb_url"] = self._pet_thumb_url(pet["slug"])
        return _json(data)

    async def h_pet_sheet(self, request: web.Request) -> web.StreamResponse:
        slug = self._pet_slug(request)
        if not self._pet_link_ok(request, slug):
            return _error(404, "not found")
        try:
            sheet = await asyncio.to_thread(self.hermes.pet_sheet, slug)
        except Exception:
            sheet = None
        if not sheet:
            return _error(404, "not found")
        # A link names the version of the sheet it was made for, so that version never changes.
        current = request.query.get("rev") == sheet["revision"]
        return web.FileResponse(sheet["path"], headers={
            "Content-Type": sheet["mime"], "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=31536000, immutable" if current else "private, no-cache",
            "Content-Security-Policy": "default-src 'none'; sandbox"})

    async def h_pet_thumb(self, request: web.Request) -> web.Response:
        slug = self._pet_slug(request)
        if not self._pet_link_ok(request, slug):
            return _error(404, "not found")
        async with self._pet_thumbs:
            try:
                data = await asyncio.to_thread(self.hermes.pet_thumbnail, slug)
            except Exception:
                logger.debug("[winglet] pet thumbnail failed", exc_info=True)
                data = None
        if not data:
            return _error(404, "not found")
        return web.Response(body=data, headers={
            "Content-Type": "image/png", "Cache-Control": "private, max-age=604800", "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox"})

    async def h_pet_display(self, request: web.Request) -> web.Response:
        device = self._require(request)
        on = bool((await self._body(request)).get("enabled"))
        pet = await self._call(self._need_hermes().show_pet, on)
        self.audit("pet", device, f"showed {pet['name']}" if pet else "turned the pet off")
        await self._pet_changed()
        return _json({"enabled": on, "pet": pet})

    async def h_pet_adopt(self, request: web.Request) -> web.Response:
        """Make a pet the agent's face. One that isn't installed yet comes from petdex, as a job."""
        device = self._require(request)
        h = self._need_hermes()
        slug = self._pet_slug(request)
        body = await self._body(request)
        # A retried request answers as the first one did, and never undoes a choice made since.
        key = str(body.get("idempotency_key") or "")[:64]
        if key:
            if (existing := self.store.job_by_key(key)) is not None:
                return _json({"job": existing}, status=202)
            if key in self._pet_choices:
                return _json({"pet": self._pet_choices[key]})
        if await self._call(h.pet_installed, slug):
            pet = await self._call(h.adopt_pet, slug)
            if key:
                self._pet_choices[key] = pet
                while len(self._pet_choices) > PET_CHOICES_KEPT:
                    self._pet_choices.pop(next(iter(self._pet_choices)))
            self.audit("pet", device, f"chose {pet['name']}")
            await self._pet_changed()
            return _json({"pet": pet})
        job = await self._begin_job(request, device, "pet_install", {"pet": slug, "message": f"Getting {slug} from petdex…"},
                                    body=body)
        if isinstance(job, web.Response):
            return job
        self.audit("pet", device, f"adopted {slug} from petdex")
        self._spawn(self._adopt_pet(job["id"], slug))
        return _json({"job": job}, status=202)

    async def _adopt_pet(self, job_id: str, slug: str) -> None:
        h = self._need_hermes()
        try:
            pet = await asyncio.to_thread(h.adopt_pet, slug)
        except h.HermesRefused as exc:
            await self._finish_job(job_id, "failed", _clip(str(exc), 300))
            return
        except Exception:
            logger.warning("[winglet] pet install failed", exc_info=True)
            await self._finish_job(job_id, "failed", "The pet couldn't be installed. The server log has the details.")
            return
        await self._finish_job(job_id, "succeeded", f"{pet['name']} is your agent's pet now.", pet=pet["slug"])
        await self._pet_changed()

    async def h_pet_remove(self, request: web.Request) -> web.Response:
        device = self._require(request)
        slug = self._pet_slug(request)
        if not await self._call(self._need_hermes().remove_pet, slug):
            return _error(404, "That pet isn't installed.")
        self.audit("pet", device, f"removed {slug}")
        await self._pet_changed()
        return _json({"ok": True})

    # -- control center: health, pause, restart, updates, logs, schedule --------------------------

    async def h_system(self, request: web.Request) -> web.Response:
        """Everything the Server screen shows at once: versions, host health, pause and recent jobs."""
        self._require(request)
        h = self._need_hermes()
        host = await asyncio.to_thread(h.system_stats)
        try:
            paused = await asyncio.to_thread(h.paused)
            can_pause = True
        except h.HermesUnavailable:
            paused, can_pause = None, False
        return _json({"version": VERSION, "hermes_version": self.hermes_version() or "",
                       "uptime_seconds": int(time.time() - self.started_at), "host": host,
                       "paused": paused, "can_pause": can_pause, "connection": self.connection,
                       "devices": len(self.store.list_devices()), "jobs": self.store.list_jobs(limit=5)})

    def paused_for(self, device: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Whether new work is on hold. Members learn that it is, not the owner's note about why."""
        if self.hermes is None:
            return None
        try:
            state = self.hermes.paused()
        except Exception:
            return None
        return state if device.get("role") == "owner" else self._member_pause(state)

    @staticmethod
    def _member_pause(state: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        return {"reason": None, "engaged_at": state.get("engaged_at")} if state else None

    async def h_pause(self, request: web.Request) -> web.Response:
        """Hold all new work (Hermes's /pause) or let it continue. Running turns are not cut off."""
        device = self._require(request)
        body = await self._body(request)
        on = bool(body.get("paused"))
        reason = _clip(str(body.get("reason") or ""), 200) or f"Paused from {device['name']}"
        state = await self._call(self._need_hermes().set_paused, on, reason)
        self.audit("system.pause", device, f"paused new work: {reason}" if on else "resumed new work")
        await self.broadcast({"type": "system.paused", "paused": state})
        return _json({"paused": state})

    def _busy_job(self) -> Optional[Dict[str, Any]]:
        return next((j for j in self.store.list_jobs(running=True) if j["detail"].get("boot") == self.boot_id), None)

    async def h_restart(self, request: web.Request) -> web.Response:
        device = self._require(request)
        h = self._need_hermes()
        job = await self._begin_job(request, device, "restart", {"message": "Restarting…"})
        if isinstance(job, web.Response):
            return job
        self.audit("system.restart", device, "restarted the gateway")
        self._spawn(self._restart_soon(job["id"], h))
        return _json({"job": job}, status=202)

    async def h_update(self, request: web.Request) -> web.Response:
        device = self._require(request)
        h = self._need_hermes()
        body = await self._body(request)
        target = str(body.get("target") or "")
        if target not in ("hermes", "winglet"):
            return _error(400, "target must be hermes or winglet")
        if target == "hermes":
            detail = {"from": self.hermes_version() or "", "message": "Starting the update…"}
        else:
            detail = {"from": VERSION, "message": "Downloading the new version…"}
        job = await self._begin_job(request, device, f"{target}_update", detail, body=body)
        if isinstance(job, web.Response):
            return job
        self.audit("system.update", device, f"started a {'Hermes' if target == 'hermes' else 'Winglet'} update")
        self._spawn(self._run_hermes_update(job["id"], h) if target == "hermes" else self._run_winglet_update(job["id"], h))
        return _json({"job": job}, status=202)

    async def _begin_job(self, request: web.Request, device: Dict[str, Any], kind: str, detail: Dict[str, Any],
                         body: Optional[Dict[str, Any]] = None):
        """Start a job, or return the one a retried request already started. One at a time."""
        body = body if body is not None else await self._body(request)
        key = str(body.get("idempotency_key") or "")[:64] or None
        if key:
            existing = self.store.job_by_key(key)
            if existing is not None:
                return _json({"job": existing}, status=202)
        busy = self._busy_job()
        if busy is not None:
            return _json({"error": "Something else is already in progress. Wait for it to finish.", "job": busy}, status=409)
        job, _ = self.store.create_job(kind, device_id=device["id"], idem_key=key, detail={**detail, "boot": self.boot_id})
        await self._job_event(job)
        return job

    async def _job_event(self, job: Optional[Dict[str, Any]]) -> None:
        if job is not None:
            await self.broadcast({"type": "system.job", "job": job})

    async def _finish_job(self, job_id: str, state: str, message: str, **detail: Any) -> None:
        await self._job_event(self.store.update_job(job_id, state=state, message=message, finished_at=time.time(), **detail))

    async def _restart_soon(self, job_id: str, h: Any) -> None:
        await asyncio.sleep(RESTART_DELAY_SECONDS)  # let the response and the job event reach the phone
        try:
            pid = await asyncio.to_thread(h.spawn_restart)
        except Exception as exc:
            logger.warning("[winglet] restart failed", exc_info=True)
            await self._finish_job(job_id, "failed", f"The restart couldn't start: {_clip(str(exc), 300)}")
            return
        await self._job_event(self.store.update_job(job_id, pid=pid, message="Restarting. Back in a moment…"))

    async def _run_hermes_update(self, job_id: str, h: Any) -> None:
        try:
            started = await h.start_hermes_update()
        except Exception as exc:
            logger.warning("[winglet] hermes update failed to start", exc_info=True)
            await self._finish_job(job_id, "failed", f"The update couldn't start: {_clip(str(exc), 300)}")
            return
        if not started.get("ok"):
            await self._finish_job(job_id, "failed", str(started.get("message") or "This install can't update itself."),
                                   command=str(started.get("update_command") or ""))
            return
        await self._job_event(self.store.update_job(job_id, action_id=started.get("action_id") or "",
                                                    message="Updating Hermes. This can take a few minutes…"))
        # Hermes restarts the gateway when it's done, which ends this process; the next one finishes
        # the job in reconcile_jobs. If it doesn't restart, the update's own status says how it went.
        deadline = time.monotonic() + UPDATE_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            await asyncio.sleep(3)
            try:
                status = await h.hermes_update_status()
            except Exception:
                continue
            if status.get("running") or status.get("exit_code") is None:
                self.store.update_job(job_id, lines=list(status.get("lines") or [])[-12:])
                continue
            ok = status.get("exit_code") == 0
            await self._finish_job(job_id, "succeeded" if ok else "failed",
                                   "Hermes is up to date." if ok else "The update didn't finish. Its log is below.",
                                   lines=list(status.get("lines") or [])[-20:])
            return
        await self._finish_job(job_id, "unknown", "The update is taking too long to report back. Check the server.")

    async def _run_winglet_update(self, job_id: str, h: Any) -> None:
        try:
            code, lines = await h.update_winglet()
        except Exception as exc:
            logger.warning("[winglet] plugin update failed", exc_info=True)
            await self._finish_job(job_id, "failed", f"The update couldn't start: {_clip(str(exc), 300)}")
            return
        if code != 0:
            await self._finish_job(job_id, "failed", "The update didn't finish. Its output is below.", lines=lines[-20:])
            return
        if any("already up to date" in line.lower() for line in lines):
            await self._finish_job(job_id, "succeeded", "Winglet is already up to date.", lines=lines[-6:])
            return
        await self._job_event(self.store.update_job(job_id, lines=lines[-12:], message="Updated. Restarting to load it…"))
        await self._restart_soon(job_id, h)

    async def reconcile_jobs(self) -> None:
        """Finish the jobs an earlier process started: a restart or update that ended it is done now."""
        h = self.hermes
        for job in self.store.list_jobs(running=True, limit=50):
            if job["detail"].get("boot") == self.boot_id:
                continue
            kind, detail = job["kind"], job["detail"]
            if kind == "restart":
                await self._finish_job(job["id"], "succeeded", "Back online.")
            elif kind == "winglet_update":
                await self._finish_job(job["id"], "succeeded", f"Updated to Winglet {VERSION}.", to=VERSION)
            elif kind == "hermes_update":
                now = self.hermes_version() or ""
                state, message, lines = "unknown", "The server restarted, but the update didn't report how it went.", []
                if h is not None:
                    try:
                        status = await h.hermes_update_status()
                    except Exception:
                        status = {}
                    lines = list(status.get("lines") or [])[-20:]
                    receipt = status.get("receipt") or {}
                    ours = detail.get("action_id") and status.get("action_id") == detail.get("action_id")
                    recent = _iso_ts(receipt.get("started_at")) >= job["created_at"] - 5
                    if ours or (recent and receipt.get("outcome") == "success"):
                        state, message = "succeeded", "Hermes is up to date."
                    elif recent and receipt.get("outcome"):
                        state, message = "failed", "The update didn't finish. Its log is below."
                if state == "unknown" and now and now != detail.get("from"):
                    state, message = "succeeded", "Hermes is up to date."
                await self._finish_job(job["id"], state, message, to=now, lines=lines)
            else:
                await self._finish_job(job["id"], "unknown", "Interrupted.")

    def expire_jobs(self, now: Optional[float] = None) -> None:
        """A job that never reported back (the server didn't come up again on its own) stops spinning."""
        cutoff = (now or time.time()) - UPDATE_TIMEOUT_SECONDS - 60
        for job in self.store.list_jobs(running=True, limit=50):
            if job["updated_at"] < cutoff:
                self.store.update_job(job["id"], state="unknown", message="This never reported back. Check the server.",
                                      finished_at=time.time())

    async def h_jobs(self, request: web.Request) -> web.Response:
        self._require(request)
        return _json({"jobs": self.store.list_jobs(limit=10)})

    async def h_job(self, request: web.Request) -> web.Response:
        self._require(request)
        job = self.store.get_job(request.match_info["job_id"])
        return _json({"job": job}) if job else _error(404, "no such job")

    async def h_system_updates(self, request: web.Request) -> web.Response:
        """Is a newer Hermes or Winglet available? Checked at most every ten minutes unless forced."""
        self._require(request)
        h = self._need_hermes()
        force = request.query.get("force") in ("1", "true")
        cached = self._update_check
        if cached and not force and time.monotonic() - cached["at"] < UPDATE_CHECK_SECONDS:
            return _json(cached["data"])
        try:
            hermes = await h.check_hermes_update(force=force)
        except Exception as exc:
            logger.info("[winglet] hermes update check failed: %s", exc)
            hermes = {"error": "Couldn't check for a Hermes update."}
        try:
            winglet = await asyncio.to_thread(h.check_winglet_update)
        except Exception as exc:
            logger.info("[winglet] winglet update check failed: %s", exc)
            winglet = {"update_available": None, "reason": "Couldn't check for a Winglet update."}
        data = {"hermes": hermes, "winglet": {**winglet, "version": VERSION}, "checked_at": time.time()}
        self._update_check = {"at": time.monotonic(), "data": data}
        return _json(data)

    async def h_logs(self, request: web.Request) -> web.Response:
        self._require(request)
        q = request.query
        try:
            lines = int(q.get("lines") or 300)
        except ValueError:
            return _error(400, "lines must be a number")
        data = await self._call(self._need_hermes().read_log, q.get("file") or "agent", lines=lines,
                                level=(q.get("level") or "").upper(), query=(q.get("q") or "")[:200])
        return _json(data)

    async def h_schedule(self, request: web.Request) -> web.Response:
        self._require(request)
        return _json({"routines": await self._call(self._need_hermes().list_schedule)})

    async def h_schedule_parse(self, request: web.Request) -> web.Response:
        """Preview a schedule as it's typed: "every weekday at 9am" → when it next runs."""
        self._require(request)
        text = str((await self._body(request)).get("schedule") or "").strip()
        if not text or len(text) > 200:
            return _error(400, "Say when it should run, like \"every day at 8am\".")
        return _json(await self._call(self._need_hermes().parse_schedule, text))

    @staticmethod
    def _routine_fields(body: Dict[str, Any], *, partial: bool) -> Dict[str, str]:
        out = {}
        for key, limit in (("name", 120), ("prompt", MAX_ROUTINE_PROMPT), ("schedule", 200)):
            if key in body or not partial:
                value = str(body.get(key) or "").strip()
                if len(value) > limit:
                    raise web.HTTPBadRequest(text=json.dumps({"error": f"The {key} is too long."}), content_type="application/json")
                if key != "name" and not value:
                    raise web.HTTPBadRequest(text=json.dumps({"error": f"The {key} is required."}), content_type="application/json")
                out[key] = value
        return out

    async def h_routine_create(self, request: web.Request) -> web.Response:
        device = self._require(request)
        fields = self._routine_fields(await self._body(request), partial=False)
        routine = await self._call(self._need_hermes().create_routine, fields["name"], fields["prompt"], fields["schedule"])
        self.audit("routine.create", device, f"{routine.get('name') or 'routine'} · {routine.get('schedule_display') or ''}")
        return _json({"routine": routine})

    async def h_routine_edit(self, request: web.Request) -> web.Response:
        device = self._require(request)
        fields = self._routine_fields(await self._body(request), partial=True)
        if not fields:
            return _error(400, "nothing to change")
        routine = await self._call(self._need_hermes().change_routine, request.match_info["routine_id"], "update", fields)
        if routine is None:
            return _error(404, "no such routine")
        self.audit("routine.edit", device, f"{routine.get('name') or 'routine'}: changed {', '.join(sorted(fields))}")
        return _json({"routine": routine})

    async def h_routine_delete(self, request: web.Request) -> web.Response:
        device = self._require(request)
        result = await self._call(self._need_hermes().change_routine, request.match_info["routine_id"], "delete")
        if not (result or {}).get("deleted"):
            return _error(404, "no such routine")
        self.audit("routine.delete", device, request.match_info["routine_id"])
        return _json({"ok": True})

    async def h_routine_action(self, request: web.Request) -> web.Response:
        device = self._require(request)
        action = request.match_info["action"]
        if action not in ("pause", "resume", "run"):
            return _error(404, "unknown action")
        routine = await self._call(self._need_hermes().change_routine, request.match_info["routine_id"], action)
        if routine is None:
            return _error(404, "no such routine")
        verb = {"pause": "paused", "resume": "resumed", "run": "ran now"}[action]
        self.audit(f"routine.{action}", device, f"{routine.get('name') or 'routine'} {verb}")
        return _json({"routine": routine})

    # -- abilities: skills, toolsets, MCP servers -------------------------------------------

    def _ability_name(self, request: web.Request) -> str:
        name = request.match_info["name"]
        if not _ABILITY_NAME.match(name):
            raise web.HTTPNotFound(text=json.dumps({"error": "not found"}), content_type="application/json")
        return name

    # -- sessions: past conversations on every platform, read-only ---------------------------------

    @staticmethod
    def _has(hermes, check: str) -> bool:
        try:
            return bool(getattr(hermes, check)())
        except Exception:
            return False

    async def h_sessions(self, request: web.Request) -> web.Response:
        self._require(request)
        try:
            limit = min(max(int(request.query.get("limit") or 30), 1), 100)
            offset = max(int(request.query.get("offset") or 0), 0)
        except ValueError:
            return _error(400, "limit and offset must be numbers")
        return _json(await self._call(self._need_hermes().list_sessions, limit, offset))

    async def h_session_search(self, request: web.Request) -> web.Response:
        self._require(request)
        query = request.query.get("q", "").strip()
        if not query:
            return _json({"results": []})
        if len(query) > 200:
            return _error(400, "That search is too long.")
        return _json({"results": await self._call(self._need_hermes().search_sessions, query)})

    async def h_session(self, request: web.Request) -> web.Response:
        self._require(request)
        session_id = request.match_info["session_id"]
        if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,200}", session_id):
            return _error(404, "No such session.")
        return _json(await self._call(self._need_hermes().session_transcript, session_id))

    async def h_skills(self, request: web.Request) -> web.Response:
        self._require(request)
        return _json({"skills": await self._call(self._need_hermes().list_skills)})

    async def h_skill_catalog(self, request: web.Request) -> web.Response:
        self._require(request)
        return _json({"skills": await self._call(self._need_hermes().skill_catalog)})

    async def h_skill_content(self, request: web.Request) -> web.Response:
        self._require(request)
        return _json(await self._call(self._need_hermes().skill_content, self._ability_name(request)))

    async def h_skill_toggle(self, request: web.Request) -> web.Response:
        device = self._require(request)
        name = self._ability_name(request)
        enabled = bool((await self._body(request)).get("enabled"))
        await self._call(self._need_hermes().set_skill_enabled, name, enabled)
        self.audit("skill.toggle", device, f"{name} turned {'on' if enabled else 'off'}")
        return _json({"ok": True, "name": name, "enabled": enabled})

    async def h_skill_install(self, request: web.Request) -> web.Response:
        """Install one of Hermes's official skills, as a job: it runs `hermes skills install`."""
        device = self._require(request)
        h = self._need_hermes()
        body = await self._body(request)
        identifier = str(body.get("identifier") or "")
        skill = next((s for s in await self._call(h.skill_catalog) if s["identifier"] == identifier), None)
        if skill is None:
            return _error(400, "Only Hermes's official skills can be installed from the app.")
        name = skill["name"]
        job = await self._begin_job(request, device, "skill_install", {"skill": name, "message": f"Installing {name}…"},
                                    body=body)
        if isinstance(job, web.Response):
            return job
        self.audit("skill.install", device, f"installed {identifier}")
        self._spawn(self._follow_action(job["id"], lambda: h.start_skill_install(identifier), h.finish_skill_action,
                                        f"{name} is installed.", f"{name} didn't install. Its output is below."))
        return _json({"job": job}, status=202)

    async def h_skill_uninstall(self, request: web.Request) -> web.Response:
        device = self._require(request)
        h = self._need_hermes()
        name = self._ability_name(request)
        skill = next((s for s in await self._call(h.list_skills) if s["name"] == name), None)
        if skill is None:
            return _error(404, "There's no skill by that name.")
        if skill["provenance"] != "hub":
            return _error(400, "This skill comes with Hermes. Turn it off instead.")
        job = await self._begin_job(request, device, "skill_uninstall", {"skill": name, "message": f"Removing {name}…"})
        if isinstance(job, web.Response):
            return job
        self.audit("skill.uninstall", device, f"removed {name}")
        self._spawn(self._follow_action(job["id"], lambda: h.start_skill_uninstall(name), h.finish_skill_action,
                                        f"{name} is removed.", f"{name} wasn't removed. Its output is below."))
        return _json({"job": job}, status=202)

    async def _follow_action(self, job_id: str, start: Callable[[], Awaitable[Optional[str]]],
                             after: Optional[Callable[[], None]], done: str, failed: str) -> None:
        """Run a Hermes background action (an install) as a job, until it exits."""
        h = self._need_hermes()
        try:
            action = await start()
        except Exception as exc:
            logger.warning("[winglet] action failed to start", exc_info=True)
            await self._finish_job(job_id, "failed", _clip(str(exc), 300) or failed)
            return
        if action:
            self.store.update_job(job_id, action=action)
            deadline = time.monotonic() + ACTION_TIMEOUT_SECONDS
            status: Dict[str, Any] = {}
            while time.monotonic() < deadline:
                await asyncio.sleep(ACTION_POLL_SECONDS)
                try:
                    status = await h.action_status(action)
                except Exception:
                    continue
                if not status.get("running") and status.get("exit_code") is not None:
                    break
                self.store.update_job(job_id, lines=list(status.get("lines") or [])[-12:])
            else:
                await self._finish_job(job_id, "unknown", "This is taking too long to report back. Check the server.")
                return
            if status.get("exit_code") != 0:
                await self._finish_job(job_id, "failed", failed, lines=list(status.get("lines") or [])[-20:])
                return
        if after is not None:
            await asyncio.to_thread(after)
        # The installer's output (its security scan) only matters when something went wrong.
        await self._finish_job(job_id, "succeeded", done, lines=[])

    def member_tools(self) -> Dict[str, Any]:
        """Whether members' tools are limited, and to what. Off until an owner turns it on."""
        try:
            saved = json.loads(self.store.get_kv("member_tools") or "{}")
        except ValueError:
            saved = {}
        toolsets = saved.get("toolsets")
        return {"limited": bool(saved.get("limited")), "mcp": bool(saved.get("mcp")),
                "toolsets": [str(t) for t in toolsets] if isinstance(toolsets, list) else list(MEMBER_TOOLSETS)}

    def member_toolsets(self, device_id: str) -> Optional[List[str]]:
        """The tools a turn from this device may use: None for an owner, or for a member while their tools
        aren't limited. A device that isn't paired any more gets none."""
        device = self.current_device(device_id)
        if device is not None and device["role"] == "owner":
            return None
        limits = self.member_tools()
        if device is not None and not limits["limited"]:
            return None
        h = self._need_hermes()
        if device is None:
            return list(h.NO_TOOLS)
        return h.member_toolsets(limits["toolsets"], limits["mcp"])

    async def h_toolsets(self, request: web.Request) -> web.Response:
        self._require(request)
        h = self._need_hermes()
        return _json({"toolsets": await self._call(h.toolsets), "approvals": await self._call(h.approval_mode),
                      "members": {**self.member_tools(), "can_limit": self.limits_members}})

    async def h_toolset_toggle(self, request: web.Request) -> web.Response:
        device = self._require(request)
        name = self._ability_name(request)
        enabled = bool((await self._body(request)).get("enabled"))
        await self._call(self._need_hermes().set_toolset, name, enabled)
        self.audit("toolset.toggle", device, f"{name} turned {'on' if enabled else 'off'}")
        return _json({"ok": True, "name": name, "enabled": enabled})

    async def h_approvals(self, request: web.Request) -> web.Response:
        """How risky commands are approved: ask an owner (manual), let a model decide the low-risk ones
        (smart), or never ask (off)."""
        device = self._require(request)
        mode = str((await self._body(request)).get("mode") or "")
        await self._call(self._need_hermes().set_approval_mode, mode)
        self.audit("approvals.mode", device, f"approvals set to {mode}")
        return _json({"ok": True, "approvals": mode})

    async def h_member_tools(self, request: web.Request) -> web.Response:
        device = self._require(request)
        body = await self._body(request)
        toolsets = body.get("toolsets")
        if not isinstance(toolsets, list) or not all(isinstance(t, str) and _ABILITY_NAME.match(t) for t in toolsets):
            return _error(400, "toolsets must be a list of toolset names")
        if body.get("limited") and not self.limits_members:
            return _error(400, "This version of Hermes can't limit what members use. Update Hermes to turn this on.")
        known = {t["name"] for t in await self._call(self._need_hermes().toolsets)}
        limits = {"limited": bool(body.get("limited")), "mcp": bool(body.get("mcp")),
                  "toolsets": sorted(set(toolsets) & known)}
        self.store.set_kv("member_tools", json.dumps(limits))
        summary = ("limited members to " + (", ".join(limits["toolsets"]) or "no tools")
                   + (" and MCP servers" if limits["mcp"] else "")) if limits["limited"] else "gave members the same tools"
        self.audit("members.tools", device, summary)
        return _json({"members": limits})

    async def h_mcp(self, request: web.Request) -> web.Response:
        self._require(request)
        servers = await self._call(self._need_hermes().mcp_servers)
        return _json({"servers": servers, "needs_reload": self.mcp_changed, "can_reload": self.reload_mcp is not None})

    async def h_mcp_catalog(self, request: web.Request) -> web.Response:
        self._require(request)
        return _json(await self._call(self._need_hermes().mcp_catalog))

    def _secrets_refused(self, device: Dict[str, Any]) -> Optional[web.Response]:
        if device["platform"] == "web" and self.connection.get("mode") == "quick" \
                and os.environ.get("WINGLET_ALLOW_WEB_SECRETS", "").lower() not in ("1", "true", "yes", "on"):
            # Over the automatic tunnel the web app's own code passes through Cloudflare, so it can't
            # promise a typed key stays private. The Android app can; so can a direct connection.
            return _error(403, "For your security, add API keys from the Android app or over a direct connection. "
                               "To allow it from the web app anyway, set WINGLET_ALLOW_WEB_SECRETS=true on the server.")
        return None

    async def h_mcp_install(self, request: web.Request) -> web.Response:
        """Add a server from Hermes's catalog. Any keys it needs arrive sealed to the server key."""
        device = self._require(request)
        h = self._need_hermes()
        body = await self._body(request)
        name = str(body.get("name") or "")
        entry = next((e for e in (await self._call(h.mcp_catalog))["entries"] if e["name"] == name), None)
        if entry is None:
            return _error(404, "That server isn't in Hermes's catalog.")
        env: Dict[str, str] = {}
        if body.get("sealed"):
            refused = self._secrets_refused(device)
            if refused is not None:
                return refused
            try:
                data = self.keys.unseal_json(str(body["sealed"]), "mcp-env", device["id"])
            except (keys.SealError, ValueError):
                return _error(400, "The keys couldn't be opened. Make sure the app is up to date and try again.")
            values = data.get("env") if isinstance(data.get("env"), dict) else {}
            env = {str(k): str(v).strip() for k, v in values.items() if str(v).strip()}
        if any(len(v) > 4096 for v in env.values()):
            return _error(400, "One of those values is too long.")
        missing = [e["name"] for e in entry.get("required_env") or [] if e.get("required") and not env.get(e["name"])]
        if missing:
            return _error(400, f"{name} needs {', '.join(missing)}.")
        summary = f"added {name}" + (f" with {', '.join(sorted(env))}" if env else "")
        if entry.get("needs_install"):
            job = await self._begin_job(request, device, "mcp_install", {"server": name, "message": f"Adding {name}…"},
                                        body=body)
            if isinstance(job, web.Response):
                return job
            self.audit("mcp.add", device, summary)
            self._spawn(self._follow_action(job["id"], lambda: h.install_mcp(name, env), self._mark_mcp_changed,
                                            f"{name} is added.", f"{name} wasn't added. Its output is below."))
            return _json({"job": job}, status=202)
        await self._call(h.install_mcp, name, env)
        self.mcp_changed = True
        self.audit("mcp.add", device, summary)
        return _json({"ok": True, "needs_reload": True})

    def _mark_mcp_changed(self) -> None:
        self.mcp_changed = True

    async def h_mcp_toggle(self, request: web.Request) -> web.Response:
        device = self._require(request)
        name = self._ability_name(request)
        enabled = bool((await self._body(request)).get("enabled"))
        await self._call(self._need_hermes().set_mcp_enabled, name, enabled)
        self.mcp_changed = True
        self.audit("mcp.toggle", device, f"{name} turned {'on' if enabled else 'off'}")
        return _json({"ok": True, "name": name, "enabled": enabled, "needs_reload": True})

    async def h_mcp_remove(self, request: web.Request) -> web.Response:
        device = self._require(request)
        name = self._ability_name(request)
        await self._call(self._need_hermes().remove_mcp, name)
        self.mcp_changed = True
        self.audit("mcp.remove", device, f"removed {name}")
        return _json({"ok": True, "needs_reload": True})

    async def h_mcp_test(self, request: web.Request) -> web.Response:
        """Connect to a server and list its tools. It runs the server's command, so it's signed."""
        self._require(request)
        return _json(await self._call(self._need_hermes().test_mcp, self._ability_name(request)))

    async def h_mcp_reload(self, request: web.Request) -> web.Response:
        device = self._require(request)
        if self.reload_mcp is None:
            return _error(404, "This server can't do that yet.")
        message = await self._call(self.reload_mcp)
        self.mcp_changed = False
        self.audit("mcp.reload", device, "reconnected MCP servers")
        return _json({"ok": True, "message": message})

    async def h_mcp_sign_in(self, request: web.Request) -> web.Response:
        """Start signing in to a server: the app opens the returned page, which comes back here."""
        device = self._require(request)
        name = self._ability_name(request)
        body = await self._body(request)
        base = str(body.get("callback_base") or self.connection.get("url") or "").rstrip("/")
        if not _CALLBACK_BASE.match(base):
            return _error(400, "callback_base must be the address the app uses for this server")
        flow = await self._call(self._need_hermes().start_mcp_sign_in, name,
                                f"{base}/api/mcp/oauth/{quote(name, safe='')}")
        self.audit("mcp.sign_in", device, f"started signing in to {name}")
        return _json({"sign_in": flow})

    async def h_mcp_sign_in_status(self, request: web.Request) -> web.Response:
        self._require(request)
        flow = await self._call(self._need_hermes().mcp_sign_in, request.match_info["flow_id"])
        return _json({"sign_in": flow}) if flow else _error(404, "That sign-in has ended. Start again.")

    async def h_mcp_sign_in_cancel(self, request: web.Request) -> web.Response:
        self._require(request)
        await self._call(self._need_hermes().cancel_mcp_sign_in, request.match_info["flow_id"])
        return _json({"ok": True})

    async def h_mcp_callback(self, request: web.Request) -> web.Response:
        """Where a server's sign-in page sends the browser back. Only a sign-in this server started, with
        the exact state it was given, accepts it."""
        h = self.hermes
        q = request.query
        outcome = "expired" if h is None else await asyncio.to_thread(
            h.finish_mcp_sign_in, request.match_info["name"], code=q.get("code"), state=q.get("state"),
            error=q.get("error"), iss=q.get("iss"))
        title, text, status = {
            "ok": ("Signed in", "You can close this page and go back to Winglet.", 200),
            "denied": ("Sign-in cancelled", "Go back to Winglet to try again.", 400),
            "rejected": ("This link was already used", "Go back to Winglet to try again.", 409),
        }.get(outcome, ("This sign-in has expired", "Go back to Winglet and start again.", 404))
        return web.Response(text=SIGN_IN_PAGE.format(title=title, body=text), status=status,
                            content_type="text/html", headers={"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
                                                               "Referrer-Policy": "no-referrer"})

    # -- push ------------------------------------------------------------------------------

    def schedule_push(self, chat_id: str, message_id: str, *, final: bool) -> None:
        """Debounced per chat so a streamed reply produces one notification with the final text."""
        task = self._push_tasks.pop(chat_id, None)
        if task is not None:
            task.cancel()
        delay = 0.3 if final else PUSH_DEBOUNCE_SECONDS
        self._push_tasks[chat_id] = asyncio.ensure_future(self._delayed_push(chat_id, message_id, delay))

    async def _delayed_push(self, chat_id: str, message_id: str, delay: float) -> None:
        try:
            await asyncio.sleep(delay)
        except asyncio.CancelledError:
            return
        self._push_tasks.pop(chat_id, None)
        if self.live_clients():
            return
        message = self.store.get_message(message_id)
        if message is None or not message["text"].strip():
            return
        chat = self.store.get_chat(chat_id) or {"title": chat_id}
        with self._bot_context(chat.get("bot") or None):
            bot = self.bot()["title"]
        title = bot if chat_id != HOME_CHAT_ID else f"{bot} · Update"
        if chat.get("kind") == "chat" and chat.get("title") not in ("", "General"):
            title = f"{bot} · {chat['title']}"
        await self.push_now({"title": title, "body": _clip(message["text"], 180), "url": self.chat_path(chat_id),
                             "kind": "message", "chat_id": chat_id}, tag=f"chat-{chat_id}")

    def chat_path(self, chat_id: str) -> str:
        """The app's route for a chat. Bots are told apart by server id; another bot on this server is
        `<server id>~<bot>`, as the app names it."""
        chat = self.store.get_chat(chat_id) or {}
        server = self.server_id() + (f"~{chat['bot']}" if chat.get("bot") else "")
        return f"/chat/{quote(server, safe='')}/{quote(chat_id, safe='')}"

    async def push_now(self, note: Dict[str, Any], *, tag: str, urgency: str = "normal",
                       item: Optional[Dict[str, Any]] = None, device_id: Optional[str] = None) -> Dict[str, int]:
        """Send ``note`` to every subscription (or only ``device_id``'s). Returns counts of deliveries the push
        services accepted, rejected, and dropped as expired (accepted is not proof the phone showed it)."""
        result = {"accepted": 0, "failed": 0, "expired": 0}
        subs = [sub for sub in self.store.list_push_subs() if device_id is None or sub["device_id"] == device_id]
        if not subs:
            return result
        client = await self._client()
        # No approve buttons on notifications: approving needs the card, with the full command in view.
        note = {**note, "tag": tag, "server_id": self.server_id()}
        devices: Dict[str, Optional[Dict[str, Any]]] = {}
        chat = self.store.get_chat(str(note.get("chat_id") or "")) if note.get("chat_id") else None
        for sub in subs:
            if sub["device_id"] not in devices:
                devices[sub["device_id"]] = self.store.get_device(sub["device_id"])
            if not _push_for(devices[sub["device_id"]], chat, note):
                continue
            if not _wants_push(self.store.get_push_prefs(sub["device_id"]), note):
                continue
            try:
                if sub["kind"] == "webpush":
                    status = await webpush.send(client, sub["data"], note, self.vapid_private_key(), PUSH_SUBJECT,
                                                urgency=urgency, topic=tag)
                elif sub["kind"] == "ntfy":
                    status = await self._send_ntfy(client, sub["data"], note)
                else:
                    continue
            except Exception as exc:
                logger.warning("[winglet] push delivery failed: %s", exc)
                result["failed"] += 1
                self._delivered[sub["id"]] = {"at": time.time(), "ok": False}
                continue
            self._delivered[sub["id"]] = {"at": time.time(), "ok": status < 300}
            if status in (404, 410) and sub["kind"] == "webpush":
                self.store.remove_push_sub(endpoint=sub["endpoint"])
                result["expired"] += 1
            elif status >= 300:
                logger.warning("[winglet] %s push rejected with HTTP %s", sub["kind"], status)
                result["failed"] += 1
            else:
                result["accepted"] += 1
        return result

    async def _client(self):
        if self._http is None:
            import httpx
            self._http = httpx.AsyncClient(timeout=15.0)
        return self._http

    async def aclose(self) -> None:
        if self._recovery_task:
            self._recovery_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._recovery_task
            self._recovery_task = None
        if self._http is not None:
            with contextlib.suppress(Exception):
                await self._http.aclose()
            self._http = None

    def vapid_private_key(self) -> str:
        return self.store.secret("vapid_private_pem", webpush.generate_vapid_private_key)

    async def h_vapid(self, request: web.Request) -> web.Response:
        return _json({"public_key": webpush.vapid_public_key(self.vapid_private_key())})

    async def h_webpush_subscribe(self, request: web.Request) -> web.Response:
        device = self._require(request)
        body = await self._body(request)
        sub = body.get("subscription") or body
        endpoint = str(sub.get("endpoint") or "") if isinstance(sub, dict) else ""
        keys = (sub.get("keys") if isinstance(sub, dict) else None) or {}
        try:
            valid = (endpoint.startswith("https://") and len(webpush.b64url_decode(keys["p256dh"])) == 65
                     and len(webpush.b64url_decode(keys["auth"])) >= 16)
        except Exception:
            valid = False
        if not valid:
            return _error(400, "invalid push subscription")
        self.store.add_push_sub(device["id"], "webpush", endpoint,
                                {"endpoint": endpoint, "keys": {"p256dh": keys["p256dh"], "auth": keys["auth"]}})
        return _json({"ok": True})

    async def h_webpush_unsubscribe(self, request: web.Request) -> web.Response:
        device = self._require(request)
        body = await self._body(request)
        removed = self.store.remove_push_sub(endpoint=str(body.get("endpoint") or ""), device_id=device["id"])
        return _json({"ok": True, "removed": removed})

    async def h_ntfy(self, request: web.Request) -> web.Response:
        """Enable ntfy delivery for this device and return the private topic to subscribe to."""
        device = self._require(request)
        legacy_shared = self.store.get_kv("ntfy_topic")  # v0.1 gave every phone the same topic
        mine = [sub for sub in self.store.list_push_subs("ntfy")
                if sub["device_id"] == device["id"] and sub["data"].get("topic") != legacy_shared]
        if mine:
            topic = mine[0]["data"]["topic"]
        else:
            # One private topic per phone: unpairing a phone stops exactly its notifications.
            topic = "winglet-" + secrets.token_hex(12)
            if legacy_shared:
                self.store.remove_push_sub(endpoint=f"{self.ntfy_server}/{legacy_shared}", device_id=device["id"])
            self.store.add_push_sub(device["id"], "ntfy", f"{self.ntfy_server}/{topic}",
                                    {"server": self.ntfy_server, "topic": topic})
        return _json({"server": self.ntfy_server, "topic": topic,
                      "subscribe_url": f"{self.ntfy_server}/{topic}"})

    async def _send_ntfy(self, client, data: Dict[str, Any], note: Dict[str, Any]) -> int:
        # ntfy topics transit a third-party server, so only generic text is sent there.
        generic = {"approval": "needs your approval", "question": "has a question for you"}.get(
            note.get("kind", ""), "sent you a message")
        payload = {"topic": data["topic"], "title": self.bot()["title"], "message": f"{self.bot()['title']} {generic}",
                   "tags": ["winglet"], "priority": 4 if note.get("kind") in ("approval", "question") else 3,
                   # Opens the Android app on the same route the web notification uses.
                   "click": f"winglet:/{note.get('url') or '/'}"}
        resp = await client.post(data["server"], json=payload, timeout=15.0)
        return resp.status_code

    async def h_push_test(self, request: web.Request) -> web.Response:
        device = self._require(request)
        # Only to the device asking: testing one phone shouldn't ring every other one.
        result = await self.push_now({"title": self.bot()["title"], "body": "Notifications are working 🎉",
                                      "url": "/", "kind": "test"}, tag="test", device_id=device["id"])
        return _json({"ok": result["accepted"] > 0, **result})

    # -- static web app -----------------------------------------------------------------------

    async def h_static(self, request: web.Request) -> web.StreamResponse:
        tail = request.match_info.get("tail", "")
        if tail.startswith("api/"):
            return _error(404, "not found")
        root = self.web_root
        if root is None or not (root / "index.html").is_file():
            return web.Response(text=_NO_WEB_BUILD, content_type="text/html")
        root = root.resolve()
        candidate = (root / tail).resolve() if tail else root / "index.html"
        inside = candidate == root / "index.html" or root in candidate.parents
        found = inside and candidate.is_file()
        if not found:
            # A missing file (font, script, icon) is a 404, not the HTML shell: a browser handed HTML
            # for a font or script fails in confusing ways, and must not cache that answer.
            if "." in Path(tail).name or tail.startswith(("_expo/", "assets/")):
                return web.Response(status=404, text="not found", headers={"Cache-Control": "no-store"})
            # Client-side routes (/chat/abc) fall back to the SPA shell; Expo also emits <route>.html.
            html = (root / f"{tail}.html").resolve() if tail else None
            candidate = html if html and root in html.parents and html.is_file() else root / "index.html"
        headers = {"Cache-Control": "no-cache"}
        if found and tail.startswith(("_expo/static/", "assets/")):
            headers["Cache-Control"] = "public, max-age=31536000, immutable"
        ctype = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        if candidate.suffix == ".webmanifest":
            ctype = "application/manifest+json"
        return web.FileResponse(candidate, headers={**headers, "Content-Type": ctype})

    @staticmethod
    async def _body(request: web.Request) -> Dict[str, Any]:
        # body_exists, not can_read_body: a signed request's body has already been read (and cached).
        if not request.body_exists:
            return {}
        try:
            data = await request.json()
        except Exception:
            return {}
        return data if isinstance(data, dict) else {}


class _TooLarge(Exception):
    pass


async def _parts(reader):
    while True:
        part = await reader.next()
        if part is None:
            return
        yield part


# Used when the adapter can't read Hermes's own command list.
_DEFAULT_COMMANDS = [
    {"cmd": "/new", "hint": "Start a fresh conversation"},
    {"cmd": "/stop", "hint": "Stop what the agent is doing"},
    {"cmd": "/retry", "hint": "Retry the last reply"},
    {"cmd": "/undo", "hint": "Remove the last exchange"},
    {"cmd": "/model", "hint": "Show or switch the model"},
    {"cmd": "/compress", "hint": "Compress the conversation context"},
    {"cmd": "/usage", "hint": "Token usage for this session"},
    {"cmd": "/help", "hint": "Everything Hermes can do"},
]


def _clean_push_prefs(raw: Any) -> Dict[str, Any]:
    """Validate notification preferences: {muted: {chat_id|"*": until (0 = until turned off)},
    quiet: {start: "HH:MM", end: "HH:MM", utc_offset_min, allow_urgent}}."""
    if not isinstance(raw, dict):
        raise ValueError("expected an object")
    out: Dict[str, Any] = {}
    muted = raw.get("muted") or {}
    if not isinstance(muted, dict) or len(muted) > 200:
        raise ValueError("muted must be an object of chat id to time")
    now = time.time()
    out["muted"] = {str(k)[:64]: float(v) for k, v in muted.items()
                    if isinstance(v, (int, float)) and (v == 0 or v > now)}
    quiet = raw.get("quiet")
    if quiet:
        if not isinstance(quiet, dict):
            raise ValueError("quiet must be an object")
        for key in ("start", "end"):
            if not (isinstance(quiet.get(key), str) and len(quiet[key]) == 5 and quiet[key][2] == ":"
                    and quiet[key][:2].isdigit() and quiet[key][3:].isdigit()
                    and int(quiet[key][:2]) < 24 and int(quiet[key][3:]) < 60):
                raise ValueError("quiet hours need start and end as HH:MM")
        offset = quiet.get("utc_offset_min", 0)
        if not isinstance(offset, (int, float)) or abs(offset) > 14 * 60:
            raise ValueError("utc_offset_min must be minutes from UTC")
        out["quiet"] = {"start": quiet["start"], "end": quiet["end"], "utc_offset_min": int(offset),
                        "allow_urgent": bool(quiet.get("allow_urgent", True))}
    return out


def _push_for(device: Optional[Dict[str, Any]], chat: Optional[Dict[str, Any]], note: Dict[str, Any]) -> bool:
    """Who a notification is for. A member hears about their own chats, except approvals, which only
    owners can answer. Owners hear about their chats, and approvals from anyone's."""
    if device is None:
        return False
    if note.get("kind") == "test" or chat is None:
        return device["role"] == "owner" or note.get("kind") == "test"
    member_chat = chat.get("owner_device")
    if device["role"] == "owner":
        return not member_chat or note.get("kind") == "approval"
    return member_chat == device["id"] and note.get("kind") != "approval"


def _wants_push(prefs: Dict[str, Any], note: Dict[str, Any], now: Optional[float] = None) -> bool:
    """Whether a device's preferences let this notification through. Approvals and questions block the
    agent, so a mute never silences them; quiet hours do unless urgent ones are allowed."""
    if not prefs:
        return True
    now = time.time() if now is None else now
    urgent = note.get("kind") in ("approval", "question")
    if note.get("kind") == "test":
        return True
    muted = prefs.get("muted") or {}
    if not urgent:
        for key in ("*", str(note.get("chat_id") or "")):
            until = muted.get(key)
            if until is not None and (until == 0 or until > now):
                return False
    quiet = prefs.get("quiet")
    if quiet and not (urgent and quiet.get("allow_urgent", True)):
        minute = int((now // 60 + quiet.get("utc_offset_min", 0)) % (24 * 60))
        start = int(quiet["start"][:2]) * 60 + int(quiet["start"][3:])
        end = int(quiet["end"][:2]) * 60 + int(quiet["end"][3:])
        inside = start <= minute < end if start <= end else (minute >= start or minute < end)
        if inside:
            return False
    return True


_NO_WEB_BUILD = """<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width">
<title>Winglet</title><body style="background:#1e1f22;color:#dbdee1;font:16px system-ui;padding:32px">
<h2>🪽 Winglet is running</h2><p>The web app isn't bundled in this install. Reinstall the plugin from a
release, or use the Android app.</p></body>"""
