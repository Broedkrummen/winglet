"""Scoped observation/control of Hermes-owned background processes, never host PIDs."""
from __future__ import annotations

import asyncio
import inspect
import secrets
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Optional

MAX_PROCESSES = 80
MAX_HANDLES = 512
MAX_STOPS = 8
MAX_STOP_RECEIPTS = 32
OUTPUT_CHARS = 16_384  # <=64 KiB UTF-8, independently of upstream retention
HANDLE_TTL = 3600


class ProcessRefused(Exception):
    def __init__(self, code: str, message: str, status: int = 409):
        self.code, self.message, self.status = code, message, status
        super().__init__(message)


@dataclass(frozen=True)
class Scope:
    chat_id: str
    bot: Optional[str]
    key: str
    session_id: str


def generation(process) -> tuple:
    return (process.id, process.started_at, process.pid, process.host_start_time,
            process.session_key, process.parent_session_id)


@dataclass
class Lease:
    handle: str
    scope: Scope
    generation: tuple
    touched: float
    output: str = ""
    revision: int = 0
    previous_revision: int = -1
    delta: Optional[str] = None
    read_sequence: int = 0
    output_sequence: int = 0
    truncated: bool = False
    unavailable: bool = False
    stop: Optional[dict] = None
    stop_receipts: dict[str, dict] = field(default_factory=dict)
    stop_task: Optional[asyncio.Task] = None
    stop_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


def sanitized(text: Any, limit: int) -> str:
    """Use the same forced redaction as server logs; refuse raw output on failure."""
    try:
        from agent.redact import redact_sensitive_text
        from tools.ansi_strip import strip_ansi
        value = str(text or "").encode("utf-8", errors="replace").decode("utf-8")
        value = strip_ansi(value)
        value = redact_sensitive_text(value, force=True, redact_url_credentials=True)
        # Terminal control characters and OSCs must not reach clipboard/rendering.
        value = "".join(c for c in value if c in "\n\t" or (ord(c) >= 32 and ord(c) != 127))
        return value[-limit:]
    except Exception:
        return "[Output hidden: Hermes redaction is unavailable.]"


class HermesProcesses:
    """Small bridge to the pinned real registry and gateway session store."""
    def __init__(self, adapter):
        self.adapter = adapter

    @property
    def store(self):
        return getattr(getattr(self.adapter, "gateway_runner", None), "session_store", None)

    @property
    def registry(self):
        from tools.process_registry import process_registry
        return process_registry

    def available(self) -> bool:
        try:
            from agent.redact import redact_sensitive_text
            from tools.ansi_strip import strip_ansi
            from tools.process_registry import ProcessSession
            registry, store = self.registry, self.store
            fields = ProcessSession.__dataclass_fields__
            return (all(name in fields for name in ('parent_session_id', 'session_key', 'host_start_time', 'total_output_chars', '_lock'))
                    and callable(redact_sensitive_text) and callable(strip_ansi) and store is not None
                    and all(callable(getattr(store, name, None)) for name in
                            ("peek_session_id", "_follow_reroutes", "_compression_tip_for_session_id", "_db_for_key"))
                    and all(callable(getattr(registry, name, None)) for name in ("list_sessions", "get", "kill_process"))
                    and "consume_output" in inspect.signature(registry.kill_process).parameters)
        except Exception:
            return False

    def canonical(self, sid: str) -> str:
        return self.store._compression_tip_for_session_id(self.store._follow_reroutes(sid))

    def scope(self, chat: dict) -> Optional[Scope]:
        key = self.adapter._session_key(chat["id"])
        if not key:
            return None
        sid = self.store.peek_session_id(key)
        return Scope(chat["id"], chat.get("bot") or None, key, self.canonical(sid)) if sid else None

    def belongs(self, process, scope: Scope) -> bool:
        if process.session_key != scope.key or not process.parent_session_id:
            return False
        sid = process.parent_session_id
        db = self.store._db_for_key(scope.key)
        seen = set()
        for _ in range(16):
            if not sid or sid in seen:
                return False
            seen.add(sid)
            if self.canonical(sid) == scope.session_id:
                return True
            row = db.get_session(sid) if db is not None else None
            sid = (row or {}).get("parent_session_id")
        return False

    def get(self, process_id: str):
        item = self.registry.get(process_id)
        # Hermes accepts abbreviations; a phone handle must always resolve the exact ID.
        return item if item is not None and item.id == process_id else None

    def list(self, scope: Scope) -> list:
        candidates = self.registry.list_sessions(session_key=scope.key)
        items = []
        for row in candidates:
            item = self.get(row["session_id"])
            if item is not None and self.belongs(item, scope):
                items.append(item)
        return sorted(items, key=lambda item: item.started_at, reverse=True)

    def stop(self, item) -> dict:
        # The registry owns platform tree termination and PID-start-time guards.
        # Do not consume an autonomous completion notification to display phone output.
        return self.registry.kill_process(item.id, source="winglet.process.stop", consume_output=False)


