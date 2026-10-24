"""Conversation branching, edit-and-resend and regeneration against real Hermes sessions.

The phone's rendered list is not the model transcript. This module maps a settled Winglet
message to the Hermes row it was persisted as (user rows keep the Winglet ``message.id`` in
``platform_message_id``; an assistant row is only used when it is the final assistant row of
that exchange), then either:

* creates a new Winglet chat whose Hermes session is seeded with the parent's real transcript
  prefix (non-destructive: the parent and its later messages are untouched), or
* rewinds the reviewed Hermes turn with durable compare-and-swap guards for an explicit
  in-place regeneration of the latest settled exchange.

Hermes' internal API is not stable, so the bridge fails the capability closed if the pinned
operations are missing. No endpoint is invented and no success is synthesized.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import re
import shutil
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .message_policy import is_tool_progress
from .store import new_id

logger = logging.getLogger(__name__)

MAX_TEXT = 16_000
MAX_TITLE = 80
OP_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{16,96}$")
# Metadata that makes a message an app-only card rather than a model transcript boundary.
NON_BOUNDARY_META = ("hidden", "picker", "status_key", "inbox_id", "routine", "activity")
# The same fields Hermes' own /branch copies into a child session.
COPIED_FIELDS = ("content", "tool_calls", "tool_call_id", "finish_reason", "reasoning",
                 "reasoning_content", "reasoning_details", "codex_reasoning_items",
                 "codex_message_items", "timestamp")


class BranchRefused(Exception):
    """A user-actionable refusal. ``code`` is one of the contract's wire codes."""

    def __init__(self, code: str, reason: str, status: int = 409):
        super().__init__(reason)
        self.code = code
        self.reason = reason
        self.status = status


# -- pure transcript/plan helpers ---------------------------------------------------------


