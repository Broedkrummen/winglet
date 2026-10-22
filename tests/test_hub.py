import asyncio

import pytest
from cryptography.hazmat.primitives.asymmetric import ec

from plugin import webpush
from plugin.hub import HOME_CHAT_ID, Hub
from plugin.store import Store, normalize_code


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "data.db")
    yield s
    s.close()


class FakeResponse:
    def __init__(self, status=201):
        self.status_code = status


class FakeHTTP:
    def __init__(self, status=201):
        self.posts = []
        self.status = status

    async def post(self, url, **kwargs):
        self.posts.append((url, kwargs))
        return FakeResponse(self.status)

    async def aclose(self):
        pass


@pytest.fixture
def hub(store, tmp_path):
    store.ensure_chat("general", "General")  # the adapter creates it on startup
    return Hub(store, web_root=tmp_path / "web", http_client=FakeHTTP(),
               bot_info=lambda: {"name": "hermes", "title": "Hermes"})


@pytest.fixture
async def client(aiohttp_client, hub):
    return await aiohttp_client(hub.build_app())


async def pair(client, hub, name="Pixel"):
    code = hub.store.create_pair_code()
    resp = await client.post("/api/pair", json={"code": code, "device_name": name, "platform": "android"})
    assert resp.status == 200
    return (await resp.json())["token"]


# -- store -------------------------------------------------------------------------------


def test_pair_code_single_use_and_normalized(store):
    code = store.create_pair_code()
    messy = f"{code[:4].lower()}-{code[4:]}"
    assert normalize_code(messy) == code
    assert store.redeem_pair_code(messy)
    assert not store.redeem_pair_code(code)


def test_pair_code_expires(store):
    code = store.create_pair_code(ttl=-1)
    assert not store.redeem_pair_code(code)


def test_device_tokens_are_hashed(store):
    device, token = store.add_device("Phone")
    assert store.device_for_token(token)["id"] == device["id"]
    raw = store._one("SELECT token_hash FROM devices")["token_hash"]
    assert token not in raw
    assert store.device_for_token("nope") is None


def test_inbox_resolves_once(store):
    item = store.add_inbox("approval", "general", "Approval needed", "rm -rf /tmp/x", {"choices": ["once"]})
    assert store.pending_count() == 1
    assert store.resolve_inbox(item["id"], "resolved", "once")["status"] == "resolved"
    assert store.resolve_inbox(item["id"], "resolved", "once") is None
    assert store.pending_count() == 0


# -- web push crypto -----------------------------------------------------------------------


def test_webpush_roundtrip():
    ua_key = ec.generate_private_key(ec.SECP256R1())
    p256dh = webpush.b64url_encode(webpush._public_bytes(ua_key.public_key()))
    auth = webpush.b64url_encode(b"0123456789abcdef")
    body = webpush.encrypt(b'{"hello":"world"}', p256dh, auth)
    assert webpush.decrypt(body, ua_key, auth) == b'{"hello":"world"}'


def test_vapid_header_shape():
    pem = webpush.generate_vapid_private_key()
    header = webpush.vapid_authorization("https://web.push.apple.com/abc", pem, "https://example.com")
    assert header.startswith("vapid t=") and f"k={webpush.vapid_public_key(pem)}" in header
    token = header.split("t=")[1].split(",")[0]
    assert token.count(".") == 2
    assert len(webpush.b64url_decode(webpush.vapid_public_key(pem))) == 65


def test_webpush_decrypts_with_reference_library():
    http_ece = pytest.importorskip("http_ece")
    ua_key = ec.generate_private_key(ec.SECP256R1())
    p256dh = webpush.b64url_encode(webpush._public_bytes(ua_key.public_key()))
    auth_secret = b"fedcba9876543210"
    body = webpush.encrypt(b"reference check", p256dh, webpush.b64url_encode(auth_secret))
    assert http_ece.decrypt(body, private_key=ua_key, auth_secret=auth_secret, version="aes128gcm") == b"reference check"


