"""Projects: server persistence, revisions, idempotency, role isolation and chat safety."""

import json

import pytest

from plugin.hub import ROUTE_POLICY, Hub
from plugin.projects import Projects
from plugin.store import Store
from test_trust import pair_phone, post_signed


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "data.db")
    yield s
    s.close()


@pytest.fixture
def hub(store, tmp_path):
    store.ensure_chat("general", "General")
    h = Hub(store, web_root=tmp_path / "web", bot_info=lambda: {"name": "hermes", "title": "Hermes"})
    return h


@pytest.fixture
async def client(aiohttp_client, hub):
    return await aiohttp_client(hub.build_app())


async def send(client, phone, method, path, data=None):
    body = json.dumps(data).encode() if data is not None else b""
    return await client.request(method, path, data=body or None, headers=phone.signed(method, path, body))


async def make_project(client, phone, name, cid):
    resp = await send(client, phone, "POST", "/api/projects", {"name": name, "client_id": cid})
    assert resp.status == 200, await resp.text()
    data = await resp.json()
    return data["project"], data["projects"]


async def make_chat(client, phone, title="Topic", project_id=None):
    path = "/api/chats"
    body = json.dumps({"title": title}).encode()
    resp = await client.post(path, data=body, headers=phone.signed("POST", path, body))
    assert resp.status == 200, await resp.text()
    chat = (await resp.json())["chat"]
    if project_id:
        snapshot = (await (await client.get("/api/projects", headers=phone.auth)).json())["projects"]
        project = next(p for p in snapshot["projects"] if p["id"] == project_id)
        path = f"/api/projects/{project_id}/chats/{chat['id']}"
        body = json.dumps({"revision": project["revision"], "client_id": f"move-{chat['id']}-1"}).encode()
        resp = await client.post(path, data=body, headers=phone.signed("POST", path, body))
        assert resp.status == 200, await resp.text()
    return chat


# -- persistence and schema ----------------------------------------------------------------


def test_schema_is_additive_and_existing_chats_are_ungrouped(store):
    chat = store.create_chat("Before projects")
    store.add_message(chat["id"], "user", "kept")
    Hub(store, bot_info=lambda: {"name": "hermes", "title": "Hermes"})
    projects = Projects(store)
    device, _ = store.add_device("Phone")
    assert store.get_chat(chat["id"])["title"] == "Before projects"
    assert store.all_messages(chat["id"])[0]["text"] == "kept"
    snap = projects.snapshot(store.get_device(device["id"]), None)
    assert snap == {"projects": [], "threads": [], "layout_revision": 1}


async def test_projects_need_a_signed_request_and_are_listed_in_hello(client, hub):
    owner = await pair_phone(client, hub)
    assert ROUTE_POLICY["h_projects"] == "device"
    assert ROUTE_POLICY["h_project_create"] == "signed"
    unsigned = await client.post("/api/projects", json={"name": "Unsigned", "client_id": "unsigned-1"},
                                 headers=owner.auth)
    assert unsigned.status == 403
    project, snap = await make_project(client, owner, "Work", "create-work-1")
    assert project["name"] == "Work" and project["can_manage"] is True
    assert snap["layout_revision"] == 2
    listed = await (await client.get("/api/projects", headers=owner.auth)).json()
    assert [p["id"] for p in listed["projects"]["projects"]] == [project["id"]]

    ws = await client.ws_connect("/api/ws")
    await ws.send_json({"type": "auth", "token": owner.token})
    hello = await ws.receive_json()
    assert hello["features"]["projects"] is True
    assert [p["name"] for p in hello["projects"]["projects"]] == ["Work"]
    await ws.close()


# -- CRUD, ordering, archive, delete -------------------------------------------------------


