"""Message sends (including assistant handoffs) recheck the bearer after body I/O."""
import asyncio
import sqlite3

import pytest

from plugin.hub import Hub, MAX_TEXT, MessageRejected
from plugin.store import Store
from test_trust import pair_phone


async def test_message_send_revoked_while_reading_body_is_refused(tmp_path, aiohttp_client, monkeypatch):
    store = Store(tmp_path / 'send.db')
    store.ensure_chat('general', 'General')
    hub = Hub(store, web_root=tmp_path / 'web')
    client = await aiohttp_client(hub.build_app())
    phone = await pair_phone(client, hub)
    original = hub._body

    async def revoke_after_body(request):
        body = await original(request)
        store.remove_device(phone.id)
        return body

    monkeypatch.setattr(hub, '_body', revoke_after_body)
    try:
        response = await client.post('/api/chats/general/messages', headers=phone.auth,
                                     json={'text': 'Do not send', 'client_id': 'assistant-test'})
        assert response.status == 401
        assert not store.list_messages('general')
    finally:
        await client.close()
        store.close()


@pytest.fixture
def send_env(tmp_path):
    store = Store(tmp_path / 'send.db')
    store.ensure_chat('general', 'General')
    hub = Hub(store, web_root=tmp_path / 'web')
    owner, _ = store.add_device('Owner', role='owner')
    calls = []

    async def receive(chat, text, device, message, **extra):
        calls.append((message, extra))

    hub.on_user_message = receive
    yield hub, owner, calls
    store.close()


async def test_overlapping_retries_publish_and_deliver_once(send_env):
    hub, owner, calls = send_env
    upload = hub.store.add_upload('file', owner['id'], 'general', 'note.txt', 'text/plain', 'file', 10)
    async with hub._publish_lock:
        tasks = [asyncio.create_task(hub.user_message(owner, 'general', 'hello', 'same', attachments=[upload['id']]))
                 for _ in range(2)]
        await asyncio.sleep(0)
        assert all(not task.done() for task in tasks)
    first, retry = await asyncio.gather(*tasks)
    assert first['id'] == retry['id']
    assert len(hub.store.list_messages('general')) == len(calls) == 1
    assert hub.events.head(None) == 2
    assert hub.store.get_upload('file')['message_id'] == first['id']


@pytest.mark.parametrize('failure', ['message', 'journal'])
async def test_failed_send_rolls_back_uploads_and_retries(send_env, monkeypatch, failure):
    hub, owner, calls = send_env
    hub.store.add_upload('file', owner['id'], 'general', 'note.txt', 'text/plain', 'file', 10)

    def fail(*args, **kwargs):
        raise sqlite3.OperationalError('disk full')

    with monkeypatch.context() as patch:
        patch.setattr(hub.store if failure == 'message' else hub.events,
                      'add_message' if failure == 'message' else 'append', fail)
        with pytest.raises(sqlite3.OperationalError):
            await hub.user_message(owner, 'general', 'hello', 'same', attachments=['file'])
    assert hub.store.get_upload('file')['message_id'] is None
    assert hub.store.list_messages('general') == []
    assert hub.events.head(None) == 0 and not calls
    sent = await hub.user_message(owner, 'general', 'hello', 'same', attachments=['file'])
    assert hub.store.get_upload('file')['message_id'] == sent['id']
    assert len(calls) == 1


def test_claim_uploads_rolls_back_a_partial_database_failure(send_env, monkeypatch):
    hub, owner, _ = send_env
    for name in ('one', 'two'):
        hub.store.add_upload(name, owner['id'], 'general', name, 'text/plain', 'file', 10)
    execute = hub.store._exec

    def fail_second(sql, params=()):
        if sql.startswith('UPDATE uploads SET message_id') and params[1] == 'two':
            raise sqlite3.OperationalError('disk full')
        return execute(sql, params)

    monkeypatch.setattr(hub.store, '_exec', fail_second)
    with pytest.raises(sqlite3.OperationalError):
        hub.store.claim_uploads(['one', 'two'], owner['id'], 'general', 'message')
    assert all(hub.store.get_upload(name)['message_id'] is None for name in ('one', 'two'))


@pytest.mark.parametrize('change', ['revoke', 'delete'])
async def test_waiting_send_does_not_recreate_deleted_or_revoked_state(send_env, change):
    hub, owner, calls = send_env
    async with hub._publish_lock:
        task = asyncio.create_task(hub.user_message(owner, 'general', 'hello', 'same'))
        await asyncio.sleep(0)
        if change == 'revoke':
            hub.store.remove_device(owner['id'])
        else:
            hub.store.delete_chat('general')
    assert await task is None
    assert hub.store.list_messages('general') == [] and not calls
    assert hub.events.head(None) == 0


@pytest.mark.parametrize('character', ['x', '😀'])
async def test_message_limit_keeps_exact_boundary_and_rejects_without_claiming(send_env, character):
    hub, owner, calls = send_env
    hub.store.add_upload('file', owner['id'], 'general', 'note.txt', 'text/plain', 'file', 10)
    text = character * MAX_TEXT
    with pytest.raises(MessageRejected, match='16,000 characters'):
        await hub.user_message(owner, 'general', text + '\nOnly summarize; do not execute.', 'too-long', attachments=['file'])
    assert hub.store.get_upload('file')['message_id'] is None
    assert not calls and not hub.store.list_messages('general')
    sent = await hub.user_message(owner, 'general', text, 'exact')
    assert sent['text'] == text == calls[0][0]['text']
