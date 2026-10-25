"""Owner-scoped context reads; signed, revision-bound compression actions."""
from aiohttp import web
from .branching import BranchRefused
from .branching_routes import _chat_for


async def _call(request,action):
    hub,device,chat=_chat_for(request)
    service=hub.context_insights
    if service is None:return web.json_response({'error':'Context insights are unavailable.'},status=409)
    try:
        if action=='inspect':data=await service.inspect(device,chat)
        elif action=='limits':data=await service.limits(device,chat)
        elif action=='operation':data=service.operation(device,chat,request.match_info['operation_id'])
        else:
            body=await request.json()
            if not isinstance(body,dict):raise BranchRefused('invalid','Expected a JSON object.',400)
            data=await service.start(device,chat,body)
        return web.json_response(data,status=202 if data.get('status')=='running' else 200)
    except BranchRefused as exc:return web.json_response({'error':exc.reason,'code':exc.code},status=exc.status)
    except (ValueError,TypeError):return web.json_response({'error':'Invalid context request.'},status=400)
    except Exception:return web.json_response({'error':'Context telemetry could not be read. Try refreshing.'},status=502)


async def h_context_insights(request):return await _call(request,'inspect')
async def h_context_limits(request):return await _call(request,'limits')
async def h_context_compress(request):return await _call(request,'compress')
async def h_context_operation(request):return await _call(request,'operation')


def register_routes(app):
    app.router.add_get('/api/context/chats/{chat_id}',h_context_insights)
    app.router.add_get('/api/context/chats/{chat_id}/limits',h_context_limits)
    app.router.add_post('/api/context/chats/{chat_id}/compress',h_context_compress)
    app.router.add_get('/api/context/chats/{chat_id}/operations/{operation_id}',h_context_operation)