# -- HTTP API --------------------------------------------------------------------------------


async def test_info_is_public(client):
    resp = await client.get("/api/info")
    data = await resp.json()
    assert data["app"] == "winglet" and data["bot"]["title"] == "Hermes"


async def test_info_and_hello_report_protocol_versions_and_features(client, hub):
    hub.hermes_version = lambda: "2026.9.24"
    data = await (await client.get("/api/info")).json()
    assert data["protocol"] >= 1 and data["min_app_protocol"] >= 1
    assert data["hermes_version"] == "2026.9.24" and data["version"]
    assert data["features"]["approvals"] is True
    token = await pair(client, hub)
    ws = await client.ws_connect(f"/api/ws?token={token}")
    hello = await ws.receive_json()
    assert hello["protocol"] == data["protocol"] and hello["hermes_version"] == "2026.9.24"
    assert hello["features"] == data["features"]
    await ws.close()


async def test_pairing_flow(client, hub):
    resp = await client.post("/api/pair", json={"code": "WRONG123"})
    assert resp.status == 403
    token = await pair(client, hub)
    resp = await client.get("/api/me", headers={"Authorization": f"Bearer {token}"})
    assert (await resp.json())["device"]["name"] == "Pixel"
    resp = await client.get("/api/chats")
    assert resp.status == 401


async def test_tunnel_pairing_limits_each_verified_client_ip(client, hub):
    hub.connection["mode"] = "quick"
    headers = {"Host": hub.tunnel_host, "CF-Connecting-IP": "192.0.2.10"}
    for _ in range(10):
        assert (await client.post("/api/pair", json={"code": "WRONG123"}, headers=headers)).status == 403
    assert (await client.post("/api/pair", json={"code": "WRONG123"}, headers=headers)).status == 429
    other = {**headers, "CF-Connecting-IP": "2001:db8::20"}
    assert (await client.post("/api/pair", json={"code": hub.store.create_pair_code()}, headers=other)).status == 200
    # The private origin marker must never be given to visiting phones.
    assert hub.tunnel_host not in str(await (await client.get("/api/info")).json())


@pytest.mark.parametrize("mode, host, ip", [("direct", "marker", "192.0.2.1"),
    ("quick", "public.trycloudflare.com", "192.0.2.1"), ("quick", "marker", "garbage"),
    ("quick", "marker", "192.0.2.1, 192.0.2.2"), ("quick", "marker", "")])
async def test_untrusted_pairing_headers_cannot_bypass_rate_limit(client, hub, mode, host, ip):
    hub.connection["mode"] = mode
    headers = {"Host": hub.tunnel_host if host == "marker" else host, "CF-Connecting-IP": ip}
    for _ in range(10):
        assert (await client.post("/api/pair", json={"code": "WRONG123"}, headers=headers)).status == 403
    headers["CF-Connecting-IP"] = "192.0.2.99"
    headers["Host"] = "public.trycloudflare.com"
    assert (await client.post("/api/pair", json={"code": hub.store.create_pair_code()}, headers=headers)).status == 429


def test_nonlocal_caller_cannot_claim_tunnel_client_ip(hub):
    from types import SimpleNamespace
    hub.connection["mode"] = "quick"
    request = SimpleNamespace(remote="192.0.2.1", headers={
        "Host": hub.tunnel_host, "CF-Connecting-IP": "192.0.2.99"})
    assert hub._pair_peer(request) == "192.0.2.1"


