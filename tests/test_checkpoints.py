"""Workspace checkpoints: the list, a bounded preview, and a restore that has to be earned.

The fake here is shaped like ``plugin/hermes_api.py`` and returns the same diff text Hermes's
checkpoint manager produces; the real manager is exercised in ``test_checkpoints_hermes.py``.
"""

import json

import pytest

from plugin.checkpoints import CheckpointService, parse_diff, revision_for, unquote_path
from plugin.hub import Hub
from plugin.store import Store
from test_trust import pair_phone, post_signed

TWO_FILES = """diff --git a/backup.sh b/backup.sh
index 1111111..2222222 100755
--- a/backup.sh
+++ b/backup.sh
@@ -1,3 +1,4 @@
 #!/bin/sh
-echo "done"
+echo "done, kept 14"
+echo "pruned"
diff --git a/notes/new.md b/notes/new.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/notes/new.md
@@ -0,0 +1,2 @@
+hello
+world
"""

MIXED = """diff --git a/logo.png b/logo.png
index 1111111..2222222 100644
Binary files a/logo.png and b/logo.png differ
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 3333333..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-old
diff --git a/old name.txt b/new name.txt
similarity index 90%
rename from old name.txt
rename to new name.txt
"""


class Refused(ValueError):
    pass


class Unavailable(RuntimeError):
    pass


class FakeHermes:
    """plugin/hermes_api.py's checkpoint functions, with one workspace's state in memory."""

    HermesRefused = Refused
    HermesUnavailable = Unavailable

    def __init__(self):
        self.supported = True
        self.enabled = True
        self.reason = ""
        self.can_restore = True
        self.workspace = {"path": "~/acme", "name": "acme"}
        self.rows = [
            {"hash": "aaaa1111bbbb2222", "short": "aaaa1111", "at": 1790000200.0,
             "label": "before patch backup.sh", "files": 2, "insertions": 3, "deletions": 1},
            {"hash": "cccc3333dddd4444", "short": "cccc3333", "at": 1790000000.0,
             "label": "before write_file notes.md", "files": 1, "insertions": 1, "deletions": 0},
        ]
        self.diff_text = TWO_FILES
        self.diff_error = ""
        self.diff_calls = []
        self.restored = []
        self.restore_result = {"success": True, "restored_to": "aaaa1111", "reason": "before patch backup.sh",
                               "restored_files": ["backup.sh"], "skipped_user_edits": ["notes/new.md"],
                               "skipped_oversize": [], "failed_deletes": []}
        self.state_calls = 0

    def checkpoints_available(self):
        return self.supported

    def checkpoint_restore_available(self):
        return self.can_restore

    def checkpoints_state(self):
        self.state_calls += 1
        return {"supported": self.supported, "enabled": self.enabled, "reason": self.reason,
                "can_restore": self.can_restore, "workspace": dict(self.workspace)}

    def list_checkpoints(self):
        return [dict(row) for row in self.rows]

    def checkpoint_diff(self, commit_hash):
        self.diff_calls.append(commit_hash)
        if self.diff_error:
            return {"success": False, "error": self.diff_error}
        stat = " backup.sh | 3 ++-\n 1 file changed" if self.diff_text else ""
        return {"success": True, "stat": stat, "diff": self.diff_text}

    def restore_checkpoint(self, commit_hash, safe=True):
        self.restored.append((commit_hash, safe))
        # Hermes snapshots the folder right before it restores, so an undo is one tap away.
        self.rows.insert(0, {"hash": "eeee5555ffff6666", "short": "eeee5555", "at": 1790000300.0,
                             "label": f"pre-rollback snapshot (restoring to {commit_hash[:8]})",
                             "files": 2, "insertions": 0, "deletions": 0})
        return dict(self.restore_result)


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "data.db")
    s.ensure_chat("general", "General")
    yield s
    s.close()


@pytest.fixture
def hub(store, tmp_path):
    h = Hub(store, web_root=tmp_path / "web", bot_info=lambda: {"name": "hermes", "title": "Hermes"})
    h.hermes = FakeHermes()
    h.checkpoints = CheckpointService(h.hermes, busy=h.busy_chats)
    return h


@pytest.fixture
async def client(aiohttp_client, hub):
    return await aiohttp_client(hub.build_app())


async def preview(client, phone, hash="aaaa1111"):
    resp = await client.get(f"/api/checkpoints/{hash}", headers=phone.auth)
    assert resp.status == 200, await resp.text()
    return await resp.json()


