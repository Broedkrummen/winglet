"""Resumable event stream for Winglet: one durable journal per bot, with an epoch and watermarks.

The hub already pushes every change over one WebSocket per bot. A phone that loses that socket used
to reconcile by reloading the chat it was looking at; everything else (an inbox card answered
elsewhere, a chat deleted on another phone, a reply that finished while the screen was off) was only
repaired by the next page load. This module gives those events a durable, resumable identity without
changing any feature's payload:

* ``seq`` counts up per bot, from 1, contiguous, and never repeats. It is assigned in the same
  transaction as the change it describes, so a change is either in the journal and on the wire, or in
  neither.
* ``epoch`` names the sequence space. A restored database or a reset journal starts counting again;
  a cursor from the old generation is refused rather than read as a later position.
* ``watermark`` is the highest seq committed when the server read the head. A resume reply carries
  everything between the phone's cursor and that watermark, so the phone can prove it is caught up
  instead of guessing from the arrival times of filtered frames.
* Filtering happens at replay time, against the device as it is now. The journal stores one copy per
  bot; an owner's promotion or a demotion changes what the same rows yield, and a revoked token
  cannot ask at all.

Gaps in the seq a device receives are normal: they are events another member may not see, or events
for a chat this device does not own. That is why a cursor advances to the watermark, not to the last
event received, and why a hole in the journal (not in the reply) is what forces a snapshot.

Delivery is at-least-once across reconnects, never exactly-once. Clients apply events as idempotent
upserts and ignore a seq at or below their cursor. Nothing here re-sends a message, re-runs a control
or touches the outbox: replay only applies state the server already committed.

Tables are feature-local and created idempotently (:func:`ensure_schema`); no global migration
version is allocated and no existing table is rewritten. Dropping ``event_streams`` and
``event_log`` removes the feature's data and leaves chats, messages, inbox and devices intact.
"""

from __future__ import annotations

import contextlib
import json
import logging
import secrets
import time
from typing import Any, Callable, Dict, List, Optional

from .store import Store

logger = logging.getLogger(__name__)

# What can be applied twice without harm and would be missed by a client that reconnects: state, not
# presence. `typing` (8 s TTL, re-sent while working), `pet.update`, `system.bots` and `system.job`
# are derivable from hello or a refetch, so journaling them would cost rows and prove nothing.
JOURNAL_KINDS = frozenset({
    "message.new", "message.update", "message.delete",
    "chat.update", "chat.delete",
    "inbox.new", "inbox.update",
    "system.paused",
    # Written by this module in place of an event too big to keep (see MAX_PAYLOAD).
    "sync.hint",
})
# Newest events kept per bot, and how old they may be. A turn streams many `message.update` rows, so
# the count is the bound that matters in practice; the age is there for a quiet bot.
KEEP_EVENTS = 1500
KEEP_SECONDS = 3 * 86400
# One row bigger than this is replaced by a hint naming the chat: the client refetches that page.
MAX_PAYLOAD = 64 * 1024
# Rows read per resume reply. A slow or heavily-filtered client pages; the reply says `has_more`.
PAGE = 200
# Age-based trimming runs at most this often per bot (count-based trimming runs on every append).
TRIM_SECONDS = 60

_SCHEMA = """
CREATE TABLE IF NOT EXISTS event_streams (
    bot TEXT PRIMARY KEY,
    next_seq INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS event_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    chat_id TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL,
    payload TEXT NOT NULL,
    UNIQUE (bot, seq)
);
CREATE INDEX IF NOT EXISTS event_log_bot_seq ON event_log (bot, seq);
CREATE INDEX IF NOT EXISTS event_log_created ON event_log (created_at);
"""


def ensure_schema(store: Store) -> None:
    """Create this feature's tables in place. Safe to run on every start and on an old database."""
    with store._lock:
        store._db.executescript(_SCHEMA)


def encode(event: Dict[str, Any]) -> str:
    """The wire form, so a replayed event is byte-identical to the one that was broadcast."""
    return json.dumps(event, separators=(",", ":"), ensure_ascii=False)


