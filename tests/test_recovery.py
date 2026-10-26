import base64
import asyncio
import json
from types import SimpleNamespace

import pytest
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from plugin import recovery
from plugin.hub import Hub
from plugin.store import Store


def decrypt(data, envelope, server_id, device_id):
    decode = lambda s: base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
    message = json.loads(envelope)
    return json.loads(AESGCM(decode(data["key"])).decrypt(decode(message["nonce"]), decode(message["ciphertext"]),
        f"winglet.connection.v1:{server_id}:{device_id}".encode()))


def test_address_messages_are_authenticated_private_and_use_fresh_nonces():
    data = recovery.credentials("https://ntfy.sh")
    first = recovery.encrypt(data, "s", "phone", "https://first.trycloudflare.com", 2)
    second = recovery.encrypt(data, "s", "phone", "https://first.trycloudflare.com", 2)
    assert "first.trycloudflare.com" not in first and data["key"] not in first
    assert first != second
    assert decrypt(data, first, "s", "phone")["revision"] == 2
    for server, phone in [("different", "phone"), ("s", "other")]:
        with pytest.raises(InvalidTag):
            decrypt(data, first, server, phone)
    with pytest.raises(InvalidTag):
        decrypt(recovery.credentials("https://ntfy.sh"), first, "s", "phone")


async def test_only_paired_android_device_receives_own_recovery_key(tmp_path, aiohttp_client):
    store = Store(tmp_path / "hub.db")
    hub = Hub(store)
    hub.connection = {"mode": "quick", "url": "https://first.trycloudflare.com"}
    client = await aiohttp_client(hub.build_app())
    try:
        assert (await client.get("/api/connection")).status == 401
        devices = []
        for platform in ("android", "android", "web"):
            response = await client.post("/api/pair", json={"code": store.create_pair_code(), "platform": platform})
            devices.append(await response.json())
        a, b, web = devices
        assert a["recovery"]["key"] != b["recovery"]["key"]
        assert a["recovery"]["topic"] != b["recovery"]["topic"]
        assert web["recovery"] is None
        again = await (await client.get("/api/connection", headers={"Authorization": "Bearer " + a["token"]})).json()
        assert again["recovery"] == a["recovery"]
        public = await (await client.get("/api/info")).json()
        assert "key" not in json.dumps(public) and "topic" not in json.dumps(public)
        store.remove_device(a["device"]["id"])
        assert (await client.get("/api/connection", headers={"Authorization": "Bearer " + a["token"]})).status == 401
        assert len(store.list_push_subs("recovery")) == 1
    finally:
        await client.close()
        await hub.aclose()
        store.close()


async def test_rotation_publishes_encrypted_address_and_revocation_stops_updates(tmp_path):
    store = Store(tmp_path / "hub.db")
    published = []
    async def post(url, **kwargs):
        published.append((url, kwargs["json"]))
        return SimpleNamespace(status_code=200)
    hub = Hub(store, http_client=SimpleNamespace(post=post))
    hub.connection = {"mode": "quick", "url": None}
    device, token = store.add_device("phone", "android")
    data = hub._recovery_credentials(device)
    try:
        await hub.set_connection("https://first.trycloudflare.com")
        await hub.publish_addresses()
        assert len(published) == 1
        assert token not in json.dumps(published) and data["key"] not in json.dumps(published)
        first = decrypt(data, published[-1][1]["message"], hub.server_id(), device["id"])
        await hub.set_connection(None)
        await hub.publish_addresses()
        assert len(published) == 1
        await hub.set_connection("https://second.trycloudflare.com")
        await hub.publish_addresses()
        second = decrypt(data, published[-1][1]["message"], hub.server_id(), device["id"])
        assert second["revision"] > first["revision"]
        count = len(published)
        store.remove_device(device["id"])
        await hub.set_connection("https://third.trycloudflare.com")
        await hub.publish_addresses()
        assert len(published) == count
    finally:
        await hub.aclose()
        store.close()


async def test_failed_ntfy_publish_is_retried_and_direct_servers_do_not_enroll(tmp_path):
    store = Store(tmp_path / "hub.db")
    device, _ = store.add_device("phone", "android")
    async def post(*args, **kwargs):
        return SimpleNamespace(status_code=429)
    hub = Hub(store, http_client=SimpleNamespace(post=post))
    try:
        assert hub._recovery_credentials(device) is None
        hub.connection = {"mode": "quick", "url": "https://first.trycloudflare.com"}
        hub._recovery_credentials(device)
        await hub.publish_addresses()
        assert hub._recovery_due
        hub.ntfy_server = "http://ntfy.example"
        another, _ = store.add_device("other", "android")
        assert hub._recovery_credentials(another) is None
    finally:
        await hub.aclose()
        store.close()