async def test_rename_reorder_archive_and_delete_preserve_chats(client, hub):
    owner = await pair_phone(client, hub)
    first, _ = await make_project(client, owner, "Alpha", "create-alpha-1")
    second, _ = await make_project(client, owner, "Beta", "create-beta-1")
    chat = await make_chat(client, owner, "Kept topic", first["id"])
    hub.store.add_message(chat["id"], "user", "still here")
    first = next(p for p in (await (await client.get("/api/projects", headers=owner.auth)).json())["projects"]["projects"]
                 if p["id"] == first["id"])

    # Rename with the revision the phone read (moving the chat bumped it).
    path = f"/api/projects/{first['id']}"
    renamed = await send(client, owner, "PATCH", path, {"name": "Alpha renamed", "revision": first["revision"],
                                                       "client_id": "rename-alpha-1"})
    assert renamed.status == 200, await renamed.text()
    assert (await renamed.json())["project"]["name"] == "Alpha renamed"

    # Reorder both projects using the current layout revision.
    snap = (await (await client.get("/api/projects", headers=owner.auth)).json())["projects"]
    order = [second["id"], first["id"]]
    reordered = await send(client, owner, "PUT", "/api/projects/order",
                           {"ids": order, "layout_revision": snap["layout_revision"], "client_id": "order-test-1"})
    assert reordered.status == 200, await reordered.text()
    snap = (await reordered.json())["projects"]
    assert [p["id"] for p in snap["projects"]] == order
    assert [t["chat_id"] for t in snap["threads"]] == [chat["id"]]

    # Archive: the chat stays in the project and in Chats.
    current = next(p for p in snap["projects"] if p["id"] == first["id"])
    archived = await send(client, owner, "PATCH", path, {"archived": True, "revision": current["revision"],
                                                        "client_id": "archive-alpha-1"})
    assert archived.status == 200
    assert next(p for p in (await archived.json())["projects"]["projects"] if p["id"] == first["id"])["archived"] is True
    assert (await client.get(f"/api/chats/{chat['id']}/messages", headers=owner.auth)).status == 200
    refused = await send(client, owner, "POST", f"/api/projects/{first['id']}/chats",
                         {"title": "Nope", "revision": current["revision"] + 1, "client_id": "new-in-archived-1"})
    assert refused.status == 400

    # Delete only the folder; the chat, its title and messages remain.
    current = next(p for p in (await (await client.get("/api/projects", headers=owner.auth)).json())["projects"]["projects"]
                   if p["id"] == first["id"])
    deleted = await send(client, owner, "DELETE", path, {"revision": current["revision"], "client_id": "delete-alpha-1"})
    assert deleted.status == 200, await deleted.text()
    assert (await deleted.json())["released_chats"] == 1
    assert (await client.get("/api/projects", headers=owner.auth)).status == 200
    chats = (await (await client.get("/api/chats", headers=owner.auth)).json())["chats"]
    assert any(c["id"] == chat["id"] and c["title"] == "Kept topic" for c in chats)
    messages = (await (await client.get(f"/api/chats/{chat['id']}/messages", headers=owner.auth)).json())["messages"]
    assert messages[-1]["text"] == "still here"
    snap = (await (await client.get("/api/projects", headers=owner.auth)).json())["projects"]
    assert [at for at in snap["threads"] if at["chat_id"] == chat["id"]] == []


async def test_duplicate_and_blank_names_are_refused(client, hub):
    owner = await pair_phone(client, hub)
    await make_project(client, owner, "Design", "create-design-1")
    duplicate = await send(client, owner, "POST", "/api/projects", {"name": " design ", "client_id": "create-design-2"})
    assert duplicate.status == 409
    blank = await send(client, owner, "POST", "/api/projects", {"name": "  ", "client_id": "create-blank-1"})
    assert blank.status == 400


# -- revisions and idempotency -------------------------------------------------------------


async def test_stale_revisions_are_refused_with_the_current_snapshot(client, hub):
    owner = await pair_phone(client, hub)
    project, _ = await make_project(client, owner, "Race", "create-race-1")
    path = f"/api/projects/{project['id']}"
    first = await send(client, owner, "PATCH", path, {"name": "First", "revision": project["revision"],
                                                     "client_id": "rename-race-1"})
    assert first.status == 200
    stale = await send(client, owner, "PATCH", path, {"name": "Second", "revision": project["revision"],
                                                     "client_id": "rename-race-2"})
    assert stale.status == 409
    body = await stale.json()
    assert body["projects"]["projects"][0]["name"] == "First"


async def test_reorder_race_is_detected(client, hub):
    owner = await pair_phone(client, hub)
    a, _ = await make_project(client, owner, "A", "create-a-1")
    b, _ = await make_project(client, owner, "B", "create-b-1")
    snap = (await (await client.get("/api/projects", headers=owner.auth)).json())["projects"]
    layout = snap["layout_revision"]
    assert (await send(client, owner, "PUT", "/api/projects/order",
                       {"ids": [b["id"], a["id"]], "layout_revision": layout, "client_id": "order-race-1"})).status == 200
    stale = await send(client, owner, "PUT", "/api/projects/order",
                       {"ids": [a["id"], b["id"]], "layout_revision": layout, "client_id": "order-race-2"})
    assert stale.status == 409


