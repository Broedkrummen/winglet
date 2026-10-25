"""Owner-only read routes; existing signed Schedule endpoints own every mutation."""
import asyncio
from aiohttp import web


def register_routes(app, hub):
    from .hub import ROUTE_POLICY, _BOT
    ROUTE_POLICY.update({'h_routine_history_index': 'owner', 'h_routine_history': 'owner', 'h_routine_run': 'owner'})

    async def refresh(routine_id=None):
        return await hub._sync_routine_history(routine_id)

    async def h_routine_history_index(request):
        hub._require(request)
        await refresh()
        hub._routine_history_actor(request)
        return web.json_response({'archived': hub.routine_history.archived(_BOT.get())})

    async def h_routine_history(request):
        hub._require(request)
        routine_id = request.match_info['routine_id']
        stale = False
        try: await refresh(routine_id)
        except Exception:
            # Existing observations stay readable during an upstream storage outage.
            stale = True
        hub._routine_history_actor(request)
        try:
            page = hub.routine_history.page(_BOT.get(), routine_id, limit=int(request.query.get('limit', 30)), cursor=request.query.get('cursor'))
        except (ValueError, TypeError):
            return web.json_response({'error': 'Invalid history page or cursor.'}, status=400)
        if page is None:
            return web.json_response({'error': 'Routine history is temporarily unavailable.' if stale else 'No retained evidence for this routine.'}, status=503 if stale else 404)
        return web.json_response({**page, 'stale': stale})

    async def h_routine_run(request):
        hub._require(request)
        routine_id, run_id = request.match_info['routine_id'], request.match_info['run_id']
        stale = False
        try: await refresh(routine_id)
        except Exception: stale = True
        hub._routine_history_actor(request)
        run = hub.routine_history.detail(_BOT.get(), routine_id, run_id)
        if run is None:
            return web.json_response({'error': 'No retained evidence for this run.'}, status=404)
        return web.json_response({'run': run, 'stale': stale})

    app.router.add_get('/api/routine-history', h_routine_history_index)
    app.router.add_get('/api/routine-history/{routine_id}', h_routine_history)
    app.router.add_get('/api/routine-history/{routine_id}/run/{run_id}', h_routine_run)
