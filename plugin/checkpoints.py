"""Workspace checkpoints: Hermes's own snapshots, previewed and restored on purpose.

Hermes takes a filesystem snapshot just before the agent changes a file. The snapshots are
files-only (the conversation is not part of them) and belong to the folder the bot works in.
This module owns the parts that make them safe to expose from a phone:

* a bounded preview (file list, change kinds, and at most ``MAX_DIFF_CHARS`` of unified diff)
  with a revision that a restore must still match;
* a restore that refuses a stale preview, a running reply, a second concurrent restore, or a
  replayed operation, and reports what actually happened — including Hermes's safety snapshot;
* honest "this Hermes can't do that" states instead of invented success.

Everything Hermes-specific comes through the ``hermes`` module installed on the hub
(``plugin/hermes_api.py``), so this file has no Hermes imports and can be tested alone.
"""

from __future__ import annotations

import asyncio
import hashlib
import re
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

# How much of one checkpoint's diff a preview may carry. Hermes's manager returns the whole
# thing; the TUI shows 4000 characters. A phone can read more than that, but not without a
# bound: the rest is still listed with its change counts.
MAX_DIFF_CHARS = 40_000
# Files named in one preview. Beyond this the preview only reports the counts.
MAX_FILES = 400
# How long a restore operation id is remembered, so a retried request cannot restore twice.
OPERATION_TTL_SECONDS = 15 * 60
MAX_OPERATIONS = 32
# A checkpoint hash as Hermes validates it. Only a hash this shape reaches git, and it must
# also match a checkpoint Hermes listed for this workspace.
HASH_RE = re.compile(r"^[0-9a-f]{4,64}$")
OPERATION_RE = re.compile(r"^[A-Za-z0-9._:-]{8,80}$")

BusyProvider = Callable[[], List[str]]


class CheckpointError(Exception):
    """A refusal the app can explain. ``status`` is the HTTP status to answer with."""

    status = 400
    needs = ""

    def __init__(self, message: str, **extra: Any):
        super().__init__(message)
        self.extra = {key: value for key, value in extra.items() if value is not None}


class CheckpointNotFound(CheckpointError):
    status = 404


class CheckpointRefused(CheckpointError):
    status = 409


class CheckpointStale(CheckpointRefused):
    needs = "refresh"


class CheckpointBusy(CheckpointRefused):
    pass


class CheckpointRunning(CheckpointRefused):
    pass


# -- pure helpers: diff parsing, revisions, wording -------------------------------------------


_ESCAPES = {"a": 7, "b": 8, "t": 9, "n": 10, "v": 11, "f": 12, "r": 13, '"': 34, "\\": 92}


def unquote_path(raw: str) -> str:
    """A path from git's diff header, with its C-style quoting undone when it has any."""
    value = str(raw or "").strip()
    if len(value) < 2 or not (value.startswith('"') and value.endswith('"')):
        return value
    out: List[str] = []
    i = 1
    end = len(value) - 1
    while i < end:
        char = value[i]
        if char == "\\" and i + 1 < end:
            nxt = value[i + 1]
            if nxt in "01234567":
                digits = value[i + 1:i + 4]
                try:
                    out.append(chr(int(digits, 8)))
                    i += 4
                    continue
                except ValueError:
                    pass
            out.append(chr(_ESCAPES[nxt]) if nxt in _ESCAPES else nxt)
            i += 2
            continue
        out.append(char)
        i += 1
    return "".join(out)


def _strip_prefix(raw: str, side: str) -> str:
    path = unquote_path(raw)
    prefix = f"{side}/"
    return path[len(prefix):] if path.startswith(prefix) else path


def _header_paths(line: str) -> Tuple[str, str]:
    """Both sides of a ``diff --git`` header. Non-rename diffs repeat the same path."""
    rest = line[len("diff --git "):] if line.startswith("diff --git ") else line
    # The two sides are separated by " b/"; a path may itself contain " b/", so the last
    # occurrence is the split that leaves a plausible pair.
    index = rest.rfind(" b/")
    if index < 0:
        single = _strip_prefix(rest, "a")
        return single, single
    left = _strip_prefix(rest[:index], "a")
    right = _strip_prefix(rest[index + 1:], "b")
    return left, right