async def test_message_reaches_hermes_and_reply_streams(client, hub):
    received = []

    async def on_user_message(chat, text, device, message):
        received.append((chat["id"], text, device["name"]))

    hub.on_user_message = on_user_message
    token = await pair(client, hub)
    ws = await client.ws_connect(f"/api/ws?token={token}")
    hello = await ws.receive_json()
    assert hello["type"] == "hello" and any(c["id"] == HOME_CHAT_ID for c in hello["chats"])

    await ws.send_json({"type": "message.send", "chat_id": "general", "text": "hi there", "client_id": "c1"})
    new = await ws.receive_json()
    assert new["type"] == "message.new" and new["message"]["role"] == "user"
    assert new["message"]["meta"]["client_id"] == "c1"
    assert (await ws.receive_json())["type"] == "chat.update"
    for _ in range(20):
        if received:
            break
        await asyncio.sleep(0.01)
    assert received == [("general", "hi there", "Pixel")]

    msg = await hub.post_message("general", "Hel")
    assert (await ws.receive_json())["message"]["text"] == "Hel"
    await ws.receive_json()  # chat.update
    await hub.edit_message(msg["id"], "Hello!", final=True)
    update = await ws.receive_json()
    assert update["type"] == "message.update" and update["message"]["text"] == "Hello!"
    assert update["message"]["status"] == "final"

    resp = await client.get("/api/chats/general/messages", headers={"Authorization": f"Bearer {token}"})
    texts = [m["text"] for m in (await resp.json())["messages"]]
    assert texts == ["hi there", "Hello!"]
    await ws.close()


async def test_approval_roundtrip_and_signed_action(client, hub):
    decisions = []

    async def on_approval(item, choice):
        decisions.append(choice)
        return True

    hub.on_approval = on_approval
    token = await pair(client, hub)
    item = await hub.add_inbox("approval", "general", "Approval needed", "rm -rf build",
                               {"choices": ["once", "session", "deny"], "session_key": "k"}, push=False)
    auth = {"Authorization": f"Bearer {token}"}
    resp = await client.post(f"/api/inbox/{item['id']}/respond", json={"choice": "always"}, headers=auth)
    assert resp.status == 409  # not an offered choice
    resp = await client.post(f"/api/inbox/{item['id']}/respond", json={"choice": "once"}, headers=auth)
    assert (await resp.json())["item"]["resolution"] == "once"
    assert decisions == ["once"]

    item2 = await hub.add_inbox("approval", "general", "Approval needed", "ls",
                                {"choices": ["once", "deny"], "session_key": "k"}, push=False)
    bad = await client.post(f"/api/inbox/{item2['id']}/respond?choice=once&sig=bad")
    assert bad.status == 401
    # Even a correctly signed link can't approve: only "deny" is honoured from a notification.
    signed_once = hub.action_signature(item2["id"], "once")
    assert (await client.post(f"/api/inbox/{item2['id']}/respond?choice=once&sig={signed_once}")).status == 401
    sig = hub.action_signature(item2["id"], "deny")
    ok = await client.post(f"/api/inbox/{item2['id']}/respond?choice=deny&sig={sig}")
    assert ok.status == 200 and decisions == ["once", "deny"]


async def test_question_answer(client, hub):
    answers = []

    async def on_answer(item, text):
        answers.append(text)
        return True

    hub.on_answer = on_answer
    token = await pair(client, hub)
    item = await hub.add_inbox("question", "general", "Question", "Which color?",
                               {"choices": ["red", "blue"], "clarify_id": "q1"}, push=False)
    resp = await client.post(f"/api/inbox/{item['id']}/respond", json={"answer": "green"},
                             headers={"Authorization": f"Bearer {token}"})
    assert resp.status == 200 and answers == ["green"]


async def test_webpush_subscription_and_delivery(client, hub):
    token = await pair(client, hub)
    auth = {"Authorization": f"Bearer {token}"}
    vapid = await (await client.get("/api/push/vapid")).json()
    assert len(webpush.b64url_decode(vapid["public_key"])) == 65

    ua_key = ec.generate_private_key(ec.SECP256R1())
    sub = {"endpoint": "https://push.example/abc",
           "keys": {"p256dh": webpush.b64url_encode(webpush._public_bytes(ua_key.public_key())),
                    "auth": webpush.b64url_encode(b"0123456789abcdef")}}
    resp = await client.post("/api/push/webpush", json={"subscription": sub}, headers=auth)
    assert resp.status == 200

    await hub.add_inbox("approval", "general", "Approval needed", "rm -rf build",
                        {"choices": ["once", "deny"], "session_key": "k", "labels": {"once": "Allow once"}})
    url, kwargs = hub._http.posts[-1]
    assert url == sub["endpoint"] and kwargs["headers"]["Urgency"] == "high"
    import json
    note = json.loads(webpush.decrypt(kwargs["content"], ua_key, sub["keys"]["auth"]))
    assert note["kind"] == "approval" and "actions" not in note
    assert note["url"].startswith("/inbox?server=") and note["item_id"] in note["url"]