async def test_client_id_makes_create_and_move_idempotent(client, hub):
    owner = await pair_phone(client, hub)
    project, snap = await make_project(client, owner, "Once", "create-once-1")
    again = await send(client, owner, "POST", "/api/projects", {"name": "Once", "client_id": "create-once-1"})
    assert again.status == 200
    assert (await again.json())["project"]["id"] == project["id"]
    assert len((await (await client.get("/api/projects", headers=owner.auth)).json())["projects"]["projects"]) == 1
    reused = await send(client, owner, "POST", "/api/projects", {"name": "Different", "client_id": "create-once-1"})
    assert reused.status == 409

    chat = await make_chat(client, owner, "Idempotent")
    path = f"/api/projects/{project['id']}/chats/{chat['id']}"
    body = {"revision": project["revision"], "client_id": "move-once-1"}
    moved = await send(client, owner, "POST", path, body)
    assert moved.status == 200
    repeated = await send(client, owner, "POST", path, body)
    assert repeated.status == 200
    snap = (await repeated.json())["projects"]
    assert len([t for t in snap["threads"] if t["chat_id"] == chat["id"]]) == 1
    assert next(p for p in snap["projects"] if p["id"] == project["id"])["revision"] == project["revision"] + 1


# -- member and cross-bot isolation --------------------------------------------------------


async def test_members_see_shared_and_own_private_projects_only(client, hub):
    owner = await pair_phone(client, hub, name="Owner")
    member = await pair_phone(client, hub, name="Member", role="member")
    other = await pair_phone(client, hub, name="Other", role="member")
    shared, _ = await make_project(client, owner, "Shared", "create-shared-1")
    mine, _ = await make_project(client, member, "Mine", "create-mine-1")
    theirs, _ = await make_project(client, other, "Theirs", "create-theirs-1")

    member_snap = (await (await client.get("/api/projects", headers=member.auth)).json())["projects"]
    names = {p["name"] for p in member_snap["projects"]}
    assert names == {"Shared", "Mine"}
    assert next(p for p in member_snap["projects"] if p["id"] == mine["id"])["can_manage"] is True
    assert next(p for p in member_snap["projects"] if p["id"] == shared["id"])["can_manage"] is False

    owner_snap = (await (await client.get("/api/projects", headers=owner.auth)).json())["projects"]
    assert {p["name"] for p in owner_snap["projects"]} == {"Shared"}

    # A member may rename their own project but not the owner's shared one.
    assert (await send(client, member, "PATCH", f"/api/projects/{mine['id']}",
                       {"name": "Mine renamed", "revision": mine["revision"], "client_id": "rename-mine-1"})).status == 200
    assert (await send(client, member, "PATCH", f"/api/projects/{shared['id']}",
                       {"name": "Stolen", "revision": shared["revision"], "client_id": "rename-shared-1"})).status == 403
    assert (await send(client, member, "PATCH", f"/api/projects/{theirs['id']}",
                       {"name": "Nope", "revision": theirs["revision"], "client_id": "rename-theirs-1"})).status == 404
    assert (await send(client, member, "PUT", "/api/projects/order",
                       {"ids": [shared["id"], mine["id"]], "layout_revision": member_snap["layout_revision"],
                        "client_id": "order-member-1"})).status == 403


async def test_member_can_only_move_their_own_accessible_chats(client, hub):
    owner = await pair_phone(client, hub, name="Owner")
    member = await pair_phone(client, hub, name="Member", role="member")
    shared, _ = await make_project(client, owner, "Shared", "create-shared-move-1")
    owner_chat = await make_chat(client, owner, "Owner topic")
    member_chat = await make_chat(client, member, "Member topic")
    snap = (await (await client.get("/api/projects", headers=member.auth)).json())["projects"]
    project = next(p for p in snap["projects"] if p["id"] == shared["id"])

    mine = await send(client, member, "POST", f"/api/projects/{shared['id']}/chats/{member_chat['id']}",
                      {"revision": project["revision"], "client_id": "move-member-1"})
    assert mine.status == 200, await mine.text()
    assert len((await mine.json())["projects"]["threads"]) == 1

    # An owner can already read that member chat, so the shared project shows it to them too.
    owner_snap = (await (await client.get("/api/projects", headers=owner.auth)).json())["projects"]
    assert [t["chat_id"] for t in owner_snap["threads"]] == [member_chat["id"]]
    assert owner_snap["projects"][0]["chat_count"] == 1

    # The owner's chat is invisible to the member, so it can't be moved by guessing its id.
    stolen = await send(client, member, "POST", f"/api/projects/{shared['id']}/chats/{owner_chat['id']}",
                        {"revision": project["revision"] + 1, "client_id": "move-owner-1"})
    assert stolen.status == 404


