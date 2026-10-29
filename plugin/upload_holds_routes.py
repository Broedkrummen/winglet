"""Explicitly retain uploads while a device's durable outbox may still need them."""
from aiohttp import web

from .branching_routes import _chat_for
from .user_sync import SyncError, _identifier


async def _hold(request, release=False):
    hub, device, chat = _chat_for(request)
    try:
        body = await request.json()
        allowed = ({'hold_id'}, {'hold_id', 'source_device'}, {'hold_id', 'upload_id', 'expected_version'}) if release else ({'hold_id', 'upload_ids'}, {'hold_id', 'upload_ids', 'allow_message_backed'})
        if not isinstance(body, dict) or set(body) not in allowed:
            raise SyncError('Invalid upload retention request.')
        hold_id = _identifier(body['hold_id'])
        message_backed = []
        with hub.store.transaction():
            # Body streaming may outlive a chat's visibility or bot scope.
            hub, device, chat = _chat_for(request)
            if release:
                if 'expected_version' in body:
                    upload = _identifier(body['upload_id'])
                    version = _identifier(body['expected_version'])
                    if not hub.store.release_upload_version(device['id'], chat['id'], upload, hold_id, version):
                        raise SyncError('This file retention changed. Refresh and review it again before releasing.', 409)
                elif 'source_device' in body:
                    source = _identifier(body['source_device'])
                    if not hub.store.release_orphan_uploads(device['id'], source, chat['id'], hold_id):
                        raise SyncError('Only a current owner can release a removed device\'s retained files.', 409)
                else:
                    raise SyncError('Refresh retained files and review the current version before releasing. Update this client if needed.', 409)
            else:
                ids = body['upload_ids']
                if not isinstance(ids, list) or not 1 <= len(ids) <= 20:
                    raise SyncError('Expected 1 to 20 upload IDs.')
                for upload_id in ids:
                    _identifier(upload_id)
                if 'allow_message_backed' in body:
                    if body['allow_message_backed'] is not True:
                        raise SyncError('Invalid message-backed source request.')
                    actor = hub.store.get_device(device['id'])
                    rows = [hub.store.get_upload(upload_id) for upload_id in ids]
                    if not actor or actor['role'] != 'owner' or any(row is None or row['device_id'] != actor['id'] or row['chat_id'] != chat['id'] for row in rows):
                        raise SyncError('This source upload is no longer available to this pairing.', 409)
                    message_backed = [row['id'] for row in rows if row['message_id'] is not None]
                    for row in rows:
                        if row['message_id'] is not None:
                            message = hub.store.get_message(row['message_id'])
                            if not message or message['chat_id'] != chat['id']:
                                raise SyncError('The message backing this saved source is unavailable.', 409)
                    ids = [upload_id for upload_id in ids if upload_id not in message_backed]
                if ids and not hub.store.hold_uploads(ids, device['id'], chat['id'], hold_id):
                    raise SyncError('An upload expired, belongs to another device, or is held by another message. Upload it again.', 409)
        return web.json_response({'retained': not release, **({'message_backed': message_backed} if message_backed else {})}, headers={'Cache-Control': 'no-store'})
    except (ValueError, TypeError) as exc:
        return web.json_response({'error': str(exc) if isinstance(exc, SyncError) else 'Invalid upload retention request.'},
                                 status=exc.status if isinstance(exc, SyncError) else 400)


async def h_upload_hold(request): return await _hold(request)
async def h_upload_release(request): return await _hold(request, True)


async def h_orphan_uploads(request):
    hub = request.app['hub']
    device = hub._require(request)
    after = request.query.get('after', '')
    if len(after) > 160:
        return web.json_response({'error': 'Invalid retained-file cursor.'}, status=400)
    scope = request.query.get('scope', 'removed')
    if scope not in ('removed', 'current'):
        return web.json_response({'error': 'Invalid retained-file scope.'}, status=400)
    rows = hub.store.own_upload_holds(device['id'], hub.bot_name() or '', after) if scope == 'current' else hub.store.orphan_upload_holds(hub.bot_name() or '', after)
    return web.json_response({'files': [{'upload': hub._upload_public(row), 'chat_id': row['chat_id'],
        'source_device': row['device_id'], 'hold_id': row['hold_id'], **({'version': row['version']} if scope == 'current' else {})} for row in rows[:100]],
        'next': rows[99]['id'] if len(rows) > 100 else None, 'scope': scope}, headers={'Cache-Control': 'no-store'})


def register_routes(app):
    app.router.add_post('/api/chats/{chat_id}/uploads/hold', h_upload_hold)
    app.router.add_delete('/api/chats/{chat_id}/uploads/hold', h_upload_release)
    app.router.add_get('/api/uploads/retained', h_orphan_uploads)