def restore_body(page, **extra):
    return {"revision": page["revision"], "operation_id": "restore-0001-abcdef", **extra}


async def restore(client, phone, page, hash="aaaa1111", **extra):
    return await post_signed(client, phone, f"/api/checkpoints/{hash}/restore", restore_body(page, **extra))


# -- listing ---------------------------------------------------------------------------------------


async def test_owners_see_the_workspace_scope_and_the_snapshots(client, hub):
    owner = await pair_phone(client, hub)
    info = await (await client.get("/api/info")).json()
    assert info["features"]["checkpoints"] and info["features"]["checkpoint_diff"]
    assert info["features"]["checkpoint_restore"]

    data = await (await client.get("/api/checkpoints", headers=owner.auth)).json()
    assert data["supported"] and data["enabled"] and data["can_restore"]
    assert data["workspace"] == {"path": "~/acme", "name": "acme"}
    # A checkpoint covers files; the chat transcript is not part of it.
    assert data["coverage"] == {"files": True, "transcript": False}
    assert [row["short"] for row in data["checkpoints"]] == ["aaaa1111", "cccc3333"]
    assert data["checkpoints"][0]["at"] == 1790000200.0
    assert data["checkpoints"][0]["safety"] is False


async def test_members_cannot_see_or_restore_the_workspace(client, hub):
    await pair_phone(client, hub)
    member = await pair_phone(client, hub, "Alex", role="member")
    assert (await client.get("/api/checkpoints", headers=member.auth)).status == 403
    assert (await client.get("/api/checkpoints/aaaa1111", headers=member.auth)).status == 403
    resp = await post_signed(client, member, "/api/checkpoints/aaaa1111/restore",
                             {"revision": "x", "operation_id": "restore-0001-abcdef"})
    assert resp.status == 403
    assert hub.hermes.restored == []


async def test_a_checkpoint_is_read_from_hermes_every_time_so_a_restart_loses_nothing(client, hub, store, tmp_path):
    owner = await pair_phone(client, hub)
    first = await (await client.get("/api/checkpoints", headers=owner.auth)).json()
    hub.hermes.rows.append({"hash": "9999aaaabbbbcccc", "short": "9999aaaa", "at": 1790000400.0,
                            "label": "before write_file later.txt", "files": 1, "insertions": 1, "deletions": 0})
    second = await (await client.get("/api/checkpoints", headers=owner.auth)).json()
    assert len(second["checkpoints"]) == len(first["checkpoints"]) + 1

    # A new hub (a server restart) caches nothing: Hermes still has the snapshots.
    restarted = Hub(store, web_root=tmp_path / "web")
    restarted.hermes = hub.hermes
    service = CheckpointService(restarted.hermes, busy=restarted.busy_chats)
    again = await service.listing()
    assert [row["short"] for row in again["checkpoints"]] == [row["short"] for row in second["checkpoints"]]


async def test_each_bot_sees_only_its_own_workspace(client, hub):
    owner = await pair_phone(client, hub)
    hub.bots_provider = lambda: {"bots": [{"name": "worker", "title": "Worker"}], "multiplex": True, "reason": ""}
    main_state = hub.hermes.checkpoints_state

    def state():
        from plugin.hub import _BOT
        data = main_state()
        if _BOT.get() == "worker":
            data["workspace"] = {"path": "~/worker-folder", "name": "worker-folder"}
        return data

    hub.hermes.checkpoints_state = state
    mine = await (await client.get("/api/checkpoints", headers=owner.auth)).json()
    other = await (await client.get("/api/checkpoints?bot=worker", headers=owner.auth)).json()
    assert mine["workspace"]["name"] == "acme"
    assert other["workspace"]["name"] == "worker-folder"


# -- honest states ---------------------------------------------------------------------------------


async def test_checkpoints_off_is_reported_not_hidden(client, hub):
    owner = await pair_phone(client, hub)
    hub.hermes.enabled = False
    data = await (await client.get("/api/checkpoints", headers=owner.auth)).json()
    assert data["supported"] is True and data["enabled"] is False
    assert data["checkpoints"] == [] and data["can_restore"] is False
    page = await (await client.get("/api/checkpoints/aaaa1111", headers=owner.auth)).json()
    resp = await restore(client, owner, page)
    assert resp.status == 409 and "doesn't keep checkpoints" in (await resp.json())["error"]
    assert hub.hermes.restored == []


