"""Personal sync never inherits another owner's data or unsigned mutations."""
import json

import pytest

from plugin.hub import Hub, ROUTE_POLICY
from plugin.store import Store
from test_trust import pair_phone


@pytest.fixture
def hub(tmp_path):
    store = Store(tmp_path / 'data.db')
    store.ensure_chat('general', 'General')
    value = Hub(store, web_root=tmp_path / 'web')
    yield value
    store.close()


@pytest.fixture
async def client(aiohttp_client, hub):
    return await aiohttp_client(hub.build_app())


async def post(client, phone, path, data):
    body = json.dumps(data).encode()
    return await client.post(path, data=body, headers=phone.signed('POST', path, body))


async def test_explicit_linking_signed_mutation_and_revoke(client, hub):
    a = await pair_phone(client, hub)
    b = await pair_phone(client, hub)
    unsigned = await client.post('/api/user-sync', json={}, headers=a.auth)
    assert unsigned.status == 403
    response = await post(client, a, '/api/user-sync', {})
    assert response.status == 200
    assert response.headers['Cache-Control'] == 'no-store'
    group = (await response.json())['group_id']
    path = f'/api/user-sync/{group}/records/draft/conversation'
    response = await post(client, a, path, {'operation_id': 'draft-first', 'base_revision': 0,
        'changes': {'text': {'deleted': False, 'value': 'private draft'}, 'generation': {'deleted': False, 'value': 'first'}}})
    assert response.status == 200
    assert (await client.get(path, headers=b.auth)).status == 403
    assert (await client.get(f'/api/user-sync/{group}/members', headers=b.auth)).status == 403
    listing = f'/api/user-sync/{group}/submissions'
    assert (await client.get(listing, headers=b.auth)).status == 403
    assert (await (await client.get('/api/user-sync', headers=b.auth)).json()) == {'groups': []}
    invite = await post(client, a, f'/api/user-sync/{group}/invite', {})
    token = (await invite.json())['token']
    assert (await post(client, b, '/api/user-sync/join', {'token': token})).status == 200
    assert (await client.get(path, headers=b.auth)).status == 200
    members = await (await client.get(f'/api/user-sync/{group}/members', headers=b.auth)).json()
    assert len(members['members']) == 2
    assert all(set(member) == {'id', 'name', 'platform', 'last_seen'} for member in members['members'])
    submit = f'/api/user-sync/{group}/drafts/conversation/submit'
    first = await (await post(client, a, submit, {'expected_revision': 1})).json()
    second = await (await post(client, b, submit, {'expected_revision': 1})).json()
    assert first['submission_id'] == second['submission_id']
    response = await client.get(listing, headers=b.auth)
    assert response.headers['Cache-Control'] == 'no-store'
    assert (await response.json())['submissions'][0]['id'] == first['submission_id']
    assert (await post(client, a, f'/api/user-sync/{group}/revoke', {'device_id': b.id})).status == 200
    assert (await client.get(path, headers=b.auth)).status == 403
    assert (await client.get(listing, headers=b.auth)).status == 403


async def test_invalid_mutation_and_unknown_fields_do_not_write(client, hub):
    phone = await pair_phone(client, hub)
    group = (await (await post(client, phone, '/api/user-sync', {})).json())['group_id']
    path = f'/api/user-sync/{group}/records/draft/conversation'
    for data in ([], {'changes': {}}, {'operation_id': 'wrong', 'base_revision': 0,
                'changes': {'text': {'value': 'missing flag'}}, 'extra': True}):
        assert (await post(client, phone, path, data)).status == 400
    assert (await (await client.get(path, headers=phone.auth)).json())['revision'] == 0


def test_all_sync_routes_have_explicit_permission_policies():
    assert ROUTE_POLICY['h_user_sync_read'] == 'owner'
    for name in ('create', 'invite', 'join', 'revoke', 'write', 'submit'):
        assert ROUTE_POLICY[f'h_user_sync_{name}'] == 'owner_signed'
