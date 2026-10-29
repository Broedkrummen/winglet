"""Roles, the one policy, sealed secrets and signed owner actions (the M3 security contract)."""

import asyncio
import base64
import hashlib
import json
import os
import secrets
import sqlite3
import time

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from plugin import keys
from plugin.hub import MEMBER_COMMANDS, ROUTE_POLICY, Hub, _push_for
from plugin.store import Store

RAW = serialization.Encoding.Raw
RAW_PUB = serialization.PublicFormat.Raw
RAW_PRIV = serialization.PrivateFormat.Raw


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "data.db")
    yield s
    s.close()


@pytest.fixture
def hub(store, tmp_path):
    store.ensure_chat("general", "General")
    h = Hub(store, web_root=tmp_path / "web", bot_info=lambda: {"name": "hermes", "title": "Hermes"})
    h.received = []

    async def on_user_message(chat, text, device, message, **extra):
        h.received.append((chat["id"], text, device["id"]))

    async def on_approval(item, choice):
        return True

    h.on_user_message = on_user_message
    h.on_approval = on_approval
    h.command_resolver = lambda name: {"reset": "new", "bg": "background"}.get(name, name if name in MEMBER_COMMANDS | {"model", "pause", "restart", "update", "approve"} else "")
    return h


@pytest.fixture
async def client(aiohttp_client, hub):
    return await aiohttp_client(hub.build_app())


# -- the phone's side, written independently of plugin/keys.py ------------------------------


def seal(info, purpose, data, device_id=""):
    recipient = base64.urlsafe_b64decode(info["sealing"] + "==")
    eph = X25519PrivateKey.generate()
    eph_pub = eph.public_key().public_bytes(RAW, RAW_PUB)
    shared = eph.exchange(X25519PublicKey.from_public_bytes(recipient))
    key = HKDF(algorithm=hashes.SHA256(), length=32, salt=eph_pub + recipient, info=b"winglet-seal-v1").derive(shared)
    nonce = os.urandom(12)
    aad = b"|".join([b"winglet-seal-v1", purpose.encode(), device_id.encode()])
    blob = eph_pub + nonce + AESGCM(key).encrypt(nonce, json.dumps(data).encode(), aad)
    return base64.urlsafe_b64encode(blob).rstrip(b"=").decode()


class Phone:
    def __init__(self, name):
        self.name = name
        self.key = Ed25519PrivateKey.generate()
        self.public = keys.b64e(self.key.public_key().public_bytes(RAW, RAW_PUB))
        self.token = ""
        self.id = ""

    @property
    def auth(self):
        return {"Authorization": f"Bearer {self.token}"}

    def signed(self, method, path, body=b"", *, stamp=None, nonce=None):
        stamp = str(int(time.time()) if stamp is None else stamp)
        nonce = nonce or secrets.token_urlsafe(18)
        payload = keys.signing_payload(method, path, body, self.id, stamp, nonce)
        return {**self.auth, "Content-Type": "application/json", "X-Winglet-Device": self.id, "X-Winglet-Time": stamp,
                "X-Winglet-Nonce": nonce, "X-Winglet-Signature": keys.b64e(self.key.sign(payload))}


async def pair_phone(client, hub, name="Pixel", role="owner", *, sealed=True, pinned=True):
    phone = Phone(name)
    code = hub.store.create_pair_code(role=role)
    info = await (await client.get("/api/server-key")).json()
    if sealed:
        body = {"sealed": seal(info, "pair", {"code": code, "device_name": name, "platform": "android",
                                              "sign_key": phone.public, "pinned": pinned})}
    else:
        body = {"code": code, "device_name": name, "platform": "android"}
    resp = await client.post("/api/pair", json=body)
    assert resp.status == 200, await resp.text()
    data = await resp.json()
    phone.token, phone.id, phone.me = data["token"], data["device"]["id"], data["me"]
    return phone


async def post_signed(client, phone, path, data, **kw):
    body = json.dumps(data).encode()
    return await client.post(path, data=body, headers=phone.signed("POST", path, body, **kw))


# -- policy table --------------------------------------------------------------------------