async def test_bot_reply_pushes_only_when_app_is_closed(client, hub, monkeypatch):
    monkeypatch.setattr("plugin.hub.PUSH_DEBOUNCE_SECONDS", 0.05)
    token = await pair(client, hub)
    hub.store.add_push_sub(hub.store.list_devices()[0]["id"], "ntfy", "https://ntfy.sh/t", {"server": "https://ntfy.sh", "topic": "t"})
    ws = await client.ws_connect(f"/api/ws?token={token}")
    await ws.receive_json()
    await hub.post_message("general", "while open")
    await asyncio.sleep(0.5)
    assert hub._http.posts == []
    await ws.close()
    await asyncio.sleep(0.05)
    await hub.post_message("general", "while closed")
    await asyncio.sleep(0.5)
    assert len(hub._http.posts) == 1
    payload = hub._http.posts[0][1]["json"]
    assert payload["topic"] == "t" and "while closed" not in payload["message"]  # generic text only


async def test_streaming_and_internal_edits_notify_only_once_when_finished(client, hub, monkeypatch):
    monkeypatch.setattr("plugin.hub.PUSH_DEBOUNCE_SECONDS", 0.01)
    device, _ = hub.store.add_device("Phone")
    hub.store.add_push_sub(device["id"], "ntfy", "https://ntfy.sh/t", {"server": "https://ntfy.sh", "topic": "t"})
    message = await hub.post_message("general", "partial", status="streaming")
    await asyncio.sleep(0.05)
    assert hub._http.posts == []
    await hub.edit_message(message["id"], "still partial")
    await asyncio.sleep(0.05)
    assert hub._http.posts == []
    await hub.edit_message(message["id"], "Finished answer.", final=True)
    await asyncio.sleep(0.4)
    assert len(hub._http.posts) == 1
    await hub.edit_message(message["id"], "Finished answer.", final=True)
    silent = await hub.post_message("general", "Internal", push=False)
    await hub.edit_message(silent["id"], "Internal updated", final=True)
    await hub.post_message("general", "🔍 web_search: cats")
    await hub.post_message("general", "🔍 Searching the web for cats")
    await asyncio.sleep(0.4)
    assert len(hub._http.posts) == 1


async def test_an_open_phone_does_not_silence_other_devices(client, hub):
    token = await pair(client, hub)
    second, _ = hub.store.add_device("Other phone")
    hub.store.add_push_sub(second["id"], "ntfy", "https://ntfy.sh/other", {"server": "https://ntfy.sh", "topic": "other"})
    ws = await client.ws_connect(f"/api/ws?token={token}")
    await ws.receive_json()
    await hub.post_message("general", "Finished.")
    await asyncio.sleep(0.4)
    assert len(hub._http.posts) == 1
    await ws.close()


async def test_replaying_an_older_reply_after_a_newer_reply_does_not_notify_again(client, hub, monkeypatch):
    device, _ = hub.store.add_device("Phone")
    hub.store.add_push_sub(device["id"], "ntfy", "https://ntfy.sh/t", {"server": "https://ntfy.sh", "topic": "t"})
    monkeypatch.setattr(hub, "schedule_push", lambda *args, **kwargs: None)
    older = await hub.post_message("general", "First answer")
    newer = await hub.post_message("general", "Second answer")
    for message in (older, newer, older):
        await hub._delayed_push("general", message["id"], 0)
    assert len(hub._http.posts) == 2