async def test_hermes_without_a_checkpoint_manager_says_why(client, hub):
    owner = await pair_phone(client, hub)
    hub.hermes.supported = False
    hub.hermes.can_restore = False
    data = await (await client.get("/api/checkpoints", headers=owner.auth)).json()
    assert data["supported"] is False and data["checkpoints"] == []
    assert "doesn't keep checkpoints" in data["reason"]


async def test_a_hub_without_the_service_says_so(store, tmp_path, aiohttp_client):
    hub = Hub(store, web_root=tmp_path / "web")
    client = await aiohttp_client(hub.build_app())
    owner = await pair_phone(client, hub)
    assert (await client.get("/api/checkpoints", headers=owner.auth)).status == 404
    info = await (await client.get("/api/info")).json()
    assert info["features"]["checkpoints"] is False


async def test_a_container_backend_reason_is_shown_and_blocks_restore(client, hub):
    owner = await pair_phone(client, hub)
    hub.hermes.enabled = False
    hub.hermes.reason = "Checkpoints are not taken for terminal.backend=docker: file paths belong to the container, not this host."
    data = await (await client.get("/api/checkpoints", headers=owner.auth)).json()
    assert data["enabled"] is False and "container" in data["reason"]


# -- preview --------------------------------------------------------------------------------------


async def test_a_preview_bounds_the_diff_and_names_each_file(client, hub):
    owner = await pair_phone(client, hub)
    page = await preview(client, owner)
    assert page["hash"] == "aaaa1111bbbb2222" and page["short"] == "aaaa1111"
    assert page["unchanged"] is False and page["error"] is None
    assert [row["path"] for row in page["files"]] == ["backup.sh", "notes/new.md"]
    assert page["files"][0]["status"] == "modified" and page["files"][0]["change"] == "restore"
    assert page["files"][1]["status"] == "added" and page["files"][1]["change"] == "remove"
    # Each file points at its own lines, so the app never re-splits the diff.
    start, end = page["files"][0]["start"], page["files"][0]["end"]
    assert page["diff"]["lines"][start].startswith("diff --git a/backup.sh")
    assert "+echo \"pruned\"" in page["diff"]["lines"][start:end]
    second = page["files"][1]
    assert page["diff"]["lines"][second["start"]].startswith("diff --git a/notes/new.md")
    assert page["effects"]["restore"] == 1 and page["effects"]["remove"] == 1
    assert page["diff"]["truncated"] is False


async def test_a_big_diff_lists_every_file_but_shows_only_what_fits(client, hub, monkeypatch):
    owner = await pair_phone(client, hub)
    from plugin import checkpoints
    # Exactly the first file's section fits; the second is still named, without its lines.
    monkeypatch.setattr(checkpoints, "MAX_DIFF_CHARS", TWO_FILES.index("diff --git a/notes"))
    page = await preview(client, owner)
    assert len(page["files"]) == 2
    assert page["diff"]["truncated"] is True
    assert page["files"][0]["shown"] is True
    assert page["files"][1]["shown"] is False and page["files"][1]["start"] is None
    # The rest is still named with its counts, and the revision covers the whole diff.
    assert page["files"][1]["path"] == "notes/new.md"


async def test_an_unchanged_folder_says_so(client, hub):
    owner = await pair_phone(client, hub)
    hub.hermes.diff_text = ""
    page = await preview(client, owner)
    assert page["unchanged"] is True and page["files"] == []


async def test_a_diff_hermes_cannot_read_is_not_an_empty_change(client, hub):
    owner = await pair_phone(client, hub)
    hub.hermes.diff_error = "Checkpoint 'aaaa1111' not found"
    page = await preview(client, owner)
    assert page["error"] == "Checkpoint 'aaaa1111' not found"
    assert page["unchanged"] is False


async def test_a_bad_or_unknown_hash_never_reaches_hermes(client, hub):
    owner = await pair_phone(client, hub)
    for bad in ("--patch", "zzzz", "not/a/hash"):
        assert (await client.get(f"/api/checkpoints/{bad}", headers=owner.auth)).status == 404, bad
    assert (await client.get("/api/checkpoints/9999dead", headers=owner.auth)).status == 404
    assert hub.hermes.diff_calls == []