def _text_hash(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8", "replace")).hexdigest()[:20]


def visible_messages(messages: List[Dict[str, Any]], limit: int = 4000) -> List[Dict[str, Any]]:
    """The substantive conversation, in insertion order.

    Offline bubbles, tool progress, hidden slash controls, picker/inbox cards, routine results
    and unfinished rows are not model transcript boundaries.
    """
    rows = sorted(messages, key=lambda m: (m.get("position") if m.get("position") is not None
                                           else int((m.get("created_at") or 0) * 1000)))
    out: List[Dict[str, Any]] = []
    for m in rows[-limit:]:
        meta = m.get("meta") or {}
        if m.get("role") not in ("user", "bot"):
            continue
        if m.get("status") != "final" or not (m.get("id") or "").strip():
            continue
        if any(meta.get(k) for k in NON_BOUNDARY_META):
            continue
        if not ((m.get("text") or "").strip() or meta.get("attachments")):
            continue
        if m["role"] == "bot" and not meta.get("attachments") and is_tool_progress(m.get("text") or ""):
            continue
        out.append(m)
    return out


def transcript_rows(transcript: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Only model-visible conversation rows; session metadata and unknown rows are skipped."""
    return [m for m in transcript if m.get("role") in ("user", "assistant", "tool")]


def _exchange_end(rows: List[Dict[str, Any]], start: int) -> int:
    """Exclusive end of the exchange that starts at user row ``start``: the next user row."""
    for i in range(start + 1, len(rows)):
        if rows[i].get("role") == "user":
            return i
    return len(rows)


def _user_rows_by_id(rows: List[Dict[str, Any]]) -> Dict[str, List[int]]:
    found: Dict[str, List[int]] = {}
    for i, row in enumerate(rows):
        if row.get("role") != "user":
            continue
        mid = str(row.get("message_id") or "").strip()
        if mid:
            found.setdefault(mid, []).append(i)
    return found


def _normalize(text: str) -> str:
    return " ".join((text or "").split())


@dataclass
class Plan:
    mode: str
    message_id: str
    copy: List[Dict[str, Any]]
    transcript_prefix: List[Dict[str, Any]]
    transcript_end: int
    later: int
    prompt: Optional[Dict[str, Any]] = None
    send_text: str = ""
    reply_to: Optional[Dict[str, Any]] = None
    in_place: bool = False
    user_row_index: Optional[int] = None


def plan_operation(messages: List[Dict[str, Any]], transcript: List[Dict[str, Any]], message_id: str,
                   mode: str, text: str = "", in_place: bool = False) -> Plan:
    """Resolve one operation against a snapshot. Raises :class:`BranchRefused` when the
    boundary cannot be proved to be a real model transcript boundary."""
    return _plan_at(visible_messages(messages), transcript_rows(transcript), message_id, mode, text, in_place)


def _plan_at(visible: List[Dict[str, Any]], rows: List[Dict[str, Any]], message_id: str,
             mode: str, text: str = "", in_place: bool = False) -> Plan:
    if mode not in ("edit", "branch", "regenerate"):
        raise BranchRefused("unsupported", "Unknown branch action.", 400)
    by_id = _user_rows_by_id(rows)
    index = next((i for i, m in enumerate(visible) if m.get("id") == message_id), None)
    if index is None:
        raise BranchRefused("unsupported", "That message isn't a settled part of this conversation.")
    target = visible[index]
    target_role = target.get("role")
    if mode == "edit" and target_role != "user":
        raise BranchRefused("unsupported", "Only your own messages can be edited.", 400)
    if mode == "regenerate" and target_role != "bot":
        raise BranchRefused("unsupported", "Only an assistant reply can be regenerated.", 400)

    # The user message that anchors this turn. Editing/regenerating a reply always anchors on
    # the prompt it answered; this is the prompt Herald's rewind targets too.
    if target_role == "user":
        prompt_index = index
    else:
        prompt_index = next((i for i in range(index - 1, -1, -1) if visible[i].get("role") == "user"), None)
        if prompt_index is None:
            raise BranchRefused("unsupported", "This reply has no user prompt in the conversation any more.")
    prompt = visible[prompt_index]
    prompt_rows = by_id.get(str(prompt.get("id") or "")) or []
    if not prompt_rows:
        raise BranchRefused("unsupported", "That prompt isn't in the model transcript yet. Wait for the reply to finish.")
    if len(prompt_rows) > 1:
        raise BranchRefused("unsupported", "That prompt has more than one transcript row; branching wouldn't be safe.")
    prompt_row = prompt_rows[0]
    exchange_end = _exchange_end(rows, prompt_row)

    if mode == "edit":
        # Everything before the edited prompt is the new branch's context. The edited text is
        # sent as a new prompt from there; the original prompt and later turns are untouched.
        copy_end = index
        transcript_end = prompt_row
        copy = visible[:copy_end]
        later = len(visible) - copy_end
        if not (text or "").strip():
            raise BranchRefused("unsupported", "Type the replacement message first.", 400)
        return Plan("edit", message_id, copy, rows[:transcript_end], transcript_end, later,
                    prompt=target, send_text=text.strip()[:MAX_TEXT],
                    reply_to=(target.get("meta") or {}).get("reply_to"), user_row_index=prompt_row)

    if mode == "regenerate":
        if target_role == "bot":
            next_user = next((i for i in range(prompt_index + 1, len(visible)) if visible[i].get("role") == "user"), None)
            last_bot = max((i for i in range(prompt_index, len(visible))
                            if visible[i].get("role") == "bot"
                            and (next_user is None or i < next_user)), default=None)
            if last_bot != index:
                raise BranchRefused("unsupported", "Only the final reply of an exchange can be regenerated.")
        # A regenerated branch starts immediately before the original prompt and re-asks it.
        copy_end = prompt_index
        transcript_end = prompt_row
        later = len(visible) - copy_end
        if in_place:
            if index != len(visible) - 1:
                raise BranchRefused("not_latest", "Only the newest reply in this chat can be replaced in place.")
            if (prompt.get("meta") or {}).get("attachments"):
                raise BranchRefused("unsupported", "This prompt has attachments. Regenerate it in a new branch instead.")
            if not _normalize(prompt.get("text") or ""):
                raise BranchRefused("unsupported", "This prompt has no text to resend in place.")
        return Plan("regenerate", message_id, visible[:copy_end], rows[:transcript_end], transcript_end, later,
                    prompt=prompt, send_text=prompt.get("text") or "",
                    reply_to=(prompt.get("meta") or {}).get("reply_to"), in_place=in_place,
                    user_row_index=prompt_row)

    # mode == "branch": copy through the whole exchange the target belongs to. For a user
    # message that includes its reply (a clean boundary); for a reply it includes that reply.
    if target_role == "bot":
        next_user = next((i for i in range(prompt_index + 1, len(visible)) if visible[i].get("role") == "user"), None)
        last_bot = max((i for i in range(prompt_index, len(visible))
                        if visible[i].get("role") == "bot" and (next_user is None or i < next_user)), default=None)
        if last_bot != index:
            raise BranchRefused("unsupported", "Only the final reply of an exchange can be branched from.")
    copy_end = next((i for i in range(index + 1, len(visible)) if visible[i].get("role") == "user"), len(visible))
    copy = visible[:copy_end]
    later = len(visible) - copy_end
    return Plan("branch", message_id, copy, rows[:exchange_end], exchange_end, later,
                prompt=prompt, user_row_index=prompt_row)


def message_capabilities(messages: List[Dict[str, Any]], transcript: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Per-message gates for the app's More menu. A missing id means nothing is offered.

    One snapshot is decoded once and reused for every message; a large chat's state read must
    not re-sort the whole conversation per row.
    """
    visible = visible_messages(messages)
    rows = transcript_rows(transcript)
    out: Dict[str, Dict[str, Any]] = {}
    for m in visible:
        caps = {"role": m.get("role")}
        try:
            if m.get("role") == "user":
                _plan_at(visible, rows, m["id"], "edit", text="x")
                caps["can_edit"] = True
            _plan_at(visible, rows, m["id"], "branch")
            caps["can_branch"] = True
        except BranchRefused as exc:
            caps["reason"] = exc.reason
        if m.get("role") == "bot":
            try:
                _plan_at(visible, rows, m["id"], "regenerate")
                caps["can_regenerate"] = True
            except BranchRefused as exc:
                caps.setdefault("reason", exc.reason)
        out[m["id"]] = caps
    return out


def transcript_revision(messages: List[Dict[str, Any]], transcript: List[Dict[str, Any]]) -> str:
    """A stable digest of both sides of the conversation the branch would copy.

    Owned by this feature and exposed to other agents as metadata, not as a second global
    replay cursor: replay/annotation code can include it in its own envelopes.
    """
    h = hashlib.sha256()
    for m in sorted(messages, key=lambda x: (x.get("position") if x.get("position") is not None
                                             else int((x.get("created_at") or 0) * 1000))):
        meta = m.get("meta") or {}
        h.update(str(m.get("id") or "").encode())
        h.update(str(m.get("role") or "").encode())
        h.update(str(m.get("status") or "").encode())
        h.update(str(m.get("updated_at") or "").encode())
        h.update(_text_hash(m.get("text") or "").encode())
        h.update(json.dumps([a.get("id") or a.get("url") for a in meta.get("attachments") or []],
                            sort_keys=True, separators=(",", ":")).encode())
    for row in transcript_rows(transcript):
        h.update(str(row.get("role") or "").encode())
        h.update(str(row.get("message_id") or "").encode())
        h.update(_text_hash(str(row.get("content") or "")).encode())
        h.update(str(row.get("tool_call_id") or "").encode())
    return "b-" + h.hexdigest()[:24]


def branch_title(parent_title: str, mode: str) -> str:
    base = (parent_title or "Chat").strip() or "Chat"
    suffix = {"edit": "edit", "regenerate": "regenerate"}.get(mode, "branch")
    room = MAX_TITLE - len(suffix) - 3
    return f"{base[:max(1, room)].rstrip()} · {suffix}"


def clean_title(value: Any, fallback: str) -> str:
    title = " ".join(str(value or "").split())[:MAX_TITLE].strip()
    return title or fallback


def _public_attachment(upload: Dict[str, Any], url: str) -> Dict[str, Any]:
    return {"id": upload["id"], "name": upload["name"], "mime": upload["mime"], "kind": upload["kind"],
            "size": upload["size"], "url": url}


def _branch_row(msg: Dict[str, Any]) -> Dict[str, Any]:
    row = {k: msg.get(k) for k in COPIED_FIELDS}
    row["role"] = msg.get("role", "user")
    row["tool_name"] = msg.get("tool_name") or msg.get("name")
    if row["role"] == "user":
        # The service remaps platform IDs to the copied Winglet rows before seeding.
        row["platform_message_id"] = msg.get("message_id") or msg.get("platform_message_id")
    try:
        from agent.turn_context import extract_api_content_sidecar
        row["api_content"] = extract_api_content_sidecar(msg)
    except Exception:
        row["api_content"] = None
    return row


# -- Hermes bridge -------------------------------------------------------------------------


@dataclass
class Snapshot:
    chat_id: str
    session_key: str
    session_id: str
    rows: List[Dict[str, Any]]
    model: Optional[Dict[str, Any]] = None


class HermesBranchBridge:
    """The only place this feature touches Hermes session-store internals."""

    def __init__(self, adapter: Any):
        self.adapter = adapter

    @property
    def runner(self):
        return getattr(self.adapter, "gateway_runner", None)

    @property
    def store(self):
        return getattr(self.runner, "session_store", None)

    @property
    def async_store(self):
        return getattr(self.runner, "async_session_store", None)

    def available(self) -> bool:
        try:
            store, async_store = self.store, self.async_store
            if store is None or async_store is None:
                return False
            for name in ("load_transcript", "rewind_session", "switch_session", "get_or_create_session",
                         "peek_session_id", "get_model_override", "set_model_override",
                         "_get_transcript_drain_lock", "_clear_dirty_transcript",
                         "_follow_reroutes", "_compression_tip_for_session_id"):
                if not callable(getattr(store, name, None)):
                    return False
            for name in ("get_or_create_session", "switch_session"):
                if not callable(getattr(async_store, name, None)):
                    return False
            db = self._db_for_key(None)
            if db is None:
                return False
            for name in ("create_session", "append_messages_batch", "set_session_title", "get_session",
                         "end_session", "rewind_user_turn"):
                if not callable(getattr(db, name, None)):
                    return False
            import inspect
            if "warm_history" not in inspect.signature(db.rewind_user_turn).parameters:
                return False
            return True
        except Exception:
            logger.debug("[winglet] branching unavailable", exc_info=True)
            return False

    def key_for(self, chat_id: str) -> str:
        key = self.adapter._session_key(chat_id) if callable(getattr(self.adapter, "_session_key", None)) else None
        if not key:
            raise BranchRefused("unsupported", "This chat doesn't have a Hermes session to branch.")
        return key

    def _db_for_key(self, key: Optional[str]):
        store = self.store
        if store is None:
            return None
        getter = getattr(store, "_db_for_key", None)
        if callable(getter):
            return getter(key) if key else getattr(store, "_db", None)
        return getattr(store, "_db", None)

    def _db_for_session(self, session_id: str):
        store = self.store
        getter = getattr(store, "_db_for_session_id", None)
        if callable(getter):
            return getter(session_id)
        return getattr(store, "_db", None)

    def source_for(self, chat: Dict[str, Any], device: Dict[str, Any]):
        from .adapter import USER_PREFIX
        source = self.adapter.build_source(
            chat_id=chat["id"], chat_name=chat.get("title") or chat["id"], chat_type="dm",
            user_id=USER_PREFIX + str(device.get("id") or "app"),
            user_name=device.get("name") or "Phone", role_authorized=True)
        bot = chat.get("bot") or None
        if bot:
            source.profile = bot
        return source

    async def snapshot(self, chat_id: str) -> Snapshot:
        store = self.store
        if store is None:
            raise BranchRefused("unsupported", "This Hermes doesn't expose session transcripts.")
        key = self.key_for(chat_id)
        session_id = store.peek_session_id(key)
        if not session_id:
            raise BranchRefused("unsupported", "This chat has no Hermes session yet.")
        try:
            session_id = await asyncio.to_thread(store._follow_reroutes, session_id)
            session_id = await asyncio.to_thread(store._compression_tip_for_session_id, session_id)
            rows = await asyncio.to_thread(store.load_transcript, session_id)
        except Exception as exc:
            logger.debug("[winglet] transcript read failed for branch", exc_info=True)
            raise BranchRefused("unsupported", "The model transcript couldn't be read right now.") from exc
        return Snapshot(chat_id, key, session_id, transcript_rows(rows), self.model(chat_id))

    def model(self, chat_id: str) -> Optional[Dict[str, Any]]:
        getter = getattr(self.adapter, "_chat_model", None)
        if not callable(getter):
            return None
        try:
            model = getter(chat_id)
            return dict(model) if isinstance(model, dict) else None
        except Exception:
            return None

    async def create_branch_session(self, new_chat: Dict[str, Any], device: Dict[str, Any], title: str,
                                    parent: Snapshot, prefix: List[Dict[str, Any]]) -> str:
        store, async_store = self.store, self.async_store
        if store is None or async_store is None:
            raise BranchRefused("unsupported", "This Hermes can't create a branch session.")
        key = self.key_for(new_chat["id"])
        db = self._db_for_key(key)
        if db is None:
            raise BranchRefused("unsupported", "This Hermes can't reach its session database.")
        source = self.source_for(new_chat, device)
        parent_row = await asyncio.to_thread(db.get_session, parent.session_id) or {}
        new_id = f"{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}"
        origin = None
        with contextlib.suppress(Exception):
            origin = json.dumps(source.to_dict())
        create_kwargs = dict(
            source=str(getattr(source, "platform", "winglet").value if hasattr(getattr(source, "platform", None), "value")
                       else getattr(source, "platform", "winglet")),
            model=parent_row.get("model") or None,
            model_config={"_branched_from": parent.session_id},
            user_id=source.user_id, session_key=key, chat_id=source.chat_id,
            chat_type=getattr(source, "chat_type", "dm") or "dm",
            thread_id=getattr(source, "thread_id", None),
            parent_session_id=parent.session_id, origin_json=origin,
            display_name=title, system_prompt=parent_row.get("system_prompt") or None,
        )
        await asyncio.to_thread(db.create_session, new_id, **create_kwargs)
        try:
            if prefix:
                await asyncio.to_thread(db.append_messages_batch, new_id, [_branch_row(m) for m in prefix],
                                        chunk_rows=500)
            await asyncio.to_thread(db.set_session_title, new_id, title)
            # Materialize the routing entry for this new chat, then point it at the seeded
            # session (the same transition Hermes' own /branch performs).
            entry = await async_store.get_or_create_session(source)
            switched = await async_store.switch_session(key, new_id, expected_session_id=entry.session_id)
            if switched is None:
                raise BranchRefused("stale", "The chat changed while the branch was being created.")
        except Exception:
            with contextlib.suppress(Exception):
                await asyncio.to_thread(db.end_session, new_id, "branch_failed")
            raise
        # A chat-level model choice is held per session key, not in the transcript. Carry the
        # explicit choice across; never invent one when the parent had none.
        with contextlib.suppress(Exception):
            override = store.get_model_override(parent.session_key)
            if override:
                store.set_model_override(key, override)
        with contextlib.suppress(Exception):
            evict = getattr(self.runner, "_evict_cached_agent", None)
            if callable(evict):
                evict(key)
        return new_id

    async def end_failed_branch(self, new_session_id: Optional[str]) -> None:
        if not new_session_id:
            return
        db = self._db_for_session(new_session_id)
        with contextlib.suppress(Exception):
            if db is not None:
                await asyncio.to_thread(db.end_session, new_session_id, "branch_failed")
        with contextlib.suppress(Exception):
            store = self.store
            remove = getattr(store, "remove_by_session_id", None)
            if callable(remove):
                remove(new_session_id)

    async def rewind_latest(self, chat_id: str, prompt_text: str, source,
                            expected_row_index: Optional[int] = None,
                            expected_rows: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
        store, async_store = self.store, self.async_store
        if store is None:
            raise BranchRefused("unsupported", "This Hermes can't rewind a session.")
        snap = await self.snapshot(chat_id)
        if expected_rows is not None and transcript_revision([], snap.rows) != transcript_revision([], expected_rows):
            raise BranchRefused("stale", "This conversation changed before it could be regenerated.")
        # Verify the target BEFORE Hermes soft-deletes anything: a concurrent turn or a changed
        # prompt must never be truncated by a stale in-place request.
        if expected_row_index is not None:
            users = [i for i, row in enumerate(snap.rows) if row.get("role") == "user"]
            if not users or users[-1] != expected_row_index:
                raise BranchRefused("not_latest", "A newer turn landed before this reply could be regenerated.")
            stored = str(snap.rows[expected_row_index].get("content") or "")
            if _normalize(prompt_text) not in _normalize(stored):
                raise BranchRefused("stale", "The prompt changed before it could be regenerated.")
        def rewind_reviewed_turn():
            # The normal gateway writer shares this drain lock. The DB also checks its current
            # turn lease and active row IDs, so another process cannot commit over this rewind.
            with store._get_transcript_drain_lock():
                current = store._compression_tip_for_session_id(store._follow_reroutes(snap.session_id))
                if current != snap.session_id:
                    raise BranchRefused("stale", "This session changed before it could be regenerated.")
                db = self._db_for_session(current)
                if db is None:
                    raise BranchRefused("unsupported", "This session database is unavailable.")
                outcome = db.rewind_user_turn(current, -1, warm_history=expected_rows if expected_rows is not None else snap.rows)
                store._clear_dirty_transcript(current)
                return {"rewound_count": outcome.rewound_count, "turns_undone": outcome.turns_undone,
                        "target_text": outcome.live_text}

        try:
            result = await asyncio.to_thread(rewind_reviewed_turn)
        except RuntimeError as exc:
            raise BranchRefused("stale", "This conversation changed before it could be regenerated.") from exc
        except ValueError as exc:
            raise BranchRefused("busy", "The current turn cannot be rewound safely. Review it and try again.") from exc
        if not result:
            raise BranchRefused("busy", "The session is busy or the newest turn can't be rewound right now.")
        with contextlib.suppress(Exception):
            entry = await async_store.get_or_create_session(source)
            entry.last_prompt_tokens = 0
        with contextlib.suppress(Exception):
            evict = getattr(self.runner, "_evict_cached_agent", None)
            if callable(evict):
                evict(snap.session_key)
        return result


# -- service ---------------------------------------------------------------------------------


class BranchService:
    """Server-side operation lock, revision checks and Winglet-side branch materialization."""

    def __init__(self, hub: Any, adapter: Any):
        self.hub = hub
        self.adapter = adapter
        self.bridge = HermesBranchBridge(adapter)
        self._locks: Dict[str, asyncio.Lock] = {}

    def available(self) -> bool:
        return self.bridge.available()

    def _lock(self, chat_id: str) -> asyncio.Lock:
        lock = self._locks.get(chat_id)
        if lock is None:
            lock = self._locks[chat_id] = asyncio.Lock()
        return lock

    def busy(self, chat_id: str) -> bool:
        typing = getattr(self.hub, "_typing", set())
        return (chat_id in typing or self._lock(chat_id).locked()
                or bool(self.hub.store.streaming_messages(chat_id)))

    async def _revision(self, chat_id: str) -> Tuple[str, Snapshot]:
        snap = await self.bridge.snapshot(chat_id)
        return transcript_revision(self.hub.store.all_messages(chat_id), snap.rows), snap

    async def state(self, device: Dict[str, Any], chat_id: str) -> Dict[str, Any]:
        chat = self.hub.store.get_chat(chat_id) or {}
        if not self.available():
            return {"supported": False, "reason": "This Hermes can't branch conversations."}
        try:
            revision, snap = await self._revision(chat_id)
        except BranchRefused as exc:
            return {"supported": False, "reason": exc.reason, "chat_id": chat_id}
        messages = self.hub.store.all_messages(chat_id)
        return {
            "supported": True,
            "chat_id": chat_id,
            "revision": revision,
            "busy": self.busy(chat_id),
            "online": True,
            "model": snap.model,
            "branch": chat.get("branch"),
            "children": self.hub.store.branch_children(chat_id),
            "messages": message_capabilities(messages, snap.rows),
        }

    # -- shared materialization ---------------------------------------------------------------

    def _clone_attachment(self, upload_id: str, new_chat_id: str, device_id: str,
                          cache: Dict[str, Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if upload_id in cache:
            return cache[upload_id]
        row = self.hub.store.get_upload(upload_id)
        if row is None:
            return None
        source = (Path(self.hub.media_dir) / row["id"] / row["name"]).resolve()
        media_root = Path(self.hub.media_dir).resolve()
        if media_root not in source.parents or not source.is_file():
            return None
        clone_id = new_id()
        target = (media_root / clone_id / row["name"])
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        new_row = self.hub.store.add_upload(clone_id, device_id, new_chat_id, row["name"], row["mime"],
                                            row["kind"], row["size"])
        public = self.hub._upload_public(new_row)
        out = _public_attachment(new_row, public["url"])
        cache[upload_id] = out
        return out

    def _copy_rows(self, new_chat_id: str, device_id: str, messages: List[Dict[str, Any]]) -> Tuple[
            List[Dict[str, Any]], Dict[str, List[str]], List[str]]:
        """New Winglet ids and metadata for one branch prefix.

        Returns (rows, attachments-by-source-message, cloned upload ids). Attachments are cloned
        into the branch so the original chat can be deleted without breaking this one.
        """
        new_ids = {m["id"]: new_id() for m in messages}
        cache: Dict[str, Dict[str, Any]] = {}
        cloned: List[str] = []
        attachments_by_message: Dict[str, List[str]] = {}
        rows = []
        for m in messages:
            meta = json.loads(json.dumps(m.get("meta") or {}))
            meta.pop("client_id", None)
            meta.pop("delivery_error", None)
            meta["branch_source_chat_id"] = m.get("chat_id")
            meta["branch_source_message_id"] = m["id"]
            if meta.get("attachments"):
                kept = []
                ids = []
                for a in meta["attachments"]:
                    upload_id = str(a.get("id") or "")
                    clone = self._clone_attachment(upload_id, new_chat_id, device_id, cache) if upload_id else None
                    if clone:
                        kept.append(clone)
                        ids.append(clone["id"])
                        cloned.append(clone["id"])
                    else:
                        # An older attachment without a stored upload id still resolves through
                        # its signed URL; it just isn't claimable as a new upload.
                        kept.append({k: v for k, v in a.items() if k != "id"})
                meta["attachments"] = kept
                if ids:
                    attachments_by_message[m["id"]] = ids
            reply = meta.get("reply_to")
            if isinstance(reply, dict):
                if reply.get("id") in new_ids:
                    meta["reply_to"] = {**reply, "id": new_ids[reply["id"]]}
                else:
                    meta.pop("reply_to", None)
            rows.append({
                "id": new_ids[m["id"]], "role": m["role"], "text": m.get("text") or "",
                "status": "final", "meta": meta,
                "created_at": m.get("created_at"), "updated_at": m.get("updated_at"),
            })
        return rows, attachments_by_message, cloned

    def _cleanup(self, new_chat_id: Optional[str], cloned: List[str]) -> None:
        if new_chat_id:
            with contextlib.suppress(Exception):
                self.hub.store.delete_chat(new_chat_id)
        for upload_id in cloned:
            with contextlib.suppress(Exception):
                row = self.hub.store.get_upload(upload_id)
                if row is not None:
                    self.hub._remove_upload(row)

    def _op_id(self, body: Dict[str, Any]) -> str:
        op_id = str(body.get("op_id") or "").strip()
        if not OP_ID_RE.fullmatch(op_id):
            raise BranchRefused("unsupported", "A stable operation id (16–96 letters, digits or ._:-) is required.", 400)
        return op_id

    @staticmethod
    def _body_revision(body: Dict[str, Any]) -> str:
        revision = str(body.get("expected_revision") or "").strip()
        if not revision:
            raise BranchRefused("unsupported", "Reload the chat before branching.", 400)
        return revision

    async def _claim(self, op_id: str, chat_id: str, kind: str, device: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        existing, problem = self.hub.store.claim_branch_op(op_id, chat_id, kind, device["id"])
        if existing and existing.get("conflict"):
            raise BranchRefused("op_conflict", "That operation id belongs to another action.", 409)
        if problem == "in_progress":
            raise BranchRefused("in_progress", "This branch is already being created.", 409)
        return existing

    async def branch(self, device: Dict[str, Any], chat: Dict[str, Any], body: Dict[str, Any]) -> Dict[str, Any]:
        chat_id = chat["id"]
        mode = str(body.get("mode") or "branch")
        kind = "edit" if mode == "edit" else "regenerate" if mode == "regenerate" else "branch"
        op_id = self._op_id(body)
        revision = self._body_revision(body)
        existing = await self._claim(op_id, chat_id, kind, device)
        if existing and existing.get("state") == "done":
            return {**(existing.get("result") or {}), "replayed": True}

        lock = self._lock(chat_id)
        if lock.locked() or self.busy(chat_id):
            self.hub.store.finish_branch_op(op_id, error="busy")
            raise BranchRefused("busy", "Wait for the current reply to finish before branching.")
        async with lock:
            new_chat_id: Optional[str] = None
            new_session_id: Optional[str] = None
            cloned: List[str] = []
            committed = False
            try:
                current, snap = await self._revision(chat_id)
                if current != revision:
                    self.hub.store.finish_branch_op(op_id, error="stale")
                    raise BranchRefused("stale", "This chat changed since you opened the menu. Review it and try again.")
                plan = plan_operation(self.hub.store.all_messages(chat_id), snap.rows, str(body.get("message_id") or ""),
                                      mode, text=str(body.get("text") or ""), in_place=False)
                title = clean_title(body.get("title"), branch_title(chat.get("title") or "Chat", mode))
                new_chat = self.hub.store.create_chat(title, owner_device=chat.get("owner_device"), bot=chat.get("bot"))
                new_chat_id = new_chat["id"]
                rows, attachments_by_message, cloned = self._copy_rows(new_chat_id, device["id"], plan.copy)
                # Last revision check before touching a Hermes session. A send/reply that landed
                # while we copied would make the prefix stale.
                after, _ = await self._revision(chat_id)
                if after != revision:
                    self._cleanup(new_chat_id, cloned)
                    new_chat_id = None
                    self.hub.store.finish_branch_op(op_id, error="stale")
                    raise BranchRefused("stale", "This chat changed while the branch was being copied. Try again.")
                self.hub.store.import_messages(new_chat_id, rows)
                # Copied prefix attachments must be owned by their copied message, or the upload
                # janitor would treat them as abandoned drafts and delete them after a day.
                for row in rows:
                    ids = [a.get("id") for a in (row.get("meta") or {}).get("attachments") or [] if a.get("id")]
                    if ids:
                        self.hub.store.claim_uploads(ids, device["id"], new_chat_id, row["id"])
                copied_ids = {row["meta"]["branch_source_message_id"]: row["id"]
                              for row in rows if row["role"] == "user"}
                prefix = [{**row, "message_id": copied_ids.get(str(row.get("message_id") or ""))}
                          if row.get("role") == "user" else row for row in plan.transcript_prefix]
                new_session_id = await self.bridge.create_branch_session(new_chat, device, title, snap, prefix)
                self.hub.store.create_branch(new_chat_id, chat_id, chat.get("title") or "Chat",
                                             plan.message_id, mode, device["id"], revision)
                final_chat = self.hub.store.get_chat(new_chat_id) or new_chat
                committed = True
                await self.hub.broadcast({"type": "chat.update", "chat": final_chat})
                await self.hub.broadcast({"type": "branch.created", "chat_id": new_chat_id, "chat": final_chat,
                                          "branch": final_chat.get("branch"), "parent_chat_id": chat_id,
                                          "copies": len(plan.copy), "later": plan.later})
                result = {"chat": final_chat, "branch": final_chat.get("branch"), "mode": mode,
                          "copies": len(plan.copy), "later": plan.later,
                          "revision": transcript_revision(self.hub.store.all_messages(chat_id), snap.rows),
                          "model": snap.model}
                if mode in ("edit", "regenerate"):
                    # Attachments for the new prompt: cloned from the edited prompt (edit) or the
                    # original prompt (regenerate). The branch owns its media. The prompt itself is
                    # not part of the copied prefix (it is the turn being replaced), so clone its
                    # attachments explicitly.
                    attachment_ids: List[str] = []
                    cache: Dict[str, Dict[str, Any]] = {}
                    for a in ((plan.prompt or {}).get("meta") or {}).get("attachments") or []:
                        uid = str(a.get("id") or "")
                        if not uid:
                            continue
                        clone = self._clone_attachment(uid, new_chat_id, device["id"], cache)
                        if clone:
                            attachment_ids.append(clone["id"])
                            cloned.append(clone["id"])
                    reply_id = None
                    if plan.reply_to and plan.reply_to.get("id"):
                        # The edited/regenerated prompt's reply target may be in the copied prefix;
                        # hub.user_message needs the branch chat's id, so resolve through metadata.
                        old = plan.reply_to.get("id")
                        for row in rows:
                            if (row.get("meta") or {}).get("branch_source_message_id") == old:
                                reply_id = row["id"]
                                break
                    try:
                        message = await self.hub.user_message(
                            device, new_chat_id, plan.send_text,
                            client_id="b-" + hashlib.sha1(op_id.encode()).hexdigest()[:24],
                            attachments=attachment_ids, reply_to=reply_id or "")
                        result["message"] = message
                    except Exception as exc:
                        logger.warning("[winglet] branch created but its first turn wasn't sent: %s", exc)
                        result["message"] = None
                        result["warning"] = "The branch is ready, but the first message couldn't be sent. Send it from the composer."
                self.hub.store.finish_branch_op(op_id, result=result)
                self.hub.audit("branch.create", device,
                               f"{mode} branch {new_chat_id} from {chat_id} at {plan.message_id}")
                return result
            except asyncio.CancelledError:
                # The client went away (reconnect/reload). Do the synchronous cleanup before
                # yielding again; a half-made chat or upload must not be left behind.
                if not committed:
                    self.hub.store.finish_branch_op(op_id, error="cancelled")
                    if new_chat_id:
                        self._cleanup(new_chat_id, cloned)
                raise
            except BranchRefused as exc:
                if not committed:
                    self.hub.store.finish_branch_op(op_id, error=exc.code)
                    if new_chat_id:
                        self._cleanup(new_chat_id, cloned)
                    if new_session_id:
                        await self.bridge.end_failed_branch(new_session_id)
                raise
            except Exception:
                if not committed:
                    self.hub.store.finish_branch_op(op_id, error="failed")
                    if new_chat_id:
                        self._cleanup(new_chat_id, cloned)
                    if new_session_id:
                        await self.bridge.end_failed_branch(new_session_id)
                self.hub.audit("branch.create", device, f"failed for {chat_id}", outcome="failed")
                logger.exception("[winglet] branch creation failed")
                raise BranchRefused("unsupported", "The branch couldn't be created. Nothing in the original chat changed.", 502)

    async def regenerate(self, device: Dict[str, Any], chat: Dict[str, Any], body: Dict[str, Any]) -> Dict[str, Any]:
        chat_id = chat["id"]
        op_id = self._op_id(body)
        revision = self._body_revision(body)
        existing = await self._claim(op_id, chat_id, "regenerate-in-place", device)
        if existing and existing.get("state") == "done":
            return {**(existing.get("result") or {}), "replayed": True}
        lock = self._lock(chat_id)
        if lock.locked() or self.busy(chat_id):
            self.hub.store.finish_branch_op(op_id, error="busy")
            raise BranchRefused("busy", "Wait for the current reply to finish before regenerating.")
        async with lock:
            try:
                current, snap = await self._revision(chat_id)
                if current != revision:
                    self.hub.store.finish_branch_op(op_id, error="stale")
                    raise BranchRefused("stale", "This chat changed since you opened the menu. Review it and try again.")
                messages = self.hub.store.all_messages(chat_id)
                plan = plan_operation(messages, snap.rows, str(body.get("message_id") or ""), "regenerate",
                                      in_place=True)
                if not plan.prompt:
                    raise BranchRefused("unsupported", "There is no prompt to resend.")
                source = self.bridge.source_for(chat, device)
                await self.bridge.rewind_latest(chat_id, plan.send_text, source,
                                                expected_row_index=plan.user_row_index, expected_rows=snap.rows)
                # The rewind is real; now remove the dead UI rows after the surviving prompt and
                # start a new turn from it. Hidden controls after this point no longer apply.
                prompt_position = plan.prompt.get("position")
                if prompt_position is not None:
                    for m in messages:
                        if (m.get("position") or 0) > prompt_position:
                            with contextlib.suppress(Exception):
                                await self.hub.delete_message(m["id"])
                await self.hub.broadcast({"type": "transcript.revised", "chat_id": chat_id,
                                          "reason": "regenerate",
                                          "revision": (await self._revision(chat_id))[0]})
                reply = (plan.prompt.get("meta") or {}).get("reply_to")
                try:
                    await self.adapter._on_user_message(chat, plan.send_text, device, plan.prompt,
                                                        reply=reply if isinstance(reply, dict) else None)
                except Exception:
                    # Do not report success: the rewind happened, but no new turn is running.
                    await self.hub.post_message(chat_id, "Regeneration couldn't start. The previous reply was removed; send your prompt again.",
                                                role="system", push=False)
                    raise
                result = {"ok": True, "chat_id": chat_id, "revision": (await self._revision(chat_id))[0],
                          "replayed": False}
                self.hub.store.finish_branch_op(op_id, result=result)
                self.hub.audit("branch.regenerate", device, f"in-place regenerate in {chat_id} at {plan.message_id}")
                return result
            except BranchRefused as exc:
                self.hub.store.finish_branch_op(op_id, error=exc.code)
                raise
            except Exception:
                self.hub.store.finish_branch_op(op_id, error="failed")
                self.hub.audit("branch.regenerate", device, f"failed in {chat_id}", outcome="failed")
                logger.exception("[winglet] in-place regenerate failed")
                raise BranchRefused("unsupported", "Regeneration failed. The previous reply may have been removed.", 502)
