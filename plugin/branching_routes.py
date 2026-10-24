"""HTTP routes for conversation branching. Kept apart so hub.py only wires them in."""

from __future__ import annotations

import json
import logging

from aiohttp import web

from .branching import BranchRefused

logger = logging.getLogger(__name__)


def _json(data, status: int = 200) -> web.Response:
    return web.json_response(data, status=status,
                            dumps=lambda o: json.dumps(o, separators=(",", ":")))


def _error(status: int, message: str, code: str = "", **extra) -> web.Response:
    return _json({"error": message, **({"code": code} if code else {}), **extra}, status=status)


def _hub(request: web.Request):
    return request.app["hub"]


def _chat_for(request: web.Request):
    hub = _hub(request)
    device = hub._require(request)
    chat_id = request.match_info["chat_id"]
    chat = hub._visible_chat(device, chat_id)
    # The policy middleware has already checked the requested bot; a chat id from another bot
    # must not be branchable through this scope.
    if callable(getattr(hub, "_in_bot", None)) and not hub._in_bot(chat_id):
        raise web.HTTPNotFound(text=json.dumps({"error": "This chat was deleted."}),
                               content_type="application/json")
    return hub, device, chat


async def _body(request: web.Request) -> dict:
    try:
        body = await request.json()
    except Exception:
        raise BranchRefused("unsupported", "Expected a JSON object.", 400)
    if not isinstance(body, dict):
        raise BranchRefused("unsupported", "Expected a JSON object.", 400)
    return body


async def h_branch_state(request: web.Request) -> web.Response:
    hub, device, chat = _chat_for(request)
    service = getattr(hub, "branching", None)
    if service is None:
        return _json({"supported": False, "reason": "This server can't branch conversations."})
    return _json(await service.state(device, chat["id"]))


async def h_branch_create(request: web.Request) -> web.Response:
    hub, device, chat = _chat_for(request)
    service = getattr(hub, "branching", None)
    if service is None:
        return _error(409, "This server can't branch conversations.", "unsupported")
    try:
        body = await _body(request)
        return _json(await service.branch(device, chat, body))
    except BranchRefused as exc:
        return _error(exc.status, exc.reason, exc.code)
    except Exception:
        logger.exception("[winglet] branch route failed")
        return _error(502, "The branch couldn't be created. Nothing in the original chat changed.", "unsupported")


async def h_branch_regenerate(request: web.Request) -> web.Response:
    hub, device, chat = _chat_for(request)
    service = getattr(hub, "branching", None)
    if service is None:
        return _error(409, "This server can't regenerate in place.", "unsupported")
    try:
        body = await _body(request)
        return _json(await service.regenerate(device, chat, body))
    except BranchRefused as exc:
        return _error(exc.status, exc.reason, exc.code)
    except Exception:
        logger.exception("[winglet] regenerate route failed")
        return _error(502, "Regeneration failed.", "unsupported")


def register_routes(app: web.Application) -> None:
    r = app.router
    r.add_get("/api/branching/chats/{chat_id}", h_branch_state)
    r.add_post("/api/branching/chats/{chat_id}/branch", h_branch_create)
    r.add_post("/api/branching/chats/{chat_id}/regenerate", h_branch_regenerate)