async def test_a_short_hash_that_names_two_checkpoints_is_refused(client, hub):
    owner = await pair_phone(client, hub)
    hub.hermes.rows.append({"hash": "aaaa9999eeee8888", "short": "aaaa9999", "at": 1790000100.0,
                            "label": "before patch other.sh", "files": 1, "insertions": 1, "deletions": 0})
    resp = await client.get("/api/checkpoints/aaaa", headers=owner.auth)
    assert resp.status == 404 and "more than one" in (await resp.json())["error"]


# -- restore --------------------------------------------------------------------------------------


async def test_restore_needs_a_signature_and_does_nothing_without_one(client, hub):
    owner = await pair_phone(client, hub)
    page = await preview(client, owner)
    resp = await client.post("/api/checkpoints/aaaa1111/restore", json=restore_body(page), headers=owner.auth)
    assert resp.status == 403
    assert hub.hermes.restored == []


async def test_restore_reports_hermes_outcome_and_points_at_the_safety_snapshot(client, hub):
    owner = await pair_phone(client, hub)
    page = await preview(client, owner)
    resp = await restore(client, owner, page)
    assert resp.status == 200, await resp.text()
    result = (await resp.json())["result"]
    assert result["ok"] is True and result["restored_to"] == "aaaa1111"
    assert result["restored"] == ["backup.sh"]
    assert result["skipped_user_edits"] == ["notes/new.md"]
    assert "Your chats are unchanged." in result["message"]
    assert "Left 1 file you edited yourself alone." in result["message"]
    # Hermes snapshots before restoring: the app can offer the undo by hash.
    assert result["safety"]["short"] == "eeee5555"
    assert hub.hermes.restored == [("aaaa1111bbbb2222", True)]
    actions = [(entry["action"], entry["outcome"]) for entry in hub.store.list_audit()]
    assert ("checkpoint.restore", "ok") in actions


async def test_a_full_restore_without_a_file_list_is_not_called_nothing(client, hub):
    owner = await pair_phone(client, hub)
    page = await preview(client, owner)
    # Hermes reports restored_files only for a safe restore; a full one puts the folder back.
    hub.hermes.restore_result = {"success": True, "restored_to": "aaaa1111", "reason": "before patch backup.sh"}
    resp = await restore(client, owner, page, safe=False)
    result = (await resp.json())["result"]
    assert result["ok"] is True and result["reported"] is False
    assert result["message"] == "Restored the folder to aaaa1111. Your chats are unchanged."


async def test_restoring_without_safe_mode_asks_for_it_explicitly(client, hub):
    owner = await pair_phone(client, hub)
    page = await preview(client, owner)
    resp = await restore(client, owner, page, safe=False)
    assert resp.status == 200
    assert hub.hermes.restored == [("aaaa1111bbbb2222", False)]
    assert (await resp.json())["result"]["safe"] is False


async def test_a_stale_preview_is_refused_after_the_folder_changes(client, hub):
    owner = await pair_phone(client, hub)
    page = await preview(client, owner)
    # Something changed in the workspace after the preview (a file edit, or a new checkpoint).
    hub.hermes.diff_text = TWO_FILES.replace("+echo \"pruned\"", "+echo \"changed again\"")
    resp = await restore(client, owner, page)
    assert resp.status == 409
    data = await resp.json()
    assert data["needs"] == "refresh" and "changed since you looked" in data["error"]
    assert hub.hermes.restored == []


async def test_a_new_checkpoint_makes_an_older_preview_stale(client, hub):
    owner = await pair_phone(client, hub)
    page = await preview(client, owner)
    hub.hermes.rows.insert(0, {"hash": "7777aaaabbbb1111", "short": "7777aaaa", "at": 1790000300.0,
                               "label": "before patch later.sh", "files": 1, "insertions": 1, "deletions": 0})
    assert (await restore(client, owner, page)).status == 409
    assert hub.hermes.restored == []


async def test_a_running_reply_blocks_a_restore(client, hub):
    owner = await pair_phone(client, hub)
    page = await preview(client, owner)
    hub._typing.add("general")
    listed = await (await client.get("/api/checkpoints", headers=owner.auth)).json()
    assert listed["busy"] == ["General"]
    resp = await restore(client, owner, page)
    assert resp.status == 409
    data = await resp.json()
    assert data["busy"] == ["General"] and "reply is running" in data["error"]
    assert hub.hermes.restored == []