class _Section:
    """One file's part of a unified diff, as git wrote it."""

    def __init__(self, line: str):
        self.header = line
        self.lines: List[str] = []
        self.path = ""
        self.old_path = ""
        self.status = "modified"
        self.binary = False
        self.insertions = 0
        self.deletions = 0
        self.rename_from = ""
        self.rename_to = ""

    def finish(self) -> None:
        if self.rename_to or self.rename_from:
            self.status = "renamed"
            self.old_path = self.rename_from or self.old_path
            self.path = self.rename_to or self.path
        if not self.path:
            left, right = _header_paths(self.header)
            self.path = right or left
            self.old_path = self.old_path or left

    @property
    def change(self) -> str:
        """What restoring this checkpoint does to the file."""
        return {"added": "remove", "deleted": "recreate"}.get(self.status, "restore")


def parse_diff(text: str, *, max_chars: Optional[int] = None,
               max_files: Optional[int] = None) -> Dict[str, Any]:
    """Split a unified diff into files and a bounded list of lines.

    Each file's ``start``/``end`` index into the returned ``lines``; ``start`` is None when the
    budget ran out before its section, so the app can name the change without pretending to show
    it. The whole diff is still hashed for the revision, so a restore notices changes past the cap.
    """
    max_chars = MAX_DIFF_CHARS if max_chars is None else max_chars
    max_files = MAX_FILES if max_files is None else max_files
    raw = str(text or "")
    sections: List[_Section] = []
    current: Optional[_Section] = None
    for line in raw.splitlines():
        if line.startswith("diff --git "):
            if current is not None:
                current.finish()
            current = _Section(line)
            sections.append(current)
            continue
        if current is None:
            continue
        current.lines.append(line)
        if line.startswith("new file mode"):
            current.status = "added"
        elif line.startswith("deleted file mode"):
            current.status = "deleted"
        elif line.startswith("rename from "):
            current.rename_from = unquote_path(line[len("rename from "):])
        elif line.startswith("rename to "):
            current.rename_to = unquote_path(line[len("rename to "):])
        elif line.startswith("Binary files ") or line.startswith("GIT binary patch"):
            current.binary = True
        elif line.startswith("--- "):
            side = line[4:]
            if side.startswith("/dev/null"):
                current.status = "added"
            else:
                current.old_path = _strip_prefix(side, "a")
        elif line.startswith("+++ "):
            side = line[4:]
            if side.startswith("/dev/null"):
                current.status = "deleted"
            else:
                current.path = _strip_prefix(side, "b")
        elif line.startswith("+") and not line.startswith("+++"):
            current.insertions += 1
        elif line.startswith("-") and not line.startswith("---"):
            current.deletions += 1
    if current is not None:
        current.finish()

    lines: List[str] = []
    budget = 0
    truncated = False
    files: List[Dict[str, Any]] = []
    for section in sections[:max_files]:
        if not section.path:
            continue
        start = None
        end = None
        body = [section.header, *section.lines]
        size = sum(len(item) + 1 for item in body)
        if budget + size <= max_chars:
            start = len(lines)
            lines.extend(body)
            budget += size
            end = len(lines)
        else:
            truncated = True
        files.append({
            "path": section.path, "from": section.old_path if section.old_path and section.old_path != section.path else "",
            "status": section.status, "binary": bool(section.binary),
            "insertions": section.insertions, "deletions": section.deletions,
            "change": section.change, "start": start, "end": end,
            "shown": start is not None,
        })
    if len(sections) > max_files:
        truncated = True
    effects = {"restore": 0, "remove": 0, "recreate": 0, "binary": 0, "renamed": 0}
    for row in files:
        effects[row["change"]] = effects.get(row["change"], 0) + 1
        if row["binary"]:
            effects["binary"] += 1
        if row["status"] == "renamed":
            effects["renamed"] += 1
    return {
        "files": files,
        "lines": lines,
        "truncated": truncated,
        "shown_files": sum(1 for row in files if row["shown"]),
        "bytes": len(raw),
        "effects": effects,
    }


def revision_for(workspace: str, commit_hash: str, tip_hash: str, stat: str, diff_text: str) -> str:
    """Identifies the state a preview described: the same inputs later means nothing moved."""
    digest = hashlib.sha256()
    for part in (workspace, commit_hash, tip_hash or "", stat or "", diff_text or ""):
        digest.update(str(part).encode("utf-8", "replace"))
        digest.update(b"\0")
    return digest.hexdigest()[:32]