async def test_static_serving_and_spa_fallback(client, hub):
    root = hub.web_root
    root.mkdir()
    (root / "index.html").write_text("<html>shell</html>")
    (root / "sw.js").write_text("self.x=1")
    assert "shell" in await (await client.get("/")).text()
    assert "shell" in await (await client.get("/chat/general")).text()
    assert "self.x" in await (await client.get("/sw.js")).text()
    resp = await client.get("/../../etc/passwd")
    assert "root:" not in await resp.text()
    assert (await client.get("/api/nope")).status == 404


async def test_media_links_are_signed_and_need_no_token(client, hub, tmp_path):
    token = await pair(client, hub)
    f = tmp_path / "chart.png"
    f.write_bytes(b"\x89PNG fake")
    attachment = hub.add_media(str(f))
    assert attachment["kind"] == "image" and "sig=" in attachment["url"] and token not in attachment["url"]
    resp = await client.get(attachment["url"])
    assert resp.status == 200 and await resp.read() == b"\x89PNG fake"
    assert resp.headers["Content-Disposition"].startswith("inline")
    unsigned = attachment["url"].split("?")[0]
    assert (await client.get(unsigned)).status == 401
    assert (await client.get(unsigned + "?sig=forged")).status == 401
    assert (await client.get(f"{unsigned}?token={token}")).status == 200  # legacy links


async def test_active_documents_are_served_inert(client, hub, tmp_path):
    for name in ("report.html", "logo.svg"):
        f = tmp_path / name
        f.write_text("<script>localStorage.getItem('winglet.servers')</script>")
        attachment = hub.add_media(str(f))
        assert attachment["kind"] == "file"
        resp = await client.get(attachment["url"])
        assert resp.status == 200
        assert resp.headers["Content-Disposition"].startswith("attachment")
        assert resp.headers["Content-Type"] == "application/octet-stream"
        assert "sandbox" in resp.headers["Content-Security-Policy"]
        assert resp.headers["X-Content-Type-Options"] == "nosniff"


async def test_turn_end_finalizes_stale_streaming_messages(hub):
    msg = await hub.post_message("general", "💻 Running ls", status="streaming")
    await hub.set_typing("general", True)
    await hub.set_typing("general", False)
    assert hub.store.get_message(msg["id"])["status"] == "final"


async def test_routine_results_do_not_count_as_needing_you(hub):
    await hub.add_inbox("result", "general", "Routine finished", "All good", {}, push=False)
    assert hub.store.pending_count() == 0
    assert hub.store.list_inbox()[0]["kind"] == "result"


async def test_pairing_is_rate_limited(client, hub):
    for _ in range(10):
        assert (await client.post("/api/pair", json={"code": "NOPE0000"})).status == 403
    assert (await client.post("/api/pair", json={"code": hub.store.create_pair_code()})).status == 429


async def test_unpair_from_another_process_cuts_off_open_socket(client, hub, monkeypatch):
    monkeypatch.setattr("plugin.hub.ALIVE_CACHE_SECONDS", 0)
    received = []

    async def on_user_message(chat, text, device, message):
        received.append(text)

    hub.on_user_message = on_user_message
    token = await pair(client, hub)
    ws = await client.ws_connect(f"/api/ws?token={token}")
    hello = await ws.receive_json()
    hub.store.remove_device(hello["device"]["id"])  # what `hermes winglet unpair` does
    await ws.send_json({"type": "message.send", "chat_id": "general", "text": "still here?"})
    msg = await ws.receive()
    assert msg.type.name in ("CLOSE", "CLOSED", "CLOSING")
    assert received == []


async def test_revoked_socket_gets_no_broadcasts(client, hub, monkeypatch):
    monkeypatch.setattr("plugin.hub.ALIVE_CACHE_SECONDS", 0)
    token = await pair(client, hub)
    ws = await client.ws_connect(f"/api/ws?token={token}")
    hello = await ws.receive_json()
    hub.store.remove_device(hello["device"]["id"])
    await hub.post_message("general", "secret reply", push=False)
    msg = await ws.receive()
    assert msg.type.name in ("CLOSE", "CLOSED", "CLOSING")


