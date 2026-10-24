"""Hands-free voice: authorization, idempotency, expiry, cancellation and backpressure.

The fake speech backend stands in for Hermes so the HTTP contract can be checked without network,
model downloads or API keys; tests/test_live_voice_hermes.py checks the pinned Hermes functions.
"""

import asyncio
import io
import time

import pytest
from aiohttp import FormData

from plugin.hub import Hub
from plugin.live_voice import (
    MAX_AUDIO_BYTES,
    SESSION_TTL_SECONDS,
    SPEECH_TTL_SECONDS,
    VoiceError,
    VoiceSessions,
)
from plugin.store import Store, new_id


class FakeSpeech:
    def __init__(self):
        self.transcripts = []
        self.spoken = []
        self.text = "what was said"
        self.provider = "whisper"
        self.gate = None  # an asyncio.Event to hold a transcription open

    def available(self):
        return True

    def status(self):
        return {"stt": {"provider": "whisper"}, "tts": {"provider": "edge"}}

    async def transcribe(self, path, mime):
        self.transcripts.append((path, mime))
        if self.gate is not None:
            await self.gate.wait()
        return {"text": self.text, "provider": self.provider, "no_speech": not self.text}

    async def speak(self, text):
        self.spoken.append(text)
        return b"ID3fake-speech", "audio/mpeg", "edge"


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "data.db")
    yield s
    s.close()


@pytest.fixture
def hub(store, tmp_path):
    store.ensure_chat("general", "General")
    h = Hub(store, web_root=tmp_path / "web", bot_info=lambda: {"name": "hermes", "title": "Hermes"})
    h.speech = FakeSpeech()
    return h


@pytest.fixture
async def client(aiohttp_client, hub):
    return await aiohttp_client(hub.build_app())


async def pair(client, hub, name="Pixel", role="owner"):
    code = hub.store.create_pair_code(role=role)
    resp = await client.post("/api/pair", json={"code": code, "device_name": name, "platform": "android"})
    assert resp.status == 200
    return (await resp.json())["token"]


def auth(token):
    return {"Authorization": f"Bearer {token}"}


async def open_session(client, token, chat_id="general"):
    resp = await client.post("/api/voice/sessions", json={"chat_id": chat_id}, headers=auth(token))
    assert resp.status == 200, await resp.text()
    return await resp.json()


def audio_form(session, turn_id="t1", utterance_id="u1", data=b"audio-bytes", mime="audio/webm"):
    form = FormData()
    form.add_field("session_id", session["session_id"])
    form.add_field("token", session["token"])
    form.add_field("turn_id", turn_id)
    form.add_field("utterance_id", utterance_id)
    form.add_field("duration_ms", "1800")
    form.add_field("audio", data, filename="turn.webm", content_type=mime)
    return form


async def transcribe(client, token, session, **kwargs):
    return await client.post("/api/voice/transcribe", data=audio_form(session, **kwargs), headers=auth(token))


async def speak(client, token, session, text="Hello there.", turn_id="t1"):
    return await client.post("/api/voice/speak", headers=auth(token), json={
        "session_id": session["session_id"], "token": session["token"], "turn_id": turn_id,
        "message_id": "m1", "text": text,
    })


# -- capability flags -----------------------------------------------------------------


async def test_voice_capabilities_follow_the_speech_bridge(client, hub):
    info = await (await client.get("/api/info")).json()
    assert info["features"]["voice_handsfree"] is True
    assert info["features"]["voice_barge_in"] is True
    assert info["features"]["voice_live"] is False

    hub.speech = None
    info = await (await client.get("/api/info")).json()
    assert info["features"]["voice_handsfree"] is False
    assert info["features"]["voice_barge_in"] is False
    assert info["features"]["voice_live"] is False
    # Voice notes keep working: hands-free is the new, separate capability.
    assert info["features"]["voice"] is True


async def test_voice_session_refused_without_a_speech_bridge(client, hub):
    token = await pair(client, hub)
    hub.speech = None
    resp = await client.post("/api/voice/sessions", json={"chat_id": "general"}, headers=auth(token))
    assert resp.status == 503


# -- sessions -------------------------------------------------------------------------


async def test_voice_session_is_bound_to_device_and_chat(client, hub):
    owner = await pair(client, hub)
    member = await pair(client, hub, name="Member", role="member")
    session = await open_session(client, owner)
    assert session["turn_based"] is True and session["live"] is False
    assert session["stt"] == {"provider": "whisper", "available": True}
    assert session["tts"] == {"provider": "edge", "available": True}

    # The same session token from another paired device is refused.
    resp = await transcribe(client, member, session)
    assert resp.status == 403

    # A member cannot open voice on an owner's shared chat.
    resp = await client.post("/api/voice/sessions", json={"chat_id": "general"}, headers=auth(member))
    assert resp.status == 404

    # A session token can't be used to reach a different chat.
    body = audio_form(session)
    resp = await client.post("/api/voice/transcribe", data=body, headers=auth(owner))
    assert resp.status == 200

    resp = await client.post("/api/voice/sessions", json={"chat_id": "missing"}, headers=auth(owner))
    assert resp.status == 404