class Processes:
    def __init__(self, adapter, *, bridge=None, clock=time.monotonic):
        self.bridge = bridge or HermesProcesses(adapter)
        self.clock = clock
        self._lock = threading.RLock()
        self._leases: OrderedDict[str, Lease] = OrderedDict()

    def available(self) -> bool:
        return self.bridge.available()

    def _require_available(self):
        if not self.available():
            raise ProcessRefused("unsupported", "This Hermes can't report background processes.")

    def _prune(self):
        now = self.clock()
        for handle, lease in list(self._leases.items()):
            if lease.stop_task is not None and not lease.stop_task.done():
                continue
            if now - lease.touched > HANDLE_TTL:
                self._leases.pop(handle, None)
        while len(self._leases) >= MAX_HANDLES:
            key = next((h for h, x in self._leases.items() if x.stop_task is None or x.stop_task.done()), None)
            if key is None:
                raise ProcessRefused("busy", "Too many processes are being stopped. Try again shortly.")
            self._leases.pop(key)

    def _lease(self, item, scope: Scope) -> Lease:
        with self._lock:
            stamp = generation(item)
            for handle, lease in self._leases.items():
                if lease.scope == scope and lease.generation == stamp:
                    # A fresh listing rotates exhausted links. Old request IDs then
                    # fail closed instead of becoming executable after cache eviction.
                    if len(lease.stop_receipts) >= MAX_STOP_RECEIPTS and (lease.stop_task is None or lease.stop_task.done()):
                        self._leases.pop(handle)
                        break
                    lease.touched = self.clock()
                    self._leases.move_to_end(handle)
                    return lease
            self._prune()
            lease = Lease(secrets.token_urlsafe(24), scope, stamp, self.clock())
            self._leases[lease.handle] = lease
            return lease

    def _resolve(self, chat: dict, handle: str):
        self._require_available()
        with self._lock:
            lease = self._leases.get(handle)
            if lease is None or self.clock() - lease.touched > HANDLE_TTL:
                raise ProcessRefused("stale", "This process link expired. Reload the process list.")
            if lease.scope.chat_id != chat["id"] or lease.scope.bot != (chat.get("bot") or None):
                raise ProcessRefused("not_found", "That process isn't in this chat.", 404)
            scope = self.bridge.scope(chat)
            item = self.bridge.get(lease.generation[0])
            if (scope != lease.scope or item is None or generation(item) != lease.generation
                    or not self.bridge.belongs(item, scope)):
                raise ProcessRefused("stale", "This process or conversation changed. Reload the process list.")
            lease.touched = self.clock()
            self._leases.move_to_end(handle)
            return item, lease

    def _public(self, item, lease: Lease) -> dict:
        with item._lock:
            status = "running" if not item.exited else "stopped" if item.completion_reason == "killed" else "exited"
            return {"handle": lease.handle, "command": sanitized(item.command, 240),
                    "workspace": sanitized(item.cwd, 500), "status": status,
                    "started_at": item.started_at, "exit_code": item.exit_code,
                    "detached": bool(item.detached), "can_stop": not item.exited,
                    "stop": lease.stop}

    async def listing(self, chat: dict) -> dict:
        if not self.available():
            return {"supported": False, "processes": [], "truncated": False}
        scope = await asyncio.to_thread(self.bridge.scope, chat)
        if scope is None:
            return {"supported": True, "processes": [], "truncated": False}
        items = await asyncio.to_thread(self.bridge.list, scope)
        rows = [self._public(item, self._lease(item, scope)) for item in items[:MAX_PROCESSES]]
        return {"supported": True, "processes": rows, "truncated": len(items) > MAX_PROCESSES}

    async def detail(self, chat: dict, handle: str, cursor: Optional[str] = None) -> dict:
        item, lease = await asyncio.to_thread(self._resolve, chat, handle)
        with item._lock:
            raw = item.output_buffer[-65_536:]
            total = item.total_output_chars
            unavailable = bool(item.detached) and not raw
        with self._lock:
            lease.read_sequence += 1
            sequence = lease.read_sequence
        # Redact the entire retained tail before deriving a delta, including cross-chunk tokens.
        text = await asyncio.to_thread(sanitized, raw, OUTPUT_CHARS)
        with self._lock:
            if sequence < lease.output_sequence:
                text = lease.output  # an older, slower redaction must not roll back a newer read
            else:
                # Hermes sandbox pollers don't consistently advance total_output_chars.
                # Order our snapshots independently of that upstream counter.
                lease.output_sequence = sequence
                lease.truncated = total > len(raw) or len(raw) > OUTPUT_CHARS
                lease.unavailable = unavailable
            if text != lease.output:
                previous = lease.output
                lease.previous_revision = lease.revision
                lease.revision += 1
                lease.delta = text[len(previous):] if text.startswith(previous) else None
                lease.output = text
            same = cursor == str(lease.revision)
            incremental = cursor == str(lease.previous_revision) and lease.delta is not None
            reset = not (same or incremental)
            output = "" if same else lease.delta if incremental else text
            page = {"cursor": str(lease.revision), "reset": reset, "text": output,
                    "truncated": lease.truncated, "unavailable": lease.unavailable}
        return {"process": self._public(item, lease), "output": page}

    async def stop(self, chat: dict, handle: str, operation_id: str) -> dict:
        if (not isinstance(operation_id, str) or not 16 <= len(operation_id) <= 96
                or any(not (c.isascii() and (c.isalnum() or c in "._:-")) for c in operation_id)):
            raise ProcessRefused("invalid", "Expected a valid operation ID.", 400)
        item, lease = await asyncio.to_thread(self._resolve, chat, handle)
        async with lease.stop_lock:
            if operation_id in lease.stop_receipts:
                return lease.stop_receipts[operation_id]
            if lease.stop_task is not None and not lease.stop_task.done():
                return lease.stop
            if lease.stop is not None and lease.stop.get("status") in ("stopped", "already_exited"):
                return lease.stop
            if len(lease.stop_receipts) >= MAX_STOP_RECEIPTS:
                raise ProcessRefused("stale", "This process link reached its attempt limit. Reload the process list.")
            if item.exited:
                lease.stop = {"operation_id": operation_id, "status": "already_exited", "message": "It had already finished."}
                lease.stop_receipts[operation_id] = lease.stop
                return lease.stop
            if item.detached and item.process is None and item.env_ref is None and item._pty is None and item.host_start_time is None:
                raise ProcessRefused("unverifiable", "Hermes can't verify this recovered process's identity. Stop it on the server.")
            if sum(x.stop_task is not None and not x.stop_task.done() for x in self._leases.values()) >= MAX_STOPS:
                raise ProcessRefused("busy", "Too many processes are being stopped. Try again shortly.")
            lease.stop = {"operation_id": operation_id, "status": "stopping", "message": "Waiting for Hermes to confirm the stop."}
            lease.stop_receipts[operation_id] = lease.stop
            lease.stop_task = asyncio.create_task(self._stop_work(chat, handle, lease))
            return lease.stop

    async def _stop_work(self, chat: dict, handle: str, lease: Lease):
        try:
            item, _ = await asyncio.to_thread(self._resolve, chat, handle)
            result = await asyncio.to_thread(self.bridge.stop, item)
            status = result.get("status")
            if status == "killed":
                answer = {"status": "stopped", "message": "Hermes confirmed the process stopped."}
            elif status == "already_exited":
                answer = {"status": "already_exited", "message": "It had already finished."}
            else:
                answer = {"status": "failed", "message": sanitized(result.get("error") or "Hermes couldn't confirm the stop. Refresh and check its status.", 300)}
        except Exception as exc:
            answer = {"status": "failed", "message": sanitized(str(exc), 300)}
        with self._lock:
            lease.stop = {"operation_id": lease.stop["operation_id"], **answer}
            lease.stop_receipts[lease.stop["operation_id"]] = lease.stop

    async def close(self):
        # Do not cancel a thread already terminating an owned process. Let it report the result.
        pending = [x.stop_task for x in self._leases.values() if x.stop_task is not None and not x.stop_task.done()]
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