async def test_unpairing_voids_notification_action_links(client, hub):
    token = await pair(client, hub)
    item = await hub.add_inbox("approval", "general", "Approval needed", "ls",
                               {"choices": ["once", "deny"], "session_key": "k"}, push=False)
    old_sig = hub.action_signature(item["id"], "deny")
    device = (await (await client.get("/api/me", headers={"Authorization": f"Bearer {token}"})).json())["device"]
    hub.store.remove_device(device["id"])
    resp = await client.post(f"/api/inbox/{item['id']}/respond?choice=deny&sig={old_sig}")
    assert resp.status == 401


async def test_missing_static_asset_is_404_not_the_app_shell(client, hub):
    root = hub.web_root
    root.mkdir()
    (root / "index.html").write_text("<html>shell</html>")
    resp = await client.get("/assets/node_modules/font.ttf")
    assert resp.status == 404 and "immutable" not in resp.headers.get("Cache-Control", "")
    resp = await client.get("/_expo/static/js/web/gone.js")
    assert resp.status == 404
    assert "shell" in await (await client.get("/inbox")).text()


async def test_retried_send_is_not_run_twice(client, hub):
    calls = []

    async def on_user_message(chat, text, device, message):
        calls.append(text)

    hub.on_user_message = on_user_message
    token = await pair(client, hub)
    auth = {"Authorization": f"Bearer {token}"}
    body = {"text": "deploy it", "client_id": "c-123"}
    first = await (await client.post("/api/chats/general/messages", json=body, headers=auth)).json()
    again = await (await client.post("/api/chats/general/messages", json=body, headers=auth)).json()
    assert first["message"]["id"] == again["message"]["id"]
    assert calls == ["deploy it"]


def test_paging_never_skips_messages_with_equal_timestamps(store, monkeypatch):
    monkeypatch.setattr("plugin.store._now", lambda: 1000.0)
    ids = [store.add_message("general", "bot", f"m{i}")["id"] for i in range(61)]
    page = store.list_messages("general", limit=60)
    older = store.list_messages("general", before_id=page[0]["id"], limit=60)
    assert [m["id"] for m in older + page] == ids
    positions = [m["position"] for m in older + page]
    assert positions == sorted(set(positions))
    assert store.get_message(ids[-1])["position"] == positions[-1]


def test_paging_position_survives_deletion_of_the_cursor_message(store):
    messages = [store.add_message("general", "bot", str(i)) for i in range(4)]
    cursor = messages[2]
    store.delete_message(cursor["id"])
    older = store.list_messages("general", before_position=cursor["position"])
    assert [m["id"] for m in older] == [m["id"] for m in messages[:2]]


async def test_history_includes_persisted_deletions_outside_latest_page(client, hub):
    token = await pair(client, hub)
    gone = hub.store.add_message("general", "bot", "Remove this")
    other = hub.store.add_message("other", "bot", "Keep isolated")
    for i in range(65):
        hub.store.add_message("general", "bot", str(i))
    await hub.delete_message(gone["id"])
    hub.store.delete_message(other["id"])
    # Reopening the database simulates a gateway restart between deletion and phone reconnect.
    reopened = Store(hub.store.path)
    assert reopened.deleted_message_ids("general") == [gone["id"]]
    reopened.close()
    data = await (await client.get("/api/chats/general/messages?limit=60",
                                  headers={"Authorization": f"Bearer {token}"})).json()
    assert len(data["messages"]) == 60
    assert data["deleted_ids"] == [gone["id"]]


def test_deleted_chat_records_deletions(store):
    chat = store.create_chat("Temp")
    message = store.add_message(chat["id"], "bot", "Gone")
    assert store.delete_chat(chat["id"])
    assert store.deleted_message_ids(chat["id"]) == [message["id"]]


