"""SQLite-backed state for Winglet: paired devices, pairing codes, chats, messages, inbox, push.

Pure stdlib so it can be unit-tested without Hermes. One connection guarded by a lock; every call is
short, so it is safe to call from the gateway's event loop.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import secrets
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

PAIR_CODE_TTL_SECONDS = 10 * 60
# Crockford-style alphabet: no 0/O/1/I/L so codes survive being read aloud or typed by hand.
_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL DEFAULT '',
    token_hash TEXT NOT NULL UNIQUE, created_at REAL NOT NULL, last_seen REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS pair_codes (
    code_hash TEXT PRIMARY KEY, created_at REAL NOT NULL, expires_at REAL NOT NULL, used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'chat',
    created_at REAL NOT NULL, updated_at REAL NOT NULL, preview TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'final', meta TEXT NOT NULL DEFAULT '{}',
    created_at REAL NOT NULL, updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_chat ON messages (chat_id, created_at);
-- Pages are read newest first by rowid; this index carries it, so a page never sorts the whole chat.
CREATE INDEX IF NOT EXISTS messages_chat_rowid ON messages (chat_id);
-- A phone's resend of a send it never heard back about, however long it was offline, finds the original here.
CREATE INDEX IF NOT EXISTS messages_client_id ON messages (chat_id, json_extract(meta, '$.client_id')) WHERE role = 'user';
CREATE TABLE IF NOT EXISTS message_deletions (
    id TEXT PRIMARY KEY, chat_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS message_deletions_chat ON message_deletions (chat_id);
CREATE TABLE IF NOT EXISTS inbox (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, chat_id TEXT NOT NULL, title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending',
    resolution TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL, updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS inbox_status ON inbox (status, created_at);
CREATE INDEX IF NOT EXISTS inbox_created ON inbox (created_at);
CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY, device_id TEXT NOT NULL, chat_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL,
    kind TEXT NOT NULL, size INTEGER NOT NULL, created_at REAL NOT NULL, message_id TEXT
);
CREATE INDEX IF NOT EXISTS uploads_device ON uploads (device_id, created_at);
CREATE INDEX IF NOT EXISTS uploads_chat ON uploads (chat_id);
CREATE TABLE IF NOT EXISTS upload_holds (
    upload_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, chat_id TEXT NOT NULL, hold_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_materializations (
    device_id TEXT NOT NULL, chat_id TEXT NOT NULL, source_id TEXT NOT NULL, slot TEXT NOT NULL,
    upload_id TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL,
    PRIMARY KEY(device_id,chat_id,source_id,slot)
);
CREATE TABLE IF NOT EXISTS push_prefs (
    device_id TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS push_subs (
    id TEXT PRIMARY KEY, device_id TEXT NOT NULL, kind TEXT NOT NULL, endpoint TEXT NOT NULL,
    data TEXT NOT NULL, created_at REAL NOT NULL, UNIQUE (kind, endpoint)
);
CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, device_id TEXT NOT NULL DEFAULT '',
    device_name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '', action TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '', outcome TEXT NOT NULL DEFAULT 'ok'
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit (ts);
CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, ts REAL NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, idem_key TEXT UNIQUE,
    device_id TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '{}', created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_created ON jobs (created_at);
-- Opt-in phone tools (Assignment 11). Grants are per device and per tool; a scope of '' is the main bot,
-- a bot name is that bot, and '*' is every bot on this server. Events are metadata only: never the note,
-- location, contact fields or event titles that a tool returned.
CREATE TABLE IF NOT EXISTS phone_tool_grants (
    device_id TEXT NOT NULL, tool TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL DEFAULT 'ask', enabled INTEGER NOT NULL DEFAULT 1, updated_at REAL NOT NULL,
    PRIMARY KEY (device_id, tool)
);
CREATE INDEX IF NOT EXISTS phone_tool_grants_device ON phone_tool_grants (device_id);
CREATE TABLE IF NOT EXISTS phone_tool_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, device_id TEXT NOT NULL DEFAULT '',
    bot TEXT NOT NULL DEFAULT '', chat_id TEXT NOT NULL DEFAULT '', tool TEXT NOT NULL,
    event TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS phone_tool_events_device ON phone_tool_events (device_id, ts);
CREATE INDEX IF NOT EXISTS phone_tool_events_ts ON phone_tool_events (ts);
-- Conversation branching (feature: branching). A branch chat keeps a snapshot of where it came from;
-- the parent conversation is never rewritten. Older code ignores these tables.
CREATE TABLE IF NOT EXISTS chat_branches (
    chat_id TEXT PRIMARY KEY, parent_chat_id TEXT NOT NULL, parent_title TEXT NOT NULL DEFAULT '',
    from_message_id TEXT NOT NULL DEFAULT '', mode TEXT NOT NULL DEFAULT 'branch',
    created_at REAL NOT NULL, created_by TEXT NOT NULL DEFAULT '', source_revision TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS chat_branches_parent ON chat_branches (parent_chat_id);
-- Idempotency and the server-held operation state for branch/regenerate calls.
CREATE TABLE IF NOT EXISTS branch_operations (
    op_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, kind TEXT NOT NULL, device_id TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'running', result TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL, updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS branch_operations_chat ON branch_operations (chat_id);
"""