def _chat_id_of(event: Dict[str, Any]) -> str:
    chat_id = event.get("chat_id")
    if isinstance(chat_id, str):
        return chat_id
    for key in ("chat", "item", "message"):
        value = event.get(key)
        if isinstance(value, dict) and isinstance(value.get("chat_id"), str):
            return value["chat_id"]
        if key == "chat" and isinstance(value, dict) and isinstance(value.get("id"), str):
            return value["id"]
    return ""


class EventStream:
    """The journal, its cursor arithmetic and the snapshot handshake.

    ``store`` owns the connection and its lock; every write here goes through it so a message and
    its replay event commit together (see :meth:`transaction`).
    """

    def __init__(self, store: Store, *, keep_events: int = KEEP_EVENTS, keep_seconds: float = KEEP_SECONDS,
                 page: int = PAGE):
        self.store = store
        self.keep_events = max(1, int(keep_events))
        self.keep_seconds = max(0.0, float(keep_seconds))
        self.page = max(1, int(page))
        self._last_trim: Dict[str, float] = {}
        ensure_schema(store)

    # -- identity ------------------------------------------------------------------------

    def epoch(self) -> str:
        """The generation of this journal. Stable across restarts; changes when it starts over."""
        return self.store.secret("event_epoch", lambda: secrets.token_hex(8))

    def rotate_epoch(self) -> bool:
        """Start a new generation. Every stored cursor becomes a snapshot request."""
        try:
            self.store.set_kv("event_epoch", secrets.token_hex(8))
            return True
        except Exception:
            logger.exception("[winglet] couldn't rotate the event epoch")
            return False

    def retention(self) -> Dict[str, Any]:
        return {"keep_events": self.keep_events, "keep_seconds": int(self.keep_seconds)}

    # -- writing -------------------------------------------------------------------------

    @contextlib.contextmanager
    def transaction(self):
        """Commit a store change and its journal row together.

        Delegates to the store, which owns the connection and its lock and treats a nested block as
        part of the outer transaction. That is what lets a caller write the chat, append the journal
        row and read back the result inside one atomic unit.
        """
        with self.store.transaction():
            yield

    def append(self, bot: Optional[str], event: Dict[str, Any]) -> Optional[int]:
        """Journal ``event`` for ``bot`` and return its seq, or None when it isn't resumable.

        A payload over ``MAX_PAYLOAD`` is stored as a ``sync.hint`` instead, under the same seq; the
        caller still broadcasts the whole event to live sockets. A journal failure raises, so the
        caller's transaction rolls back the change too: a committed change without its replay row
        would be invisible to every phone that reconnects, which is worse than a retry.
        """
        kind = str(event.get("type") or "")
        if kind not in JOURNAL_KINDS:
            return None
        scope = bot or ""
        payload = encode(event)
        hint = False
        if len(payload.encode("utf-8")) > MAX_PAYLOAD:
            payload = encode({"type": "sync.hint", "chat_id": _chat_id_of(event), "reason": "oversize"})
            hint = True
        now = time.time()
        with self.transaction():
            row = self.store._one("SELECT next_seq FROM event_streams WHERE bot = ?", (scope,))
            seq = (int(row["next_seq"]) if row else 0) + 1
            if row:
                self.store._exec("UPDATE event_streams SET next_seq = ? WHERE bot = ?", (seq, scope))
            else:
                self.store._exec("INSERT INTO event_streams (bot, next_seq, created_at) VALUES (?, ?, ?)",
                                 (scope, seq, now))
            self.store._exec(
                "INSERT INTO event_log (bot, seq, kind, chat_id, created_at, payload) VALUES (?, ?, ?, ?, ?, ?)",
                (scope, seq, "sync.hint" if hint else kind, _chat_id_of(event), now, payload))
            # Count bound: one indexed delete against the primary key, no scan.
            self.store._exec("DELETE FROM event_log WHERE bot = ? AND seq <= ?",
                             (scope, seq - self.keep_events))
            if now - self._last_trim.get(scope, 0.0) > TRIM_SECONDS:
                self._last_trim[scope] = now
                self.store._exec("DELETE FROM event_log WHERE bot = ? AND created_at < ?",
                                 (scope, now - self.keep_seconds))
        return seq

    def head(self, bot: Optional[str]) -> int:
        """The newest seq committed for ``bot`` (0 before its first event). Survives trimming."""
        row = self.store._one("SELECT next_seq FROM event_streams WHERE bot = ?", (bot or "",))
        return int(row["next_seq"]) if row else 0

    # -- reading -------------------------------------------------------------------------

    def replay(self, bot: Optional[str], *, after: Any, epoch: Any,
               visible: Callable[[Dict[str, Any]], bool], page: Optional[int] = None) -> Dict[str, Any]:
        """Events after ``after`` for this bot, filtered by ``visible``, or the reason to snapshot.

        The watermark is read *before* the rows and the rows are bounded by it: an event appended
        while this runs is either in the reply and no later than the watermark, or after it and left
        to the live stream. Neither order loses an event, and both are safe to apply twice.
        """
        scope = bot or ""
        try:
            current = self.epoch()
            head = self.head(scope)
        except Exception:
            logger.exception("[winglet] couldn't read the event stream; asking for a snapshot")
            return {"ok": False, "reason": "journal", "epoch": None, "watermark": 0,
                    "retention": self.retention()}
        base = {"epoch": current, "watermark": head, "retention": self.retention()}
        if not isinstance(after, int) or isinstance(after, bool) or after < 0:
            return {"ok": False, "reason": "cursor", **base}
        if epoch != current:
            return {"ok": False, "reason": "epoch", **base}
        if after > head:
            # The journal started over without a new epoch (an operator dropped the table): the
            # cursor points into a sequence this server never issued.
            return {"ok": False, "reason": "cursor", **base}
        try:
            oldest = self.store._one("SELECT MIN(seq) AS oldest FROM event_log WHERE bot = ?", (scope,))
            first = int(oldest["oldest"]) if oldest is not None and oldest["oldest"] is not None else None
            if after < head and (first is None or after + 1 < first):
                # Rows the client still needed are gone: trimmed by the retention bound, or the whole
                # journal emptied by a reset. Either way only a snapshot can repair it.
                return {"ok": False, "reason": "gap", **base}
            limit = max(1, int(page or self.page))
            rows = self.store._all(
                "SELECT seq, payload FROM event_log WHERE bot = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?",
                (scope, after, head, limit + 1))
        except Exception:
            logger.exception("[winglet] couldn't read the event journal; asking for a snapshot")
            return {"ok": False, "reason": "journal", **base}
        more = len(rows) > limit
        events: List[Dict[str, Any]] = []
        scanned = head
        for row in rows[:limit]:
            scanned = int(row["seq"])
            try:
                event = json.loads(row["payload"])
            except ValueError:
                continue
            if not isinstance(event, dict) or not visible(event):
                continue
            # The same shape as the live frame (which carries its seq), so a client applies both
            # through one path and can page from the last event or from the page cursor.
            events.append({**event, "seq": int(row["seq"])})
        return {"ok": True, "events": events, "has_more": more, "cursor": scanned, **base}

    # -- maintenance ---------------------------------------------------------------------

    def trim(self, bot: Optional[str] = None) -> int:
        """Drop rows past the retention bounds now (the janitor and tests call this)."""
        scope = bot or ""
        removed = self.store._exec("DELETE FROM event_log WHERE bot = ? AND seq <= ?",
                                   (scope, self.head(scope) - self.keep_events))
        removed += self.store._exec("DELETE FROM event_log WHERE bot = ? AND created_at < ?",
                                    (scope, time.time() - self.keep_seconds))
        return removed

    def reset(self, bot: Optional[str] = None) -> None:
        """Forget the journal for one bot (tests and an explicit operator reset). New epoch."""
        with self.store._lock:
            self.store._exec("DELETE FROM event_log WHERE bot = ?", (bot or "",))
            self.store._exec("DELETE FROM event_streams WHERE bot = ?", (bot or "",))
        self.rotate_epoch()
