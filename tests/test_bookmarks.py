"""Source-local saved answers never bypass the live conversation ACL."""
import json

import pytest

from plugin.bookmarks import digest
from plugin.hub import Hub
from plugin.store import Store
from test_trust import pair_phone


@pytest.fixture
def hub(tmp_path):
    store = Store(tmp_path / 'data.db')
    store.ensure_chat('general', 'General')
    store.ensure_chat('other', 'Other')
    hub = Hub(store, web_root=tmp_path / 'web', bot_info=lambda: {'name': 'hermes', 'title': 'Hermes'})
    yield hub
    store.close()


@pytest.fixture
async def client(aiohttp_client, hub):
    return await aiohttp_client(hub.build_app())


async def save(client, phone, message, bookmark='saved-1', **changes):
    path = f'/api/chats/{message["chat_id"]}/bookmark-snapshots/{bookmark}'
    body = json.dumps({'message_id': message['id'], 'expected_sha256': digest(message), **changes}).encode()
    return await client.put(path, data=body, headers=phone.signed('PUT', path, body))


async def test_snapshot_is_immutable_and_tracks_edits_then_source_deletion(client, hub):
    owner = await pair_phone(client, hub)
    message = hub.store.add_message('general', 'bot', 'Original answer')
    source = f'/api/chats/general/bookmark-source/{message["id"]}'
    assert (await (await client.get(source, headers=owner.auth)).json())['sha256'] == digest(message)
    response = await save(client, owner, message)
    assert response.status == 201
    assert (await save(client, owner, message)).status == 200
    path = '/api/chats/general/bookmark-snapshots/saved-1'
    hub.store.update_message(message['id'], 'Revised answer')
    result = await (await client.get(path, headers=owner.auth)).json()
    assert result['state'] == 'edited' and result['snapshot']['text'] == 'Original answer'
    assert (await save(client, owner, message, bookmark='stale')).status == 409
    hub.store.delete_message(message['id'])
    result = await (await client.get(path, headers=owner.auth)).json()
    assert result['state'] == 'deleted' and result['snapshot']['text'] == 'Original answer'
    assert (await (await client.get(source, headers=owner.auth)).json()) == {'state': 'deleted'}
    assert (await client.delete(path, headers=owner.auth)).status == 403
    assert (await client.delete(path, headers=owner.signed('DELETE', path))).status == 200
    assert (await client.get(path, headers=owner.auth)).status == 404


async def test_source_acl_role_changes_and_hidden_rows_do_not_leak_snapshots(client, hub):
    owner = await pair_phone(client, hub)
    member = await pair_phone(client, hub, 'Member', role='member')
    message = hub.store.add_message('general', 'bot', 'Private answer')
    assert (await save(client, owner, message)).status == 201
    path = '/api/chats/general/bookmark-snapshots/saved-1'
    assert (await client.get(path, headers=member.auth)).status == 404
    assert (await save(client, member, message, bookmark='forbidden')).status == 404
    assert (await client.get('/api/chats/other/bookmark-snapshots/saved-1', headers=owner.auth)).status == 404
    await pair_phone(client, hub, 'Second owner')
    hub.store.update_device(owner.id, role='member')
    assert (await client.get(path, headers=owner.auth)).status == 404
    hub.store.update_device(owner.id, role='owner')
    hub.store.update_message(message['id'], 'Private answer', meta={'hidden': True})
    assert (await client.get(path, headers=owner.auth)).status == 404
    assert (await save(client, owner, message)).status == 404


async def test_bounded_snapshot_and_strict_source_validation(client, hub):
    owner = await pair_phone(client, hub)
    message = hub.store.add_message('general', 'bot', '🦉' * 9000)
    result = await (await save(client, owner, message)).json()
    assert len(result['snapshot']['text']) == 8192 and result['snapshot']['truncated'] == 1
    assert len(result['snapshot']['text'].encode()) <= 32768
    assert (await save(client, owner, message, bookmark='invalid', expected_sha256='bad')).status == 400
    assert (await save(client, owner, message, bookmark='saved-1', message_id='other')).status == 409
    streaming = hub.store.add_message('general', 'bot', 'unfinished', status='streaming')
    assert (await save(client, owner, streaming, bookmark='unfinished')).status == 404
    hub.store.delete_chat('general')
    hub.store.ensure_chat('general', 'Recreated')
    assert (await client.get('/api/chats/general/bookmark-snapshots/saved-1', headers=owner.auth)).status == 404
    assert hub.store._one('SELECT COUNT(*) AS n FROM bookmark_snapshots')['n'] == 0

async def test_revoked_pairing_is_rechecked_after_signature_body_read(client, hub):
    owner = await pair_phone(client, hub)
    message = hub.store.add_message('general', 'bot', 'Private answer')
    original = hub._signature_problem

    async def revoke(request, device):
        result = await original(request, device)
        hub.store.remove_device(owner.id)
        return result

    hub._signature_problem = revoke
    assert (await save(client, owner, message)).status == 401
    assert hub.store._one('SELECT COUNT(*) AS n FROM bookmark_snapshots')['n'] == 0
