"""The real thing: Hermes's own checkpoint manager, in a throwaway home and folder.

Only runs where a Hermes checkout is importable (CI's Hermes job, or
``PYTHONPATH=<hermes checkout>`` locally); the rest of the checkpoint tests use a fake.
"""

import asyncio
import shutil

import pytest

pytest.importorskip("tools.checkpoint_manager", reason="needs a real Hermes checkout")
pytest.importorskip("hermes_cli.config", reason="needs a real Hermes checkout")

from tools import checkpoint_manager  # noqa: E402
from tools.checkpoint_manager import CheckpointManager  # noqa: E402

from plugin import hermes_api  # noqa: E402
from plugin.checkpoints import CheckpointService  # noqa: E402


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    if shutil.which("git") is None:
        pytest.skip("git is needed for real checkpoints")
    home = tmp_path / "hermes-home"
    home.mkdir()
    (home / "config.yaml").write_text("checkpoints:\n  enabled: true\n  max_snapshots: 5\n", encoding="utf-8")
    project = tmp_path / "acme"
    project.mkdir()
    (project / "backup.sh").write_text("echo done\n", encoding="utf-8")
    monkeypatch.setenv("HERMES_HOME", str(home))
    # These tests exercise real snapshots with the already-required system Git.
    # A fresh fake home must not bootstrap/extract a second Git installation.
    monkeypatch.setenv("HERMES_DISABLE_LAZY_INSTALLS", "1")
    monkeypatch.setenv("TERMINAL_CWD", str(project))
    return project


def snapshot(project, label="before patch backup.sh"):
    manager = CheckpointManager(enabled=True, max_snapshots=5)
    assert manager.ensure_checkpoint(str(project), label) is True
    return manager


def test_hermes_lists_its_own_snapshot_with_a_usable_diff(workspace):
    snapshot(workspace)
    (workspace / "backup.sh").write_text('echo "changed"\n', encoding="utf-8")

    state = hermes_api.checkpoints_state()
    assert state["supported"] is True and state["enabled"] is True
    assert state["workspace"]["name"] == "acme"
    assert state["workspace"]["path"].endswith("acme")

    rows = hermes_api.list_checkpoints()
    assert rows and rows[0]["label"] == "before patch backup.sh"
    assert rows[0]["hash"] and rows[0]["at"] > 0

    diff = hermes_api.checkpoint_diff(rows[0]["hash"])
    assert diff["success"] is True
    assert "backup.sh" in diff["diff"]
    assert 'echo "changed"' in diff["diff"]


def test_a_real_restore_puts_the_file_back_and_leaves_a_safety_snapshot(workspace):
    snapshot(workspace)
    (workspace / "backup.sh").write_text('echo "changed"\n', encoding="utf-8")

    rows = hermes_api.list_checkpoints()
    result = hermes_api.restore_checkpoint(rows[0]["hash"], safe=False)
    assert result["success"] is True
    # A full restore puts the folder back without a per-file list; the file itself is the proof.
    assert "restored_files" not in result
    assert (workspace / "backup.sh").read_text(encoding="utf-8") == "echo done\n"

    # Hermes snapshots before restoring, so the undo is a checkpoint too.
    after = hermes_api.list_checkpoints()
    assert after[0]["label"].startswith("pre-rollback snapshot")


def test_a_real_safe_restore_leaves_a_file_the_owner_edited_alone(workspace):
    manager = snapshot(workspace)
    # Hermes writes the file, then the owner edits it afterwards.
    (workspace / "backup.sh").write_text('echo "hermes wrote this"\n', encoding="utf-8")
    manager.record_agent_write(str(workspace / "backup.sh"))
    (workspace / "backup.sh").write_text('echo "I edited this"\n', encoding="utf-8")

    rows = hermes_api.list_checkpoints()
    result = hermes_api.restore_checkpoint(rows[0]["hash"], safe=True)
    assert result["success"] is True
    assert "backup.sh" in result.get("skipped_user_edits", [])
    assert (workspace / "backup.sh").read_text(encoding="utf-8") == 'echo "I edited this"\n'


