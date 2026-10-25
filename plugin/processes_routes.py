"""Owner-only background process routes on the usual bot-scoped transports."""
import json
import logging
from aiohttp import web
from .processes import ProcessRefused

logger = logging.getLogger(__name__)


def _context(request):
    hub = request.app["hub"]
    device = hub._require(request)
    chat = hub._visible_chat(device, request.match_info["chat_id"])
    if not hub._in_bot(chat["id"]):
        raise web.HTTPNotFound()
    if hub.processes is None:
        raise ProcessRefused("unsupported", "This server can't report background processes.")
    return hub, device, chat


async def _run(request, action):
    try:
        hub, device, chat = _context(request)
        if action == "list":
            answer = await hub.processes.listing(chat)
        elif action == "detail":
            answer = await hub.processes.detail(chat, request.match_info["handle"], request.query.get("cursor"))
        else:
            try:
                body = await request.json()
            except Exception:
                raise ProcessRefused("invalid", "Expected a JSON object.", 400)
            if not isinstance(body, dict):
                raise ProcessRefused("invalid", "Expected a JSON object.", 400)
            answer = await hub.processes.stop(chat, request.match_info["handle"], body.get("operation_id"))
            hub.store.add_audit("process.stop", device=device, summary=f"Stop requested in {chat['id']}",
                                outcome=answer["status"])
        return web.json_response(answer, status=202 if answer.get("status") == "stopping" else 200)
    except ProcessRefused as exc:
        return web.json_response({"error": exc.message, "code": exc.code}, status=exc.status)
    except web.HTTPException:
        raise
    except Exception:
        logger.exception("[winglet] process %s failed", action)
        return web.json_response({"error": "Couldn't read the process state. Refresh and try again.", "code": "unavailable"}, status=502)


async def h_process_list(request):
    return await _run(request, "list")


async def h_process_detail(request):
    return await _run(request, "detail")


async def h_process_stop(request):
    return await _run(request, "stop")


def register_routes(app):
    app.router.add_get("/api/processes/chats/{chat_id}", h_process_list)
    app.router.add_get("/api/processes/chats/{chat_id}/{handle}", h_process_detail)
    app.router.add_post("/api/processes/chats/{chat_id}/{handle}/stop", h_process_stop)
