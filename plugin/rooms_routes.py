"""Paired scoped reads and signed room controls; no generic RPC proxy."""
import asyncio
import logging
from aiohttp import web
from .rooms import RoomError

logger=logging.getLogger(__name__)


async def _run(request, kind):
    hub=request.app['hub']
    device=hub._require(request)
    if hub.rooms is None:
        return web.json_response({'error':'Rooms are unavailable on this Hermes.'},status=409)
    room_id=request.match_info.get('room_id','')
    try:
        if kind=='list':
            result=await asyncio.to_thread(hub.rooms.listing,device)
        elif kind=='state':
            result=await asyncio.to_thread(hub.rooms.state,device,room_id)
        elif kind=='log':
            result=await asyncio.to_thread(hub.rooms.log,device,room_id,
                None if request.query.get('tail')=='1' else request.query.get('epoch','0'),request.query.get('after','0'))
        else:
            try: body=await request.json()
            except Exception: raise RoomError('Expected a JSON object.',400)
            if not isinstance(body,dict): raise RoomError('Expected a JSON object.',400)
            action='create' if kind=='create' else request.match_info['action']
            result=await asyncio.to_thread(hub.rooms.mutate,device,action,room_id,body)
        return web.json_response(result)
    except RoomError as exc:
        return web.json_response({'error':str(exc)},status=exc.status)
    except ValueError as exc:
        return web.json_response({'error':str(exc)},status=409)
    except Exception:
        logger.exception('[winglet] room %s failed',kind)
        return web.json_response({'error':'Could not complete the room operation. Reload to check its state.'},status=502)


async def h_rooms(request): return await _run(request,'list')
async def h_room_create(request): return await _run(request,'create')
async def h_room_state(request): return await _run(request,'state')
async def h_room_log(request): return await _run(request,'log')
async def h_room_action(request): return await _run(request,'action')


def register_routes(app):
    app.router.add_get('/api/rooms',h_rooms)
    app.router.add_post('/api/rooms',h_room_create)
    app.router.add_get('/api/rooms/{room_id}',h_room_state)
    app.router.add_get('/api/rooms/{room_id}/log',h_room_log)
    app.router.add_post('/api/rooms/{room_id}/{action}',h_room_action)
