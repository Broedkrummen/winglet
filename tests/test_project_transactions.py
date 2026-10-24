"""Crash-safe project mutations and scope-bound retry identities."""
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest

from plugin.projects import ProjectConflict, Projects
from plugin.store import Store

OWNER = {"id": "owner", "role": "owner"}


@pytest.fixture
def service(tmp_path):
    store = Store(tmp_path / "projects.db")
    yield Projects(store), store
    store.close()


def test_failed_retry_journal_rolls_back_project_creation(service, monkeypatch):
    projects, store = service
    execute = store._exec

    def fail_journal(sql, args=()):
        if sql.startswith("INSERT INTO project_ops"):
            raise sqlite3.OperationalError("simulated interrupted journal write")
        return execute(sql, args)

    monkeypatch.setattr(store, "_exec", fail_journal)
    with pytest.raises(sqlite3.OperationalError):
        projects.create(OWNER, None, {"name": "Work", "client_id": "create-retry-1"})
    assert projects.snapshot(OWNER, None)["projects"] == []
    assert projects.snapshot(OWNER, None)["layout_revision"] == 1

    monkeypatch.setattr(store, "_exec", execute)
    payload = {"name": "Work", "client_id": "create-retry-1"}
    created = projects.create(OWNER, None, payload)
    assert projects.create(OWNER, None, payload) == created
    assert len(projects.snapshot(OWNER, None)["projects"]) == 1


def test_failed_retry_journal_rolls_back_new_chat_and_project_revision(service, monkeypatch):
    projects, store = service
    project = projects.create(OWNER, None, {"name": "Work", "client_id": "create-work-1"})["project"]
    execute = store._exec

    def fail_journal(sql, args=()):
        if sql.startswith("INSERT INTO project_ops") and args[3] == "chat.create":
            raise sqlite3.OperationalError("simulated interrupted journal write")
        return execute(sql, args)

    payload = {"title": "New topic", "revision": 1, "client_id": "create-topic-1"}
    monkeypatch.setattr(store, "_exec", fail_journal)
    with pytest.raises(sqlite3.OperationalError):
        projects.create_chat(OWNER, None, project["id"], payload)
    assert store.list_chats() == []
    assert projects.snapshot(OWNER, None)["projects"][0]["revision"] == 1

    monkeypatch.setattr(store, "_exec", execute)
    result = projects.create_chat(OWNER, None, project["id"], payload)
    assert projects.create_chat(OWNER, None, project["id"], payload) == result
    assert len(store.list_chats()) == 1


@pytest.mark.parametrize("operation", ["update", "delete", "create_chat"])
def test_retry_identity_cannot_be_reused_on_another_project(service, operation):
    projects, store = service
    first = projects.create(OWNER, None, {"name": "First", "client_id": "create-first-1"})["project"]
    second = projects.create(OWNER, None, {"name": "Second", "client_id": "create-second-1"})["project"]
    payload = {"revision": 1, "client_id": "same-operation-1"}
    if operation == "update":
        payload["name"] = "Renamed"
    elif operation == "create_chat":
        payload["title"] = "Topic"
    call = getattr(projects, operation)
    call(OWNER, None, first["id"], payload)
    with pytest.raises(ProjectConflict):
        call(OWNER, None, second["id"], payload)


def test_cached_owner_chat_result_is_not_returned_after_demotion(service):
    projects, _ = service
    project = projects.create(OWNER, None, {"name": "Work", "client_id": "create-work-1"})["project"]
    payload = {"title": "Owner topic", "revision": 1, "client_id": "owner-topic-1"}
    projects.create_chat(OWNER, None, project["id"], payload)
    with pytest.raises(ProjectConflict):
        projects.create_chat({**OWNER, "role": "member"}, None, project["id"], payload)


def test_two_connections_cannot_both_commit_the_same_project_revision(tmp_path):
    path = tmp_path / "projects.db"
    stores = [Store(path), Store(path)]
    try:
        services = [Projects(s) for s in stores]
        project = services[0].create(OWNER, None, {"name": "Work", "client_id": "create-work-1"})["project"]
        start = Barrier(2)

        def rename(index):
            start.wait(timeout=5)
            try:
                services[index].update(OWNER, None, project["id"],
                    {"name": f"Change {index}", "revision": 1, "client_id": f"rename-work-{index}"})
                return "committed"
            except ProjectConflict:
                return "conflict"

        with ThreadPoolExecutor(max_workers=2) as pool:
            assert sorted(pool.map(rename, range(2))) == ["committed", "conflict"]
        assert services[0].snapshot(OWNER, None)["projects"][0]["revision"] == 2
    finally:
        for store in stores:
            store.close()
