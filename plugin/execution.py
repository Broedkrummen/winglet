"""Structured task activity: turns, tools, plans and delegated subagents.

Hermes exposes authoritative facts to plugins as hooks. This module folds those facts into one
bounded, per-chat snapshot and a stream of namespaced incremental events that the app can render
without guessing from prose.

Contract (see ``docs/agent-handoffs/execution.md``):

* ``pre_llm_call`` / ``post_llm_call`` delimit a turn; ``agent_loop_stopped`` is a cancellation.
* ``pre_tool_call`` / ``post_tool_call`` carry ``tool_call_id``, ``duration_ms`` and ``status``.
* ``subagent_start`` / ``subagent_stop`` carry the parent and child session/subagent IDs.
* The ``todo_list`` tool's result carries the authoritative plan and its monotonic revision.

Everything here is in memory and bounded. Tool arguments and results are never stored: only a short,
redacted preview of a few textual argument keys, and a bounded error line. If Hermes does not supply
a fact the field stays ``None``/``"unknown"``; nothing is inferred from silence and no percentage is
invented.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

# Namespaced for other features to reference; the global event cursor belongs to the replay agent.
SNAPSHOT_EVENT = "task.snapshot"
UPDATE_EVENT = "task.event"

MAX_TOOLS = 40
MAX_SUBAGENTS = 40
MAX_PLAN_ITEMS = 256
MAX_CHATS = 32
MAX_GOAL = 500
MAX_SUMMARY = 600
MAX_ERROR = 300
MAX_PREVIEW = 160
MAX_PLAN_ITEM = 400
MAX_ACTIVITY = 12
MAX_ACTIVITY_LINE = 180
MAX_REASON = 200

# Task states. ``unknown`` is a real answer: the server has no authoritative fact.
RUNNING = "running"
COMPLETED = "completed"
FAILED = "failed"
CANCELLED = "cancelled"
UNKNOWN = "unknown"

# Subagent states. ``unwatched`` and ``unknown`` are never successes.
SUB_QUEUED = "queued"
SUB_RUNNING = "running"
SUB_COMPLETED = "completed"
SUB_FAILED = "failed"
SUB_CANCELLED = "cancelled"
SUB_UNWATCHED = "unwatched"
SUB_UNKNOWN = "unknown"

TOOL_RUNNING = "running"
TOOL_COMPLETED = "completed"
TOOL_FAILED = "failed"
TOOL_UNKNOWN = "unknown"

PLAN_STATUSES = {"pending", "in_progress", "completed", "cancelled"}

_SECRET = re.compile(
    r"(?:sk-[A-Za-z0-9_\-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[abprs]-[A-Za-z0-9-]{8,}"
    r"|(?i:bearer)\s+[A-Za-z0-9._\-]{8,}|(?i:(?:api[_-]?key|token|secret|password)\s*[=:]\s*)\S+)"
)
_URL_CREDENTIAL = re.compile(r"(?<=://)[^/\s:@]+:[^/\s@]+@")
_CURSOR = re.compile(r"\s*▉\s*$")
_WHITESPACE = re.compile(r"\s+")

# Argument keys whose value is short enough to show as a preview; anything else is summarised by name only.
_PREVIEW_KEYS = ("command", "cmd", "path", "file_path", "query", "q", "url", "pattern", "goal", "name", "prompt", "description")

_PLAN_TOOLS = {"todo_list", "todo"}


def redact(text: Any, limit: int) -> str:
    """A single bounded line with credential-shaped text removed. Never raises."""
    try:
        value = _WHITESPACE.sub(" ", str(text or "")).strip()
    except Exception:
        return ""
    if not value:
        return ""
    value = _URL_CREDENTIAL.sub("***@", value)
    value = _SECRET.sub("***", value)
    value = _CURSOR.sub("", value)
    return value if len(value) <= limit else value[: max(0, limit - 1)].rstrip() + "…"


def _as_dict(value: Any) -> Optional[Dict[str, Any]]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip().startswith("{"):
        import json
        try:
            parsed = json.loads(value)
        except Exception:
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def tool_preview(tool_name: str, args: Any) -> str:
    """A short preview of a tool call: one textual argument, redacted. Arguments are not kept."""
    data = _as_dict(args)
    if not data:
        return ""
    for key in _PREVIEW_KEYS:
        raw = data.get(key)
        if isinstance(raw, (str, int, float)) and not isinstance(raw, bool):
            text = redact(raw, MAX_PREVIEW)
            if text:
                return text
    # No allow-listed text value: name the shape, never its contents.
    return redact(", ".join(sorted(str(k) for k in data.keys()))[:MAX_PREVIEW], MAX_PREVIEW)


def clean_goal(goal: Any) -> str:
    return redact(goal, MAX_GOAL)


def _status_for_subagent(value: Any) -> str:
    status = str(value or "").strip().lower()
    if status in ("completed", "complete", "ok", "success", "succeeded"):
        return SUB_COMPLETED
    if status in ("failed", "error", "timeout", "timed_out"):
        return SUB_FAILED
    if status in ("interrupted", "cancelled", "canceled", "stopped"):
        return SUB_CANCELLED
    if status in ("queued", "pending", "dispatched"):
        return SUB_QUEUED
    if status in ("running", "started", "in_progress"):
        return SUB_RUNNING
    return SUB_UNKNOWN


def _status_for_tool(value: Any, error: Any = None) -> str:
    status = str(value or "").strip().lower()
    if status in ("ok", "success", "completed", "complete", "succeeded"):
        return TOOL_COMPLETED
    if status in ("error", "failed", "failure", "timeout", "blocked", "denied"):
        return TOOL_FAILED
    if status in ("running", "started", "in_progress"):
        return TOOL_RUNNING
    return TOOL_FAILED if error else TOOL_UNKNOWN


def _activity_status(value: Any) -> str:
    status = str(value or "").strip().lower()
    if status in ("ok", "success", "completed", "complete"):
        return TOOL_COMPLETED
    if status in ("error", "failed", "failure", "timeout"):
        return TOOL_FAILED
    if status in ("running", "started", "in_progress"):
        return TOOL_RUNNING
    return TOOL_UNKNOWN


class _Tool:
    __slots__ = ("id", "name", "preview", "status", "started_at", "ended_at", "duration_ms", "error", "started_known")

    def __init__(self, tool_id: str, name: str, preview: str = "", status: str = TOOL_RUNNING,
                 started_at: Optional[float] = None, started_known: bool = True):
        self.id = tool_id
        self.name = redact(name, 80) or "tool"
        self.preview = preview
        self.status = status
        self.started_at = started_at
        self.ended_at: Optional[float] = None
        self.duration_ms: Optional[float] = None
        self.error: Optional[str] = None
        self.started_known = started_known

    def payload(self) -> Dict[str, Any]:
        return {"id": self.id, "name": self.name, "preview": self.preview, "status": self.status,
                "started_at": self.started_at, "ended_at": self.ended_at, "duration_ms": self.duration_ms,
                "error": self.error, "started_known": self.started_known}


class _Subagent:
    __slots__ = ("id", "parent_id", "goal", "role", "status", "started_at", "ended_at", "duration_ms",
                 "summary", "activity", "started_known", "session_id")

    def __init__(self, subagent_id: str, *, parent_id: Optional[str], goal: str, role: str,
                 started_at: Optional[float], started_known: bool = True, session_id: Optional[str] = None,
                 status: str = SUB_RUNNING):
        self.id = subagent_id
        self.parent_id = parent_id
        self.goal = goal
        self.role = role or "leaf"
        self.status = status
        self.started_at = started_at
        self.ended_at: Optional[float] = None
        self.duration_ms: Optional[float] = None
        self.summary: Optional[str] = None
        self.activity: List[Dict[str, Any]] = []
        self.started_known = started_known
        self.session_id = session_id

    def add_activity(self, name: Any, detail: Any = "", status: Any = None) -> None:
        line = {"name": redact(name, 80) or "tool", "detail": redact(detail, MAX_ACTIVITY_LINE),
                "status": _activity_status(status)}
        if not line["detail"]:
            line.pop("detail")
        # A repeated identical line from a progress batch is dropped; the tail still lands once.
        if self.activity and self.activity[-1] == line:
            return
        self.activity.append(line)
        del self.activity[:-MAX_ACTIVITY]

    def finish_activity(self, name: Any, status: Any) -> None:
        """Settle the running row for this tool instead of adding a second, detail-less copy."""
        label = redact(name, 80) or "tool"
        for row in reversed(self.activity):
            if row["name"] == label and row["status"] == TOOL_RUNNING:
                row["status"] = _activity_status(status)
                return
        self.add_activity(label, "", status)

    def payload(self) -> Dict[str, Any]:
        return {"id": self.id, "parent_id": self.parent_id, "goal": self.goal, "role": self.role,
                "status": self.status, "started_at": self.started_at, "ended_at": self.ended_at,
                "duration_ms": self.duration_ms, "summary": self.summary,
                "tool_count": len(self.activity) or None, "started_known": self.started_known,
                "activity": list(self.activity)}


class _Plan:
    __slots__ = ("revision", "items", "turn_index")

    def __init__(self, revision: int, items: List[Dict[str, Any]], turn_index: int):
        self.revision = revision
        self.items = items
        self.turn_index = turn_index

    def payload(self) -> Dict[str, Any]:
        return {"revision": self.revision, "items": [dict(item) for item in self.items]}


class _Task:
    """One chat's current turn."""

    __slots__ = ("chat_id", "bot", "turn_id", "turn_index", "state", "started_at", "ended_at",
                 "updated_at", "reason", "outcome", "plan", "tools", "subagents", "seq")

    def __init__(self, chat_id: str, bot: Optional[str], turn_id: Optional[str], turn_index: int, now: float):
        self.chat_id = chat_id
        self.bot = bot
        self.turn_id = turn_id
        self.turn_index = turn_index
        self.state = RUNNING
        self.started_at: Optional[float] = now
        self.ended_at: Optional[float] = None
        self.updated_at = now
        self.reason: Optional[str] = None
        self.outcome: Optional[Dict[str, Any]] = None
        self.plan: Optional[_Plan] = None
        self.tools: Dict[str, _Tool] = {}
        self.subagents: Dict[str, _Subagent] = {}
        self.seq = 0