async def test_legacy_ntfy_is_retired_on_upgrade_before_any_push(tmp_path):
    path = tmp_path / "legacy.db"
    old = Store(path)
    a, _ = old.add_device("Phone A")
    b, _ = old.add_device("Phone B")
    old.set_kv("ntfy_topic", "legacy-shared")
    shared = {"server": "https://old.ntfy.example", "topic": "legacy-shared"}
    for device in (a, b):
        old.add_push_sub(device["id"], "ntfy", "https://old.ntfy.example/legacy-shared", shared)
    old.add_push_sub(b["id"], "webpush", "https://push.example/b", {"keys": {}})
    old.close()

    upgraded = Store(path)
    http = FakeHTTP()
    upgraded_hub = Hub(upgraded, http_client=http)
    try:
        assert upgraded.list_push_subs("ntfy") == []
        assert len(upgraded.list_push_subs("webpush")) == 1
        upgraded.remove_push_sub(endpoint="https://push.example/b")
        upgraded.remove_device(a["id"])
        result = await upgraded_hub.push_now({"kind": "message", "url": "/"}, tag="test")
        assert result == {"accepted": 0, "failed": 0, "expired": 0} and http.posts == []
        private = {"server": "https://ntfy.sh", "topic": "private-b"}
        upgraded.add_push_sub(b["id"], "ntfy", "https://ntfy.sh/private-b", private)
        reopened = Store(path)
        assert [s["data"]["topic"] for s in reopened.list_push_subs("ntfy")] == ["private-b"]
        reopened.close()
    finally:
        upgraded.close()


async def test_bad_paging_params_are_400(client, hub):
    token = await pair(client, hub)
    resp = await client.get("/api/chats/general/messages?limit=abc", headers={"Authorization": f"Bearer {token}"})
    assert resp.status == 400
    resp = await client.get("/api/chats/general/messages?before_position=-1", headers={"Authorization": f"Bearer {token}"})
    assert resp.status == 400


async def test_notifications_point_at_real_app_routes(client, hub, monkeypatch):
    monkeypatch.setattr("plugin.hub.PUSH_DEBOUNCE_SECONDS", 0.05)
    device, _ = hub.store.add_device("Phone")
    hub.store.add_push_sub(device["id"], "ntfy", "https://ntfy.sh/t", {"server": "https://ntfy.sh", "topic": "t"})
    await hub.post_message("general", "done!")
    await asyncio.sleep(0.5)
    item = await hub.add_inbox("approval", "general", "Approval needed", "ls", {"choices": ["once"]})
    clicks = [post[1]["json"]["click"] for post in hub._http.posts]
    assert clicks == [f"winglet://chat/{hub.server_id()}/general",
                      f"winglet://inbox?server={hub.server_id()}&item={item['id']}"]


async def test_old_pending_requests_are_never_crowded_out(client, hub):
    token = await pair(client, hub)
    old = await hub.add_inbox("approval", "general", "Approval needed", "ls", {"choices": ["once"]}, push=False)
    for i in range(101):
        await hub.add_inbox("result", "general", "Routine finished", f"r{i}", {}, push=False)
    data = await (await client.get("/api/inbox", headers={"Authorization": f"Bearer {token}"})).json()
    assert data["pending"] == 1
    assert old["id"] in [i["id"] for i in data["items"] if i["status"] == "pending"]


async def test_multi_select_answer_passes_the_list(client, hub):
    answers = []

    async def on_answer(item, reply):
        answers.append(reply)
        return True

    hub.on_answer = on_answer
    item = await hub.add_inbox("question", "general", "Question", "Where to deploy?",
                               {"choices": ["Staging", "Prod"], "clarify_id": "q2", "multi_select": True}, push=False)
    ok, updated = await hub.respond(item["id"], answer=["Staging", "Prod"])
    assert ok and answers == [["Staging", "Prod"]] and updated["resolution"] == "Staging, Prod"