def test_every_route_has_an_explicit_policy(hub):
    app = hub.build_app()
    names = {getattr(route.handler, "__name__", "") for route in app.router.routes()}
    names.discard("")
    assert names <= set(ROUTE_POLICY), names - set(ROUTE_POLICY)
    assert {name for name, level in ROUTE_POLICY.items() if level == "owner_signed"} >= {
        "h_device_update", "h_device_delete", "h_pairing_code"}


# -- server key and sealing ------------------------------------------------------------------


def test_server_key_is_stable_signed_and_fingerprinted(store):
    a, b = keys.ServerKeys(store), keys.ServerKeys(store)
    info = a.public_info()
    assert info == b.public_info()
    identity = Ed25519PublicKey.from_public_bytes(keys.b64d(info["identity"]))
    identity.verify(keys.b64d(info["sealing_sig"]), keys.SEALING_CONTEXT + keys.b64d(info["sealing"]))
    assert info["fingerprint"] == keys.fingerprint(keys.b64d(info["identity"])) == a.fingerprint
    assert len(info["fingerprint"]) == 22


def test_sealed_values_open_only_for_their_purpose_and_device(store):
    k = keys.ServerKeys(store)
    blob = seal(k.public_info(), "provider-key", {"key": "sk-test-123"}, "dev1")
    assert k.unseal_json(blob, "provider-key", "dev1") == {"key": "sk-test-123"}
    for purpose, device in (("pair", "dev1"), ("provider-key", "dev2")):
        with pytest.raises(keys.SealError):
            k.unseal(blob, purpose, device)
    tampered = keys.b64d(blob)
    tampered = tampered[:-1] + bytes([tampered[-1] ^ 1])
    with pytest.raises(keys.SealError):
        k.unseal(keys.b64e(tampered), "provider-key", "dev1")


def test_rotation_keeps_identity_and_still_opens_the_old_key_for_a_while(store):
    k = keys.ServerKeys(store)
    before = k.public_info()
    blob = seal(before, "x", {"n": 1})
    k.rotate_sealing()
    after = k.public_info()
    assert after["fingerprint"] == before["fingerprint"] and after["sealing"] != before["sealing"]
    assert k.unseal_json(blob, "x") == {"n": 1}
    retired = json.loads(store.get_kv("sealing_key_previous"))
    retired["retired_at"] = time.time() - keys.PREVIOUS_KEY_SECONDS - 1
    store.set_kv("sealing_key_previous", json.dumps(retired))
    with pytest.raises(keys.SealError):
        k.unseal(blob, "x")


def test_app_and_server_agree_on_the_wire_format(store):
    """tests/fixtures/crypto_vectors.json is produced by the app's crypto (app/tests/crypto.test.ts
    checks it reproduces it byte for byte); the server must open and verify it."""
    path = os.path.join(os.path.dirname(__file__), "fixtures", "crypto_vectors.json")
    with open(path) as f:
        v = json.load(f)
    store.set_kv("sealing_key", v["server_sealing_private"])
    opened = keys.ServerKeys(store).unseal_json(v["sealed"], v["purpose"], v["device_id"])
    assert opened == v["plaintext"]
    payload = keys.signing_payload(v["method"], v["path"], v["body"].encode(), v["device_id"], v["time"], v["nonce"])
    assert keys.verify_device_signature(v["device_public"], payload, v["signature"])
    assert not keys.verify_device_signature(v["device_public"], payload + b"x", v["signature"])


# -- pairing -------------------------------------------------------------------------------


async def test_sealed_pairing_registers_a_verified_signing_key(client, hub):
    phone = await pair_phone(client, hub)
    assert phone.me == {"id": phone.id, "name": "Pixel", "role": "owner", "verified": True, "home_chat": "general"}
    assert hub.store.device_sign_key(phone.id) == phone.public


async def test_typed_or_legacy_pairing_is_not_verified(client, hub):
    legacy = await pair_phone(client, hub, "Old", sealed=False)
    typed = await pair_phone(client, hub, "Typed", pinned=False)
    assert not legacy.me["verified"] and not typed.me["verified"]
    assert hub.store.device_sign_key(typed.id) == ""