async def test_a_retried_restore_replays_its_result_instead_of_restoring_twice(client, hub):
    owner = await pair_phone(client, hub)
    page = await preview(client, owner)
    first = await restore(client, owner, page)
    assert first.status == 200
    again = await restore(client, owner, page)
    assert again.status == 200
    replayed = (await again.json())["result"]
    assert replayed["replayed"] is True and replayed["ok"] is True
    assert hub.hermes.restored == [("aaaa1111bbbb2222", True)]


async def test_a_restore_needs_an_operation_id(client, hub):
    owner = await pair_phone(client, hub)
    page = await preview(client, owner)
    resp = await post_signed(client, owner, "/api/checkpoints/aaaa1111/restore", {"revision": page["revision"]})
    assert resp.status == 400 and "operation id" in (await resp.json())["error"]
    assert hub.hermes.restored == []


async def test_a_restore_needs_the_preview_it_was_confirmed_from(client, hub):
    owner = await pair_phone(client, hub)
    resp = await post_signed(client, owner, "/api/checkpoints/aaaa1111/restore",
                             {"operation_id": "restore-0002-abcdef"})
    assert resp.status == 409 and (await resp.json())["needs"] == "refresh"
    assert hub.hermes.restored == []


async def test_a_failed_restore_is_reported_as_a_failure_with_recovery(client, hub):
    owner = await pair_phone(client, hub)
    page = await preview(client, owner)
    hub.hermes.restore_result = {"success": False, "error": "Restore failed: permission denied"}
    resp = await restore(client, owner, page)
    assert resp.status == 200
    result = (await resp.json())["result"]
    assert result["ok"] is False
    assert result["error"] == "Restore failed: permission denied"
    assert "chats are unchanged" not in result["message"]
    # The safety snapshot is still named, so a partial restore can be looked at or undone.
    assert result["safety"]["short"] == "eeee5555"
    actions = [(entry["action"], entry["outcome"]) for entry in hub.store.list_audit()]
    assert ("checkpoint.restore", "failed") in actions


async def test_a_restore_hermes_cannot_perform_is_a_refusal_not_a_success(client, hub):
    owner = await pair_phone(client, hub)
    page = await preview(client, owner)
    hub.hermes.can_restore = False
    resp = await restore(client, owner, page)
    assert resp.status == 409
    assert "only from its own terminal" in (await resp.json())["error"]
    assert hub.hermes.restored == []


async def test_restore_events_reach_owners_but_not_members(hub):
    assert hub._event_visible({"role": "owner", "id": "o"}, {"type": "checkpoint.restored", "result": {}})
    assert not hub._event_visible({"role": "member", "id": "m"}, {"type": "checkpoint.restored", "result": {}})


# -- pure parsing ---------------------------------------------------------------------------------


def test_diff_sections_name_added_removed_binary_and_renamed_files():
    parsed = parse_diff(MIXED)
    by_path = {row["path"]: row for row in parsed["files"]}
    assert by_path["logo.png"]["binary"] is True and by_path["logo.png"]["change"] == "restore"
    assert by_path["gone.txt"]["status"] == "deleted" and by_path["gone.txt"]["change"] == "recreate"
    renamed = by_path["new name.txt"]
    assert renamed["status"] == "renamed" and renamed["from"] == "old name.txt"
    assert parsed["effects"]["binary"] == 1 and parsed["effects"]["renamed"] == 1
    assert parsed["effects"]["recreate"] == 1


def test_quoted_paths_are_unescaped():
    assert unquote_path('"a/with tab\\there.txt"') == "a/with tab\there.txt"
    assert unquote_path('"a/quote\\"x.txt"') == 'a/quote"x.txt'
    assert unquote_path("plain.txt") == "plain.txt"


def test_the_revision_changes_with_any_input_that_matters():
    base = revision_for("~/acme", "aaaa", "aaaa", "stat", "diff")
    assert base == revision_for("~/acme", "aaaa", "aaaa", "stat", "diff")
    for change in (("~/other", "aaaa", "aaaa", "stat", "diff"),
                   ("~/acme", "bbbb", "aaaa", "stat", "diff"),
                   ("~/acme", "aaaa", "bbbb", "stat", "diff"),
                   ("~/acme", "aaaa", "aaaa", "other", "diff"),
                   ("~/acme", "aaaa", "aaaa", "stat", "other")):
        assert revision_for(*change) != base