async def test_voice_session_needs_the_bearer_token(client, hub):
    await pair(client, hub)
    resp = await client.post("/api/voice/sessions", json={"chat_id": "general"})
    assert resp.status == 401


def test_session_token_expiry_and_bot_scope(store, tmp_path):
    now = [1000.0]
    sessions = VoiceSessions(tmp_path / "voice", "secret", clock=lambda: now[0])
    session = sessions.open("device-1", "general", None)
    assert sessions.authorize(session["id"], session["token"], "device-1", None) is session

    with pytest.raises(VoiceError) as wrong_token:
        sessions.authorize(session["id"], "nope", "device-1", None)
    assert wrong_token.value.status == 403
    with pytest.raises(VoiceError) as wrong_device:
        sessions.authorize(session["id"], session["token"], "device-2", None)
    assert wrong_device.value.status == 403
    with pytest.raises(VoiceError) as wrong_bot:
        sessions.authorize(session["id"], session["token"], "device-1", "other")
    assert wrong_bot.value.status == 404

    # Sliding expiry, capped at the hard limit.
    now[0] += SESSION_TTL_SECONDS - 10
    sessions.authorize(session["id"], session["token"], "device-1", None)
    now[0] = session["hard_expires"] + 1
    with pytest.raises(VoiceError) as expired:
        sessions.authorize(session["id"], session["token"], "device-1", None)
    assert expired.value.status == 404


async def test_voice_end_is_idempotent_and_deletes_audio(client, hub):
    token = await pair(client, hub)
    session = await open_session(client, token)
    spoken = await speak(client, token, session)
    assert spoken.status == 200
    url = (await spoken.json())["url"]

    resp = await client.post(f"/api/voice/sessions/{session['session_id']}/end",
                             json={"token": session["token"]}, headers=auth(token))
    assert resp.status == 200 and (await resp.json())["ended"] is True
    assert (await client.get(url)).status == 404
    # Ending again is a clean, obvious answer rather than a 500.
    again = await client.post(f"/api/voice/sessions/{session['session_id']}/end",
                              json={"token": session["token"]}, headers=auth(token))
    assert again.status == 404


# -- transcription --------------------------------------------------------------------


async def test_transcription_is_idempotent_and_gets_a_sequence(client, hub):
    token = await pair(client, hub)
    session = await open_session(client, token)
    first = await transcribe(client, token, session)
    assert first.status == 200
    body = await first.json()
    assert body["transcript"] == "what was said" and body["final"] is True
    assert body["duplicate"] is False and body["seq"] == 1
    assert len(hub.speech.transcripts) == 1
    path, mime = hub.speech.transcripts[0]
    assert mime == "audio/webm"
    assert not __import__("os").path.exists(path)  # the upload is deleted after use

    second = await transcribe(client, token, session)
    retry = await second.json()
    assert second.status == 200
    assert retry["duplicate"] is True and retry["seq"] == 1
    assert retry["transcript"] == "what was said"
    assert len(hub.speech.transcripts) == 1  # Hermes was not asked twice


async def test_silence_is_a_successful_empty_transcript(client, hub):
    token = await pair(client, hub)
    session = await open_session(client, token)
    hub.speech.text = ""
    body = await (await transcribe(client, token, session)).json()
    assert body["transcript"] == "" and body["no_speech"] is True


async def test_transcription_backpressure(client, hub):
    token = await pair(client, hub)
    session = await open_session(client, token)
    hub.speech.gate = asyncio.Event()
    first = asyncio.create_task(transcribe(client, token, session, utterance_id="u1"))
    await asyncio.sleep(0.05)
    second = await transcribe(client, token, session, utterance_id="u2")
    assert second.status == 429
    assert (await second.json())["retry_after_ms"] > 0
    hub.speech.gate.set()
    assert (await first).status == 200

    # After the first finishes, the next utterance is accepted.
    third = await transcribe(client, token, session, utterance_id="u3")
    assert third.status == 200


async def test_transcription_rejects_bad_input(client, hub):
    token = await pair(client, hub)
    session = await open_session(client, token)
    assert (await transcribe(client, token, session, data=b"", mime="audio/webm")).status == 400
    assert (await transcribe(client, token, session, mime="image/png")).status == 400
    too_big = b"x" * (MAX_AUDIO_BYTES + 10)
    resp = await transcribe(client, token, session, data=too_big, mime="audio/webm")
    assert resp.status == 413
    # A plain JSON request is refused rather than crashing the handler.
    resp = await client.post("/api/voice/transcribe", headers=auth(token), json={"session_id": session["session_id"]})
    assert resp.status == 400