def test_the_service_round_trip_uses_the_reviewed_revision(workspace):
    snapshot(workspace)
    (workspace / "backup.sh").write_text('echo "changed"\n', encoding="utf-8")

    async def go():
        service = CheckpointService(hermes_api, busy=lambda: [])
        listing = await service.listing()
        assert listing["supported"] and listing["enabled"] and listing["can_restore"]
        page = await service.preview(listing["checkpoints"][0]["short"])
        assert page["revision"] and page["error"] is None
        assert [row["path"] for row in page["files"]] == ["backup.sh"]
        assert page["files"][0]["status"] == "modified"
        result = await service.restore(page["hash"], revision=page["revision"],
                                       operation_id="real-0001-abcdef", safe=False)
        assert result["ok"] is True and result["reported"] is False
        assert result["message"].startswith("Restored the folder to ")
        assert result["safety"]["short"]
        # The same operation again reports what happened; it does not restore a second time.
        again = await service.restore(page["hash"], revision=page["revision"],
                                      operation_id="real-0001-abcdef", safe=False)
        assert again["replayed"] is True

    asyncio.run(go())
    assert (workspace / "backup.sh").read_text(encoding="utf-8") == "echo done\n"


@pytest.mark.parametrize("ledger_state", ["missing", "empty", "unreadable", "corrupt"])
def test_safe_restore_refuses_unusable_write_history_without_touching_personal_files(workspace, ledger_state):
    manager = snapshot(workspace)
    target = hermes_api.list_checkpoints()[0]["hash"]
    personal = workspace / "backup.sh"
    personal.write_text('echo "my personal edit"\n', encoding="utf-8")
    ledger = checkpoint_manager._ledger_path(
        checkpoint_manager._store_path(), manager._ledger_key(str(workspace)))
    ledger.parent.mkdir(parents=True, exist_ok=True)
    if ledger_state == "empty":
        ledger.write_text("{}", encoding="utf-8")
    elif ledger_state == "unreadable":
        # Reading a directory raises OSError on Windows and Unix, without relying on
        # chmod (which a root CI process could bypass).
        ledger.mkdir()
    elif ledger_state == "corrupt":
        ledger.write_text("{broken", encoding="utf-8")
    else:
        assert not ledger.exists()

    before = hermes_api.list_checkpoints()
    result = hermes_api.restore_checkpoint(target, safe=True)
    assert result["success"] is False
    assert "file-write history is unavailable" in result["error"]
    assert "Also revert files I edited myself" in result["error"]
    assert personal.read_text(encoding="utf-8") == 'echo "my personal edit"\n'
    assert hermes_api.list_checkpoints() == before  # refused before a safety snapshot/mutation

    # The owner can still explicitly choose the existing full-restore option.
    result = hermes_api.restore_checkpoint(target, safe=False)
    assert result["success"] is True
    assert personal.read_text(encoding="utf-8") == "echo done\n"


def test_safe_restore_requires_a_supported_planner_but_full_restore_still_works(workspace, monkeypatch):
    manager = snapshot(workspace)
    target = hermes_api.list_checkpoints()[0]["hash"]
    personal = workspace / "backup.sh"
    personal.write_text("personal edit\n", encoding="utf-8")
    monkeypatch.setattr(manager, "_safe_restore_plan", None)
    monkeypatch.setattr(hermes_api, "_checkpoint_manager", lambda: manager)

    result = hermes_api.restore_checkpoint(target, safe=True)
    assert result["success"] is False
    assert "file-write history is unavailable" in result["error"]
    assert personal.read_text(encoding="utf-8") == "personal edit\n"
    assert hermes_api.restore_checkpoint(target, safe=False)["success"] is True
    assert personal.read_text(encoding="utf-8") == "echo done\n"


def test_safe_restore_with_write_history_still_restores_agent_changes(workspace):
    manager = snapshot(workspace)
    target = hermes_api.list_checkpoints()[0]["hash"]
    changed = workspace / "backup.sh"
    changed.write_text("agent edit\n", encoding="utf-8")
    manager.record_agent_write(str(changed))

    result = hermes_api.restore_checkpoint(target, safe=True)
    assert result["success"] is True
    assert result["restored_files"] == ["backup.sh"]
    assert changed.read_text(encoding="utf-8") == "echo done\n"