# Columns added after v0.3. Existing phones become owners, unverified until they scan a fresh code.
_MIGRATIONS = [
    ("devices", "role", "TEXT NOT NULL DEFAULT 'owner'"),
    ("devices", "sign_key", "TEXT NOT NULL DEFAULT ''"),
    ("devices", "verified", "INTEGER NOT NULL DEFAULT 0"),
    ("pair_codes", "role", "TEXT NOT NULL DEFAULT 'owner'"),
    ("chats", "owner_device", "TEXT"),
    # The Hermes profile (bot) a chat talks to; NULL is the main one this gateway runs as.
    ("chats", "bot", "TEXT"),
    # When a message was deleted, so old tombstones can be dropped.
    ("message_deletions", "deleted_at", "REAL NOT NULL DEFAULT 0"),
]
ROLES = ("owner", "member")
AUDIT_KEEP_SECONDS = 180 * 86400
AUDIT_KEEP_ROWS = 5000
JOB_STATES = ("running", "succeeded", "failed", "unknown")
JOBS_KEEP = 50
# Tombstones repair phones that were offline when a message was deleted; after this long they're dropped.
DELETIONS_KEEP_SECONDS = 90 * 86400
# Answered inbox items stay as history this long; pending ones stay until answered.
INBOX_KEEP_SECONDS = 90 * 86400
# A device's "last seen" is written at most this often (it's read to the minute).
LAST_SEEN_EVERY_SECONDS = 60