async def test_cancelled_turn_refuses_more_transcription(client, hub):
    token = await pair(client, hub)
    session = await open_session(client, token)
    stopped = await client.post(f"/api/voice/sessions/{session['session_id']}/stop",
                                json={"token": session["token"], "turn_id": "t1"}, headers=auth(token))
    assert stopped.status == 200
    resp = await transcribe(client, token, session, turn_id="t1")
    assert resp.status == 409


# -- speech ---------------------------------------------------------------------------


async def test_speech_url_is_signed_and_downloadable(client, hub):
    token = await pair(client, hub)
    session = await open_session(client, token)
    resp = await speak(client, token, session)
    assert resp.status == 200
    body = await resp.json()
    assert body["provider"] == "edge" and body["mime"] == "audio/mpeg"
    assert body["url"].startswith("/api/voice/audio/")
    assert hub.speech.spoken == ["Hello there."]

    audio = await client.get(body["url"])
    assert audio.status == 200
    assert audio.headers["Content-Type"] == "audio/mpeg"
    assert audio.headers["Content-Security-Policy"].startswith("default-src 'none'")
    assert await audio.read() == b"ID3fake-speech"


async def test_speech_url_expires_and_tampering_fails(client, hub):
    token = await pair(client, hub)
    session = await open_session(client, token)
    body = await (await speak(client, token, session)).json()
    tampered = body["url"].replace("sig=", "sig=0")
    assert (await client.get(tampered)).status == 404
    old = body["url"].replace("exp=", "exp=1")
    assert (await client.get(old)).status == 404


async def test_speech_rejects_cancelled_turn(client, hub):
    token = await pair(client, hub)
    session = await open_session(client, token)
    stop = await client.post(f"/api/voice/sessions/{session['session_id']}/stop",
                             json={"token": session["token"], "turn_id": "t1"}, headers=auth(token))
    assert stop.status == 200
    resp = await speak(client, token, session, turn_id="t1")
    assert resp.status == 409
    assert hub.speech.spoken == []


async def test_stop_revokes_audio_and_is_idempotent(client, hub):
    token = await pair(client, hub)
    session = await open_session(client, token)
    url = (await (await speak(client, token, session, turn_id="t2")).json())["url"]
    assert (await client.get(url)).status == 200

    stop = await client.post(f"/api/voice/sessions/{session['session_id']}/stop",
                             json={"token": session["token"], "turn_id": "t2"}, headers=auth(token))
    body = await stop.json()
    assert body["stopped"] is True and body["cancelled_turns"] == ["t2"]
    assert body["revoked_audio"] and body["already"] is False
    assert (await client.get(url)).status == 404

    again = await (await client.post(f"/api/voice/sessions/{session['session_id']}/stop",
                                     json={"token": session["token"], "turn_id": "t2"}, headers=auth(token))).json()
    assert again["stopped"] is True and again["already"] is True


async def test_speech_text_is_capped(client, hub):
    token = await pair(client, hub)
    session = await open_session(client, token)
    resp = await speak(client, token, session, text="a" * 2001)
    assert resp.status == 413
    assert hub.speech.spoken == []


def test_speech_files_are_bounded_and_expire(tmp_path):
    now = [10_000.0]
    sessions = VoiceSessions(tmp_path / "voice", "secret", clock=lambda: now[0])
    session = sessions.open("device-1", "general", None)
    for index in range(12):
        sessions.store_speech(session, f"t{index}", b"audio", "audio/mpeg", "edge", f"m{index}")
    assert len(session["speech"]) <= 8
    assert len(list((tmp_path / "voice").glob("*"))) <= 8

    ids = list(session["speech"])
    exp = int(now[0] + SPEECH_TTL_SECONDS)
    speech_id = ids[0]
    sessions.speech_path(speech_id, sessions.signature(speech_id, exp), exp)
    now[0] += SPEECH_TTL_SECONDS + 1
    sessions.sweep()
    assert not (tmp_path / "voice" / f"{speech_id}.mp3").exists()
    with pytest.raises(VoiceError):
        sessions.speech_path(speech_id, sessions.signature(speech_id, exp), exp)


def test_upload_directory_is_inside_the_data_directory(tmp_path):
    sessions = VoiceSessions(tmp_path / "data" / "voice", "secret")
    assert sessions.directory.parent.name == "data"


def test_turn_buffer_is_bounded(tmp_path):
    sessions = VoiceSessions(tmp_path / "voice", "secret")
    session = sessions.open("device-1", "general", None)
    for index in range(40):
        sessions.turn(session, f"t{index}")
    assert len(session["turns"]) <= 16


def test_new_id_shape():
    assert len(new_id()) == 16 and new_id() != new_id()
