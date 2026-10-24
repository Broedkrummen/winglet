"""Opt-in, single-phone reads. All pending state/results are memory-only.

Inspired by Herald PhoneToolsBridge/PhoneTool (MIT); see the feature notice.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import math
import secrets
import time
from dataclasses import dataclass

CATALOG = {
    "phone_status": {"title": "Device status", "description": "Battery, connection, sound mode and Android version.", "fields": "Battery percentage, charging, network type, metered, Do Not Disturb, model, Android version", "sensitive": False},
    "phone_shared_note": {"title": "Shared note", "description": "Only the note you write here for your agent.", "fields": "Your note, up to 2000 characters", "sensitive": False},
    "phone_location": {"title": "Location on request", "description": "A fresh location while Winglet is open. Precise location always asks.", "fields": "Latitude, longitude, horizontal accuracy; approximate by default", "sensitive": True},
    "phone_contacts": {"title": "Contact lookup", "description": "Find up to five people matching a specific query.", "fields": "Name, up to three phone numbers and three email addresses", "sensitive": True},
    "phone_calendar": {"title": "Calendar events", "description": "Read up to 50 events within a range of at most 31 days.", "fields": "Title, start, end, all-day, calendar name", "sensitive": True},
}
ERRORS = {"denied", "permission", "expired", "cancelled", "locked", "offline", "revoked", "unavailable", "invalid_result", "busy", "scope", "restart", "native_error"}


def arguments(tool, args):
    if tool not in CATALOG or not isinstance(args, dict):
        raise ValueError("Unknown phone tool or invalid arguments")
    keys = {"phone_location": {"precise"}, "phone_contacts": {"query"}, "phone_calendar": {"start_ms", "end_ms"}}.get(tool, set())
    if set(args) - keys:
        raise ValueError("Unsupported phone tool arguments")
    if tool == "phone_location":
        if "precise" in args and type(args["precise"]) is not bool:
            raise ValueError("precise must be boolean")
        return {"precise": args.get("precise", False)}
    if tool == "phone_contacts":
        q = args.get("query")
        if not isinstance(q, str) or not 2 <= len(q.strip()) <= 80:
            raise ValueError("A specific contact query of 2–80 characters is required")
        return {"query": q.strip()}
    if tool == "phone_calendar":
        a, b = args.get("start_ms"), args.get("end_ms")
        if type(a) is not int or type(b) is not int or not 0 <= a < b <= 4102444800000 or b-a > 31*86400000:
            raise ValueError("Calendar timestamps must be UTC milliseconds, at most 31 days apart")
        return {"start_ms": a, "end_ms": b}
    return {}


def _text(value, limit):
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError("Invalid text result")
    return value


def _number(value, low, high):
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError("Invalid number result")
    return value


def result(tool, data, args):
    """Allowlist fields twice (Android also caps them); never forward extra native data."""
    if not isinstance(data, dict) or len(json.dumps(data, allow_nan=False).encode()) > 40000:
        raise ValueError("Invalid result")
    if tool == "phone_shared_note":
        return {"note": _text(data.get("note"), 2000)}
    if tool == "phone_status":
        network = data.get("network")
        if network not in ("wifi", "mobile", "other", "offline") or any(type(data.get(k)) is not bool for k in ("charging", "metered", "dnd")):
            raise ValueError("Invalid status")
        return {"battery": _number(data.get("battery"), -1, 100), "charging": data["charging"], "network": network,
                "metered": data["metered"], "dnd": data["dnd"], "model": _text(data.get("model"), 120), "android": _text(data.get("android"), 40)}
    if tool == "phone_location":
        lat, lon = _number(data.get("latitude"), -90, 90), _number(data.get("longitude"), -180, 180)
        accuracy = _number(data.get("accuracy"), 0, 100000)
        if not args.get("precise"):
            lat, lon, accuracy = round(lat, 2), round(lon, 2), max(accuracy, 1500)
        return {"latitude": lat, "longitude": lon, "accuracy": accuracy, "precise": args.get("precise", False)}
    if tool == "phone_contacts":
        rows = data.get("contacts")
        if not isinstance(rows, list) or len(rows) > 5:
            raise ValueError("Contact limit exceeded")
        out = []
        for row in rows:
            if not isinstance(row, dict):
                raise ValueError("Invalid contact")
            item = {"name": _text(row.get("name"), 200)}
            for key in ("phones", "emails"):
                values = row.get(key)
                if not isinstance(values, list) or len(values) > 3:
                    raise ValueError("Contact field limit exceeded")
                item[key] = [_text(v, 254) for v in values]
            out.append(item)
        return {"contacts": out}
    rows = data.get("events")
    if not isinstance(rows, list) or len(rows) > 50:
        raise ValueError("Event limit exceeded")
    out = []
    for row in rows:
        if not isinstance(row, dict) or type(row.get("all_day")) is not bool:
            raise ValueError("Invalid event")
        a, b = _number(row.get("start_ms"), 0, 4102444800000), _number(row.get("end_ms"), 0, 4102444800000)
        if a >= b or a >= args["end_ms"] or b <= args["start_ms"]:
            raise ValueError("Event outside requested range")
        out.append({"title": _text(row.get("title"), 300), "calendar": _text(row.get("calendar"), 200), "start_ms": a, "end_ms": b, "all_day": row["all_day"]})
    return {"events": out}


@dataclass
class Pending:
    id: str
    nonce: str
    device_id: str
    bot: str
    chat_id: str
    role: str
    tool: str
    args: dict
    ws: object
    expires: float
    future: asyncio.Future
    mode: str
    executing: bool = False


class PhoneTools:
    def __init__(self, hub, timeout=120):
        self.hub, self.store, self.timeout = hub, hub.store, timeout
        self.pending = {}
        self.instances = {}
        self.loop = asyncio.get_running_loop()

    def grants(self, device_id):
        return [dict(r) for r in self.store._all("SELECT tool,scope,mode,enabled FROM phone_tool_grants WHERE device_id=?", (device_id,))]

    def grant(self, device_id, tool, bot):
        return next((g for g in self.grants(device_id) if g["tool"] == tool and g["enabled"] and g["scope"] in (bot, "*")), None)

    async def update(self, device, bot, body):
        tool, mode, scope, enabled = body.get("tool"), body.get("mode", "ask"), body.get("scope", "bot"), body.get("enabled")
        if tool not in CATALOG or mode not in ("ask", "while_open") or scope not in ("bot", "server") or type(enabled) is not bool:
            raise ValueError("Invalid phone tool grant")
        if device.get("platform") != "android" or (scope == "server" and device["role"] != "owner"):
            raise PermissionError("This scope is unavailable for this device")
        # One explicit scope per tool; changing it cancels the old request first.
        await self.cancel_device(device["id"], "revoked", tool)
        self.store._exec("INSERT INTO phone_tool_grants(device_id,tool,scope,mode,enabled,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(device_id,tool) DO UPDATE SET scope=excluded.scope,mode=excluded.mode,enabled=excluded.enabled,updated_at=excluded.updated_at", (device["id"], tool, "*" if scope == "server" else bot, mode, int(enabled), time.time()))
        self.audit(device["id"], bot, "", tool, "enabled" if enabled else "revoked")
        await self.changed(device["id"])

    async def changed(self, device_id):
        for ws, meta in list(self.hub._sockets.items()):
            if meta["device"]["id"] == device_id and not ws.closed:
                try:
                    await ws.send_json({"type": "phone_tool.grants_changed"})
                except (ConnectionError, RuntimeError):
                    pass

    async def revoke(self, device_id):
        await self.cancel_device(device_id, "revoked")
        self.store._exec("DELETE FROM phone_tool_grants WHERE device_id=?", (device_id,))
        self.audit(device_id, "", "", "all", "revoked")
        await self.changed(device_id)

    def history(self, device_id, bot):
        return [dict(r) for r in self.store._all("SELECT ts,tool,event FROM phone_tool_events WHERE device_id=? AND bot=? ORDER BY id DESC LIMIT 20", (device_id, bot))]

    def audit(self, device_id, bot, chat, tool, event):
        # Only enum outcomes; never request args, exceptions or result payloads.
        self.store._exec("INSERT INTO phone_tool_events(ts,device_id,bot,chat_id,tool,event) VALUES(?,?,?,?,?,?)", (time.time(), device_id, bot, chat, tool, event))
        self.store._exec("DELETE FROM phone_tool_events WHERE ts<? OR id NOT IN (SELECT id FROM phone_tool_events ORDER BY id DESC LIMIT 5000)", (time.time()-30*86400,))

    def _current(self, p):
        d, c = self.store.get_device(p.device_id), self.store.get_chat(p.chat_id)
        meta = self.hub._sockets.get(p.ws, {})
        g = self.grant(p.device_id, p.tool, p.bot)
        return bool(d and d.get("platform") == "android" and d["role"] == p.role and c and self.hub.can_see(d,c)
                    and (c.get("bot") or "") == p.bot and g and (g["scope"] != "*" or d["role"] == "owner") and g["mode"] == p.mode
                    and not p.ws.closed and meta.get("phone_ready") and meta.get("visible") is True and meta.get("phone_unlocked") is True
                    and (meta.get("bot") or "") == p.bot and time.time() < p.expires)

    async def request(self, device_id, chat_id, bot, tool, args):
        args = arguments(tool, args)
        d, c = self.store.get_device(device_id), self.store.get_chat(chat_id)
        if not d or not c or not self.hub.can_see(d,c) or (c.get("bot") or "") != bot:
            return {"error": "scope"}
        g = self.grant(device_id, tool, bot)
        if not g or (g["scope"] == "*" and d["role"] != "owner"):
            return {"error": "revoked"}
        candidates = [(ws,m) for ws,m in self.hub._sockets.items() if m["device"]["id"] == device_id and (m.get("bot") or "") == bot and m.get("phone_ready") and m.get("visible") is True and m.get("phone_unlocked") is True and not ws.closed]
        if not candidates or d.get("platform") != "android":
            self.audit(device_id, bot, chat_id, tool, "offline")
            return {"error": "offline"}
        if sum(p.device_id == device_id for p in self.pending.values()) >= 4:
            return {"error": "busy"}
        ws, _ = candidates[-1]  # Exactly one socket. Never broadcast private requests.
        ask = g["mode"] == "ask" or bool(args.get("precise"))
        ttl = min(self.timeout, 120 if ask else 20)
        p = Pending(secrets.token_hex(16), secrets.token_hex(24), device_id, bot, chat_id, d["role"], tool, args, ws, time.time()+ttl, self.loop.create_future(), g["mode"])
        self.pending[p.id] = p
        try:
            with self.hub._bot_context(bot or None):
                context = self.hub.bot()
            await ws.send_json({"type": "phone_tool.request", "request": {"id": p.id, "nonce": p.nonce, "tool": tool, "args": args, "ask": ask, "mode": p.mode, "requested_at": time.time(), "expires_at": p.expires, "bot": context, "chat": {"id": chat_id, "title": c["title"]}}})
            self.audit(device_id, bot, chat_id, tool, "requested")
            return await asyncio.wait_for(asyncio.shield(p.future), ttl)
        except asyncio.TimeoutError:
            await self.finish(p, {"error": "expired"})
            return {"error": "expired"}
        except asyncio.CancelledError:
            await self.finish(p, {"error": "cancelled"})
            raise
        except (ConnectionError, RuntimeError):
            await self.finish(p, {"error": "offline"})
            return {"error": "offline"}
        finally:
            self.pending.pop(p.id, None)

    async def finish(self, p, answer):
        if self.pending.pop(p.id, None) is not p:
            return
        self.audit(p.device_id, p.bot, p.chat_id, p.tool, answer.get("error", "allowed"))
        if not p.future.done():
            p.future.set_result(answer)
        if "error" in answer and not p.ws.closed:
            try:
                await p.ws.send_json({"type": "phone_tool.cancel", "id": p.id, "reason": answer["error"]})
            except (ConnectionError, RuntimeError):
                pass

    async def cancel_device(self, device_id, reason, tool=None):
        for p in list(self.pending.values()):
            if p.device_id == device_id and (tool is None or p.tool == tool):
                await self.finish(p, {"error": reason})

    async def socket_closed(self, ws):
        for p in list(self.pending.values()):
            if p.ws is ws:
                await self.finish(p, {"error": "offline"})

    async def event(self, ws, device, bot, data):
        kind, meta = data.get("type"), self.hub._sockets[ws]
        if kind == "phone_tools.hello":
            instance = data.get("instance_id")
            if not isinstance(instance, str) or not 16 <= len(instance) <= 80 or device.get("platform") != "android":
                return
            if self.instances.get(device["id"], instance) != instance:
                await self.cancel_device(device["id"], "restart")
            self.instances[device["id"]] = instance
            meta.update(phone_instance=instance, phone_ready=True, phone_unlocked=data.get("unlocked") is True)
            if not meta["phone_unlocked"]:
                await self.cancel_device(device["id"], "locked")
            return
        p = self.pending.get(data.get("id")) if isinstance(data.get("id"), str) else None
        if not p or p.ws is not ws or p.device_id != device["id"] or p.bot != bot or not isinstance(data.get("nonce"), str) or not hmac.compare_digest(p.nonce, data["nonce"]):
            return  # Wrong socket, replay or untrusted id cannot settle a request.
        if not self._current(p):
            await self.finish(p, {"error": "revoked" if time.time() < p.expires else "expired"})
            return
        if kind == "phone_tool.decision" and not p.executing:
            if data.get("allow") is not True:
                await self.finish(p, {"error": "denied"})
            else:
                p.executing = True
                await ws.send_json({"type": "phone_tool.execute", "id": p.id, "nonce": p.nonce})
        elif kind == "phone_tool.answer" and p.executing:
            try:
                answer = {"result": result(p.tool, data.get("result"), p.args)} if data.get("ok") is True else {"error": data.get("error") if data.get("error") in ERRORS else "native_error"}
            except (ValueError, TypeError, OverflowError):
                answer = {"error": "invalid_result"}
            await self.finish(p, answer)