def _hash(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def _now() -> float:
    return time.time()


_LIST_ITEM = re.compile(r"^\s*(?:[-*+•]|\d{1,3}[.)])\s+")
_LINE_MARKUP = re.compile(r"^\s*(?:#{1,6}\s+|>\s?)")


def preview_of(text: str, limit: int = 140) -> str:
    """One line for the chat list: a list's items joined with commas, not "- a - b", and no heading or quote
    markers. The app strips inline Markdown (bold, links) itself."""
    parts: List[str] = []
    item = False
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or line.startswith("```") or set(line) <= set("|-: "):
            continue
        is_item = bool(_LIST_ITEM.match(line))
        heading = line.startswith("#")
        if line.startswith("|"):  # a table row: its cells
            line = " · ".join(c.strip() for c in line.strip("|").split("|") if c.strip())
        line = " ".join(_LINE_MARKUP.sub("", _LIST_ITEM.sub("", line)).split())
        if heading and line and line[-1] not in ".:!?":
            line += ":"
        if parts:
            parts.append(", " if is_item and item else " ")
        parts.append(line)
        item = is_item
        if sum(map(len, parts)) > limit:
            break
    return "".join(parts)[:limit]


def new_id() -> str:
    return uuid.uuid4().hex[:16]


def normalize_code(code: str) -> str:
    """Pairing codes are case-insensitive and may be typed with dashes or spaces."""
    return "".join(ch for ch in (code or "").upper() if ch.isalnum())


class Store:
    def __init__(self, path: Path | str):
        self.path = str(path)
        self._lock = threading.RLock()
        self._db = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        with self._lock:
            self._db.execute("PRAGMA journal_mode=WAL")
            # Safe with WAL (a power cut can lose the last commits, never corrupt the file), and commits stop
            # waiting on a disk flush each: a streamed reply commits many times a second.
            self._db.execute("PRAGMA synchronous=NORMAL")
            self._db.executescript(_SCHEMA)
            for table, column, decl in _MIGRATIONS:
                columns = {r["name"] for r in self._db.execute(f"PRAGMA table_info({table})")}
                if column not in columns:
                    self._db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
            # Tombstones from before deleted_at count from now.
            self._db.execute("UPDATE message_deletions SET deleted_at = ? WHERE deleted_at = 0", (_now(),))
            # Keys and tokens live here: keep the file private to this user.
            with contextlib.suppress(OSError):
                os.chmod(self.path, 0o600)
            # v0.1 shared one topic between phones. Retire it before the upgraded hub can send any
            # push, including when its row belongs to a different phone than the one being revoked.
            legacy_topic = self.get_kv("ntfy_topic")
            if legacy_topic:
                self._exec("DELETE FROM push_subs WHERE kind = 'ntfy' AND json_extract(data, '$.topic') = ?",
                           (legacy_topic,))

    def close(self) -> None:
        with self._lock:
            self._db.close()

    # -- helpers ---------------------------------------------------------------

    def _one(self, sql: str, args: tuple = ()) -> Optional[sqlite3.Row]:
        with self._lock:
            return self._db.execute(sql, args).fetchone()

    def _all(self, sql: str, args: tuple = ()) -> List[sqlite3.Row]:
        with self._lock:
            return self._db.execute(sql, args).fetchall()

    def _exec(self, sql: str, args: tuple = ()) -> int:
        with self._lock:
            return self._db.execute(sql, args).rowcount

    @contextlib.contextmanager
    def transaction(self):
        """Run several statements as one atomic write; nested use joins the outer transaction.

        The connection runs in autocommit mode, so ``BEGIN IMMEDIATE`` is what makes the block
        atomic. When a caller already opened a transaction (the event journal does, so a change and
        its replay row commit together) this only joins it and leaves the commit to that owner.
        """
        with self._lock:
            own = not self._db.in_transaction
            if own:
                self._db.execute("BEGIN IMMEDIATE")
            try:
                yield
            except BaseException:
                if own:
                    self._db.rollback()
                raise
            else:
                if own:
                    self._db.commit()

    # -- key/value ---------------------------------------------------------------

    def get_kv(self, key: str) -> Optional[str]:
        row = self._one("SELECT value FROM kv WHERE key = ?", (key,))
        return row["value"] if row else None

    def set_kv(self, key: str, value: str) -> None:
        self._exec("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                   (key, value))

    def secret(self, key: str, factory=lambda: secrets.token_urlsafe(32)) -> str:
        """Get-or-create a persistent secret (signing keys, ntfy topic, ...)."""
        with self._lock:
            value = self.get_kv(key)
            if value is None:
                value = factory()
                self.set_kv(key, value)
            return value

    # -- pairing -----------------------------------------------------------------

    def create_pair_code(self, ttl: float = PAIR_CODE_TTL_SECONDS, role: str = "owner") -> str:
        if role not in ROLES:
            raise ValueError("role must be owner or member")
        code = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(8))
        now = _now()
        with self._lock:
            self._exec("DELETE FROM pair_codes WHERE expires_at < ? OR used = 1", (now,))
            self._exec("INSERT INTO pair_codes (code_hash, created_at, expires_at, role) VALUES (?, ?, ?, ?)",
                       (_hash(code), now, now + ttl, role))
        return code

    def redeem_pair_code(self, code: str) -> Optional[str]:
        """Consume a pairing code. Returns the role it grants, exactly once per valid, unexpired code."""
        code_hash = _hash(normalize_code(code))
        with self._lock:
            row = self._one("SELECT role FROM pair_codes WHERE code_hash = ? AND used = 0 AND expires_at >= ?",
                            (code_hash, _now()))
            if row is None:
                return None
            changed = self._exec("UPDATE pair_codes SET used = 1 WHERE code_hash = ? AND used = 0", (code_hash,))
        return row["role"] if changed == 1 else None

    # -- devices -----------------------------------------------------------------

    def add_device(self, name: str, platform: str = "", *, role: str = "owner", sign_key: str = "",
                   verified: bool = False) -> tuple[Dict[str, Any], str]:
        if role not in ROLES:
            raise ValueError("role must be owner or member")
        token = secrets.token_urlsafe(32)
        device_id, now = new_id(), _now()
        name = (name or "").strip()[:64] or "My phone"
        self._exec("INSERT INTO devices (id, name, platform, token_hash, created_at, last_seen, role, sign_key, verified) "
                   "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                   (device_id, name, (platform or "")[:32], _hash(token), now, now, role, sign_key,
                    1 if verified and sign_key else 0))
        return self.get_device(device_id), token

    def update_device(self, device_id: str, *, name: Optional[str] = None, role: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """Rename or change a role. Refuses to leave the server without an owner."""
        with self._lock:
            device = self.get_device(device_id)
            if device is None:
                return None
            if role is not None:
                if role not in ROLES:
                    raise ValueError("role must be owner or member")
                if device["role"] == "owner" and role != "owner" and self.owner_count() <= 1:
                    raise ValueError("At least one owner must remain.")
                self._exec("UPDATE devices SET role = ? WHERE id = ?", (role, device_id))
            if name is not None and name.strip():
                self._exec("UPDATE devices SET name = ? WHERE id = ?", (name.strip()[:64], device_id))
            return self.get_device(device_id)

    def owner_count(self) -> int:
        row = self._one("SELECT COUNT(*) AS n FROM devices WHERE role = 'owner'")
        return int(row["n"]) if row else 0

    def set_device_key(self, device_id: str, sign_key: str) -> Optional[Dict[str, Any]]:
        """Record a phone's signing key once it has proved it scanned a fresh code from this server."""
        self._exec("UPDATE devices SET sign_key = ?, verified = 1 WHERE id = ?", (sign_key, device_id))
        return self.get_device(device_id)

    def device_sign_key(self, device_id: str) -> str:
        row = self._one("SELECT sign_key FROM devices WHERE id = ? AND verified = 1", (device_id,))
        return row["sign_key"] if row else ""

    def rotate_token(self, device_id: str) -> Optional[str]:
        token = secrets.token_urlsafe(32)
        if self._exec("UPDATE devices SET token_hash = ? WHERE id = ?", (_hash(token), device_id)) != 1:
            return None
        return token

    def device_for_token(self, token: str) -> Optional[Dict[str, Any]]:
        if not token:
            return None
        row = self._one("SELECT * FROM devices WHERE token_hash = ?", (_hash(token),))
        if not row:
            return None
        now = _now()
        if now - row["last_seen"] >= LAST_SEEN_EVERY_SECONDS:  # not a write on every request
            self._exec("UPDATE devices SET last_seen = ? WHERE id = ?", (now, row["id"]))
        return self._device(row)

    def get_device(self, device_id: str) -> Optional[Dict[str, Any]]:
        row = self._one("SELECT * FROM devices WHERE id = ?", (device_id,))
        return self._device(row) if row else None

    def list_devices(self) -> List[Dict[str, Any]]:
        return [self._device(r) for r in self._all("SELECT * FROM devices ORDER BY created_at")]

    def remove_device(self, device_id: str, *, keep_an_owner: bool = False) -> bool:
        with self.transaction():
            if keep_an_owner:
                device = self.get_device(device_id)
                if device and device["role"] == "owner" and self.owner_count() <= 1:
                    raise ValueError("At least one owner must remain.")
            self._exec("DELETE FROM push_subs WHERE device_id = ?", (device_id,))
            self._exec("DELETE FROM push_prefs WHERE device_id = ?", (device_id,))
            removed = self._exec("DELETE FROM devices WHERE id = ?", (device_id,)) == 1
            if removed:
                # Notification action links are signed with this key; rotating it voids any the
                # removed phone may still hold.
                self._exec("DELETE FROM kv WHERE key = 'action_key'")
            return removed

    @staticmethod
    def _device(row: sqlite3.Row) -> Dict[str, Any]:
        return {"id": row["id"], "name": row["name"], "platform": row["platform"],
                "created_at": row["created_at"], "last_seen": row["last_seen"],
                "role": row["role"], "verified": bool(row["verified"])}

    # -- chats -------------------------------------------------------------------

    def ensure_chat(self, chat_id: str, title: str = "", kind: str = "chat", owner_device: Optional[str] = None,
                    bot: Optional[str] = None) -> Dict[str, Any]:
        """``owner_device`` marks a member's chat; owners' chats have none, and every owner sees them.
        ``bot`` is the Hermes profile the chat talks to (None: the main one)."""
        now = _now()
        self._exec("INSERT OR IGNORE INTO chats (id, title, kind, created_at, updated_at, owner_device, bot) "
                   "VALUES (?, ?, ?, ?, ?, ?, ?)", (chat_id, (title or chat_id)[:80], kind, now, now, owner_device, bot or None))
        return self.get_chat(chat_id)

    def create_chat(self, title: str = "", owner_device: Optional[str] = None, bot: Optional[str] = None) -> Dict[str, Any]:
        return self.ensure_chat("c-" + new_id(), (title or "").strip() or "New chat", owner_device=owner_device, bot=bot)

    def get_chat(self, chat_id: str) -> Optional[Dict[str, Any]]:
        row = self._one("SELECT * FROM chats WHERE id = ?", (chat_id,))
        if row is None:
            return None
        return self._with_branch(dict(row))

    def list_chats(self, bot: Optional[str] = None) -> List[Dict[str, Any]]:
        """One bot's chats (None: the main bot's)."""
        return [self._with_branch(dict(r)) for r in
                self._all("SELECT * FROM chats WHERE COALESCE(bot, '') = ? ORDER BY updated_at DESC", (bot or "",))]

    def _with_branch(self, chat: Dict[str, Any]) -> Dict[str, Any]:
        """Add the branch snapshot (where this chat came from), if it is one. One cheap indexed lookup."""
        chat["branch"] = self.branch_info(chat["id"])
        return chat

    # -- branching ---------------------------------------------------------------

    def create_branch(self, chat_id: str, parent_chat_id: str, parent_title: str, from_message_id: str,
                      mode: str, created_by: str, source_revision: str) -> None:
        """Record a branch chat's origin. The chat row itself is created by ``create_chat``."""
        self._exec("INSERT OR REPLACE INTO chat_branches (chat_id, parent_chat_id, parent_title, from_message_id, "
                   "mode, created_at, created_by, source_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                   (chat_id, parent_chat_id, (parent_title or "")[:80], from_message_id, mode, _now(),
                    created_by, source_revision))

    def branch_info(self, chat_id: str) -> Optional[Dict[str, Any]]:
        row = self._one("SELECT parent_chat_id, parent_title, from_message_id, mode, created_at, source_revision "
                        "FROM chat_branches WHERE chat_id = ?", (chat_id,))
        return dict(row) if row else None

    def branch_children(self, chat_id: str) -> List[Dict[str, Any]]:
        """Branches made from this chat, newest first, with the title they carry now."""
        rows = self._all("SELECT c.id, c.title, c.created_at FROM chat_branches b JOIN chats c ON c.id = b.chat_id "
                         "WHERE b.parent_chat_id = ? ORDER BY b.created_at DESC", (chat_id,))
        return [dict(r) for r in rows]

    def branch_op(self, op_id: str) -> Optional[Dict[str, Any]]:
        row = self._one("SELECT * FROM branch_operations WHERE op_id = ?", (op_id,))
        if row is None:
            return None
        out = dict(row)
        out["result"] = json.loads(out["result"]) if out.get("result") else None
        return out

    def claim_branch_op(self, op_id: str, chat_id: str, kind: str, device_id: str) -> tuple:
        """Claim an operation id. Returns (existing, None) for a finished op, (None, "in_progress")
        for one still running, or (None, None) once this caller owns it. A different chat/kind is
        always a conflict."""
        with self._lock:
            now = _now()
            row = self._one("SELECT * FROM branch_operations WHERE op_id = ?", (op_id,))
            if row is not None:
                if (row["chat_id"] != chat_id or row["kind"] != kind
                        or (row["device_id"] and row["device_id"] != device_id)):
                    return {"conflict": True}, None
                if row["state"] == "done":
                    return self.branch_op(op_id), None
                # A running row left by a process that died must not block the id forever.
                if row["state"] == "running" and now - float(row["updated_at"] or 0) < 120:
                    return None, "in_progress"
                # A failed op (or an abandoned running one) may be retried with the same id.
            self._exec("INSERT OR REPLACE INTO branch_operations (op_id, chat_id, kind, device_id, state, result, "
                       "error, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', '', '', ?, ?)",
                       (op_id, chat_id, kind, device_id, now, now))
            return None, None

    def finish_branch_op(self, op_id: str, result: Optional[Dict[str, Any]] = None, error: str = "") -> None:
        state = "done" if result is not None else "failed"
        self._exec("UPDATE branch_operations SET state = ?, result = ?, error = ?, updated_at = ? WHERE op_id = ?",
                   (state, json.dumps(result) if result is not None else "", (error or "")[:500], _now(), op_id))

    def import_messages(self, chat_id: str, rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Insert branch copies with their original times and positions in one transaction.
        Each row needs id, role, text, status, meta, created_at, updated_at."""
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                for row in rows:
                    self._exec("INSERT INTO messages (id, chat_id, role, text, status, meta, created_at, updated_at) "
                               "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                               (row["id"], chat_id, row["role"], row.get("text") or "", row.get("status") or "final",
                                json.dumps(row.get("meta") or {}), row.get("created_at") or _now(),
                                row.get("updated_at") or row.get("created_at") or _now()))
                last = rows[-1] if rows else None
                if last is not None:
                    self._exec("UPDATE chats SET updated_at = ?, preview = ? WHERE id = ?",
                               (_now(), preview_of(last.get("text") or ""), chat_id))
                self._db.commit()
            except Exception:
                self._db.rollback()
                raise
        return [self.get_message(row["id"]) for row in rows]

    def rename_chat(self, chat_id: str, title: str) -> Optional[Dict[str, Any]]:
        title = (title or "").strip()[:80]
        if not title:
            return self.get_chat(chat_id)
        self._exec("UPDATE chats SET title = ? WHERE id = ?", (title, chat_id))
        return self.get_chat(chat_id)

    def delete_chat(self, chat_id: str) -> bool:
        with self.transaction():
            self._exec("INSERT OR IGNORE INTO message_deletions (id, chat_id, deleted_at) "
                       "SELECT id, chat_id, ? FROM messages WHERE chat_id = ?", (_now(), chat_id))
            self._exec("DELETE FROM messages WHERE chat_id = ?", (chat_id,))
            self._exec("DELETE FROM chat_branches WHERE chat_id = ?", (chat_id,))
            return self._exec("DELETE FROM chats WHERE id = ?", (chat_id,)) == 1

    def _touch_chat(self, chat_id: str, preview: str, meta: Optional[Dict[str, Any]] = None) -> None:
        # Model/thinking controls are recorded for sync, but opening settings is not conversation activity.
        meta = meta or {}
        if meta.get("hidden") or (meta.get("picker") or {}).get("kind") in ("model", "choice"):
            return
        self._exec("UPDATE chats SET updated_at = ?, preview = ? WHERE id = ?", (_now(), preview_of(preview), chat_id))

    # -- messages ----------------------------------------------------------------

    def add_message(self, chat_id: str, role: str, text: str, *, status: str = "final",
                    meta: Optional[Dict[str, Any]] = None, message_id: Optional[str] = None) -> Dict[str, Any]:
        self.ensure_chat(chat_id)
        message_id, now = message_id or new_id(), _now()
        self._exec("INSERT INTO messages (id, chat_id, role, text, status, meta, created_at, updated_at) "
                   "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                   (message_id, chat_id, role, text, status, json.dumps(meta or {}), now, now))
        self._touch_chat(chat_id, text, meta)
        return self.get_message(message_id)

    def update_message(self, message_id: str, text: str, *, status: Optional[str] = None,
                       meta: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
        with self._lock:
            current = self.get_message(message_id)
            if current is None:
                return None
            status = status or current["status"]
            meta = meta if meta is not None else current["meta"]
            now = _now()
            self._exec("UPDATE messages SET text = ?, status = ?, meta = ?, updated_at = ? WHERE id = ?",
                       (text, status, json.dumps(meta), now, message_id))
            # The chat's preview and order follow a reply once it's done, not on each streamed edit.
            if status != "streaming":
                self._touch_chat(current["chat_id"], text, meta)
            return {**current, "text": text, "status": status, "meta": json.loads(json.dumps(meta)), "updated_at": now}

    def delete_message(self, message_id: str) -> Optional[Dict[str, Any]]:
        with self.transaction():
            current = self.get_message(message_id)
            if current is not None:
                self._exec("INSERT OR IGNORE INTO message_deletions (id, chat_id, deleted_at) VALUES (?, ?, ?)",
                           (message_id, current["chat_id"], _now()))
                self._exec("DELETE FROM messages WHERE id = ?", (message_id,))
                latest = self._one("SELECT text FROM messages WHERE chat_id = ? "
                                   "AND COALESCE(json_extract(meta, '$.hidden'), 0) != 1 "
                                   "AND COALESCE(json_extract(meta, '$.picker.kind'), '') NOT IN ('model', 'choice') "
                                   "ORDER BY rowid DESC LIMIT 1", (current["chat_id"],))
                self._exec("UPDATE chats SET preview = ? WHERE id = ?",
                           (preview_of(latest["text"]) if latest else "", current["chat_id"]))
            return current

    def deleted_message_ids(self, chat_id: str) -> List[str]:
        """Durable tombstones let a reconnect repair delete events the phone missed while offline."""
        return [r["id"] for r in self._all("SELECT id FROM message_deletions WHERE chat_id = ?", (chat_id,))]

    def find_user_message(self, chat_id: str, client_id: str) -> Optional[Dict[str, Any]]:
        """A message this chat already received with the app's ``client_id`` (retry detection)."""
        # Matches the messages_client_id index (same expression, same role), so it's a lookup, not a scan.
        row = self._one("SELECT rowid AS position, * FROM messages WHERE chat_id = ? "
                        "AND json_extract(meta, '$.client_id') = ? AND role = 'user'", (chat_id, client_id))
        return self._message(row) if row else None

    def streaming_messages(self, chat_id: str) -> List[Dict[str, Any]]:
        rows = self._all("SELECT rowid AS position, * FROM messages WHERE chat_id = ? AND status = 'streaming'", (chat_id,))
        return [self._message(r) for r in rows]

    def get_message(self, message_id: str) -> Optional[Dict[str, Any]]:
        row = self._one("SELECT rowid AS position, * FROM messages WHERE id = ?", (message_id,))
        return self._message(row) if row else None

    def list_messages(self, chat_id: str, *, before_position: Optional[int] = None, before_id: Optional[str] = None, before: Optional[float] = None,
                      limit: int = 50) -> List[Dict[str, Any]]:
        """Newest ``limit`` messages, oldest first. Pages by insertion order (rowid), so messages that
        share a timestamp are never skipped; ``before`` (a timestamp) is kept for older clients."""
        limit = max(1, min(int(limit or 50), 200))
        if before_position is not None:
            rows = self._all("SELECT rowid AS position, * FROM messages WHERE chat_id = ? AND rowid < ? "
                             "ORDER BY rowid DESC LIMIT ?", (chat_id, before_position, limit))
        elif before_id:
            rows = self._all("SELECT rowid AS position, * FROM messages WHERE chat_id = ? AND rowid < "
                             "(SELECT rowid FROM messages WHERE id = ?) ORDER BY rowid DESC LIMIT ?",
                             (chat_id, before_id, limit))
        elif before:
            rows = self._all("SELECT rowid AS position, * FROM messages WHERE chat_id = ? AND created_at < ? "
                             "ORDER BY rowid DESC LIMIT ?", (chat_id, float(before), limit))
        else:
            rows = self._all("SELECT rowid AS position, * FROM messages WHERE chat_id = ? ORDER BY rowid DESC LIMIT ?",
                             (chat_id, limit))
        return [self._message(r) for r in reversed(rows)]

    @staticmethod
    def _message(row: sqlite3.Row) -> Dict[str, Any]:
        out = dict(row)
        out["meta"] = json.loads(out.get("meta") or "{}")
        return out

    # -- inbox -------------------------------------------------------------------

    def add_inbox(self, kind: str, chat_id: str, title: str, body: str = "",
                  payload: Optional[Dict[str, Any]] = None, status: str = "pending") -> Dict[str, Any]:
        item_id, now = new_id(), _now()
        self._exec("INSERT INTO inbox (id, kind, chat_id, title, body, payload, status, created_at, updated_at) "
                   "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                   (item_id, kind, chat_id, title[:200], body, json.dumps(payload or {}), status, now, now))
        return self.get_inbox(item_id)

    def get_inbox(self, item_id: str) -> Optional[Dict[str, Any]]:
        row = self._one("SELECT * FROM inbox WHERE id = ?", (item_id,))
        return self._inbox(row) if row else None

    def list_inbox(self, *, status: Optional[str] = None, limit: int = 100) -> List[Dict[str, Any]]:
        limit = max(1, min(int(limit or 100), 500))
        if status:
            rows = self._all("SELECT * FROM inbox WHERE status = ? ORDER BY created_at DESC LIMIT ?", (status, limit))
        else:
            rows = self._all("SELECT * FROM inbox ORDER BY created_at DESC LIMIT ?", (limit,))
        return [self._inbox(r) for r in rows]

    def resolve_inbox(self, item_id: str, status: str, resolution: str = "") -> Optional[Dict[str, Any]]:
        """Move a pending item to ``status``; returns None if it was not pending (already handled)."""
        with self._lock:
            changed = self._exec("UPDATE inbox SET status = ?, resolution = ?, updated_at = ? "
                                 "WHERE id = ? AND status = 'pending'", (status, resolution, _now(), item_id))
            return self.get_inbox(item_id) if changed == 1 else None

    def expire_pending(self, kind: str, *, chat_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """Mark pending items of ``kind`` expired (e.g. when a new approval supersedes old ones)."""
        with self._lock:
            if chat_id:
                rows = self._all("SELECT id FROM inbox WHERE kind = ? AND chat_id = ? AND status = 'pending'",
                                 (kind, chat_id))
            else:
                rows = self._all("SELECT id FROM inbox WHERE kind = ? AND status = 'pending'", (kind,))
            return [item for r in rows if (item := self.resolve_inbox(r["id"], "expired"))]

    def pending_items(self, kind: Optional[str] = None) -> List[Dict[str, Any]]:
        """Every pending item, however old: these are the ones that still need an answer."""
        if kind:
            rows = self._all("SELECT * FROM inbox WHERE status = 'pending' AND kind = ? ORDER BY created_at DESC",
                             (kind,))
        else:
            rows = self._all("SELECT * FROM inbox WHERE status = 'pending' ORDER BY created_at DESC")
        return [self._inbox(r) for r in rows]

    def pending_count(self) -> int:
        row = self._one("SELECT COUNT(*) AS n FROM inbox WHERE status = 'pending'")
        return int(row["n"]) if row else 0

    def pending_count_for(self, bot: Optional[str], owner_device: Optional[str] = None) -> int:
        """Pending items in one bot's chats (None: the main bot's); with ``owner_device``, only in the chats
        that device started (what a member sees)."""
        sql = ("SELECT COUNT(*) AS n FROM inbox JOIN chats ON chats.id = inbox.chat_id "
               "WHERE inbox.status = 'pending' AND COALESCE(chats.bot, '') = ?")
        args: tuple = (bot or "",)
        if owner_device is not None:
            sql += " AND chats.owner_device = ?"
            args += (owner_device,)
        row = self._one(sql, args)
        return int(row["n"]) if row else 0

    def prune(self, now: Optional[float] = None) -> int:
        """Drop old tombstones and old answered inbox items. Returns how many rows went."""
        now = now or _now()
        return (self._exec("DELETE FROM phone_tool_events WHERE ts < ? OR id NOT IN (SELECT id FROM phone_tool_events ORDER BY id DESC LIMIT 5000)", (now - 30 * 86400,))
                + self._exec("DELETE FROM message_deletions WHERE deleted_at < ?", (now - DELETIONS_KEEP_SECONDS,))
                + self._exec("DELETE FROM inbox WHERE status != 'pending' AND updated_at < ?",
                             (now - INBOX_KEEP_SECONDS,)))

    @staticmethod
    def _inbox(row: sqlite3.Row) -> Dict[str, Any]:
        out = dict(row)
        out["payload"] = json.loads(out.get("payload") or "{}")
        return out

    # -- push subscriptions --------------------------------------------------------

    def add_push_sub(self, device_id: str, kind: str, endpoint: str, data: Dict[str, Any]) -> Dict[str, Any]:
        sub_id = new_id()
        with self._lock:
            self._exec("DELETE FROM push_subs WHERE kind = ? AND endpoint = ?", (kind, endpoint))
            self._exec("INSERT INTO push_subs (id, device_id, kind, endpoint, data, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                       (sub_id, device_id, kind, endpoint, json.dumps(data), _now()))
        return {"id": sub_id, "device_id": device_id, "kind": kind, "endpoint": endpoint}

    def list_push_subs(self, kind: Optional[str] = None) -> List[Dict[str, Any]]:
        if kind:
            rows = self._all("SELECT * FROM push_subs WHERE kind = ?", (kind,))
        else:
            rows = self._all("SELECT * FROM push_subs")
        return [{**dict(r), "data": json.loads(r["data"])} for r in rows]

    def remove_push_sub(self, *, endpoint: str, device_id: Optional[str] = None) -> int:
        if device_id:
            return self._exec("DELETE FROM push_subs WHERE endpoint = ? AND device_id = ?", (endpoint, device_id))
        return self._exec("DELETE FROM push_subs WHERE endpoint = ?", (endpoint,))

    # -- uploads ---------------------------------------------------------------------

    def add_upload(self, upload_id: str, device_id: str, chat_id: str, name: str, mime: str, kind: str,
                   size: int) -> Dict[str, Any]:
        self._exec("INSERT INTO uploads (id, device_id, chat_id, name, mime, kind, size, created_at) "
                   "VALUES (?, ?, ?, ?, ?, ?, ?, ?)", (upload_id, device_id, chat_id, name, mime, kind, int(size), _now()))
        return self.get_upload(upload_id)

    def get_upload(self, upload_id: str) -> Optional[Dict[str, Any]]:
        row = self._one("SELECT * FROM uploads WHERE id = ?", (upload_id,))
        return dict(row) if row else None

    def claim_uploads(self, upload_ids: List[str], device_id: str, chat_id: str, message_id: str) -> Optional[List[Dict[str, Any]]]:
        """Attach uploads to a message. All or nothing: each must belong to this device and chat and
        not already be attached to another message; otherwise None and nothing changes."""
        with self.transaction():
            rows = []
            for upload_id in upload_ids:
                row = self.get_upload(upload_id)
                if (row is None or row["device_id"] != device_id or row["chat_id"] != chat_id
                        or row["message_id"] not in (None, message_id)):
                    return None
                rows.append(row)
            for row in rows:
                self._exec("UPDATE uploads SET message_id = ? WHERE id = ?", (message_id, row["id"]))
                self._exec('DELETE FROM upload_holds WHERE upload_id=?', (row['id'],))
            return [self.get_upload(r["id"]) for r in rows]

    def upload_bytes_since(self, device_id: str, since: float) -> int:
        row = self._one("SELECT COALESCE(SUM(size), 0) AS n FROM uploads WHERE device_id = ? AND created_at >= ?",
                        (device_id, since))
        return int(row["n"]) if row else 0

    def total_upload_bytes(self) -> int:
        row = self._one("SELECT COALESCE(SUM(size), 0) AS n FROM uploads")
        return int(row["n"]) if row else 0

    def stale_uploads(self, older_than: float) -> List[Dict[str, Any]]:
        """Uploads never attached to a message, created before ``older_than``."""
        return [dict(r) for r in self._all("SELECT * FROM uploads WHERE message_id IS NULL AND created_at < ?",
                                           (older_than,))]

    def chat_uploads(self, chat_id: str) -> List[Dict[str, Any]]:
        return [dict(r) for r in self._all("SELECT * FROM uploads WHERE chat_id = ?", (chat_id,))]

    def delete_upload(self, upload_id: str) -> None:
        with self.transaction():
            self._exec('DELETE FROM upload_holds WHERE upload_id=?', (upload_id,))
            self._exec('DELETE FROM sync_materializations WHERE upload_id=?', (upload_id,))
            self._exec("DELETE FROM uploads WHERE id = ?", (upload_id,))

    def upload_held(self, upload_id: str) -> bool:
        return self._one('SELECT 1 FROM upload_holds WHERE upload_id=?', (upload_id,)) is not None

    def hold_uploads(self, upload_ids: List[str], device_id: str, chat_id: str, hold_id: str) -> bool:
        with self.transaction():
            device = self.get_device(device_id)
            if not device or device['role'] != 'owner':
                return False
            rows = [self.get_upload(upload_id) for upload_id in upload_ids]
            if any(row is None or row['device_id'] != device_id or row['chat_id'] != chat_id or row['message_id'] is not None for row in rows):
                return False
            if any(self._one('SELECT 1 FROM upload_holds WHERE upload_id=? AND hold_id!=?', (row['id'], hold_id)) for row in rows):
                return False
            for row in rows:
                self._exec('INSERT INTO upload_holds VALUES (?,?,?,?) ON CONFLICT(upload_id) '
                           'DO UPDATE SET hold_id=excluded.hold_id', (row['id'], device_id, chat_id, hold_id))
            return True

    def release_uploads(self, device_id: str, chat_id: str, hold_id: str) -> None:
        self._exec('DELETE FROM upload_holds WHERE device_id=? AND chat_id=? AND hold_id=?', (device_id, chat_id, hold_id))

    def orphan_upload_holds(self, bot: str, after: str = '') -> List[Dict[str, Any]]:
        return [dict(row) for row in self._all('SELECT u.*,h.hold_id FROM upload_holds h JOIN uploads u ON u.id=h.upload_id '
            'JOIN chats c ON c.id=u.chat_id LEFT JOIN devices d ON d.id=h.device_id '
            "WHERE d.id IS NULL AND u.id>? AND COALESCE(c.bot,'')=? ORDER BY u.id LIMIT 101", (after, bot))]

    def release_orphan_uploads(self, actor: str, source_device: str, chat_id: str, hold_id: str) -> bool:
        with self.transaction():
            device = self.get_device(actor)
            if not device or device['role'] != 'owner' or self.get_device(source_device):
                return False
            self.release_uploads(source_device, chat_id, hold_id)
            return True

    # -- notification preferences --------------------------------------------------------

    def get_push_prefs(self, device_id: str) -> Dict[str, Any]:
        row = self._one("SELECT data FROM push_prefs WHERE device_id = ?", (device_id,))
        return json.loads(row["data"]) if row else {}

    def set_push_prefs(self, device_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
        self._exec("INSERT INTO push_prefs (device_id, data) VALUES (?, ?) "
                   "ON CONFLICT(device_id) DO UPDATE SET data = excluded.data", (device_id, json.dumps(data)))
        return self.get_push_prefs(device_id)

    def all_messages(self, chat_id: str) -> List[Dict[str, Any]]:
        rows = self._all("SELECT rowid AS position, * FROM messages WHERE chat_id = ? ORDER BY rowid", (chat_id,))
        return [self._message(r) for r in rows]

    def search_messages(self, query: str, chat_ids: List[str], *, limit: int = 50) -> List[Dict[str, Any]]:
        """Newest messages in these chats whose text contains every word of the query, in any order and
        ignoring case (so a phrase still matches across a line break). Hidden helper messages and status
        lines are left out."""
        words = [w.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") for w in query.split()[:10]]
        if not chat_ids or not words:
            return []
        marks = ",".join("?" * len(chat_ids))
        likes = " AND ".join(["text LIKE ? ESCAPE '\\'"] * len(words))
        rows = self._all(f"SELECT rowid AS position, * FROM messages WHERE chat_id IN ({marks}) AND role != 'system' "
                         f"AND {likes} AND COALESCE(json_extract(meta, '$.hidden'), 0) = 0 "
                         "ORDER BY rowid DESC LIMIT ?",
                         (*chat_ids, *(f"%{w}%" for w in words), max(1, min(limit, 100))))
        return [self._message(r) for r in rows]

    def chat_attachments(self, chat_id: str, *, limit: int = 300) -> List[Dict[str, Any]]:
        """Every file and photo in a chat, newest first, each with the message it came in."""
        rows = self._all("SELECT id, role, meta, created_at FROM messages WHERE chat_id = ? "
                         "AND json_array_length(json_extract(meta, '$.attachments')) > 0 ORDER BY rowid DESC LIMIT ?",
                         (chat_id, max(1, min(limit, 1000))))
        out: List[Dict[str, Any]] = []
        for r in rows:
            for a in json.loads(r["meta"] or "{}").get("attachments") or []:
                if isinstance(a, dict):
                    out.append({**a, "message_id": r["id"], "role": r["role"], "created_at": r["created_at"]})
        return out

    # -- audit log -------------------------------------------------------------------

    def add_audit(self, action: str, *, device: Optional[Dict[str, Any]] = None, summary: str = "",
                  outcome: str = "ok") -> None:
        now = _now()
        with self._lock:
            self._exec("INSERT INTO audit (ts, device_id, device_name, role, action, summary, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)",
                       (now, (device or {}).get("id", ""), (device or {}).get("name", ""), (device or {}).get("role", ""),
                        action[:64], summary[:300], outcome[:32]))
            self._exec("DELETE FROM audit WHERE ts < ?", (now - AUDIT_KEEP_SECONDS,))
            self._exec("DELETE FROM audit WHERE id <= (SELECT MAX(id) FROM audit) - ?", (AUDIT_KEEP_ROWS,))

    def list_audit(self, *, before: Optional[int] = None, limit: int = 100) -> List[Dict[str, Any]]:
        limit = max(1, min(int(limit or 100), 200))
        if before:
            rows = self._all("SELECT * FROM audit WHERE id < ? ORDER BY id DESC LIMIT ?", (before, limit))
        else:
            rows = self._all("SELECT * FROM audit ORDER BY id DESC LIMIT ?", (limit,))
        return [dict(r) for r in rows]

    # -- signed-request nonces --------------------------------------------------------

    def use_nonce(self, nonce: str, window: float) -> bool:
        """True the first time a nonce is seen within the window; a replay gets False."""
        now = _now()
        with self._lock:
            self._exec("DELETE FROM nonces WHERE ts < ?", (now - 2 * window,))
            try:
                self._exec("INSERT INTO nonces (nonce, ts) VALUES (?, ?)", (nonce, now))
            except sqlite3.IntegrityError:
                return False
        return True

    # -- long-running actions (restart, updates) ----------------------------------------

    @staticmethod
    def _job(row: sqlite3.Row) -> Dict[str, Any]:
        job = dict(row)
        job["detail"] = json.loads(job["detail"] or "{}")
        job.pop("idem_key", None)
        return job

    def create_job(self, kind: str, *, device_id: str = "", idem_key: Optional[str] = None,
                   detail: Optional[Dict[str, Any]] = None) -> tuple:
        """(job, created). A repeated idempotency key returns the first job instead of starting another."""
        now = _now()
        with self._lock:
            if idem_key:
                row = self._one("SELECT * FROM jobs WHERE idem_key = ?", (idem_key,))
                if row is not None:
                    return self._job(row), False
            job_id = new_id()
            self._exec("INSERT INTO jobs (id, kind, state, idem_key, device_id, detail, created_at, updated_at) "
                       "VALUES (?, ?, 'running', ?, ?, ?, ?, ?)",
                       (job_id, kind, idem_key or None, device_id, json.dumps(detail or {}), now, now))
            self._exec("DELETE FROM jobs WHERE id NOT IN (SELECT id FROM jobs ORDER BY created_at DESC LIMIT ?)",
                       (JOBS_KEEP,))
            return self._job(self._one("SELECT * FROM jobs WHERE id = ?", (job_id,))), True

    def job_by_key(self, idem_key: str) -> Optional[Dict[str, Any]]:
        row = self._one("SELECT * FROM jobs WHERE idem_key = ?", (idem_key,))
        return self._job(row) if row else None

    def get_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        row = self._one("SELECT * FROM jobs WHERE id = ?", (job_id,))
        return self._job(row) if row else None

    def update_job(self, job_id: str, *, state: Optional[str] = None, **detail: Any) -> Optional[Dict[str, Any]]:
        with self._lock:
            job = self.get_job(job_id)
            if job is None:
                return None
            if state is not None and state not in JOB_STATES:
                raise ValueError(f"unknown job state {state!r}")
            merged = {**job["detail"], **detail}
            self._exec("UPDATE jobs SET state = ?, detail = ?, updated_at = ? WHERE id = ?",
                       (state or job["state"], json.dumps(merged), _now(), job_id))
            return self.get_job(job_id)

    def list_jobs(self, *, running: bool = False, limit: int = 10) -> List[Dict[str, Any]]:
        where = "WHERE state = 'running' " if running else ""
        rows = self._all(f"SELECT * FROM jobs {where}ORDER BY created_at DESC LIMIT ?", (max(1, min(limit, JOBS_KEEP)),))
        return [self._job(r) for r in rows]
