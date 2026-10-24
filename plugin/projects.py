"""Server-persisted projects (folders) for Winglet conversations.

A Winglet chat is the persistent thread users name, pin, archive and draft in; the Hermes session
inside it is an execution context. A project only organizes chats: it never owns messages, never
grants access to a chat, and never changes the working directory Hermes runs in (the pinned plugin
protocol has no per-chat cwd, so this feature deliberately has no path field).

Projects are scoped to one bot. Owners share the projects they create with the bot's other owner
devices; a member's own projects are private to that member. Members may still move their own chats
in and out of shared projects. Removing a chat from a project, or deleting the project, leaves the
chat, its messages, draft, pin and local archive untouched.

All data lives in additive, feature-specific tables created idempotently by :func:`ensure_schema`.
No global migration version is allocated and no existing table is rewritten.
"""

from __future__ import annotations

import json
import sqlite3
import time
from typing import Any, Dict, List, Optional, Sequence

from .store import Store, new_id

MAX_NAME = 80
MAX_PROJECTS_PER_SCOPE = 200
POSITION_STEP = 1000
OPS_KEEP = 500
OPS_KEEP_SECONDS = 7 * 86400
MAX_CLIENT_ID = 100
MIN_CLIENT_ID = 8

_SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    bot TEXT NOT NULL DEFAULT '',
    owner_device TEXT,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 1000,
    archived INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS projects_scope ON projects (bot, owner_device, position);