async def test_projects_do_not_cross_bots(store):
    owner, _ = store.add_device("Owner")
    owner = store.get_device(owner["id"])
    a = store.create_chat("A", bot="alpha")
    b = store.create_chat("B", bot="beta")
    projects = Projects(store)
    created = projects.create(owner, "alpha", {"name": "Alpha only", "client_id": "cross-create-1"})["project"]
    assert [p["id"] for p in projects.snapshot(owner, "beta")["projects"]] == []
    with pytest.raises(Exception):
        projects.move_chat(owner, "beta", created["id"], b["id"], {"revision": 1, "client_id": "cross-move-1"})
    assert projects.snapshot(owner, "alpha")["projects"][0]["id"] == created["id"]
    assert not any(t["chat_id"] == a["id"] for t in projects.snapshot(owner, "alpha")["threads"])


# -- search scoping and events -------------------------------------------------------------


async def test_search_within_a_project_never_leaks_other_chats(client, hub):
    owner = await pair_phone(client, hub)
    project, _ = await make_project(client, owner, "Scoped", "create-scoped-1")
    inside = await make_chat(client, owner, "Inside", project["id"])
    outside = await make_chat(client, owner, "Outside")
    hub.store.add_message(inside["id"], "user", "needle inside this project")
    hub.store.add_message(outside["id"], "user", "needle outside the project")

    scoped = await (await client.get(f"/api/search?q=needle&project_id={project['id']}", headers=owner.auth)).json()
    assert [r["chat"]["id"] for r in scoped["results"]] == [inside["id"]]
    every = await (await client.get("/api/search?q=needle", headers=owner.auth)).json()
    assert {r["chat"]["id"] for r in every["results"]} == {inside["id"], outside["id"]}
    missing = await client.get("/api/search?q=needle&project_id=p-nope", headers=owner.auth)
    assert missing.status == 404


async def test_a_members_project_search_never_returns_an_owners_chat(client, hub):
    owner = await pair_phone(client, hub, name="Owner")
    member = await pair_phone(client, hub, name="Member", role="member")
    shared, _ = await make_project(client, owner, "Shared search", "create-shared-search-1")
    owner_chat = await make_chat(client, owner, "Owner only", shared["id"])
    member_chat = await make_chat(client, member, "Member topic", shared["id"])
    hub.store.add_message(owner_chat["id"], "user", "needle from the owner")
    hub.store.add_message(member_chat["id"], "user", "needle from the member")
    path = f"/api/search?q=needle&project_id={shared['id']}"
    member_results = await (await client.get(path, headers=member.auth)).json()
    assert [r["chat"]["id"] for r in member_results["results"]] == [member_chat["id"]]
    owner_results = await (await client.get(path, headers=owner.auth)).json()
    assert {r["chat"]["id"] for r in owner_results["results"]} == {owner_chat["id"], member_chat["id"]}


async def test_project_sync_is_tailored_per_device(client, hub):
    owner = await pair_phone(client, hub, name="Owner")
    member = await pair_phone(client, hub, name="Member", role="member")
    owner_ws = await client.ws_connect("/api/ws")
    await owner_ws.send_json({"type": "auth", "token": owner.token})
    await owner_ws.receive_json()
    member_ws = await client.ws_connect("/api/ws")
    await member_ws.send_json({"type": "auth", "token": member.token})
    await member_ws.receive_json()

    await make_project(client, member, "Private plan", "create-private-event-1")
    member_event = await member_ws.receive_json()
    assert member_event["type"] == "project.sync"
    assert [p["name"] for p in member_event["projects"]["projects"]] == ["Private plan"]
    owner_event = await owner_ws.receive_json()
    assert owner_event["type"] == "project.sync"
    assert owner_event["projects"]["projects"] == []
    await owner_ws.close()
    await member_ws.close()