async def test_a_sealed_request_for_another_server_is_refused(client, hub, tmp_path):
    other = keys.ServerKeys(Store(tmp_path / "other.db"))
    code = hub.store.create_pair_code()
    resp = await client.post("/api/pair", json={"sealed": seal(other.public_info(), "pair", {"code": code})})
    assert resp.status == 400
    assert hub.store.redeem_pair_code(code) == "owner"  # the code wasn't spent


async def test_member_codes_pair_members_with_their_own_chat(client, hub):
    member = await pair_phone(client, hub, "Alex", role="member")
    assert member.me["role"] == "member" and member.me["home_chat"] == f"m-{member.id}"
    chats = (await (await client.get("/api/chats", headers=member.auth)).json())["chats"]
    assert [c["id"] for c in chats] == [f"m-{member.id}"]


# -- signed owner actions ------------------------------------------------------------------


async def test_owner_actions_need_a_fresh_signature_from_a_verified_owner(client, hub):
    owner = await pair_phone(client, hub)
    ok = await post_signed(client, owner, "/api/devices/pairing-code", {"role": "owner"})
    assert ok.status == 200
    data = await ok.json()
    assert data["role"] == "owner" and data["fingerprint"] == hub.keys.fingerprint and len(data["code"]) == 8

    body = json.dumps({"role": "owner"}).encode()
    # A stolen bearer token alone: refused.
    assert (await client.post("/api/devices/pairing-code", data=body, headers=owner.auth)).status == 403
    # Replayed: refused.
    headers = owner.signed("POST", "/api/devices/pairing-code", body)
    assert (await client.post("/api/devices/pairing-code", data=body, headers=headers)).status == 200
    assert (await client.post("/api/devices/pairing-code", data=body, headers=headers)).status == 403
    # Altered body: refused.
    altered = owner.signed("POST", "/api/devices/pairing-code", body)
    assert (await client.post("/api/devices/pairing-code", data=b'{"role":"member"}', headers=altered)).status == 403
    # Stale: refused.
    assert (await post_signed(client, owner, "/api/devices/pairing-code", {}, stamp=time.time() - 300)).status == 403
    # Signed by some other key: refused.
    impostor = Phone("x")
    impostor.token, impostor.id = owner.token, owner.id
    assert (await post_signed(client, impostor, "/api/devices/pairing-code", {})).status == 403
    refused = [e for e in hub.store.list_audit() if e["outcome"] == "refused"]
    assert len(refused) == 5  # bearer only, replay, altered, stale, wrong key


async def test_unverified_owners_and_members_cant_run_control_actions(client, hub):
    legacy = await pair_phone(client, hub, "Old", sealed=False)
    member = await pair_phone(client, hub, "Alex", role="member")
    resp = await post_signed(client, legacy, "/api/devices/pairing-code", {})
    body = await resp.json()
    # The app is told it can fix this by verifying, so it offers that instead of a dead end.
    assert resp.status == 403 and "Verify this device" in body["error"] and body["needs"] == "verify"
    resp = await post_signed(client, member, "/api/devices/pairing-code", {})
    assert resp.status == 403 and "needs" not in await resp.json()  # a member can't, verified or not
    assert (await client.get("/api/devices", headers=member.auth)).status == 403
    assert (await client.get("/api/audit", headers=member.auth)).status == 403


async def test_an_older_phone_verifies_by_scanning_a_fresh_code(client, hub):
    legacy = await pair_phone(client, hub, "Old", sealed=False)
    code = hub.store.create_pair_code()
    info = await (await client.get("/api/server-key")).json()
    new_key = Phone("Old")
    sealed = seal(info, "verify", {"code": code, "sign_key": new_key.public, "pinned": True}, legacy.id)
    resp = await client.post("/api/devices/verify", json={"sealed": sealed}, headers=legacy.auth)
    assert resp.status == 200 and (await resp.json())["me"]["verified"] is True
    new_key.token, new_key.id = legacy.token, legacy.id
    assert (await post_signed(client, new_key, "/api/devices/pairing-code", {})).status == 200
    # The code is spent, and a verification sealed for another device doesn't open.
    again = seal(info, "verify", {"code": code, "sign_key": new_key.public, "pinned": True}, legacy.id)
    assert (await client.post("/api/devices/verify", json={"sealed": again}, headers=legacy.auth)).status == 403
    other = seal(info, "verify", {"code": hub.store.create_pair_code(), "sign_key": new_key.public, "pinned": True}, "someone")
    assert (await client.post("/api/devices/verify", json={"sealed": other}, headers=legacy.auth)).status == 400