async def test_sending_to_a_deleted_chat_does_not_recreate_it(client, hub):
    token = await pair(client, hub)
    auth = {"Authorization": f"Bearer {token}"}
    chat = (await (await client.post("/api/chats", json={"title": "Temp"}, headers=auth)).json())["chat"]
    assert (await client.delete(f"/api/chats/{chat['id']}", headers=auth)).status == 200
    resp = await client.post(f"/api/chats/{chat['id']}/messages", json={"text": "hello?"}, headers=auth)
    assert resp.status == 404
    assert hub.store.get_chat(chat["id"]) is None


async def test_each_phone_gets_its_own_ntfy_topic(client, hub):
    a, b = await pair(client, hub, "Phone A"), await pair(client, hub, "Phone B")
    topic_a = (await (await client.get("/api/push/ntfy", headers={"Authorization": f"Bearer {a}"})).json())["topic"]
    topic_b = (await (await client.get("/api/push/ntfy", headers={"Authorization": f"Bearer {b}"})).json())["topic"]
    again_a = (await (await client.get("/api/push/ntfy", headers={"Authorization": f"Bearer {a}"})).json())["topic"]
    assert topic_a != topic_b and again_a == topic_a
    await client.delete("/api/me", headers={"Authorization": f"Bearer {b}"})
    assert [s["data"]["topic"] for s in hub.store.list_push_subs("ntfy")] == [topic_a]


async def test_push_test_reports_failures_honestly(client, hub):
    token = await pair(client, hub)
    auth = {"Authorization": f"Bearer {token}"}
    hub.store.add_push_sub(hub.store.list_devices()[0]["id"], "ntfy", "https://ntfy.sh/t", {"server": "https://ntfy.sh", "topic": "t"})
    hub._http.status = 500
    data = await (await client.post("/api/push/test", headers=auth)).json()
    assert data["ok"] is False and data["failed"] == 1 and data["accepted"] == 0
    hub._http.status = 200
    data = await (await client.post("/api/push/test", headers=auth)).json()
    assert data["ok"] is True and data["accepted"] == 1


async def test_malformed_input_is_rejected_cleanly(client, hub):
    assert (await client.post("/api/pair", json=["not", "an", "object"])).status == 400
    token = await pair(client, hub)
    bad = {"subscription": {"endpoint": "https://push.example/x", "keys": {"p256dh": "short", "auth": "x"}}}
    resp = await client.post("/api/push/webpush", json=bad, headers={"Authorization": f"Bearer {token}"})
    assert resp.status == 400


async def test_push_test_only_rings_the_device_asking(client, hub):
    mine, theirs = await pair(client, hub, "Mine"), await pair(client, hub, "Theirs")
    for token in (mine, theirs):
        await client.get("/api/push/ntfy", headers={"Authorization": f"Bearer {token}"})
    hub._http.posts.clear()
    data = await (await client.post("/api/push/test", headers={"Authorization": f"Bearer {mine}"})).json()
    assert data["accepted"] == 1 and len(hub._http.posts) == 1


def test_chat_previews_read_as_one_line(store):
    from plugin.store import preview_of
    assert preview_of("Shopping list:\n- chickpeas\n- coconut milk\n- rice") == "Shopping list: chickpeas, coconut milk, rice"
    assert preview_of("## Plan\n1. Groceries\n2. Meal prep\n\n| Day | Dinner |\n|---|---|\n| Mon | Pasta |") == \
        "Plan: Groceries, Meal prep Day · Dinner Mon · Pasta"
    assert preview_of("> Tip: buy rice.\nDone") == "Tip: buy rice. Done"
    assert preview_of("a - b") == "a - b"  # a dash inside a sentence stays
    assert len(preview_of("word " * 100)) == 140
    chat = store.create_chat("Food")
    store.add_message(chat["id"], "bot", "List:\n- a\n- b")
    assert store.get_chat(chat["id"])["preview"] == "List: a, b"
