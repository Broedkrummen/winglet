"""Every private blob request rechecks explicit sync-group membership."""
import asyncio

from aiohttp import web

from .user_sync import SyncError
from .branching_routes import _chat_for


async def h_sync_blob_put(request):
    hub = request.app['hub']
    device = hub._require(request)['id']
    try:
        data = await request.read()
        blob = await asyncio.to_thread(hub.sync_blobs.put, request.match_info['group_id'], device,
            request.match_info['digest'], request.query.get('name', 'file'), data, request.query.get('voice') == '1')
        return web.json_response({'blob': blob}, headers={'Cache-Control': 'no-store'})
    except SyncError as exc:
        return web.json_response({'error': str(exc)}, status=exc.status, headers={'Cache-Control': 'no-store'})


async def h_sync_blob_get(request):
    hub = request.app['hub']
    device = hub._require(request)['id']
    try:
        _blob, file_path = await asyncio.to_thread(hub.sync_blobs.get,
            request.match_info['group_id'], device, request.match_info['blob_id'])
        return web.FileResponse(file_path, headers={'Cache-Control': 'no-store', 'Content-Type': 'application/octet-stream',
            'Content-Disposition': 'attachment', 'X-Content-Type-Options': 'nosniff', "Content-Security-Policy": "default-src 'none'; sandbox"})
    except SyncError as exc:
        return web.json_response({'error': str(exc)}, status=exc.status, headers={'Cache-Control': 'no-store'})


async def h_sync_materialize(request):
    hub, device, chat = _chat_for(request)
    try:
        from .sync_materialize import materialize
        upload = await asyncio.to_thread(materialize, hub, device, chat, request.match_info['source_id'],
            request.query.get('slot', ''), request.query.get('sha256', ''), request.query.get('name', 'file'),
            await request.read(), request.query.get('voice') == '1')
        return web.json_response({'upload': upload}, headers={'Cache-Control': 'no-store'})
    except SyncError as exc:
        return web.json_response({'error': str(exc)}, status=exc.status, headers={'Cache-Control': 'no-store'})


def register_routes(app):
    app.router.add_put('/api/user-sync/{group_id}/blobs/{digest}', h_sync_blob_put)
    app.router.add_get('/api/user-sync/{group_id}/blobs/{blob_id}', h_sync_blob_get)
    app.router.add_put('/api/chats/{chat_id}/staged-files/{source_id}', h_sync_materialize)
