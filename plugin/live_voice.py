"""Turn-based hands-free voice: sessions, signed speech files, dedupe and cancellation.

The app records one utterance at a time, the gateway transcribes it with the profile's own
speech-to-text, the transcript becomes a normal chat message, and the finished reply is voiced with
the profile's own text-to-speech. That is a deliberate, honest turn loop — not full-duplex audio.

This module owns the parts the app must be able to trust:

* a short-lived session bound to one device, one chat and one bot;
* idempotent transcription (a retried utterance is never transcribed twice);
* backpressure (one transcription and one synthesis at a time per session);
* signed, expiring audio URLs that die with their turn, so an interrupted reply cannot keep playing
  from a stale URL;
* bounded memory and files: nothing is replayed after reconnect and nothing lives forever.

No database tables: sessions are ephemeral by design. A restart means "open a new session", and the
app asks for a tap instead of quietly opening the microphone again.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import secrets
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from aiohttp import web

logger = logging.getLogger(__name__)

SESSION_TTL_SECONDS = 30 * 60
SESSION_MAX_SECONDS = 2 * 60 * 60
MAX_SESSIONS = 32
MAX_TURNS = 16
MAX_RESULTS = 48
MAX_SPEECH_FILES = 8
SPEECH_TTL_SECONDS = 5 * 60
MAX_TEXT = 2000
MAX_AUDIO_BYTES = 1_500_000
MAX_SPEECH_BYTES = 24 * 1024 * 1024
AUDIO_MIME_EXTENSIONS = {
    "audio/aac": ".aac", "audio/flac": ".flac", "audio/m4a": ".m4a", "audio/mp3": ".mp3",
    "audio/mp4": ".mp4", "audio/mpeg": ".mp3", "audio/ogg": ".ogg", "audio/opus": ".opus",
    "audio/wav": ".wav", "audio/wave": ".wav", "audio/webm": ".webm", "audio/x-m4a": ".m4a",
    "audio/x-wav": ".wav", "video/webm": ".webm",
}
SPEECH_MIME_BY_EXT = {
    ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".wav": "audio/wav",
    ".flac": "audio/flac", ".m4a": "audio/mp4", ".aac": "audio/aac",
}
_BUILTIN_MIME = {
    "application/octet-stream": ".m4a",
}


class VoiceError(Exception):
    """A request the voice bridge refuses, with the HTTP status the app should see."""

    def __init__(self, status: int, message: str, **extra: Any):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra


def _json(data: Dict[str, Any], status: int = 200) -> web.Response:
    return web.json_response(data, status=status, dumps=lambda o: json.dumps(o, separators=(",", ":")))


def _error(exc: VoiceError) -> web.Response:
    return _json({"error": exc.message, **exc.extra}, status=exc.status)


def _audio_extension(mime: str) -> str:
    normalized = (mime or "").split(";", 1)[0].strip().lower()
    return AUDIO_MIME_EXTENSIONS.get(normalized, _BUILTIN_MIME.get(normalized, ".webm"))


class VoiceSessions:
    """In-memory sessions. Every method is small and loop-safe: no I/O under the lock."""

    def __init__(self, directory: Path, secret: str, clock=time.time):
        self.directory = Path(directory)
        self._secret = secret.encode("utf-8")
        self._clock = clock
        self._sessions: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()

    # -- lifecycle ---------------------------------------------------------------------

    def open(self, device_id: str, chat_id: str, bot: Optional[str]) -> Dict[str, Any]:
        now = self._clock()
        self.sweep(now)
        while len(self._sessions) >= MAX_SESSIONS:
            oldest = next(iter(self._sessions))
            self.close(self._sessions[oldest])
        session = {
            "id": "vs_" + secrets.token_hex(10), "token": secrets.token_urlsafe(32),
            "device_id": device_id, "chat_id": chat_id, "bot": bot or None,
            "created": now, "expires": now + SESSION_TTL_SECONDS,
            "hard_expires": now + SESSION_MAX_SECONDS, "seq": 0, "busy": None, "synthesizing": False,
            "turns": OrderedDict(), "results": OrderedDict(), "speech": OrderedDict(),
        }
        self._sessions[session["id"]] = session
        return session

    def authorize(self, session_id: str, token: str, device_id: str, bot: Optional[str]) -> Dict[str, Any]:
        session = self._sessions.get(session_id or "")
        now = self._clock()
        if session is None or session["expires"] < now:
            if session is not None:
                self.close(session)
            raise VoiceError(404, "This voice session ended. Open live voice again.")
        if not token or not hmac.compare_digest(str(token), session["token"]):
            raise VoiceError(403, "This voice session belongs to another device.")
        if session["device_id"] != device_id:
            raise VoiceError(403, "This voice session belongs to another device.")
        if (session["bot"] or None) != (bot or None):
            # A session is scoped to the bot it was opened on; don't reveal another bot's session.
            raise VoiceError(404, "This voice session ended. Open live voice again.")
        session["expires"] = min(now + SESSION_TTL_SECONDS, session["hard_expires"])
        return session

    def close(self, session: Dict[str, Any]) -> None:
        for speech in list(session.get("speech", {}).values()):
            self._unlink(speech.get("path"))
        session.get("speech", {}).clear()
        self._sessions.pop(session.get("id", ""), None)

    def end(self, session: Dict[str, Any]) -> None:
        self.close(session)

    def sweep(self, now: Optional[float] = None) -> int:
        """Forget expired sessions and their files. Returns how many sessions went away."""
        now = self._clock() if now is None else now
        removed = 0
        for session in list(self._sessions.values()):
            for speech_id, speech in list(session["speech"].items()):
                if speech["expires"] <= now:
                    self._unlink(speech.get("path"))
                    session["speech"].pop(speech_id, None)
            if session["expires"] <= now:
                self.close(session)
                removed += 1
        return removed

    def stats(self) -> Dict[str, int]:
        return {"sessions": len(self._sessions),
                "speech_files": sum(len(s["speech"]) for s in self._sessions.values())}

    # -- turns -------------------------------------------------------------------------

    def turn(self, session: Dict[str, Any], turn_id: str, create: bool = True) -> Optional[Dict[str, Any]]:
        turn = session["turns"].get(turn_id)
        if turn is None and create:
            while len(session["turns"]) >= MAX_TURNS:
                old_id, old = session["turns"].popitem(last=False)
                for speech_id in list(old["speech"]):
                    self.revoke_speech(session, speech_id)
            turn = {"id": turn_id, "status": "open", "created": self._clock(), "speech": set()}
            session["turns"][turn_id] = turn
        if turn is not None:
            session["turns"].move_to_end(turn_id)
        return turn

    def cancelled(self, session: Dict[str, Any], turn_id: str) -> bool:
        turn = session["turns"].get(turn_id)
        return bool(turn and turn["status"] == "cancelled")

    def cancel(self, session: Dict[str, Any], turn_id: Optional[str] = None) -> Tuple[list, list]:
        """Cancel one turn (or every open turn), delete its audio and return what changed."""
        cancelled, revoked = [], []
        if turn_id:
            # Record the cancellation even if the audio or reply has not arrived yet: a late
            # transcription or synthesis for a stopped turn must be refused, not silently accepted.
            turns = [self.turn(session, turn_id)]
        else:
            turns = [t for t in session["turns"].values() if t["status"] == "open"]
        for turn in turns:
            if turn["status"] == "cancelled":
                continue
            turn["status"] = "cancelled"
            cancelled.append(turn["id"])
            for speech_id in list(turn["speech"]):
                if self.revoke_speech(session, speech_id):
                    revoked.append(speech_id)
        return cancelled, revoked

    def begin_transcription(self, session: Dict[str, Any], turn_id: str, utterance_id: str) -> Optional[Dict[str, Any]]:
        cached = session["results"].get((turn_id, utterance_id))
        if cached is not None:
            session["results"].move_to_end((turn_id, utterance_id))
            return cached
        self.turn(session, turn_id)
        if self.cancelled(session, turn_id):
            raise VoiceError(409, "That turn was interrupted.")
        if session["busy"]:
            raise VoiceError(429, "Still transcribing the last thing you said.", retry_after_ms=800)
        session["busy"] = utterance_id
        return None

    def complete_transcription(self, session: Dict[str, Any], result: Dict[str, Any]) -> Dict[str, Any]:
        session["busy"] = None
        key = (result["turn_id"], result["utterance_id"])
        session["results"][key] = result
        session["results"].move_to_end(key)
        while len(session["results"]) > MAX_RESULTS:
            session["results"].popitem(last=False)
        session["seq"] += 1
        result = {**result, "seq": session["seq"]}
        session["results"][key] = result
        return result

    def release_transcription(self, session: Dict[str, Any]) -> None:
        session["busy"] = None

    # -- speech ------------------------------------------------------------------------

    def claim_synthesis(self, session: Dict[str, Any]) -> None:
        """One synthesis at a time: four chunks of a long reply are spoken in order, not raced."""
        if session["synthesizing"]:
            raise VoiceError(429, "Still speaking the last part of the reply.", retry_after_ms=600)
        session["synthesizing"] = True

    def release_synthesis(self, session: Dict[str, Any]) -> None:
        session["synthesizing"] = False

    def store_speech(self, session: Dict[str, Any], turn_id: str, data: bytes, mime: str,
                     provider: str, message_id: str) -> Dict[str, Any]:
        turn = self.turn(session, turn_id)
        if turn is None or turn["status"] == "cancelled":
            raise VoiceError(409, "That turn was interrupted.")
        if len(data) > MAX_SPEECH_BYTES:
            raise VoiceError(413, "That reply is too large to speak.")
        self.directory.mkdir(parents=True, exist_ok=True)
        speech_id = "sp_" + secrets.token_hex(8)
        ext = next((e for e, m in SPEECH_MIME_BY_EXT.items() if m == mime), ".mp3")
        path = self.directory / f"{speech_id}{ext}"
        path.write_bytes(data)
        expires = self._clock() + SPEECH_TTL_SECONDS
        session["speech"][speech_id] = {
            "id": speech_id, "path": str(path), "mime": mime, "turn_id": turn_id,
            "message_id": message_id, "expires": expires,
        }
        turn["speech"].add(speech_id)
        while len(session["speech"]) > MAX_SPEECH_FILES:
            oldest, _ = next(iter(session["speech"].items()))
            self.revoke_speech(session, oldest)
        return {"speech_id": speech_id, "expires_at": expires,
                "url": f"/api/voice/audio/{speech_id}?exp={int(expires)}&sig={self.signature(speech_id, int(expires))}",
                "mime": mime, "provider": provider, "bytes": len(data)}

    def speech_path(self, speech_id: str, signature: str, exp: int) -> Tuple[str, str]:
        now = self._clock()
        if not exp or exp < now or not hmac.compare_digest(str(signature or ""), self.signature(speech_id, int(exp))):
            raise VoiceError(404, "That audio expired.")
        for session in self._sessions.values():
            speech = session["speech"].get(speech_id)
            if speech is None:
                continue
            turn = session["turns"].get(speech["turn_id"])
            if session["expires"] < now or turn is None or turn["status"] == "cancelled" or speech["expires"] < now:
                self.revoke_speech(session, speech_id)
                raise VoiceError(404, "That audio expired.")
            path = Path(speech["path"])
            if not path.is_file():
                raise VoiceError(404, "That audio expired.")
            return str(path), speech["mime"]
        raise VoiceError(404, "That audio expired.")

    def revoke_speech(self, session: Dict[str, Any], speech_id: str) -> bool:
        speech = session["speech"].pop(speech_id, None)
        if speech is None:
            return False
        turn = session["turns"].get(speech["turn_id"])
        if turn:
            turn["speech"].discard(speech_id)
        self._unlink(speech.get("path"))
        return True

    def signature(self, speech_id: str, exp: int) -> str:
        return hmac.new(self._secret, f"{speech_id}:{int(exp)}".encode(), hashlib.sha256).hexdigest()[:32]

    @staticmethod
    def _unlink(path: Optional[str]) -> None:
        if not path:
            return
        try:
            os.unlink(path)
        except OSError:
            pass


class VoiceBridge:
    """HTTP handlers for the voice session API. Hermes lives behind ``hub.speech``."""

    def __init__(self, hub: Any):
        self.hub = hub
        self.sessions = VoiceSessions(Path(hub.store.path).parent / "voice",
                                      hub.store.secret("voice_key"))

    @property
    def available(self) -> bool:
        speech = getattr(self.hub, "speech", None)
        try:
            return bool(speech is not None and speech.available())
        except Exception:
            logger.debug("[winglet] speech availability check failed", exc_info=True)
            return False

    def status(self) -> Dict[str, Any]:
        if not self.available:
            return {}
        try:
            return dict(self.hub.speech.status() or {})
        except Exception:
            logger.debug("[winglet] speech status failed", exc_info=True)
            return {}

    def sweep(self) -> None:
        self.sessions.sweep()

    def _speech(self) -> Any:
        if not self.available:
            raise VoiceError(503, "Speech isn't available on this server yet.")
        return self.hub.speech

    def _session(self, request: web.Request, body: Dict[str, Any]) -> Dict[str, Any]:
        device = self.hub._require(request)
        bot = self.hub.bot_name()
        session_id = str(body.get("session_id") or request.match_info.get("session_id") or "")
        session = self.sessions.authorize(session_id, str(body.get("token") or ""),
                                          device["id"], bot)
        chat = self.hub.store.get_chat(session["chat_id"])
        if chat is None or not self.hub.can_see(device, chat):
            self.sessions.close(session)
            raise VoiceError(404, "This chat is no longer available.")
        return session

    async def _body(self, request: web.Request) -> Dict[str, Any]:
        try:
            body = await request.json()
        except Exception:
            raise VoiceError(400, "invalid JSON")
        if not isinstance(body, dict):
            raise VoiceError(400, "expected a JSON object")
        return body

    # -- routes ------------------------------------------------------------------------

    async def h_voice_session(self, request: web.Request) -> web.Response:
        try:
            self._speech()
            device = self.hub._require(request)
            body = await self._body(request)
            chat_id = str(body.get("chat_id") or "")
            chat = self.hub.store.get_chat(chat_id)
            if chat is None or not self.hub.can_see(device, chat):
                raise VoiceError(404, "This chat is no longer available.")
            session = self.sessions.open(device["id"], chat_id, self.hub.bot_name())
            status = self.status()
            stt = dict(status.get("stt") or {})
            tts = dict(status.get("tts") or {})
            return _json({
                "session_id": session["id"], "token": session["token"],
                "expires_at": session["expires"], "ttl_seconds": SESSION_TTL_SECONDS,
                "chat_id": chat_id, "turn_based": True, "live": False,
                "stt": {"provider": str(stt.get("provider") or ""), "available": True},
                "tts": {"provider": str(tts.get("provider") or ""), "available": True},
            })
        except VoiceError as exc:
            return _error(exc)

    async def h_voice_transcribe(self, request: web.Request) -> web.Response:
        audio_path: Optional[str] = None
        session: Optional[Dict[str, Any]] = None
        try:
            self._speech()
            fields, data, mime = await self._read_audio(request)
            device = self.hub._require(request)
            bot = self.hub.bot_name()
            session = self.sessions.authorize(fields.get("session_id", ""), fields.get("token", ""),
                                              device["id"], bot)
            chat = self.hub.store.get_chat(session["chat_id"])
            if chat is None or not self.hub.can_see(device, chat):
                raise VoiceError(404, "This chat is no longer available.")
            turn_id = fields.get("turn_id", "").strip()
            utterance_id = fields.get("utterance_id", "").strip()
            if not turn_id or not utterance_id:
                raise VoiceError(400, "turn_id and utterance_id are required.")
            if len(turn_id) > 80 or len(utterance_id) > 80:
                raise VoiceError(400, "invalid turn id")
            cached = self.sessions.begin_transcription(session, turn_id, utterance_id)
            if cached is not None:
                return _json({**cached, "duplicate": True})
            if not data:
                raise VoiceError(400, "The recording is empty.")
            if len(data) > MAX_AUDIO_BYTES:
                raise VoiceError(413, "That recording is too long.")
            if not mime.startswith("audio/") and mime != "video/webm":
                raise VoiceError(400, "Send an audio recording.")
            self.sessions._unlink(audio_path)
            audio_path = await self._write_temp(data, mime)
            result = await self._speech().transcribe(audio_path, mime)
            transcript = str(result.get("text") or "").strip()
            no_speech = bool(result.get("no_speech")) or not transcript
            payload = {
                "turn_id": turn_id, "utterance_id": utterance_id, "transcript": transcript,
                "provider": str(result.get("provider") or ""), "final": True,
                "no_speech": no_speech, "duplicate": False,
                "duration_ms": min(120_000, max(0, int(fields.get("duration_ms") or 0))),
            }
            return _json(self.sessions.complete_transcription(session, payload))
        except VoiceError as exc:
            if session is not None:
                self.sessions.release_transcription(session)
            return _error(exc)
        except ValueError as exc:
            if session is not None:
                self.sessions.release_transcription(session)
            return _json({"error": str(exc) or "Transcription failed."}, status=400)
        except Exception:
            if session is not None:
                self.sessions.release_transcription(session)
            logger.warning("[winglet] voice transcription failed", exc_info=True)
            return _json({"error": "Transcription failed. Try again."}, status=502)
        finally:
            self.sessions._unlink(audio_path)

    async def h_voice_speak(self, request: web.Request) -> web.Response:
        session: Optional[Dict[str, Any]] = None
        try:
            self._speech()
            body = await self._body(request)
            session = self._session(request, body)
            text = str(body.get("text") or "").strip()
            turn_id = str(body.get("turn_id") or "").strip()
            message_id = str(body.get("message_id") or "").strip()
            if not text:
                raise VoiceError(400, "Text is required.")
            if len(text) > MAX_TEXT:
                raise VoiceError(413, f"Speak at most {MAX_TEXT} characters at a time.")
            if not turn_id:
                raise VoiceError(400, "turn_id is required.")
            turn = self.sessions.turn(session, turn_id)
            if turn is not None and turn["status"] == "cancelled":
                raise VoiceError(409, "That turn was interrupted.")
            self.sessions.claim_synthesis(session)
            audio, mime, provider = await self._speech().speak(text)
            if not audio:
                raise VoiceError(502, "Speech synthesis returned no audio.")
            stored = self.sessions.store_speech(session, turn_id, audio, mime, provider, message_id)
            return _json(stored)
        except VoiceError as exc:
            return _error(exc)
        except ValueError as exc:
            return _json({"error": str(exc) or "Speech synthesis failed."}, status=400)
        except TimeoutError:
            return _json({"error": "Speech synthesis timed out."}, status=504)
        except Exception:
            logger.warning("[winglet] voice synthesis failed", exc_info=True)
            return _json({"error": "Speech synthesis failed. Try again."}, status=502)
        finally:
            if session is not None:
                self.sessions.release_synthesis(session)

    async def h_voice_stop(self, request: web.Request) -> web.Response:
        try:
            body = await self._body(request)
            session = self._session(request, body)
            turn_id = str(body.get("turn_id") or "").strip() or None
            cancelled, revoked = self.sessions.cancel(session, turn_id)
            return _json({"stopped": True, "turn_id": turn_id or "",
                          "cancelled_turns": cancelled, "revoked_audio": revoked,
                          "already": not cancelled and not revoked})
        except VoiceError as exc:
            return _error(exc)

    async def h_voice_end(self, request: web.Request) -> web.Response:
        try:
            body = await self._body(request)
            session = self._session(request, body)
            self.sessions.end(session)
            return _json({"ended": True})
        except VoiceError as exc:
            return _error(exc)

    async def h_voice_audio(self, request: web.Request) -> web.StreamResponse:
        try:
            exp = int(request.query.get("exp") or 0)
            path, mime = self.sessions.speech_path(request.match_info["speech_id"],
                                                  request.query.get("sig", ""), exp)
        except (ValueError, VoiceError):
            return _json({"error": "not found"}, status=404)
        return web.FileResponse(path, headers={
            "Cache-Control": "private, max-age=60",
            "Content-Type": mime,
            "Content-Disposition": "inline",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "X-Content-Type-Options": "nosniff",
        })

    # -- helpers -----------------------------------------------------------------------

    async def _read_audio(self, request: web.Request) -> Tuple[Dict[str, str], bytes, str]:
        if not request.content_type.startswith("multipart/"):
            raise VoiceError(400, "Send multipart form data.")
        reader = await request.multipart()
        fields: Dict[str, str] = {}
        data, mime = b"", ""
        while True:
            part = await reader.next()
            if part is None:
                break
            if part.name == "audio":
                mime = (part.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
                data = await part.read(decode=True)
            else:
                if part.name in fields:
                    continue
                # Fields are small ids; cap each so a hostile client can't grow memory with text.
                raw = await part.read(decode=True)
                fields[part.name] = raw[:2000].decode("utf-8", "replace").strip()
        return fields, data, mime

    async def _write_temp(self, data: bytes, mime: str) -> str:
        import asyncio
        import tempfile

        directory = self.sessions.directory
        await asyncio.to_thread(directory.mkdir, parents=True, exist_ok=True)
        suffix = _audio_extension(mime)

        def write() -> str:
            fd, path = tempfile.mkstemp(prefix="voice-upload-", suffix=suffix, dir=str(directory))
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
            return path

        return await asyncio.to_thread(write)