async def test_verifying_counts_wrong_codes_against_the_pairing_limit(client, hub):
    legacy = await pair_phone(client, hub, "Old", sealed=False)
    info = await (await client.get("/api/server-key")).json()
    key = Phone("Old")
    for _ in range(10):
        wrong = seal(info, "verify", {"code": "WRONG123", "sign_key": key.public, "pinned": True}, legacy.id)
        assert (await client.post("/api/devices/verify", json={"sealed": wrong}, headers=legacy.auth)).status == 403
    right = seal(info, "verify", {"code": hub.store.create_pair_code(), "sign_key": key.public, "pinned": True}, legacy.id)
    assert (await client.post("/api/devices/verify", json={"sealed": right}, headers=legacy.auth)).status == 429


async def test_a_timestamp_that_isnt_a_number_is_refused(client, hub):
    owner = await pair_phone(client, hub)
    for stamp in ("nan", "inf", "-inf", "soon"):
        assert (await post_signed(client, owner, "/api/devices/pairing-code", {}, stamp=stamp)).status == 403
    assert (await post_signed(client, owner, "/api/devices/pairing-code", {})).status == 200


async def test_roles_rename_remove_and_the_last_owner(client, hub):
    owner = await pair_phone(client, hub, "Mine")
    member = await pair_phone(client, hub, "Alex", role="member")

    async def patch(device_id, data):
        path = f"/api/devices/{device_id}"
        body = json.dumps(data).encode()
        return await client.patch(path, data=body, headers=owner.signed("PATCH", path, body))

    assert (await patch(owner.id, {"role": "member"})).status == 400  # the only owner
    resp = await patch(member.id, {"role": "owner", "name": "Alex's phone"})
    assert resp.status == 200 and (await resp.json())["device"]["role"] == "owner"
    devices = (await (await client.get("/api/devices", headers=owner.auth)).json())["devices"]
    assert {d["name"]: d["current"] for d in devices} == {"Mine": True, "Alex's phone": False}
    path = f"/api/devices/{member.id}"
    assert (await client.delete(path, headers=owner.signed("DELETE", path))).status == 200
    path = f"/api/devices/{owner.id}"
    assert (await client.delete(path, headers=owner.signed("DELETE", path))).status == 400
    actions = [e["action"] for e in hub.store.list_audit()]
    assert {"device.paired", "device.role", "device.renamed", "device.removed"} <= set(actions)


async def test_token_rotation_replaces_the_old_token(client, hub):
    phone = await pair_phone(client, hub)
    resp = await post_signed(client, phone, "/api/devices/me/rotate-token", {})
    new = (await resp.json())["token"]
    assert (await client.get("/api/me", headers=phone.auth)).status == 401
    assert (await client.get("/api/me", headers={"Authorization": f"Bearer {new}"})).status == 200


async def test_approval_requires_signed_http_but_deny_remains_available(client, hub):
    owner = await pair_phone(client, hub)
    item = await hub.add_inbox('approval', 'general', 'Run?', '', {'choices': ['once', 'deny']}, push=False)
    path = f"/api/inbox/{item['id']}/respond"
    assert (await client.post(path, json={'choice': 'once'}, headers=owner.auth)).status == 403
    assert hub.store.get_inbox(item['id'])['status'] == 'pending'
    ws = await client.ws_connect('/api/ws')
    await ws.send_json({'type': 'auth', 'token': owner.token})
    assert (await ws.receive_json())['type'] == 'hello'
    await ws.send_json({'type': 'inbox.respond', 'id': item['id'], 'choice': 'once'})
    assert (await ws.receive_json())['type'] == 'error'
    assert hub.store.get_inbox(item['id'])['status'] == 'pending'
    await ws.close()
    impostor = Phone('impostor')
    impostor.id, impostor.token = owner.id, owner.token
    assert (await post_signed(client, impostor, path, {'choice': 'once'})).status == 403
    assert (await post_signed(client, owner, path, {'choice': 'once'})).status == 200
    denied = await hub.add_inbox('approval', 'general', 'Run?', '', {'choices': ['once', 'deny']}, push=False)
    assert (await client.post(f"/api/inbox/{denied['id']}/respond", json={'choice': 'deny'}, headers=owner.auth)).status == 200
    legacy = await pair_phone(client, hub, 'Unverified', sealed=False)
    item = await hub.add_inbox('approval', 'general', 'Run?', '', {'choices': ['once', 'deny']}, push=False)
    response = await client.post(f"/api/inbox/{item['id']}/respond", json={'choice': 'once'}, headers=legacy.auth)
    assert response.status == 403 and (await response.json())['needs'] == 'verify'