class Tracker:
    """Folds Hermes hook payloads into bounded per-chat task snapshots.

    ``resolve_chat(session_id)`` maps a Hermes session id to ``{"chat_id", "bot"}`` for a Winglet chat;
    ``resolve_key(session_key)`` does the same for a gateway session key (used by ``agent_loop_stopped``).
    Both are supplied by the adapter and must return ``None`` for anything that isn't a Winglet chat.
    ``publish(event)`` hands one socket event to the adapter; it may be called from a worker thread.
    """

    def __init__(self, resolve_chat: Callable[[str], Optional[Dict[str, Any]]],
                 publish: Optional[Callable[[Dict[str, Any]], None]] = None,
                 resolve_key: Optional[Callable[[str], Optional[str]]] = None,
                 clock: Callable[[], float] = time.time):
        self._resolve_chat = resolve_chat
        self._resolve_key = resolve_key
        self._publish = publish
        self._clock = clock
        self._lock = threading.RLock()
        self._tasks: Dict[str, _Task] = {}
        self._turn_counters: Dict[str, int] = {}
        # child session id -> subtask key, and (chat id, subtask id) -> key, so a late start/stop both land.
        self._child_sessions: Dict[str, str] = {}
        self._closed = False

    # -- lifecycle ---------------------------------------------------------------------------

    def close(self) -> None:
        with self._lock:
            self._closed = True
            self._tasks.clear()
            self._child_sessions.clear()

    def reset(self) -> None:
        """Drop all state without disabling the hook callbacks (a gateway restart/reconnect)."""
        with self._lock:
            self._tasks.clear()
            self._child_sessions.clear()
            self._turn_counters.clear()

    def set_publish(self, publish: Optional[Callable[[Dict[str, Any]], None]]) -> None:
        with self._lock:
            self._publish = publish

    def forget_chat(self, chat_id: str) -> None:
        with self._lock:
            self._tasks.pop(chat_id, None)

    # -- hook entry points --------------------------------------------------------------------

    def turn_started(self, session_id: Any, turn_id: Any = None, *, user_message: Any = None) -> None:
        target = self._target(session_id)
        if target is None:
            return
        chat_id, bot = target["chat_id"], target.get("bot")
        now = self._clock()
        with self._lock:
            if self._closed:
                return
            index = self._turn_counters.get(chat_id, 0) + 1
            self._turn_counters[chat_id] = index
            previous = self._tasks.get(chat_id)
            task = _Task(chat_id, bot, self._turn_id(turn_id), index, now)
            # A new turn starts clean: no stale tool or subagent survives into it. The plan is the
            # session's own list, so it carries over as a "last plan" until this turn writes a new one.
            if previous is not None and previous.plan is not None:
                task.plan = previous.plan
            self._tasks[chat_id] = task
            self._trim_chats()
            task.seq += 1
            snapshot = self._snapshot(task)
            event = {"type": SNAPSHOT_EVENT, "chat_id": chat_id, "bot": bot, "snapshot": snapshot}
        self._emit(event)

    def turn_finished(self, session_id: Any, turn_id: Any = None, *, failed: bool = False,
                      reason: Any = None, outcome: Any = None, notify: bool = True) -> None:
        target = self._target(session_id)
        if target is None:
            return
        self._finish(target["chat_id"], turn_id, FAILED if failed else COMPLETED, reason=reason, outcome=outcome,
                     notify=notify)

    def loop_stopped(self, session_key: Any = None, *, reason: Any = None) -> None:
        chat_id = None
        if self._resolve_key is not None and session_key:
            try:
                chat_id = self._resolve_key(str(session_key))
            except Exception:
                logger.debug("[winglet] could not resolve a stopped session", exc_info=True)
        if not chat_id:
            return
        self._finish(chat_id, None, CANCELLED, reason=reason or "Stopped")

    def tool_started(self, session_id: Any, tool_name: Any, tool_call_id: Any = None, args: Any = None,
                     turn_id: Any = None, index: Any = None) -> None:
        now = self._clock()
        child = self._child_target(session_id)
        with self._lock:
            if self._closed:
                return
            if child is not None:
                task, sub = child
                sub.add_activity(tool_name, tool_preview(str(tool_name or ""), args), TOOL_RUNNING)
                task.updated_at = now
                payload = {"kind": "subagent.updated", "subagent": sub.payload()}
                events = self._update_events(task, payload)
            else:
                target = self._target_locked(session_id)
                if target is None:
                    return
                task = self._active_task(target["chat_id"], turn_id)
                if task is None:
                    return
                key = self._tool_key(task, tool_call_id, index)
                if key is None:
                    return
                tool = _Tool(key, str(tool_name or "tool"), tool_preview(str(tool_name or ""), args),
                             TOOL_RUNNING, now)
                task.tools[key] = tool
                self._trim_tools(task)
                task.updated_at = now
                events = self._update_events(task, {"kind": "tool.started", "tool": tool.payload()})
        for event in events:
            self._emit(event)

    def tool_finished(self, session_id: Any, tool_name: Any = None, tool_call_id: Any = None,
                      turn_id: Any = None, index: Any = None, status: Any = None, duration_ms: Any = None,
                      error: Any = None, error_type: Any = None) -> None:
        now = self._clock()
        child = self._child_target(session_id)
        with self._lock:
            if self._closed:
                return
            if child is not None:
                task, sub = child
                sub.finish_activity(tool_name or "tool", status)
                task.updated_at = now
                events = self._update_events(task, {"kind": "subagent.updated", "subagent": sub.payload()})
            else:
                target = self._target_locked(session_id)
                if target is None:
                    return
                task = self._active_task(target["chat_id"], turn_id)
                if task is None:
                    return
                key = self._tool_key(task, tool_call_id, index)
                if key is None:
                    return
                tool = task.tools.get(key)
                if tool is None:
                    # A finish whose start this server never saw (a reconnect, a dropped event):
                    # one row, honest about the missing start.
                    tool = _Tool(key, str(tool_name or "tool"), "", TOOL_UNKNOWN, None, started_known=False)
                    task.tools[key] = tool
                    self._trim_tools(task)
                tool.status = _status_for_tool(status, error)
                tool.ended_at = now
                try:
                    ms = float(duration_ms) if duration_ms is not None else None
                except (TypeError, ValueError):
                    ms = None
                tool.duration_ms = ms if ms is not None and ms >= 0 else (
                    round((now - tool.started_at) * 1000, 1) if tool.started_at else None)
                detail = redact(error or error_type or "", MAX_ERROR) or None
                tool.error = detail
                task.updated_at = now
                events = self._update_events(task, {"kind": "tool.finished", "tool": tool.payload()})
        for event in events:
            self._emit(event)

    def plan_updated(self, session_id: Any, result: Any, *, turn_id: Any = None) -> None:
        snapshot = _as_dict(result)
        if snapshot is None:
            return
        source = snapshot if isinstance(snapshot.get("todos"), list) else _as_dict(snapshot.get("result"))
        if source is None or not isinstance(source.get("todos"), list):
            return
        try:
            revision = int(source.get("revision") or 0)
        except (TypeError, ValueError):
            revision = 0
        items = []
        for raw in source["todos"][:MAX_PLAN_ITEMS]:
            if not isinstance(raw, dict):
                continue
            status = str(raw.get("status") or "").strip().lower()
            if status not in PLAN_STATUSES:
                continue
            item_id = redact(raw.get("id"), 80)
            content = redact(raw.get("content"), MAX_PLAN_ITEM)
            if not item_id or not content:
                continue
            parent = redact(raw.get("parent"), 80) or None
            items.append({"id": item_id, "content": content, "status": status,
                          "parent": None if parent == item_id else parent})
        with self._lock:
            if self._closed:
                return
            target = self._target_locked(session_id)
            if target is None:
                return
            task = self._active_task(target["chat_id"], turn_id)
            if task is None:
                return
            if task.plan is not None and revision < task.plan.revision:
                return  # a stale write cannot replace a newer plan
            task.plan = _Plan(revision, items, task.turn_index)
            task.updated_at = self._clock()
            events = self._update_events(task, {"kind": "plan.updated", "plan": task.plan.payload()})
        for event in events:
            self._emit(event)

    def subagent_started(self, parent_session_id: Any, child_session_id: Any = None, child_subagent_id: Any = None,
                         *, parent_subagent_id: Any = None, goal: Any = None, role: Any = None,
                         parent_turn_id: Any = None) -> None:
        target = self._target(parent_session_id)
        nested = None if target is not None else self._child_target(parent_session_id)
        if target is None and nested is None:
            return
        now = self._clock()
        sub_id = redact(child_subagent_id, 120) or redact(child_session_id, 120)
        if not sub_id:
            return
        with self._lock:
            if self._closed:
                return
            if target is not None:
                task = self._active_task(target["chat_id"], parent_turn_id)
            else:
                task = nested[0] if nested[0].state == RUNNING else None
            if task is None:
                return
            parent_key = redact(parent_subagent_id, 120) or (nested[1].id if nested is not None else None)
            existing = task.subagents.get(sub_id)
            if existing is None:
                existing = _Subagent(sub_id, parent_id=parent_key, goal=clean_goal(goal), role=redact(role, 40),
                                     started_at=now, session_id=redact(child_session_id, 120) or None)
                task.subagents[sub_id] = existing
                self._trim_subagents(task)
            else:
                existing.status = SUB_RUNNING
                existing.started_at = existing.started_at or now
                existing.started_known = True
                existing.parent_id = parent_key or existing.parent_id
            if child_session_id:
                self._child_sessions[str(child_session_id)] = sub_id
            task.updated_at = now
            events = self._update_events(task, {"kind": "subagent.started", "subagent": existing.payload()})
        for event in events:
            self._emit(event)

    def subagent_finished(self, parent_session_id: Any, *, child_session_id: Any = None,
                          child_subagent_id: Any = None, status: Any = None, summary: Any = None,
                          duration_ms: Any = None, tool_call_history: Any = None,
                          parent_turn_id: Any = None) -> None:
        target = self._target(parent_session_id)
        nested = None if target is not None else self._child_target(parent_session_id)
        if target is None and nested is None:
            return
        now = self._clock()
        with self._lock:
            if self._closed:
                return
            if target is not None:
                task = self._active_task(target["chat_id"], parent_turn_id)
            else:
                task = nested[0] if nested[0].state == RUNNING else None
            if task is None:
                return
            sub_id = None
            if child_session_id:
                sub_id = self._child_sessions.get(str(child_session_id))
            sub_id = sub_id or redact(child_subagent_id, 120) or redact(child_session_id, 120)
            if not sub_id:
                return
            sub = task.subagents.get(sub_id)
            if sub is None:
                sub = _Subagent(sub_id, parent_id=None, goal="", role="", started_at=None, started_known=False)
                task.subagents[sub_id] = sub
                self._trim_subagents(task)
            sub.status = _status_for_subagent(status)
            sub.ended_at = now
            try:
                ms = float(duration_ms) if duration_ms is not None else None
            except (TypeError, ValueError):
                ms = None
            sub.duration_ms = ms if ms is not None and ms >= 0 else (
                round((now - sub.started_at) * 1000, 1) if sub.started_at else None)
            sub.summary = redact(summary, MAX_SUMMARY) or None
            if isinstance(tool_call_history, list):
                sub.activity = []
                for entry in tool_call_history[-MAX_ACTIVITY:]:
                    if not isinstance(entry, dict):
                        continue
                    sub.add_activity(entry.get("tool_name") or entry.get("name"), entry.get("tool_input") or "",
                                     entry.get("status"))
            if child_session_id:
                self._child_sessions.pop(str(child_session_id), None)
            task.updated_at = now
            events = self._update_events(task, {"kind": "subagent.finished", "subagent": sub.payload()})
        for event in events:
            self._emit(event)

    # -- reads --------------------------------------------------------------------------------

    def snapshot(self, chat_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            task = self._tasks.get(str(chat_id))
            return None if task is None else self._snapshot(task)

    def capabilities(self) -> Dict[str, bool]:
        # A messaging adapter cannot target one child on the pinned Hermes; only the whole task stops.
        return {"subagent_stop": False}

    # -- internals ----------------------------------------------------------------------------

    @staticmethod
    def _turn_id(value: Any) -> Optional[str]:
        text = redact(value, 120)
        return text or None

    def _target(self, session_id: Any) -> Optional[Dict[str, Any]]:
        """Resolve a Hermes session id to a Winglet chat, tolerating a resolver that raises."""
        if not session_id:
            return None
        try:
            target = self._resolve_chat(str(session_id))
        except Exception:
            logger.debug("[winglet] could not resolve an execution session", exc_info=True)
            return None
        if not isinstance(target, dict) or not target.get("chat_id"):
            return None
        return target

    def _target_locked(self, session_id: Any) -> Optional[Dict[str, Any]]:
        return self._target(session_id)

    def _child_target(self, session_id: Any) -> Optional[tuple]:
        if not session_id:
            return None
        with self._lock:
            key = self._child_sessions.get(str(session_id))
            if not key:
                return None
            for task in self._tasks.values():
                sub = task.subagents.get(key)
                if sub is not None and sub.status in (SUB_RUNNING, SUB_QUEUED):
                    return task, sub
        return None

    def _active_task(self, chat_id: str, turn_id: Any) -> Optional[_Task]:
        task = self._tasks.get(str(chat_id))
        if task is None or task.state != RUNNING:
            return None
        wanted = self._turn_id(turn_id)
        # Accept a turn-aware hook when both sides know the id; never attach to a different turn.
        if wanted and task.turn_id and wanted != task.turn_id:
            return None
        return task

    @staticmethod
    def _tool_key(task: _Task, tool_call_id: Any, index: Any) -> Optional[str]:
        key = redact(tool_call_id, 160)
        if key:
            return key
        # No authoritative id: use a turn-local key. Never an array position of a shared transcript.
        try:
            number = int(index)
        except (TypeError, ValueError):
            number = len(task.tools)
        return f"{task.turn_id or task.turn_index}:{number}"

    @staticmethod
    def _trim_tools(task: _Task) -> None:
        if len(task.tools) > MAX_TOOLS:
            for key in list(task.tools)[: len(task.tools) - MAX_TOOLS]:
                task.tools.pop(key, None)

    @staticmethod
    def _trim_subagents(task: _Task) -> None:
        if len(task.subagents) <= MAX_SUBAGENTS:
            return
        # Finished children go first; a flood of live ones still stays bounded, newest kept.
        for key, sub in list(task.subagents.items()):
            if len(task.subagents) <= MAX_SUBAGENTS:
                return
            if sub.status not in (SUB_RUNNING, SUB_QUEUED):
                task.subagents.pop(key, None)
        for key in list(task.subagents)[: max(0, len(task.subagents) - MAX_SUBAGENTS)]:
            task.subagents.pop(key, None)

    def _trim_chats(self) -> None:
        if len(self._tasks) <= MAX_CHATS:
            return
        ended = sorted(self._tasks.items(), key=lambda pair: pair[1].updated_at)
        for chat_id, task in ended:
            if len(self._tasks) <= MAX_CHATS:
                break
            if task.state != RUNNING:
                self._tasks.pop(chat_id, None)

    def _finish(self, chat_id: str, turn_id: Any, state: str, *, reason: Any = None, outcome: Any = None,
                notify: bool = True) -> None:
        now = self._clock()
        with self._lock:
            if self._closed:
                return
            task = self._tasks.get(str(chat_id))
            if task is None:
                return
            wanted = self._turn_id(turn_id)
            if wanted and task.turn_id and wanted != task.turn_id:
                return  # a late end for an older turn cannot close the running one
            # Only the first terminal fact wins: a cancelled turn is not later reported as completed.
            if task.state != RUNNING:
                return
            task.state = state
            task.ended_at = now
            task.updated_at = now
            task.reason = redact(reason, MAX_REASON) or None
            summary = redact(outcome, MAX_SUMMARY) or None
            task.outcome = {"state": state, "summary": summary} if summary else {"state": state, "summary": None}
            for sub in task.subagents.values():
                if sub.status in (SUB_RUNNING, SUB_QUEUED):
                    # The turn ended before this child reported: not a success, not a failure we saw.
                    sub.status = SUB_UNKNOWN
                    sub.ended_at = sub.ended_at or now
            for tool in task.tools.values():
                if tool.status == TOOL_RUNNING:
                    # A tool cannot still be running once its turn is over; we simply never saw its end.
                    tool.status = TOOL_UNKNOWN
                    tool.ended_at = tool.ended_at or now
                    if tool.duration_ms is None and tool.started_at is not None:
                        tool.duration_ms = round((now - tool.started_at) * 1000, 1)
            task.seq += 1
            snapshot = self._snapshot(task)
            events = [{"type": UPDATE_EVENT, "chat_id": chat_id, "bot": task.bot, "seq": task.seq,
                       "turn_id": task.turn_id, "turn_index": task.turn_index,
                       "event": {"kind": "turn.finished", "state": state, "reason": task.reason,
                                 "outcome": task.outcome}}]
            if notify:
                events.append({"type": SNAPSHOT_EVENT, "chat_id": chat_id, "bot": task.bot,
                               "snapshot": snapshot})
        for event in events:
            self._emit(event)

    def _update_events(self, task: _Task, payload: Dict[str, Any]) -> List[Dict[str, Any]]:
        task.seq += 1
        return [{"type": UPDATE_EVENT, "chat_id": task.chat_id, "bot": task.bot, "seq": task.seq,
                 "turn_id": task.turn_id, "turn_index": task.turn_index, "event": payload}]

    def _snapshot(self, task: _Task) -> Dict[str, Any]:
        tools = [tool.payload() for tool in task.tools.values()]
        subagents = [sub.payload() for sub in task.subagents.values()]
        plan = task.plan.payload() if task.plan is not None else None
        if plan is not None:
            plan["live"] = task.plan.turn_index == task.turn_index
        done = sum(1 for item in (task.plan.items if task.plan else []) if item["status"] == "completed")
        total = sum(1 for item in (task.plan.items if task.plan else []) if item["status"] != "cancelled")
        return {"chat_id": task.chat_id, "bot": task.bot, "turn_id": task.turn_id,
                "turn_index": task.turn_index, "task_id": None, "state": task.state,
                "started_at": task.started_at, "ended_at": task.ended_at, "updated_at": task.updated_at,
                "reason": task.reason, "outcome": task.outcome, "plan": plan,
                "tools": tools, "subagents": subagents,
                "counts": {"tools": len(tools), "subagents": len(subagents), "plan_done": done, "plan_total": total},
                "seq": task.seq}

    def _emit(self, event: Dict[str, Any]) -> None:
        publish = self._publish
        if publish is None:
            return
        try:
            publish(event)
        except Exception:
            logger.debug("[winglet] could not publish a task event", exc_info=True)


def plan_tool_name(name: Any) -> bool:
    return str(name or "") in _PLAN_TOOLS


# -- plugin hook registration ---------------------------------------------------------------

def register_hooks(ctx: Any, tracker: Tracker) -> Dict[str, bool]:
    """Register the observer hooks this feature needs. Missing hooks never break the platform.

    Returns which hooks were accepted, so the adapter can decide whether the feature is usable.
    """
    def on_turn_start(**kw: Any) -> None:
        tracker.turn_started(kw.get("session_id"), kw.get("turn_id"))

    def on_turn_end(**kw: Any) -> None:
        tracker.turn_finished(kw.get("session_id"), kw.get("turn_id"))

    def on_tool_start(**kw: Any) -> None:
        tracker.tool_started(kw.get("session_id"), kw.get("tool_name"), kw.get("tool_call_id"),
                             kw.get("args"), kw.get("turn_id"), kw.get("index"))

    def on_tool_end(**kw: Any) -> None:
        if plan_tool_name(kw.get("tool_name")):
            tracker.plan_updated(kw.get("session_id"), kw.get("result"), turn_id=kw.get("turn_id"))
        tracker.tool_finished(kw.get("session_id"), kw.get("tool_name"), kw.get("tool_call_id"),
                              kw.get("turn_id"), kw.get("index"), kw.get("status"),
                              kw.get("duration_ms"), kw.get("error_message"), kw.get("error_type"))

    def on_subagent_start(**kw: Any) -> None:
        tracker.subagent_started(kw.get("parent_session_id"), kw.get("child_session_id"),
                                 kw.get("child_subagent_id"), parent_subagent_id=kw.get("parent_subagent_id"),
                                 goal=kw.get("child_goal"), role=kw.get("child_role"),
                                 parent_turn_id=kw.get("parent_turn_id"))

    def on_subagent_stop(**kw: Any) -> None:
        tracker.subagent_finished(kw.get("parent_session_id"), child_session_id=kw.get("child_session_id"),
                                  child_subagent_id=kw.get("child_subagent_id"), status=kw.get("child_status"),
                                  summary=kw.get("child_summary"), duration_ms=kw.get("duration_ms"),
                                  tool_call_history=kw.get("tool_call_history"),
                                  parent_turn_id=kw.get("parent_turn_id"))

    def on_loop_stopped(**kw: Any) -> None:
        tracker.loop_stopped(kw.get("session_key"), reason=kw.get("reason"))

    wanted = {"pre_llm_call": on_turn_start, "post_llm_call": on_turn_end,
              "pre_tool_call": on_tool_start, "post_tool_call": on_tool_end,
              "subagent_start": on_subagent_start, "subagent_stop": on_subagent_stop,
              "agent_loop_stopped": on_loop_stopped}
    accepted: Dict[str, bool] = {}
    register = getattr(ctx, "register_hook", None)
    if register is None:
        return {name: False for name in wanted}
    for name, callback in wanted.items():
        try:
            register(name, callback)
            accepted[name] = True
        except Exception:
            logger.debug("[winglet] this Hermes refused the %s hook", name, exc_info=True)
            accepted[name] = False
    return accepted
