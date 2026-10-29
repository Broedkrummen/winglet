"""Saved answer snapshots remain behind the source conversation's current ACL."""
from __future__ import annotations

import hashlib
import re
import time

from aiohttp import web


def _json(value, status=200):
    return web.json_response(value, status=status, headers={'Cache-Control': 'no-store'})


def digest(message):
    return hashlib.sha256(message['text'].encode('utf-8')).hexdigest()


def _chat(request):
    hub = request.app['hub']
    device = hub._device(request)
    if not device:
        raise web.HTTPUnauthorized()
    _, problem = hub._requested_bot(request, device)
    if problem is not None:
        raise web.HTTPForbidden()
    chat_id = request.match_info['chat_id']
    hub._visible_chat(device, chat_id)
    if not hub._in_bot(chat_id):
        raise web.HTTPNotFound()
    return hub, chat_id


def _message(hub, chat_id, message_id):
    message = hub.store.get_message(message_id)
    if not message or message['chat_id'] != chat_id:
        return None
    if message['role'] not in ('user', 'bot') or message['status'] != 'final' or message['meta'].get('hidden'):
        raise web.HTTPNotFound()
    return message


def _identifier(request):
    value = request.match_info['bookmark_id']
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,160}', value):
        raise web.HTTPBadRequest(text='Invalid saved answer identifier.')
    return value


async def h_bookmark_source(request):
    hub, chat_id = _chat(request)
    message = _message(hub, chat_id, request.match_info['message_id'])
    if not message:
        return _json({'state': 'deleted'})
    return _json({'state': 'available', 'sha256': digest(message), 'message': message})


async def h_bookmark_snapshot_save(request):
    try:
        body = await request.json()
    except (ValueError, UnicodeError):
        raise web.HTTPBadRequest(text='Expected a saved answer source.')
    if not isinstance(body, dict) or set(body) != {'message_id', 'expected_sha256'} \
            or not isinstance(body['message_id'], str) or not 1 <= len(body['message_id']) <= 160 \
            or not isinstance(body['expected_sha256'], str) or not re.fullmatch(r'[a-f0-9]{64}', body['expected_sha256']):
        raise web.HTTPBadRequest(text='Expected a message and its exact source hash.')
    bookmark_id = _identifier(request)
    hub = request.app['hub']
    with hub.store.transaction():
        hub, chat_id = _chat(request)
        prior = hub.store._one('SELECT * FROM bookmark_snapshots WHERE id = ?', (bookmark_id,))
        if prior:
            if prior['chat_id'] != chat_id or prior['message_id'] != body['message_id'] or prior['sha256'] != body['expected_sha256']:
                raise web.HTTPConflict(text='This saved answer identifier already has a different source.')
            _message(hub, chat_id, prior['message_id'])
            return _json({'snapshot': dict(prior)})
        message = _message(hub, chat_id, body['message_id'])
        if not message:
            raise web.HTTPNotFound()
        if digest(message) != body['expected_sha256']:
            raise web.HTTPConflict(text='The answer changed. Review its current text before saving a snapshot.')
        count = hub.store._one('SELECT COUNT(*) AS n FROM bookmark_snapshots')['n']
        if count >= 10000:
            raise web.HTTPRequestEntityTooLarge(max_size=10000, actual_size=count + 1,
                                                text='Saved answer storage is full. Remove unused snapshots first.')
        text = message['text'][:8192]
        hub.store._exec('INSERT INTO bookmark_snapshots VALUES (?,?,?,?,?,?,?,?)',
                        (bookmark_id, chat_id, message['id'], body['expected_sha256'], message['role'], text,
                         int(len(text) < len(message['text'])), time.time()))
        saved = hub.store._one('SELECT * FROM bookmark_snapshots WHERE id = ?', (bookmark_id,))
    return _json({'snapshot': dict(saved)}, status=201)


async def h_bookmark_snapshot_read(request):
    hub, chat_id = _chat(request)
    saved = hub.store._one('SELECT * FROM bookmark_snapshots WHERE id = ? AND chat_id = ?', (_identifier(request), chat_id))
    if not saved:
        raise web.HTTPNotFound()
    message = _message(hub, chat_id, saved['message_id'])
    state = 'deleted' if not message else 'available' if digest(message) == saved['sha256'] else 'edited'
    return _json({'state': state, 'snapshot': dict(saved)})


async def h_bookmark_snapshot_delete(request):
    hub, chat_id = _chat(request)
    hub.store._exec('DELETE FROM bookmark_snapshots WHERE id = ? AND chat_id = ?', (_identifier(request), chat_id))
    return _json({'deleted': True})


def register_routes(app):
    app.router.add_get('/api/chats/{chat_id}/bookmark-source/{message_id}', h_bookmark_source)
    path = '/api/chats/{chat_id}/bookmark-snapshots/{bookmark_id}'
    app.router.add_put(path, h_bookmark_snapshot_save)
    app.router.add_get(path, h_bookmark_snapshot_read)
    app.router.add_delete(path, h_bookmark_snapshot_delete)