def restore_message(result: Dict[str, Any]) -> str:
    """What a restore did, in words: the files put back, the ones left alone, or why not."""
    if not result.get("ok"):
        return str(result.get("error") or "The checkpoint couldn't be restored.")
    restored = list(result.get("restored") or [])
    skipped = list(result.get("skipped_user_edits") or [])
    oversize = list(result.get("skipped_oversize") or [])
    failed = list(result.get("failed_deletes") or [])
    if not result.get("reported", True):
        # A full restore (safe mode off) puts the folder back without listing each file.
        target = str(result.get("restored_to") or "")
        text = f"Restored the folder to {target}" if target else "Restored the folder"
    elif restored:
        text = f"Restored {len(restored)} file{'s' if len(restored) != 1 else ''}"
    elif skipped:
        text = "Nothing needed restoring"
    else:
        text = "The folder already matched this checkpoint"
    text += "."
    if skipped:
        text += f" Left {len(skipped)} file{'s' if len(skipped) != 1 else ''} you edited yourself alone."
    if oversize:
        text += f" Too large to restore: {', '.join(oversize[:3])}{'…' if len(oversize) > 3 else ''}."
    if failed:
        text += f" Couldn't remove: {', '.join(failed[:3])}{'…' if len(failed) > 3 else ''}."
    return text + " Your chats are unchanged."


def _as_list(value: Any) -> List[str]:
    return [str(item) for item in value] if isinstance(value, (list, tuple)) else []


def _outcome(raw: Any) -> Dict[str, Any]:
    """Hermes's restore result, in the shape the app reads. Never claims more than was reported."""
    data = raw if isinstance(raw, dict) else {}
    if not data or data.get("success") is not True:
        return {"ok": False, "error": str(data.get("error") or data.get("reason") or "The checkpoint couldn't be restored.")}
    return {
        "ok": True,
        "restored_to": str(data.get("restored_to") or "")[:8],
        "reason": str(data.get("reason") or ""),
        # Only a safe restore reports this list; a full restore has no per-file detail, and
        # saying "nothing needed restoring" there would be wrong.
        "reported": isinstance(data.get("restored_files"), (list, tuple)),
        "restored": _as_list(data.get("restored_files")),
        "skipped_user_edits": _as_list(data.get("skipped_user_edits")),
        "skipped_oversize": _as_list(data.get("skipped_oversize")),
        "failed_deletes": _as_list(data.get("failed_deletes")),
    }


# -- the service ---------------------------------------------------------------------------------