async def test_old_inflight_publish_cannot_delay_rotated_address(tmp_path):
    store = Store(tmp_path / "hub.db")
    started, finish = asyncio.Event(), asyncio.Event()
    published = []
    async def post(url, **kwargs):
        published.append(kwargs["json"]["message"])
        if len(published) == 1:
            started.set()
            await finish.wait()
        return SimpleNamespace(status_code=200)
    hub = Hub(store, http_client=SimpleNamespace(post=post))
    hub.connection = {"mode": "quick", "url": "https://old.trycloudflare.com"}
    device, _ = store.add_device("phone", "android")
    data = hub._recovery_credentials(device)
    old = asyncio.create_task(hub.publish_addresses())
    try:
        await started.wait()
        await hub.set_connection("https://new.trycloudflare.com")
        finish.set()
        await old
        await hub.publish_addresses()
        messages = [decrypt(data, message, hub.server_id(), device["id"]) for message in published]
        assert [message["url"] for message in messages] == ["https://old.trycloudflare.com", "https://new.trycloudflare.com"]
        assert messages[1]["revision"] > messages[0]["revision"]
    finally:
        finish.set()
        await hub.aclose()
        store.close()


async def test_connection_status_tells_each_device_what_applies_to_it(tmp_path, aiohttp_client):
    store = Store(tmp_path / "hub.db")
    async def post(url, **kwargs):
        return SimpleNamespace(status_code=200)
    hub = Hub(store, http_client=SimpleNamespace(post=post))
    hub.connection = {"mode": "quick", "url": None}
    hub.listen = "127.0.0.1:8787"
    hub.tunnel = SimpleNamespace(status={"state": "retrying", "since": 1.0, "error": "cloudflared at /opt/x failed",
                                         "retry_at": 3.0})
    client = await aiohttp_client(hub.build_app())
    try:
        assert (await client.get("/api/connection/status")).status == 401
        owner = await (await client.post("/api/pair", json={"code": store.create_pair_code(), "platform": "android"})).json()
        member = await (await client.post("/api/pair", json={"code": store.create_pair_code(role="member"),
                                                             "platform": "web"})).json()
        auth = lambda d: {"Authorization": "Bearer " + d["token"]}  # noqa: E731

        status = await (await client.get("/api/connection/status", headers=auth(owner))).json()
        assert status["mode"] == "quick" and status["url"] is None and status["address_since"] is None
        assert status["tunnel"]["state"] == "retrying" and "failed" in status["tunnel"]["error"]
        assert status["recovery"] == {"enrolled": True, "last": None}
        assert status["listen"] == "127.0.0.1:8787" and status["web_keys"] is False
        assert status["push"] == {"encrypted": 0, "ntfy": 0, "webpush": 0, "last": None, "ntfy_server": "ntfy.sh"}

        await hub.set_connection("https://first.trycloudflare.com")
        await hub.publish_addresses()
        await client.get("/api/push/ntfy", headers=auth(owner))
        assert (await (await client.post("/api/push/test", headers=auth(owner))).json())["accepted"] == 1
        status = await (await client.get("/api/connection/status", headers=auth(owner))).json()
        assert status["url"] == "https://first.trycloudflare.com" and status["address_since"] > 0
        assert status["address_changes"] == 1
        assert status["recovery"]["last"]["ok"] is True
        assert status["push"]["ntfy"] == 1 and status["push"]["last"]["ok"] is True

        # A member on the web app: no recovery, no server details, and no tunnel error text.
        theirs = await (await client.get("/api/connection/status", headers=auth(member))).json()
        assert theirs["recovery"] is None and theirs["push"]["ntfy"] == 0 and theirs["push"]["last"] is None
        assert theirs["tunnel"]["state"] == "retrying" and theirs["tunnel"]["error"] is None
        assert "listen" not in theirs and "web_keys" not in theirs
    finally:
        await client.close()
        await hub.aclose()
        store.close()


async def test_a_direct_server_reports_the_address_it_gives_phones(tmp_path, aiohttp_client):
    store = Store(tmp_path / "hub.db")
    hub = Hub(store)
    hub.public_url = "https://hermes.example.ts.net"
    client = await aiohttp_client(hub.build_app())
    try:
        phone = await (await client.post("/api/pair", json={"code": store.create_pair_code(), "platform": "android"})).json()
        status = await (await client.get("/api/connection/status", headers={"Authorization": "Bearer " + phone["token"]})).json()
        assert status["mode"] == "direct" and status["url"] == "https://hermes.example.ts.net"
        assert status["tunnel"] is None and status["recovery"] is None and status["address_changes"] is None
        assert status["web_keys"] is True
        # Not in the public info: it can name a private network.
        assert "ts.net" not in json.dumps(await (await client.get("/api/info")).json())
    finally:
        await client.close()
        await hub.aclose()
        store.close()
