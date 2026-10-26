"""Message sends (including assistant handoffs) recheck the bearer after body I/O."""
from plugin.hub import Hub
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