async def test_verified_key_replacement_requires_current_key_and_owner_code(client, hub):
    owner = await pair_phone(client, hub)
    attacker = Phone('attacker')
    info = await (await client.get('/api/server-key')).json()
    code = hub.store.create_pair_code(role='member')
    payload = {'sealed': seal(info, 'verify', {'code': code, 'sign_key': attacker.public, 'pinned': True}, owner.id)}
    assert (await post_signed(client, owner, '/api/devices/verify', payload)).status == 403
    assert hub.store.redeem_pair_code(code) == 'member'
    code = hub.store.create_pair_code(role='owner')
    payload = {'sealed': seal(info, 'verify', {'code': code, 'sign_key': attacker.public, 'pinned': True}, owner.id)}
    assert (await client.post('/api/devices/verify', json=payload, headers=owner.auth)).status == 403
    assert hub.store.device_sign_key(owner.id) == owner.public
    assert (await post_signed(client, owner, '/api/devices/verify', payload)).status == 200
    assert hub.store.device_sign_key(owner.id) == attacker.public


async def test_owner_approve_slash_command_needs_signed_http(client, hub):
    owner = await pair_phone(client, hub)
    path = '/api/chats/general/messages'
    response = await client.post(path, json={'text': '/approve once'}, headers=owner.auth)
    assert response.status == 403 and not hub.received
    ws = await client.ws_connect('/api/ws')
    await ws.send_json({'type': 'auth', 'token': owner.token})
    assert (await ws.receive_json())['type'] == 'hello'
    await ws.send_json({'type': 'message.send', 'chat_id': 'general', 'text': '/approve once'})
    assert (await ws.receive_json())['type'] == 'error' and not hub.received
    await ws.close()
    assert (await post_signed(client, owner, path, {'text': '/approve once'})).status == 200
    assert [entry[1] for entry in hub.received] == ['/approve once']


async def test_confirm_picker_requires_signature(client, hub):
    owner = await pair_phone(client, hub)
    called = []
    async def confirm(choice):
        called.append(choice)
        return 'Done'
    message = await hub.post_picker('general', 'confirm', 'Confirm?', {'choices': [{'value': 'once'}]}, confirm)
    path = f"/api/pickers/{message['meta']['picker']['id']}/select"
    assert (await client.post(path, json={'value': 'once'}, headers=owner.auth)).status == 403
    assert not called
    assert (await post_signed(client, owner, path, {'value': 'once'})).status == 200
    assert called == ['once']


# -- what members can see and do ----------------------------------------------------------------


async def test_members_only_see_their_own_chats_and_inbox(client, hub):
    owner = await pair_phone(client, hub)
    member = await pair_phone(client, hub, "Alex", role="member")
    await hub.post_message("general", "owner's secret plans")
    await hub.add_inbox("question", "general", "Pick one", "", {"choices": ["a", "b"]}, push=False)
    for path in ("/api/chats/general/messages", "/api/chats/general/export"):
        assert (await client.get(path, headers=member.auth)).status == 404
    resp = await client.post("/api/chats/general/messages", json={"text": "hi"}, headers=member.auth)
    assert resp.status == 404 and not hub.received
    inbox = await (await client.get("/api/inbox", headers=member.auth)).json()
    assert inbox == {"items": [], "pending": 0}
    assert (await (await client.get("/api/inbox", headers=owner.auth)).json())["pending"] == 1
    # Chats a member starts are theirs; owners see those too.
    chat = (await (await client.post("/api/chats", json={"title": "Homework"}, headers=member.auth)).json())["chat"]
    owner_view = {c["id"] for c in (await (await client.get("/api/chats", headers=owner.auth)).json())["chats"]}
    assert chat["id"] in owner_view and f"m-{member.id}" in owner_view


