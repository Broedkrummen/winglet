"""Winglet platform adapter: makes the Winglet app a Hermes messaging platform.

Hermes treats Winglet like Telegram or Discord: each app chat is a gateway chat (its own session),
approvals and clarify questions arrive through the standard adapter hooks, and cron routines can
deliver to the ``home`` chat. The adapter owns a :class:`~.hub.Hub` (HTTP + WebSocket + push) and
translates between the two.

Config (``.env`` or ``config.yaml`` ``platforms.winglet.extra``):
  WINGLET_ENABLED   true to start Winglet with the gateway
  WINGLET_HOST      bind address (default loopback for quick tunnels, 0.0.0.0 for direct access)
  WINGLET_PORT      port (default 8787)
  WINGLET_PUBLIC_URL  the URL your phone uses to reach this server (used in pairing QR codes)
  WINGLET_CONNECTION quick for automatic Cloudflare HTTPS, direct for a custom connection
  WINGLET_NTFY_SERVER ntfy server for Android notifications (default https://ntfy.sh)
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Coroutine, Dict, List, Optional

from gateway.config import Platform, PlatformConfig
from gateway.platforms._shared import extra_or_secret, get_scoped_secret, seed_extra_from_env
from gateway.platforms.base import BasePlatformAdapter, ExecApprovalPrompt, SendResult
from gateway.platforms.event import MessageEvent, MessageType

from . import bridge, cli, hermes_api, teamwork
from .dependencies import missing_dependencies
from .store import Store

if TYPE_CHECKING:
    from .hub import Hub

logger = logging.getLogger(__name__)

PLATFORM = "winglet"
# Each paired device is its own Hermes user ("winglet:<device id>"). Sessions don't change: Hermes keys a
# DM session by its chat id and leaves the sender out when there is one.
USER_PREFIX = "winglet:"
DEFAULT_PORT = 8787
GENERAL_CHAT_ID = "general"
RECONCILE_SECONDS = 5.0
MAX_MESSAGE_LENGTH = 16_000
_TRUTHY = ("1", "true", "yes", "on")

PLATFORM_HINT = (
    "You are talking to your owner through Winglet, their personal mobile app. It renders full "
    "Markdown (headings, lists, tables, code blocks, links and images). Keep replies easy to read on "
    "a phone: lead with the answer, use short paragraphs, and avoid very wide tables."
)


def data_dir() -> Path:
    """Per-profile state directory (``<hermes home>/plugin-data/winglet``)."""
    try:
        from plugins.plugin_storage import plugin_data_dir
        return plugin_data_dir("winglet")
    except Exception:
        from hermes_constants import get_hermes_home
        path = get_hermes_home() / "plugin-data" / "winglet"
        path.mkdir(parents=True, exist_ok=True)
        return path


def open_store() -> Store:
    return Store(data_dir() / "data.db")


def profile_info() -> Dict[str, Any]:
    """Name/title/description of the Hermes profile this gateway serves (its Bot Mode identity)."""
    from hermes_constants import get_hermes_home
    home = get_hermes_home()
    name = home.name if home.parent.name == "profiles" else "hermes"
    info = {"name": name, "title": name.replace("-", " ").title() if name != "hermes" else "Hermes",
            "description": ""}
    try:
        from hermes_cli.profiles import read_profile_meta
        meta = read_profile_meta(home)
        info["title"] = meta.get("bot_title") or meta.get("display_name") or info["title"]
        info["description"] = meta.get("description") or ""
    except Exception:
        logger.debug("[winglet] could not read profile metadata", exc_info=True)
    return info


def check_requirements() -> bool:
    return not missing_dependencies()


def validate_config(config) -> bool:
    return True


def is_connected(config) -> bool:
    extra = getattr(config, "extra", {}) or {}
    if extra.get("enabled"):
        return True
    return str(get_scoped_secret("WINGLET_ENABLED", "") or "").strip().lower() in _TRUTHY


def _env_enablement() -> Optional[dict]:
    if str(get_scoped_secret("WINGLET_ENABLED", "") or "").strip().lower() not in _TRUTHY:
        return None
    seed = seed_extra_from_env((
        ("WINGLET_HOST", "host", None),
        ("WINGLET_PORT", "port", int),
        ("WINGLET_PUBLIC_URL", "public_url", lambda v: v.rstrip("/")),
        ("WINGLET_CONNECTION", "connection", None),
        ("WINGLET_NTFY_SERVER", "ntfy_server", lambda v: v.rstrip("/")),
    ), home_env="WINGLET_HOME_CHANNEL", home_default="home")
    return {"enabled": True, **seed}


def _routine_name(job_id: str) -> str:
    try:
        from cron.jobs import get_job
        job = get_job(job_id) or {}
        name = str(job.get("name") or "").strip()
        # Bot Mode names routines "[bot:<name>] <routine>"; the app already shows which bot it is.
        if name.startswith("[bot:") and "]" in name:
            name = name.split("]", 1)[1].strip()
        return name[:100]
    except Exception:
        return ""


# Hermes wraps a routine's result in a header (its name and job id) and a footer about stopping it.
# The app labels the message with the routine's name, so only the result is kept. Hermes's own
# Yuanbao adapter does the same, with the same rule: leave anything that isn't exactly this shape.
_CRON_HEADER = "Cronjob Response: "
_CRON_DIVIDER = "\n-------------\n\n"
_CRON_FOOTER = '\n\nTo stop or manage this job, send me a new message (e.g. "stop reminder '


# Winglet's own chat ids: Updates, the main chat, side chats and members' chats. A routine set to
# deliver to "winglet:home" must reach exactly that chat; without this, Hermes would look "home" up by
# name among known chats and could pick one called "Homelab".
_CHAT_ID = re.compile(r"^(?:home|general|[cm]-[0-9a-f]{8,32})$")


def parse_target_ref(ref: str):
    """A Winglet chat id as written; anything else (a chat's name) goes on to Hermes's lookup."""
    ref = (ref or "").strip()
    return (ref, None) if _CHAT_ID.match(ref) else None


def _unwrap_routine(text: str) -> str:
    if not text.startswith(_CRON_HEADER):
        return text
    divider, footer = text.find(_CRON_DIVIDER), text.rfind(_CRON_FOOTER)
    if divider < 0 or footer <= divider or "\n(job_id: " not in text[:divider]:
        return text
    return text[divider + len(_CRON_DIVIDER):footer].strip() or text


def _strip_cursor(text: str) -> str:
    """Drop the streaming cursor Hermes appends to in-progress previews; the app draws its own."""
    stripped = text.rstrip()
    return stripped[:-1].rstrip() if stripped.endswith("▉") else text


def _strip_skip_hint(question: str) -> str:
    """The text-platform hint ('Reply "skip" to skip…') is noise next to the app's buttons."""
    hints = {'reply "skip" to skip this question.'}
    try:
        from agent.i18n import t
        hints.add(str(t("gateway.clarify.skip_hint")).strip().lower())
    except Exception:
        pass
    lines = [ln for ln in (question or "").splitlines() if ln.strip().lower() not in hints]
    return "\n".join(lines).strip() or question


class WingletAdapter(BasePlatformAdapter):
    MAX_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH
    # Always get the closing edit of a streamed reply so the app can mark it complete.
    REQUIRES_EDIT_FINALIZE = True

    def __init__(self, config: PlatformConfig):
        super().__init__(config=config, platform=Platform(PLATFORM))
        extra = config.extra or {}
        self._connection = str(extra_or_secret(extra, "connection", "WINGLET_CONNECTION", "direct") or "direct")
        default_host = "127.0.0.1" if self._connection == "quick" else "0.0.0.0"
        self._host = str(extra_or_secret(extra, "host", "WINGLET_HOST", default_host) or default_host)
        try:
            self._port = int(extra_or_secret(extra, "port", "WINGLET_PORT", DEFAULT_PORT) or DEFAULT_PORT)
        except (TypeError, ValueError):
            self._port = DEFAULT_PORT
        self._ntfy_server = str(extra_or_secret(extra, "ntfy_server", "WINGLET_NTFY_SERVER", "https://ntfy.sh"))
        self._public_url = str(extra_or_secret(extra, "public_url", "WINGLET_PUBLIC_URL", "") or "").rstrip("/")
        self._hub: Optional[Hub] = None
        self._runner = None
        self._tunnel = None
        self._reconcile_task: Optional[asyncio.Task] = None
        # (chat_id, status_key) -> message id, so a repeated status edits one line in place.
        self._status_ids: Dict[tuple, str] = {}

    # -- lifecycle -------------------------------------------------------------------------

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        if not check_requirements():
            logger.warning("[%s] Winglet dependencies unavailable; run hermes winglet setup", self.name)
            return False
        from .hub import Hub

        try:
            store = open_store()
            store.ensure_chat(GENERAL_CHAT_ID, "General")
            # Hermes keeps waiting approvals/questions in memory: after a restart none of the old cards
            # can be answered any more.
            for kind in ("approval", "question"):
                store.expire_pending(kind)
            hub = Hub(store, web_root=Path(__file__).parent / "web", bot_info=profile_info,
                      ntfy_server=self._ntfy_server)
            hub.connection = {"mode": self._connection, "url": None}
            hub.public_url = self._public_url or None
            hub.listen = f"{self._host}:{self._port}"
            hub.on_user_message = self._on_user_message
            hub.on_approval = self._on_approval
            hub.on_answer = self._on_answer
            hub.hermes_version = hermes_api.hermes_version
            hub.commands_provider = hermes_api.list_commands
            hub.hermes = hermes_api
            # Speech-to-text and text-to-speech from this profile's own configuration. The app only sees
            # the capability and provider names; keys and models stay on the server.
            hub.speech = hermes_api.SpeechBackend() if hermes_api.speech_available() else None
            hub.chat_model = self._chat_model
            # The app only offers goals when this Hermes has them (features.goals).
            hub.chat_goal = self._chat_goal if hermes_api.goals_available() else None
            hub.command_resolver = hermes_api.resolve_command
            hub.reload_mcp = self._reload_mcp
            # Other Hermes profiles this gateway serves are more bots on the same server (no new port or pairing).
            hub.bots_provider = self._bots_state if hermes_api.bots_available() else None
            if hub.bots_provider is not None:
                loop = asyncio.get_running_loop()
                teamwork.on_bots_changed = lambda: loop.call_soon_threadsafe(
                    lambda: asyncio.ensure_future(hub._bots_changed()))
            # Members' tool limits hold only if every turn's final toolsets can be capped (see toolset_limit).
            hub.limits_members = hermes_api.limit_turn_toolsets(self.gateway_runner, PLATFORM) \
                if getattr(self, "gateway_runner", None) is not None else False
            from gateway.platforms.shared_ingress import bind_listener
            # No access log: device tokens ride in WebSocket/media query strings and must not reach log files.
            self._runner = await bind_listener(self, hub.build_app(), self._host, self._port, "/api/ws",
                                               access_log=None)
            self._hub = hub
            if self._connection == "quick":
                from .tunnel import QuickTunnel, origin_url
                self._tunnel = QuickTunnel(data_dir(), origin_url(self._host, self._port), hub.server_id(),
                                           hub.set_connection, host_header=hub.tunnel_host)
                self._tunnel.start()
                hub.tunnel = self._tunnel
        except OSError as exc:
            logger.error("[%s] could not listen on %s:%s: %s", self.name, self._host, self._port, exc)
            self._set_fatal_error("winglet_bind_failed", f"Port {self._port} is unavailable: {exc}. "
                                  "Set WINGLET_PORT to a free port.", retryable=False)
            return False
        self._reconcile_task = asyncio.ensure_future(self._reconcile_loop())
        self._mark_connected()
        self._wire_plugin_handlers(None)
        logger.info("[%s] Winglet is listening on %s:%s — pair a phone with `hermes winglet pair`",
                    self.name, self._host, self._port)
        return True

    async def disconnect(self) -> None:
        self._running = False
        self._mark_disconnected()
        if self._tunnel is not None:
            await self._tunnel.stop()
            self._tunnel = None
        if self._reconcile_task is not None:
            self._reconcile_task.cancel()
            self._reconcile_task = None
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None
        if self._hub is not None:
            await self._hub.aclose()
            self._hub.store.close()
            self._hub = None

    # -- inbound -----------------------------------------------------------------------------

    async def _on_user_message(self, chat: Dict[str, Any], text: str, device: Dict[str, Any],
                               message: Dict[str, Any], files: Optional[list] = None,
                               reply: Optional[Dict[str, Any]] = None) -> None:
        source = self.build_source(
            chat_id=chat["id"], chat_name=chat.get("title") or chat["id"], chat_type="dm",
            user_id=USER_PREFIX + device["id"], user_name=device.get("name") or "Phone", message_id=message["id"],
            # The device proved itself with its pairing token before reaching this point.
            role_authorized=True)
        bot = chat.get("bot") or None
        if bot:
            if not self._serves(bot):
                # Hermes would quietly answer as the main bot instead; say what's wrong rather than pretend.
                await self._hub.post_message(chat["id"], "This bot isn't running yet. Restart the server so Hermes "
                                             "starts serving it, then send your message again.", role="system", push=False)
                return
            source.profile = bot
        media_urls, media_types, kinds = [], [], []
        for f in files or []:
            voice = f.get("kind") == "voice"
            try:
                path, media_type, kind = await hermes_api.cache_media(f["path"], f["name"], f["mime"], voice=voice)
            except Exception:
                logger.warning("[%s] could not pass %s to Hermes", self.name, f.get("name"), exc_info=True)
                continue
            media_urls.append(path)
            media_types.append(media_type)
            kinds.append("voice" if voice else kind)
        event = MessageEvent(
            text=text, message_type=_message_type(text, kinds),
            source=source, message_id=message["id"], raw_message=message, timestamp=datetime.now(tz=timezone.utc))
        if media_urls:
            event.media_urls = media_urls
            event.media_types = media_types
        if reply:
            # Hermes adds '[Replying to: "…"]' context for the agent, as it does for Telegram replies.
            event.reply_to_message_id = reply["id"]
            event.reply_to_text = reply["text"]
            event.reply_to_is_own_message = reply.get("role") == "bot"
        await self.handle_message(event)

    async def _on_approval(self, item: Dict[str, Any], choice: str) -> bool:
        # Only the exact request this card was shown for; a stale card must never approve a newer one.
        payload = item["payload"]
        return bridge.resolve_approval(payload.get("session_key") or "", payload.get("request_id") or "", choice)

    async def _on_answer(self, item: Dict[str, Any], answer: Any) -> bool:
        payload = item["payload"]
        return bridge.resolve_clarify(payload.get("clarify_id") or "",
                                      bridge.clarify_answer(answer, bool(payload.get("multi_select"))))

    # -- outbound ----------------------------------------------------------------------------

    async def send(self, chat_id: str, content: str, reply_to: Optional[str] = None,
                   metadata: Optional[Dict[str, Any]] = None) -> SendResult:
        hub = self._hub
        if hub is None:
            return SendResult(success=False, error="Winglet is not running", retryable=True)
        metadata = metadata or {}
        text = _strip_cursor(content or "")
        if metadata.get("job_id"):
            # A routine (cron job) delivered its result: keep it in the chat and surface it in the inbox.
            name = _routine_name(str(metadata["job_id"]))
            text = _unwrap_routine(text)
            message = await hub.post_message(chat_id, text, push=False, meta={"routine": name} if name else None)
            await hub.add_inbox("result", chat_id, f"Routine finished: {name}"[:120] if name else "Routine finished", text,
                                {"message_id": message["id"], "job_id": metadata["job_id"]})
        elif metadata.get("expect_edits"):
            message = await hub.post_message(chat_id, text, status="streaming")
        else:
            message = await hub.post_message(chat_id, text)
        return SendResult(success=True, message_id=message["id"])

    async def edit_message(self, chat_id: str, message_id: str, content: str, *,
                           finalize: bool = False) -> SendResult:
        hub = self._hub
        if hub is None:
            return SendResult(success=False, error="Winglet is not running")
        current = hub.store.get_message(message_id)
        inbox_id = (current or {}).get("meta", {}).get("inbox_id")
        if inbox_id:
            # Hermes edits an approval card when its request times out: the card is dead from here on.
            await hub.expire_item(inbox_id, _strip_cursor(content or ""))
        message = await hub.edit_message(message_id, _strip_cursor(content or ""), final=finalize)
        return SendResult(success=message is not None, message_id=message_id,
                          error=None if message else "message not found")

    # -- pickers: /model, /reasoning, /fast and command confirmations, as cards in the chat --------

    async def send_model_picker(self, chat_id: str, providers: list, current_model: str, current_provider: str,
                                session_key: str, on_model_selected, metadata: Optional[Dict[str, Any]] = None) -> SendResult:
        hub = self._hub
        if hub is None or hub.store.get_chat(str(chat_id)) is None:
            return SendResult(success=False, error="Winglet is not running")
        offered = [{"slug": str(p.get("slug") or ""), "name": str(p.get("name") or p.get("slug") or ""),
                    "models": [str(m) for m in (p.get("models") or [])], "custom_models": True}
                   for p in providers or [] if p.get("slug")]
        # Hermes's chat picker supplies only a preview (currently 50 models). Its shared
        # inventory has the complete cached catalog, including configured custom endpoints.
        try:
            chat = hub.store.get_chat(str(chat_id)) or {}
            with hub._bot_context(chat.get("bot") or None):
                catalog = await asyncio.to_thread(hermes_api.model_options)
            by_slug = {p["slug"]: p for p in offered}
            for p in catalog.get("providers") or []:
                if not p.get("authenticated"):
                    continue
                slug = p["slug"]
                previous = by_slug.get(slug, {})
                by_slug[slug] = {"slug": slug, "name": p.get("name") or slug, "custom_models": True,
                                 "models": list(dict.fromkeys([*(previous.get("models") or []), *(p.get("models") or [])]))}
            offered = list(by_slug.values())
        except Exception:
            logger.debug("[%s] full model inventory unavailable; using Hermes's preview", self.name, exc_info=True)
        if not offered:
            return SendResult(success=False, error="No models")
        message = await hub.post_picker(
            str(chat_id), "model", "Choose a model for this chat",
            {"current_model": current_model or "", "current_provider": current_provider or "",
             "current_label": hermes_api.provider_label(current_provider or ""), "providers": offered},
            on_model_selected)
        return SendResult(success=True, message_id=message["id"])

    async def send_choice_picker(self, chat_id: str, title: str, choices: list, session_key: str, on_choice_selected,
                                 metadata: Optional[Dict[str, Any]] = None) -> SendResult:
        hub = self._hub
        if hub is None or hub.store.get_chat(str(chat_id)) is None:
            return SendResult(success=False, error="Winglet is not running")
        options = [{"value": str(c.get("value") or ""), "label": str(c.get("label") or c.get("value") or ""),
                    "current": bool(c.get("is_current"))} for c in choices or [] if c.get("value")]
        if not options:
            return SendResult(success=False, error="No choices")
        message = await hub.post_picker(str(chat_id), "choice", _strip_cursor(title or "Choose"), {"choices": options},
                                        on_choice_selected)
        return SendResult(success=True, message_id=message["id"])

    async def send_slash_confirm(self, chat_id: str, title: str, message: str, session_key: str, confirm_id: str,
                                 metadata: Optional[Dict[str, Any]] = None) -> SendResult:
        hub = self._hub
        if hub is None or hub.store.get_chat(str(chat_id)) is None:
            return SendResult(success=False, error="Winglet is not running")

        async def resolve(choice: str) -> str:
            return await hermes_api.resolve_slash_confirm(session_key, confirm_id, choice)

        # Hermes gives up on a confirmation after five minutes; the card expires with it.
        posted = await hub.post_picker(
            str(chat_id), "confirm", _strip_cursor(title or "Confirm"),
            {"detail": _strip_cursor(message or ""), "choices": [
                {"value": "once", "label": "Approve once"}, {"value": "always", "label": "Always approve"},
                {"value": "cancel", "label": "Cancel"}]},
            resolve, ttl=300)
        return SendResult(success=True, message_id=posted["id"])

    def toolsets_for_source(self, source) -> Optional[List[str]]:
        """A member's tools, when an owner has limited them, as the list Hermes starts from. Hermes adds
        to it (default-on plugin toolsets, x_search), so toolset_limit caps the result too."""
        user_id = str(getattr(source, "user_id", "") or "")
        if self._hub is None or not user_id.startswith(USER_PREFIX):
            return None
        try:
            return self._hub.member_toolsets(user_id[len(USER_PREFIX):])
        except Exception:
            logger.warning("[%s] couldn't work out a member's tools; giving none this turn", self.name, exc_info=True)
            return list(hermes_api.NO_TOOLS)

    def toolset_limit(self, source) -> Optional[set]:
        """The most a turn from this app may use, after Hermes has resolved it: None for owners and for
        members whose tools aren't limited. Anything that goes wrong means no tools. The gateway asks the
        adapter each source is routed to, so each profile's devices are checked against its own store."""
        platform = getattr(source, "platform", None)
        user_id = str(getattr(source, "user_id", "") or "")
        if getattr(platform, "value", platform) != PLATFORM or not user_id.startswith(USER_PREFIX):
            return None
        hub = self._hub
        if hub is None:
            return set()
        try:
            allowed = hub.member_toolsets(user_id[len(USER_PREFIX):])
        except Exception:
            logger.warning("[%s] couldn't work out a member's tools; giving none this turn", self.name, exc_info=True)
            return set()
        return None if allowed is None else set(allowed) - set(hermes_api.NO_TOOLS)

    async def _reload_mcp(self) -> str:
        """Hermes's /reload-mcp for the bot the request is about, as if sent from its main chat, which also gets
        the note that tools changed. Hermes reloads the servers of the profile the message is routed to."""
        bot = hermes_api.current_bot()
        if bot and not self._serves(bot):
            raise hermes_api.HermesRefused("This bot isn't running yet. Restart the server and it connects its MCP "
                                           "servers as it starts.")
        chat_id = self._hub.home_chat({"role": "owner"}) if bot else GENERAL_CHAT_ID
        source = self.build_source(chat_id=chat_id, chat_name=chat_id if bot else "General", chat_type="dm",
                                   user_id=USER_PREFIX + "app", user_name="Winglet", role_authorized=True)
        if bot:
            source.profile = bot
        event = MessageEvent(text="/reload-mcp", message_type=MessageType.COMMAND, source=source,
                             timestamp=datetime.now(tz=timezone.utc))
        return await hermes_api.reload_mcp(getattr(self, "gateway_runner", None), event)

    def _session_key(self, chat_id: str) -> Optional[str]:
        """The key Hermes files this chat's session under, or None outside a gateway."""
        runner = getattr(self, "gateway_runner", None)
        if runner is None:
            return None
        source = self.build_source(chat_id=chat_id, chat_name=chat_id, chat_type="dm", user_id=USER_PREFIX + "app",
                                   user_name="Winglet", role_authorized=True)
        bot = self._bot_of(chat_id)
        if bot and self._serves(bot):
            source.profile = bot
        # The runner's own key (it adds the profile's namespace); a DM key leaves the sender out.
        key_for = getattr(runner, "_session_key_for_source", None)
        if key_for is None:
            from gateway.session import build_session_key as key_for
        return key_for(source)

    # -- bots: other profiles this gateway serves --------------------------------------------------

    def _bot_of(self, chat_id: str) -> Optional[str]:
        chat = self._hub.store.get_chat(chat_id) if self._hub is not None else None
        return (chat or {}).get("bot") or None

    def _serves(self, bot: str) -> bool:
        state = hermes_api.multiplex_state(getattr(self, "gateway_runner", None))
        return state["multiplex"] and bot in state["served"]

    def _bots_state(self) -> Dict[str, Any]:
        state = hermes_api.multiplex_state(getattr(self, "gateway_runner", None))
        bots = [{**b, "served": state["multiplex"] and b["name"] in state["served"]} for b in hermes_api.list_bots()]
        return {"bots": bots, "multiplex": state["multiplex"], "reason": state["reason"]}

    def _chat_model(self, chat_id: str) -> Optional[Dict[str, Any]]:
        try:
            key = self._session_key(chat_id)
            return hermes_api.chat_model(self.gateway_runner, key) if key else None
        except Exception:
            logger.debug("[%s] chat model unavailable", self.name, exc_info=True)
            return None

    def _chat_goal(self, chat_id: str) -> Optional[Dict[str, Any]]:
        try:
            key = self._session_key(chat_id)
            return hermes_api.chat_goal(self.gateway_runner, key) if key else None
        except Exception:
            logger.debug("[%s] chat goal unavailable", self.name, exc_info=True)
            return None

    async def send_or_update_status(self, chat_id: str, status_key: str, content: str, *,
                                    metadata: Optional[Dict[str, Any]] = None) -> SendResult:
        """Hermes's lifecycle and status notes (context pressure, compression, fallback): one line per
        kind, edited in place instead of a new bubble each time."""
        hub = self._hub
        if hub is None:
            return SendResult(success=False, error="Winglet is not running")
        text = _strip_cursor(content or "")
        key = (str(chat_id), str(status_key))
        cached = self._status_ids.get(key)
        if cached and hub.store.get_message(cached) is not None:
            message = await hub.edit_message(cached, text, final=True)
            if message is not None:
                return SendResult(success=True, message_id=cached)
        message = await hub.post_message(chat_id, text, role="system", meta={"status_key": str(status_key)}, push=False)
        self._status_ids[key] = message["id"]
        return SendResult(success=True, message_id=message["id"])

    async def delete_message(self, chat_id: str, message_id: str) -> bool:
        return bool(self._hub and await self._hub.delete_message(message_id))

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        if self._hub is not None:
            await self._hub.set_typing(chat_id, True)

    async def stop_typing(self, chat_id: str) -> None:
        if self._hub is not None:
            await self._hub.set_typing(chat_id, False)

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        chat = self._hub.store.get_chat(chat_id) if self._hub else None
        return {"name": (chat or {}).get("title") or chat_id, "type": "dm", "chat_id": chat_id}

    # -- approvals & questions ------------------------------------------------------------------

    def send_exec_approval(
        self, chat_id: str, command: str, session_key: str, description: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None, allow_permanent: bool = True, allow_session: bool = True,
        smart_denied: bool = False, *, request_id: Optional[str] = None,
    ) -> Coroutine[Any, Any, SendResult]:
        """Capture the notified ID synchronously, then let Hermes render/schedule its prompt.

        An async override would run after the notifier's frame has disappeared. This regular
        function returns the usual awaitable, with only the immutable ID copied across threads.
        Explicit identity takes precedence; stale/invalid supplied IDs never trigger inference.
        """
        metadata = dict(metadata or {})
        if request_id is not None:
            metadata["approval_request_id"] = request_id
        elif "approval_request_id" not in metadata:
            identity = bridge.notified_request_id(self, chat_id, session_key)
            if identity is not None:
                metadata["approval_request_id"] = identity
        return super().send_exec_approval(
            chat_id=chat_id, command=command, session_key=session_key, description=description,
            metadata=metadata, allow_permanent=allow_permanent, allow_session=allow_session,
            smart_denied=smart_denied)

    async def _send_exec_approval_prompt(self, prompt: ExecApprovalPrompt) -> SendResult:
        hub = self._hub
        if hub is None:
            return SendResult(success=False, error="Winglet is not running")
        labels = {choice: label for label, choice, _style in prompt.actions}
        styles = {choice: style for _label, choice, style in prompt.actions}
        claimed = {i["payload"].get("request_id") for i in hub.store.pending_items("approval")
                   if i["payload"].get("session_key") == prompt.session_key}
        # The ID must travel with the prompt, not be guessed from today's queue. The namespaced
        # metadata field is an integration contract for Hermes versions forwarding approval identity;
        # a native request_id on the prompt also supports versions adding it to ExecApprovalPrompt.
        identity = getattr(prompt, "request_id", None) or (prompt.metadata or {}).get("approval_request_id")
        request_id = bridge.pick_request_id(bridge.queued_approvals(prompt.session_key) or [], identity,
                                            {r for r in claimed if r})
        if request_id is None:
            logger.warning("[%s] approval identity unavailable; using Hermes' text approval flow",
                           self.name)
            # The gateway falls back to its /approve instructions when button delivery is unsupported.
            # Do not persist or push a card whose identity is unknown or already expired.
            return SendResult(success=False, error="An active approval request ID is required for buttons")
        item = await hub.add_inbox(
            "approval", prompt.chat_id, "Approval needed", prompt.command,
            {"command": prompt.command, "description": prompt.description, "choices": prompt.choices,
             "labels": labels, "styles": styles, "session_key": prompt.session_key,
             "request_id": request_id, "smart_denied": prompt.smart_denied})
        message = await hub.post_message(prompt.chat_id, prompt.description or "Approval needed", role="system",
                                         meta={"inbox_id": item["id"], "kind": "approval"}, push=False)
        return SendResult(success=True, message_id=message["id"])

    async def send_clarify(self, chat_id: str, question: str, choices: Optional[list], clarify_id: str,
                           session_key: str, metadata: Optional[Dict[str, Any]] = None) -> SendResult:
        hub = self._hub
        if hub is None:
            return SendResult(success=False, error="Winglet is not running")
        multi = False
        try:
            from tools import clarify_gateway as _cg
            with _cg._lock:
                multi = bool(getattr(_cg._entries.get(clarify_id), "multi_select", False))
        except Exception:
            pass
        question = _strip_skip_hint(question)
        item = await hub.add_inbox(
            "question", chat_id, "Question", question,
            {"question": question, "choices": [str(c) for c in (choices or [])], "clarify_id": clarify_id,
             "session_key": session_key, "multi_select": multi})
        message = await hub.post_message(chat_id, question, role="system",
                                         meta={"inbox_id": item["id"], "kind": "question"}, push=False)
        return SendResult(success=True, message_id=message["id"])

    async def retire_clarify_card(self, clarify_id: str, notice: Optional[str] = None) -> None:
        hub = self._hub
        if hub is None:
            return
        for item in hub.store.pending_items("question"):
            if item["payload"].get("clarify_id") == clarify_id:
                await hub.expire_item(item["id"], notice or "")

    async def _reconcile_loop(self) -> None:
        """Expire cards whose request ended elsewhere (timeout, /stop, answered in another client)."""
        while True:
            await asyncio.sleep(RECONCILE_SECONDS)
            try:
                await self._reconcile_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.debug("[%s] inbox reconcile failed", self.name, exc_info=True)

    async def _reconcile_once(self) -> None:
        hub = self._hub
        if hub is None:
            return
        for item in hub.store.pending_items():
            payload = item["payload"]
            if item["kind"] == "approval":
                queued = bridge.queued_approvals(payload.get("session_key") or "")
                if queued is not None and payload.get("request_id") not in {e.get("request_id") for e in queued}:
                    await hub.expire_item(item["id"])
            elif item["kind"] == "question" and bridge.clarify_pending(payload.get("clarify_id") or "") is False:
                await hub.expire_item(item["id"])

    # -- media ------------------------------------------------------------------------------------

    async def _send_attachment(self, chat_id: str, path: str, caption: Optional[str],
                               name: Optional[str] = None) -> SendResult:
        hub = self._hub
        if hub is None:
            return SendResult(success=False, error="Winglet is not running")
        try:
            # Off the event loop: an agent's video can be hundreds of MB.
            attachment = await asyncio.to_thread(hub.add_media, path, name)
        except OSError as exc:
            return SendResult(success=False, error=f"could not read {path}: {exc}")
        message = await hub.post_message(chat_id, caption or "", meta={"attachments": [attachment]})
        return SendResult(success=True, message_id=message["id"])

    async def send_image(self, chat_id: str, image_url: str, caption: Optional[str] = None,
                         reply_to: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None) -> SendResult:
        text = f"![image]({image_url})" + (f"\n\n{caption}" if caption else "")
        return await self.send(chat_id, text, reply_to=reply_to, metadata=metadata)

    async def send_image_file(self, chat_id: str, image_path: str, caption: Optional[str] = None,
                              reply_to: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None,
                              **kwargs) -> SendResult:
        return await self._send_attachment(chat_id, image_path, caption)

    async def send_document(self, chat_id: str, file_path: str, caption: Optional[str] = None,
                            file_name: Optional[str] = None, reply_to: Optional[str] = None,
                            metadata: Optional[Dict[str, Any]] = None, **kwargs) -> SendResult:
        return await self._send_attachment(chat_id, file_path, caption, file_name)

    async def send_voice(self, chat_id: str, audio_path: str, caption: Optional[str] = None,
                         reply_to: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None,
                         **kwargs) -> SendResult:
        return await self._send_attachment(chat_id, audio_path, caption)

    async def send_video(self, chat_id: str, video_path: str, caption: Optional[str] = None,
                         reply_to: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None,
                         **kwargs) -> SendResult:
        return await self._send_attachment(chat_id, video_path, caption)


def _message_type(text: str, kinds: list):
    """Voice beats documents beats photos, as other platforms do (a document turns on Hermes's
    document handling; a voice note turns on transcription)."""
    for kind, name in (("voice", "VOICE"), ("document", "DOCUMENT"), ("image", "PHOTO"), ("video", "VIDEO"),
                       ("audio", "AUDIO")):
        if kind in kinds:
            return getattr(MessageType, name)
    return MessageType.COMMAND if text.startswith("/") else MessageType.TEXT


def register(ctx) -> None:
    platform = dict(
        name=PLATFORM, label="Winglet", adapter_factory=lambda cfg: WingletAdapter(cfg),
        check_fn=check_requirements, validate_config=validate_config, is_connected=is_connected,
        required_env=[], install_hint="hermes winglet setup",
        env_enablement_fn=_env_enablement, cron_deliver_env_var="WINGLET_HOME_CHANNEL",
        max_message_length=MAX_MESSAGE_LENGTH, emoji="🪽", pii_safe=True, allow_update_command=True,
        platform_hint=PLATFORM_HINT)
    try:
        ctx.register_platform(**platform, parse_target_ref_fn=parse_target_ref)
    except TypeError:
        ctx.register_platform(**platform)  # a Hermes without target parsers looks targets up by name
    ctx.register_cli_command(
        name="winglet", help="Pair phones and manage the Winglet app",
        setup_fn=cli.setup_parser, handler_fn=cli.main,
        description="Winglet: your Hermes agents on your phone. Start with `hermes winglet setup`.")
    # Bots ask each other, and make new ones with an owner's approval.
    teamwork.register(ctx)