class CheckpointService:
    """List, preview and restore one bot's workspace checkpoints through Hermes.

    ``hermes`` is the hub's ``plugin.hermes_api`` module (or a fake in tests): it must offer
    ``checkpoints_state``, ``list_checkpoints``, ``checkpoint_diff``, ``restore_checkpoint`` and
    ``checkpoints_available``. ``busy`` names chats with a reply running now.
    """

    def __init__(self, hermes: Any, busy: Optional[BusyProvider] = None,
                 clock: Callable[[], float] = time.time):
        self.hermes = hermes
        self._busy = busy or (lambda: [])
        self._clock = clock
        self._restore_lock = asyncio.Lock()
        self._operations: Dict[str, Dict[str, Any]] = {}

    # -- capabilities ------------------------------------------------------------------

    @property
    def can_restore(self) -> bool:
        try:
            return bool(self.hermes.checkpoint_restore_available())
        except Exception:
            return False

    async def _state(self) -> Dict[str, Any]:
        try:
            state = await asyncio.to_thread(self.hermes.checkpoints_state)
        except Exception as exc:  # no Hermes, a broken import, an unreadable config
            return {"supported": False, "enabled": False, "can_restore": False,
                    "reason": str(exc) or "This Hermes can't list checkpoints.",
                    "workspace": {"path": "", "name": ""}, "coverage": {"files": True, "transcript": False}}
        data = state if isinstance(state, dict) else {}
        supported = bool(data.get("supported"))
        enabled = bool(data.get("enabled")) and supported
        reason = str(data.get("reason") or "")
        if not supported:
            reason = reason or "This Hermes version doesn't keep checkpoints."
        return {
            "supported": supported,
            "enabled": enabled,
            "can_restore": bool(data.get("can_restore")) and enabled and self.can_restore,
            "reason": reason,
            "workspace": data.get("workspace") or {"path": "", "name": ""},
            "coverage": {"files": True, "transcript": False},
        }

    def busy_chats(self) -> List[str]:
        try:
            return [str(name) for name in (self._busy() or []) if str(name)]
        except Exception:
            return []

    # -- list ---------------------------------------------------------------------------

    async def listing(self) -> Dict[str, Any]:
        state = await self._state()
        rows = await self._rows(state)
        return {
            **state,
            "busy": self.busy_chats(),
            "checkpoints": [
                {**row, "safety": row["label"].startswith("pre-rollback snapshot")} for row in rows
            ],
        }

    async def _rows(self, state: Dict[str, Any]) -> List[Dict[str, Any]]:
        if not state["supported"] or not state["enabled"]:
            return []
        try:
            raw = await asyncio.to_thread(self.hermes.list_checkpoints)
        except Exception:
            raise CheckpointNotFound("Hermes couldn't read its checkpoints just now.")
        rows = []
        for item in raw if isinstance(raw, list) else []:
            if not isinstance(item, dict):
                continue
            digest = str(item.get("hash") or "").lower()
            if not HASH_RE.match(digest):
                continue
            rows.append({
                "hash": digest,
                "short": str(item.get("short") or digest[:8]),
                "at": float(item.get("at") or 0),
                "label": str(item.get("label") or "Checkpoint")[:200],
                "files": int(item.get("files") or 0),
                "insertions": int(item.get("insertions") or 0),
                "deletions": int(item.get("deletions") or 0),
            })
        return rows

    def _find(self, rows: List[Dict[str, Any]], wanted: str) -> Dict[str, Any]:
        value = str(wanted or "").strip().lower()
        if not HASH_RE.match(value):
            raise CheckpointNotFound("That isn't a checkpoint.")
        exact = next((row for row in rows if row["hash"] == value), None)
        if exact is not None:
            return exact
        # A short hash from the list is enough, as long as it names exactly one checkpoint.
        matches = [row for row in rows if row["hash"].startswith(value)] if len(value) >= 4 else []
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            raise CheckpointNotFound("That prefix matches more than one checkpoint. Pick one from the list.")
        raise CheckpointNotFound("That checkpoint isn't there any more. It may have been pruned.")

    # -- preview ------------------------------------------------------------------------

    async def preview(self, wanted: str) -> Dict[str, Any]:
        state = await self._state()
        if not state["supported"] or not state["enabled"]:
            # Nothing to open: say why instead of pretending the hash vanished.
            return {**state, "busy": self.busy_chats(), "hash": "", "short": "", "at": 0.0, "label": "",
                    "safety": False, "files": [], "diff": {"lines": [], "truncated": False, "bytes": 0},
                    "unchanged": False, "effects": {}, "revision": "", "error": None}
        rows = await self._rows(state)
        target = self._find(rows, wanted)
        base = {**state, "busy": self.busy_chats(), "hash": target["hash"], "short": target["short"],
                "at": target["at"], "label": target["label"], "safety": target["label"].startswith("pre-rollback snapshot")}
        raw = await asyncio.to_thread(self.hermes.checkpoint_diff, target["hash"])
        result = raw if isinstance(raw, dict) else {}
        if result.get("success") is False or result.get("error"):
            return {**base, "files": [], "diff": {"lines": [], "truncated": False, "bytes": 0},
                    "unchanged": False, "effects": {}, "revision": "",
                    "error": str(result.get("error") or "Hermes couldn't read the changes.")}
        stat = str(result.get("stat") or "")
        text = str(result.get("diff") or "")
        parsed = parse_diff(text)
        tip = rows[0]["hash"] if rows else ""
        revision = revision_for(str((state.get("workspace") or {}).get("path") or ""), target["hash"], tip, stat, text)
        return {
            **base,
            "workspace": state["workspace"],
            "files": parsed["files"],
            "diff": {"lines": parsed["lines"], "truncated": parsed["truncated"], "bytes": parsed["bytes"]},
            "shown_files": parsed["shown_files"],
            "effects": parsed["effects"],
            "unchanged": not parsed["files"] and not text.strip() and not stat.strip(),
            "revision": revision,
            "error": None,
        }

    # -- restore ------------------------------------------------------------------------

    async def restore(self, wanted: str, *, revision: str, safe: bool = True,
                      operation_id: str = "", device: Optional[str] = None) -> Dict[str, Any]:
        operation = str(operation_id or "").strip()
        if not OPERATION_RE.match(operation):
            raise CheckpointError("This restore needs an operation id.")
        self._prune_operations()
        done = self._operations.get(operation)
        if done is not None:
            if done["state"] == "running":
                raise CheckpointRunning("That restore is still running.", operation_id=operation)
            return {**done["result"], "replayed": True}

        state = await self._state()
        if not state["supported"] or not state["enabled"]:
            raise CheckpointRefused(state["reason"] or "This Hermes doesn't keep checkpoints.")
        if not self.can_restore:
            raise CheckpointRefused("This Hermes can restore checkpoints only from its own terminal.")
        expected = str(revision or "").strip()
        if not expected:
            raise CheckpointStale("Look at this checkpoint again before restoring it.")
        busy = self.busy_chats()
        if busy:
            raise CheckpointBusy(
                f"A reply is running in {busy[0]}. Restoring waits until it finishes.", busy=busy)
        if self._restore_lock.locked():
            raise CheckpointRunning("Another restore is running right now.")

        async with self._restore_lock:
            rows = await self._rows(state)
            target = self._find(rows, wanted)
            fresh = await asyncio.to_thread(self.hermes.checkpoint_diff, target["hash"])
            result = fresh if isinstance(fresh, dict) else {}
            if result.get("success") is False or result.get("error"):
                raise CheckpointRefused(str(result.get("error") or "Hermes couldn't read the changes."))
            tip = rows[0]["hash"] if rows else ""
            current = revision_for(str((state.get("workspace") or {}).get("path") or ""), target["hash"], tip,
                                   str(result.get("stat") or ""), str(result.get("diff") or ""))
            if current != expected:
                raise CheckpointStale("The folder changed since you looked. Check what will be restored, then try again.")

            self._operations[operation] = {"state": "running", "at": self._clock(), "result": {}}
            try:
                raw = await asyncio.to_thread(self.hermes.restore_checkpoint, target["hash"], bool(safe))
            except Exception as exc:
                if exc.__class__.__name__ == "HermesUnavailable":
                    message = "This Hermes version can't restore checkpoints."
                else:
                    message = str(exc) or "The restore failed."
                outcome = {"ok": False, "error": message}
            else:
                outcome = _outcome(raw)
            outcome["safe"] = bool(safe)
            outcome["checkpoint"] = {"hash": target["hash"], "short": target["short"]}
            safety = await self._safety_snapshot(target["hash"])
            if safety:
                outcome["safety"] = safety
            outcome["message"] = restore_message(outcome)
            if device:
                outcome["by"] = str(device)
            self._operations[operation] = {"state": "done", "at": self._clock(), "result": outcome}
            return outcome

    async def _safety_snapshot(self, restored_hash: str) -> Optional[Dict[str, str]]:
        """Hermes snapshots the folder right before a restore; point at it so an undo is one tap."""
        try:
            raw = await asyncio.to_thread(self.hermes.list_checkpoints)
        except Exception:
            return None
        for item in raw if isinstance(raw, list) else []:
            if not isinstance(item, dict):
                continue
            label = str(item.get("label") or "")
            digest = str(item.get("hash") or "").lower()
            if label.startswith("pre-rollback snapshot") and digest and digest != restored_hash:
                return {"hash": digest, "short": str(item.get("short") or digest[:8]), "label": label[:200]}
        return None

    def _prune_operations(self) -> None:
        cutoff = self._clock() - OPERATION_TTL_SECONDS
        for key in [name for name, entry in self._operations.items() if entry["at"] < cutoff]:
            self._operations.pop(key, None)
        if len(self._operations) > MAX_OPERATIONS:
            for key, _entry in sorted(self._operations.items(), key=lambda kv: kv[1]["at"])[:len(self._operations) - MAX_OPERATIONS]:
                self._operations.pop(key, None)