async def test_members_cant_use_owner_slash_commands(client, hub):
    member = await pair_phone(client, hub, "Alex", role="member")
    home = member.me["home_chat"]
    for text in ("/model gpt-5", "/approve", "/restart", "/some-skill do it"):
        resp = await client.post(f"/api/chats/{home}/messages", json={"text": text}, headers=member.auth)
        assert resp.status == 200
    assert hub.received == []
    notes = [m["text"] for m in hub.store.list_messages(home) if m["role"] == "system"]
    assert "Only an owner can use /model." in notes and "Only an owner can use /some-skill." in notes
    for text in ("/new", "/reset", "/stop", "/steer go left", "/bg tidy up", "hello"):
        await client.post(f"/api/chats/{home}/messages", json={"text": text}, headers=member.auth)
    assert [t for _, t, _ in hub.received] == ["/new", "/reset", "/stop", "/steer go left", "/bg tidy up", "hello"]
    commands = [c["cmd"] for c in (await (await client.get("/api/commands", headers=member.auth)).json())["commands"]]
    assert "/model" not in commands and "/new" in commands


async def test_only_owners_answer_approvals_even_in_a_members_chat(client, hub):
    owner = await pair_phone(client, hub)
    member = await pair_phone(client, hub, "Alex", role="member")
    item = await hub.add_inbox("approval", member.me["home_chat"], "Run rm?", "rm -rf x",
                               {"choices": ["once", "deny"], "command": "rm -rf x"}, push=False)
    resp = await client.post(f"/api/inbox/{item['id']}/respond", json={"choice": "once"}, headers=member.auth)
    assert resp.status == 403
    resp = await post_signed(client, owner, f"/api/inbox/{item['id']}/respond", {"choice": "once"})
    assert resp.status == 200
    entry = hub.store.list_audit()[0]
    assert entry["action"] == "approval" and entry["summary"] == "once: rm -rf x" and entry["device_id"] == owner.id
    question = await hub.add_inbox("question", member.me["home_chat"], "Color?", "", {"choices": ["red"]}, push=False)

    async def on_answer(item, reply):
        return True

    hub.on_answer = on_answer
    resp = await client.post(f"/api/inbox/{question['id']}/respond", json={"answer": "red"}, headers=member.auth)
    assert resp.status == 200


async def test_members_only_receive_their_own_chats_live(client, hub):
    owner = await pair_phone(client, hub)
    member = await pair_phone(client, hub, "Alex", role="member")
    ws = await client.ws_connect("/api/ws")
    await ws.send_json({"type": "auth", "token": member.token})
    hello = await ws.receive_json()
    assert hello["type"] == "hello" and hello["me"]["role"] == "member"
    assert [c["id"] for c in hello["chats"]] == [member.me["home_chat"]]
    await hub.post_message("general", "for owners")
    await hub.post_message(member.me["home_chat"], "for Alex")
    seen = []
    while True:
        try:
            event = await ws.receive_json(timeout=0.3)
        except asyncio.TimeoutError:
            break
        seen.append(event)
    texts = [e["message"]["text"] for e in seen if e["type"] == "message.new"]
    assert texts == ["for Alex"]
    await ws.close()


async def test_a_role_changed_elsewhere_applies_to_open_sockets(client, hub, monkeypatch):
    monkeypatch.setattr("plugin.hub.ALIVE_CACHE_SECONDS", 0)
    owner = await pair_phone(client, hub)
    await pair_phone(client, hub, "Second owner")
    ws = await client.ws_connect("/api/ws")
    await ws.send_json({"type": "auth", "token": owner.token})
    assert (await ws.receive_json())["type"] == "hello"
    hub.store.update_device(owner.id, role="member")  # as `hermes winglet role` would, from another process
    await hub.post_message("general", "owners only")
    with pytest.raises(asyncio.TimeoutError):
        while True:
            event = await ws.receive_json(timeout=0.3)
            assert event.get("type") != "message.new"
    await ws.close()