CREATE UNIQUE INDEX IF NOT EXISTS projects_name
    ON projects (bot, IFNULL(owner_device, ''), name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS project_chats (
    chat_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 1000,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS project_chats_project ON project_chats (project_id, position);
CREATE TABLE IF NOT EXISTS project_layout (
    bot TEXT NOT NULL DEFAULT '',
    scope TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (bot, scope)
);
CREATE TABLE IF NOT EXISTS project_ops (
    id TEXT PRIMARY KEY,
    bot TEXT NOT NULL DEFAULT '',
    device_id TEXT NOT NULL,
    op TEXT NOT NULL,
    payload TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS project_ops_created ON project_ops (created_at);
"""


class ProjectError(Exception):
    """A project request that can't run; ``status`` is the HTTP status the hub returns."""

    status = 400

    def __init__(self, message: str, status: Optional[int] = None):
        super().__init__(message)
        if status is not None:
            self.status = status


class ProjectConflict(ProjectError):
    status = 409


class ProjectNotFound(ProjectError):
    status = 404


class ProjectForbidden(ProjectError):
    status = 403


def ensure_schema(store: Store) -> None:
    with store._lock:
        store._db.executescript(_SCHEMA)


def _now() -> float:
    return time.time()


def clean_name(value: Any) -> str:
    name = " ".join(str(value or "").split())
    if not name:
        raise ProjectError("Give the project a name.")
    return name[:MAX_NAME]


def clean_title(value: Any) -> str:
    title = " ".join(str(value or "").split())
    return (title or "New chat")[:80]


def _client_id(value: Any) -> str:
    key = str(value or "").strip()
    if not MIN_CLIENT_ID <= len(key) <= MAX_CLIENT_ID:
        raise ProjectError("A request id is required for this change.")
    return key


def _revision(value: Any) -> int:
    try:
        revision = int(value)
    except (TypeError, ValueError):
        raise ProjectError("A revision is required for this change.") from None
    if revision < 1:
        raise ProjectError("A revision is required for this change.")
    return revision


def _can_see(device: Dict[str, Any], chat: Optional[Dict[str, Any]]) -> bool:
    """The hub's rule, repeated here so the feature module is usable without a Hub."""
    if chat is None or device is None:
        return False
    return device.get("role") == "owner" or chat.get("owner_device") == device["id"]


def _private(device: Dict[str, Any]) -> bool:
    return device.get("role") != "owner"


class Projects:
    """Reads and writes projects. All methods are short synchronous SQLite operations."""

    def __init__(self, store: Store):
        self.store = store
        ensure_schema(store)
        self._prune_ops()

    # -- scopes, layout and visibility ------------------------------------------------

    @staticmethod
    def scope_of(device: Dict[str, Any]) -> str:
        """`shared` for owner-created projects; the member's device id for private ones."""
        return device["id"] if _private(device) else "shared"

    def _layout(self, bot: Optional[str], scope: str) -> int:
        bot = bot or ""
        row = self.store._one("SELECT revision FROM project_layout WHERE bot = ? AND scope = ?", (bot, scope))
        if row is None:
            self.store._exec("INSERT OR IGNORE INTO project_layout (bot, scope, revision) VALUES (?, ?, 1)",
                             (bot, scope))
            return 1
        return int(row["revision"])

    def _bump_layout(self, bot: Optional[str], scope: str) -> int:
        bot = bot or ""
        self._layout(bot, scope)
        self.store._exec("UPDATE project_layout SET revision = revision + 1 WHERE bot = ? AND scope = ?",
                         (bot, scope))
        return self._layout(bot, scope)

    @staticmethod
    def _visible_sql(device: Dict[str, Any], column: str = "p.owner_device") -> tuple:
        if _private(device):
            return f"({column} IS NULL OR {column} = ?)", (device["id"],)
        return f"{column} IS NULL", ()

    @staticmethod
    def _chat_visible_sql(device: Dict[str, Any], column: str = "c.owner_device") -> tuple:
        """Owners see every chat they can access; members only the chats they started."""
        if _private(device):
            return f"{column} = ?", (device["id"],)
        return "1 = 1", ()

    def _visible_project(self, device: Dict[str, Any], project_id: str,
                         bot: Optional[str]) -> Dict[str, Any]:
        where, args = self._visible_sql(device)
        row = self.store._one(f"SELECT p.* FROM projects p WHERE p.id = ? AND p.bot = ? AND {where}",
                              (project_id, bot or "", *args))
        if row is None:
            raise ProjectNotFound("This project no longer exists.")
        return dict(row)

    def all_projects(self, device: Dict[str, Any], bot: Optional[str]) -> List[Dict[str, Any]]:
        where, args = self._visible_sql(device)
        rows = self.store._all(
            "SELECT p.*, (SELECT COUNT(*) FROM project_chats pc JOIN chats c ON c.id = pc.chat_id "
            " WHERE pc.project_id = p.id AND COALESCE(c.bot, '') = ? AND c.kind = 'chat' "
            " AND (? = 1 OR c.owner_device = ?)) AS chat_count "
            f"FROM projects p WHERE p.bot = ? AND {where} "
            "ORDER BY CASE WHEN p.owner_device IS NULL THEN 0 ELSE 1 END, p.position, p.created_at, p.id",
            (bot or "", 0 if _private(device) else 1, device["id"], bot or "", *args),
        )
        return [self._public(dict(row), device) for row in rows]

    @staticmethod
    def _public(row: Dict[str, Any], device: Dict[str, Any]) -> Dict[str, Any]:
        private = bool(row.get("owner_device"))
        can_manage = (row["owner_device"] == device["id"]) if private else device.get("role") == "owner"
        return {
            "id": row["id"], "name": row["name"], "position": int(row["position"]),
            "archived": bool(row["archived"]), "revision": int(row["revision"]),
            "private": private, "can_manage": bool(can_manage), "chat_count": int(row.get("chat_count") or 0),
            "created_at": row["created_at"], "updated_at": row["updated_at"],
        }

    def snapshot(self, device: Dict[str, Any], bot: Optional[str]) -> Dict[str, Any]:
        """Everything this device may see about this bot's projects, in a deterministic order."""
        bot = bot or ""
        projects = self.all_projects(device, bot)
        ids = {p["id"] for p in projects}
        threads: List[Dict[str, Any]] = []
        if ids:
            marks = ",".join("?" * len(ids))
            chat_where, chat_args = self._chat_visible_sql(device)
            rows = self.store._all(
                "SELECT pc.chat_id, pc.project_id, pc.position FROM project_chats pc "
                "JOIN projects p ON p.id = pc.project_id "
                "JOIN chats c ON c.id = pc.chat_id "
                f"WHERE pc.project_id IN ({marks}) AND COALESCE(c.bot, '') = ? AND c.kind = 'chat' "
                f"AND {chat_where} ORDER BY pc.project_id, pc.position, pc.chat_id",
                (*ids, bot, *chat_args),
            )
            threads = [{"chat_id": r["chat_id"], "project_id": r["project_id"], "position": int(r["position"])}
                       for r in rows]
        return {"projects": projects, "threads": threads,
                "layout_revision": self._layout(bot, self.scope_of(device))}

    def project_chat_ids(self, device: Dict[str, Any], project_id: str, bot: Optional[str]) -> List[str]:
        """Chat ids a project contains and this device can read, for scoped search."""
        self._visible_project(device, project_id, bot)
        where, args = self._chat_visible_sql(device)
        rows = self.store._all(
            "SELECT c.id FROM project_chats pc JOIN chats c ON c.id = pc.chat_id "
            f"WHERE pc.project_id = ? AND COALESCE(c.bot, '') = ? AND c.kind = 'chat' AND {where} "
            "ORDER BY pc.position, c.updated_at DESC, c.id",
            (project_id, bot or "", *args),
        )
        return [r["id"] for r in rows]

    # -- idempotency ---------------------------------------------------------------------

    def _prune_ops(self) -> None:
        now = _now()
        with self.store._lock:
            self.store._exec("DELETE FROM project_ops WHERE created_at < ?", (now - OPS_KEEP_SECONDS,))
            self.store._exec("DELETE FROM project_ops WHERE id NOT IN "
                             "(SELECT id FROM project_ops ORDER BY created_at DESC LIMIT ?)", (OPS_KEEP,))

    def _run_op(self, device: Dict[str, Any], bot: Optional[str], op: str, payload: Dict[str, Any], fn):
        key = _client_id(payload.get("client_id"))
        # A cached owner result must not be replayed after the device is downgraded.
        canonical = json.dumps({"request": payload, "role": device.get("role")},
                               sort_keys=True, separators=(",", ":"), default=str)
        with self.store._lock:
            # Serialize revision checks with every write and the durable retry result, including
            # across separate SQLite connections. A failed journal write rolls back the mutation.
            self.store._db.execute("BEGIN IMMEDIATE")
            try:
                existing = self.store._one("SELECT * FROM project_ops WHERE id = ?", (key,))
                if existing is not None:
                    if (existing["bot"] != (bot or "") or existing["device_id"] != device["id"]
                            or existing["op"] != op or existing["payload"] != canonical):
                        raise ProjectConflict("That request id was already used for a different change.")
                    result = json.loads(existing["result"])
                else:
                    result = fn()
                    self.store._exec(
                        "INSERT INTO project_ops (id, bot, device_id, op, payload, result, created_at) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (key, bot or "", device["id"], op, canonical, json.dumps(result), _now()))
                    self._prune_ops()
                self.store._db.commit()
                return result
            except Exception:
                self.store._db.rollback()
                raise

    # -- project mutations ---------------------------------------------------------------

    def create(self, device: Dict[str, Any], bot: Optional[str], payload: Dict[str, Any]) -> Dict[str, Any]:
        def run():
            name = clean_name(payload.get("name"))
            scope = self.scope_of(device)
            owner = None if not _private(device) else device["id"]
            with self.store._lock:
                count = self.store._one(
                    "SELECT COUNT(*) AS n FROM projects WHERE bot = ? AND "
                    + ("owner_device IS NULL" if owner is None else "owner_device = ?"),
                    (bot or "",) if owner is None else (bot or "", owner))["n"]
                if int(count) >= MAX_PROJECTS_PER_SCOPE:
                    raise ProjectError("This bot has too many projects. Delete an old one first.")
                last = self.store._one(
                    "SELECT COALESCE(MAX(position), 0) AS p FROM projects WHERE bot = ? AND "
                    + ("owner_device IS NULL" if owner is None else "owner_device = ?"),
                    (bot or "",) if owner is None else (bot or "", owner))["p"]
                project_id, now = "p-" + new_id(), _now()
                try:
                    self.store._exec(
                        "INSERT INTO projects (id, bot, owner_device, name, position, archived, revision, "
                        "created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?, ?)",
                        (project_id, bot or "", owner, name, int(last or 0) + POSITION_STEP,
                         device["id"], now, now),
                    )
                except sqlite3.IntegrityError:
                    raise ProjectConflict(f"A project named “{name}” already exists.") from None
                self._bump_layout(bot, scope)
                row = self.store._one("SELECT * FROM projects WHERE id = ?", (project_id,))
                return {"project": self._public(dict(row), device)}
        return self._run_op(device, bot, "create", payload, run)

    def update(self, device: Dict[str, Any], bot: Optional[str], project_id: str,
               payload: Dict[str, Any]) -> Dict[str, Any]:
        def run():
            project = self._visible_project(device, project_id, bot)
            self._require_manage(device, project)
            revision = _revision(payload.get("revision"))
            if revision != int(project["revision"]):
                raise ProjectConflict("This project changed on another device. Reload it and try again.")
            fields: Dict[str, Any] = {}
            if "name" in payload:
                fields["name"] = clean_name(payload.get("name"))
            if "archived" in payload:
                fields["archived"] = 1 if payload.get("archived") is True else 0
            if not fields:
                raise ProjectError("Nothing to change.")
            if all(project[key] == value for key, value in fields.items()):
                return {"project": self._public(project, device)}
            assignments = ", ".join(f"{key} = ?" for key in fields)
            try:
                self.store._exec(
                    f"UPDATE projects SET {assignments}, revision = revision + 1, updated_at = ? WHERE id = ?",
                    (*fields.values(), _now(), project_id))
            except sqlite3.IntegrityError:
                raise ProjectConflict("Another project already has that name.") from None
            row = self.store._one("SELECT * FROM projects WHERE id = ?", (project_id,))
            return {"project": self._public(dict(row), device)}
        return self._run_op(device, bot, "update", {**payload, "project_id": project_id}, run)

    def delete(self, device: Dict[str, Any], bot: Optional[str], project_id: str,
               payload: Dict[str, Any]) -> Dict[str, Any]:
        def run():
            project = self._visible_project(device, project_id, bot)
            self._require_manage(device, project)
            revision = _revision(payload.get("revision"))
            if revision != int(project["revision"]):
                raise ProjectConflict("This project changed on another device. Reload it and try again.")
            with self.store._lock:
                released = self.store._one("SELECT COUNT(*) AS n FROM project_chats WHERE project_id = ?",
                                           (project_id,))["n"]
                # Only the folder and its memberships go: every chat and message stays.
                self.store._exec("DELETE FROM project_chats WHERE project_id = ?", (project_id,))
                self.store._exec("DELETE FROM projects WHERE id = ?", (project_id,))
                self._bump_layout(bot, self.scope_of(device))
            return {"deleted": project_id, "released_chats": int(released)}
        return self._run_op(device, bot, "delete", {**payload, "project_id": project_id}, run)

    def reorder(self, device: Dict[str, Any], bot: Optional[str], payload: Dict[str, Any]) -> Dict[str, Any]:
        def run():
            ids = payload.get("ids")
            if not isinstance(ids, list) or not all(isinstance(i, str) and i for i in ids):
                raise ProjectError("Send the projects in their new order.")
            if len(set(ids)) != len(ids):
                raise ProjectError("A project can only appear once in an order.")
            scope = self.scope_of(device)
            where, args = self._visible_sql(device)
            rows = self.store._all(
                f"SELECT p.id, p.owner_device FROM projects p WHERE p.bot = ? AND {where}", (bot or "", *args))
            managed = {r["id"] for r in rows
                       if (r["owner_device"] == device["id"] if r["owner_device"] else device.get("role") == "owner")}
            if set(ids) != managed:
                if _private(device) and any(r["id"] in ids and not r["owner_device"] for r in rows):
                    raise ProjectForbidden("Only an owner can reorder shared projects.")
                raise ProjectConflict("Projects changed on another device. Reload them and try again.")
            expected = _revision(payload.get("layout_revision"))
            if expected != self._layout(bot, scope):
                raise ProjectConflict("The project order changed on another device. Reload it and try again.")
            with self.store._lock:
                for index, project_id in enumerate(ids, start=1):
                    self.store._exec("UPDATE projects SET position = ?, updated_at = ? WHERE id = ?",
                                     (index * POSITION_STEP, _now(), project_id))
                revision = self._bump_layout(bot, scope)
            return {"layout_revision": revision}
        return self._run_op(device, bot, "order", payload, run)

    # -- chats in projects ---------------------------------------------------------------

    def create_chat(self, device: Dict[str, Any], bot: Optional[str], project_id: str,
                    payload: Dict[str, Any]) -> Dict[str, Any]:
        def run():
            project = self._visible_project(device, project_id, bot)
            if project["archived"]:
                raise ProjectError("Restore this project before starting a chat in it.")
            revision = _revision(payload.get("revision"))
            if revision != int(project["revision"]):
                raise ProjectConflict("This project changed on another device. Reload it and try again.")
            title = clean_title(payload.get("title"))
            owner = None if device.get("role") == "owner" else device["id"]
            with self.store._lock:
                chat = self.store.create_chat(title, owner_device=owner, bot=bot)
                position = self._next_chat_position(project_id)
                now = _now()
                self.store._exec("INSERT INTO project_chats (chat_id, project_id, position, created_at, updated_at) "
                                 "VALUES (?, ?, ?, ?, ?)", (chat["id"], project_id, position, now, now))
                self.store._exec("UPDATE projects SET revision = revision + 1, updated_at = ? WHERE id = ?",
                                 (_now(), project_id))
            row = self.store._one("SELECT * FROM projects WHERE id = ?", (project_id,))
            return {"project": self._public(dict(row), device), "chat": chat}
        return self._run_op(device, bot, "chat.create", {**payload, "project_id": project_id}, run)

    def move_chat(self, device: Dict[str, Any], bot: Optional[str], project_id: str, chat_id: str,
                  payload: Dict[str, Any]) -> Dict[str, Any]:
        def run():
            project = self._visible_project(device, project_id, bot)
            if project["archived"]:
                raise ProjectError("Restore this project before moving a chat into it.")
            revision = _revision(payload.get("revision"))
            if revision != int(project["revision"]):
                raise ProjectConflict("This project changed on another device. Reload it and try again.")
            chat = self.store.get_chat(chat_id)
            if (chat is None or (chat.get("bot") or None) != (bot or None) or not _can_see(device, chat)):
                raise ProjectNotFound("That chat isn't available on this device.")
            self._require_organizable(chat, bot, device)
            current = self.store._one("SELECT * FROM project_chats WHERE chat_id = ?", (chat_id,))
            if current is not None and current["project_id"] == project_id:
                return {"project": self._public(project, device), "chat": chat, "moved": False}
            source = None
            if current is not None:
                source = self._visible_project(device, current["project_id"], bot)
                expected_from = payload.get("from_project_id")
                if expected_from and expected_from != source["id"]:
                    raise ProjectConflict("That chat moved on another device. Reload it and try again.")
                if expected_from and _revision(payload.get("from_revision")) != int(source["revision"]):
                    raise ProjectConflict("That chat's project changed on another device. Reload it and try again.")
            with self.store._lock:
                now = _now()
                self.store._exec(
                    "INSERT INTO project_chats (chat_id, project_id, position, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET project_id = excluded.project_id, "
                    "position = excluded.position, updated_at = excluded.updated_at",
                    (chat_id, project_id, self._next_chat_position(project_id), now, now))
                self.store._exec("UPDATE projects SET revision = revision + 1, updated_at = ? WHERE id = ?",
                                 (now, project_id))
                if source is not None:
                    self.store._exec("UPDATE projects SET revision = revision + 1, updated_at = ? WHERE id = ?",
                                     (now, source["id"]))
            row = self.store._one("SELECT * FROM projects WHERE id = ?", (project_id,))
            return {"project": self._public(dict(row), device), "chat": chat, "moved": True,
                    "from_project_id": source["id"] if source else None}
        return self._run_op(device, bot, "chat.move", {**payload, "project_id": project_id,
                                                     "chat_id": chat_id}, run)

    def remove_chat(self, device: Dict[str, Any], bot: Optional[str], project_id: str, chat_id: str,
                    payload: Dict[str, Any]) -> Dict[str, Any]:
        def run():
            project = self._visible_project(device, project_id, bot)
            revision = _revision(payload.get("revision"))
            if revision != int(project["revision"]):
                raise ProjectConflict("This project changed on another device. Reload it and try again.")
            chat = self.store.get_chat(chat_id)
            if (chat is None or (chat.get("bot") or None) != (bot or None) or not _can_see(device, chat)):
                raise ProjectNotFound("That chat isn't available on this device.")
            current = self.store._one("SELECT * FROM project_chats WHERE chat_id = ?", (chat_id,))
            if current is None or current["project_id"] != project_id:
                raise ProjectNotFound("That chat isn't in this project any more.")
            with self.store._lock:
                self.store._exec("DELETE FROM project_chats WHERE chat_id = ?", (chat_id,))
                self.store._exec("UPDATE projects SET revision = revision + 1, updated_at = ? WHERE id = ?",
                                 (_now(), project_id))
            return {"project_id": project_id, "chat_id": chat_id, "removed": True}
        return self._run_op(device, bot, "chat.remove", {**payload, "project_id": project_id,
                                                       "chat_id": chat_id}, run)

    # -- helpers -------------------------------------------------------------------------

    def _next_chat_position(self, project_id: str) -> int:
        row = self.store._one("SELECT COALESCE(MAX(position), 0) AS p FROM project_chats WHERE project_id = ?",
                              (project_id,))
        return int(row["p"] or 0) + POSITION_STEP

    @staticmethod
    def _require_manage(device: Dict[str, Any], project: Dict[str, Any]) -> None:
        if project.get("owner_device"):
            if project["owner_device"] != device["id"]:
                raise ProjectForbidden("That private project belongs to another device.")
        elif device.get("role") != "owner":
            raise ProjectForbidden("Only an owner can change a shared project.")

    @staticmethod
    def _require_organizable(chat: Dict[str, Any], bot: Optional[str], device: Dict[str, Any]) -> None:
        """The Updates feed and every bot/member's main chat stay out of projects."""
        chat_id = chat["id"]
        if chat.get("kind") != "chat":
            raise ProjectError("The Updates feed can't be in a project.")
        if chat_id in ("home", "general", f"b-{bot or ''}") or chat_id.startswith("m-"):
            raise ProjectError("A main chat can't be in a project.")
