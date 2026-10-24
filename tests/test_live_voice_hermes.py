"""Test actual Hermes speech wrappers with disposable providers, without network or personal profiles."""
import contextlib
import wave

import pytest


async def test_real_hermes_speech_wrappers_and_cleanup(monkeypatch, tmp_path):
    stt = pytest.importorskip("tools.transcription_tools")
    tts = pytest.importorskip("tools.tts_tool")
    pytest.importorskip("tools.voice_mode")
    from plugin import hermes_api

    monkeypatch.setattr(hermes_api, "_profile_scope", contextlib.nullcontext)
    monkeypatch.setattr(stt, "_load_stt_config", lambda: {"provider": "local"})
    monkeypatch.setattr(stt, "_detect_local_backend", lambda: "local")
    import tools.tool_backend_helpers as selections
    monkeypatch.setattr(selections, "read_selection", lambda *args, **kwargs: "local")
    monkeypatch.setattr(tts, "_load_tts_config", lambda: {"provider": "edge"})
    monkeypatch.setattr(stt, "transcribe_audio", lambda path, **kwargs:
                        {"success": True, "transcript": "A deterministic spoken question", "provider": "local"})
    backend = hermes_api.SpeechBackend()
    assert backend.available()
    assert backend.status()["stt"]["provider"] == "local"
    assert backend.status()["tts"]["provider"] == "edge"
    result = await backend.transcribe(str(tmp_path / "recording.wav"), "audio/wav")
    assert result["text"] == "A deterministic spoken question"

    destination = tmp_path / "synthesized.wav"
    monkeypatch.setattr(tts, "_resolve_output_base", lambda *args, **kwargs: (destination, None))
    def synthesize(chunks, base_path, artifacts, **kwargs):
        with wave.open(str(destination), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(b"\0\0" * 1600)
        artifacts.add(str(destination))
        return [str(destination)], [{"provider": "edge", "voice_compatible": False}]
    monkeypatch.setattr(tts, "_synthesize_chunks", synthesize)
    audio, mime, provider = await backend.speak("A deterministic spoken answer.")
    assert audio.startswith(b"RIFF") and mime == "audio/wav" and provider == "edge"
    assert not destination.exists()


async def test_real_hermes_filtered_silence_is_success(monkeypatch, tmp_path):
    stt = pytest.importorskip("tools.transcription_tools")
    pytest.importorskip("tools.voice_mode")
    from plugin import hermes_api

    monkeypatch.setattr(hermes_api, "_profile_scope", contextlib.nullcontext)
    monkeypatch.setattr(stt, "transcribe_audio", lambda *args, **kwargs:
                        {"success": False, "transcript": "", "no_speech": True})
    result = await hermes_api.SpeechBackend().transcribe(str(tmp_path / "quiet.wav"), "audio/wav")
    assert result["no_speech"] is True and result["text"] == ""