async def test_websocket_auth_in_the_first_frame(client, hub):
    phone = await pair_phone(client, hub)
    ws = await client.ws_connect("/api/ws")
    await ws.send_json({"type": "auth", "token": "wrong"})
    msg = await ws.receive()
    assert msg.type.name in ("CLOSE", "CLOSED") and ws.close_code == 4401
    ws = await client.ws_connect("/api/ws")
    await ws.send_json({"type": "auth", "token": phone.token})
    assert (await ws.receive_json())["type"] == "hello"
    await ws.close()


def test_push_goes_to_the_right_people():
    owner = {"id": "o", "role": "owner"}
    member = {"id": "m", "role": "member"}
    owners_chat = {"id": "general", "owner_device": None}
    members_chat = {"id": "m-m", "owner_device": "m"}
    assert _push_for(owner, owners_chat, {"kind": "message"})
    assert not _push_for(member, owners_chat, {"kind": "message"})
    assert _push_for(member, members_chat, {"kind": "message"})
    assert not _push_for(owner, members_chat, {"kind": "message"})
    assert _push_for(owner, members_chat, {"kind": "approval"})
    assert not _push_for(member, members_chat, {"kind": "approval"})
    assert _push_for(member, members_chat, {"kind": "question"})
    assert not _push_for(None, owners_chat, {"kind": "message"})


def test_devices_paired_before_roles_become_unverified_owners(tmp_path):
    path = tmp_path / "old.db"
    db = sqlite3.connect(path)
    db.executescript("""
        CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL DEFAULT '',
            token_hash TEXT NOT NULL UNIQUE, created_at REAL NOT NULL, last_seen REAL NOT NULL);
        CREATE TABLE pair_codes (code_hash TEXT PRIMARY KEY, created_at REAL NOT NULL, expires_at REAL NOT NULL,
            used INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'chat',
            created_at REAL NOT NULL, updated_at REAL NOT NULL, preview TEXT NOT NULL DEFAULT '');
        INSERT INTO devices VALUES ('d1', 'Phone', 'android', 'h', 1, 1);
        INSERT INTO chats VALUES ('general', 'General', 'chat', 1, 1, '');
    """)
    db.close()
    s = Store(path)
    try:
        assert s.get_device("d1")["role"] == "owner" and s.get_device("d1")["verified"] is False
        assert s.get_chat("general")["owner_device"] is None
        if os.name == "posix":
            assert os.stat(path).st_mode & 0o077 == 0
    finally:
        s.close()


def test_secrets_never_reach_the_audit_log(store):
    k = keys.ServerKeys(store)
    k.public_info()  # creates the sealing key
    store.add_audit("pairing_code", summary="for a new member")
    dump = json.dumps(store.list_audit())
    assert store.get_kv("sealing_key") not in dump and store.get_kv("identity_key") not in dump
    assert hashlib.sha256(dump.encode()).hexdigest()  # the log is plain data
    assert k.fingerprint not in dump


async def test_a_server_signs_whether_an_address_is_its_own(client, hub):
    info = await (await client.get("/api/server-key")).json()
    identity = Ed25519PublicKey.from_public_bytes(base64.urlsafe_b64decode(info["identity"] + "=="))

    async def check(url):
        data = await (await client.get("/api/address-check", params={"url": url})).json()
        identity.verify(base64.urlsafe_b64decode(data["sig"] + "=="), b"winglet-address-v1" + data["statement"].encode())
        statement = json.loads(data["statement"])
        assert statement["server_id"] == hub.server_id() and statement["url"] == url
        assert abs(statement["issued_at"] - time.time()) < 60
        return statement["listed"]

    assert await check("https://hermes.example.ts.net") is False  # nothing set yet
    hub.public_url = "https://hermes.example.ts.net"
    assert await check("https://hermes.example.ts.net") is True and await check("https://hermes.example.ts.net/") is True
    # A relay asking on a phone's behalf gets a signed no for its own address, which it can't turn into a yes.
    assert await check("https://relay.example") is False
    hub.connection = {"mode": "quick", "url": "https://abc-def.trycloudflare.com"}
    assert await check("https://abc-def.trycloudflare.com") is True and await check("https://hermes.example.ts.net") is False
    assert (await client.get("/api/address-check")).status == 400
