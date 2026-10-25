"""Disposable hands-free voice preview. Never connects to Hermes, speech providers or personal data.

Run: python -m scripts.preview_live_voice
Pair at http://127.0.0.1:8307 using the printed fixture code and http://127.0.0.1:9307.
Delete only the chosen --data-dir after stopping this process to discard the synthetic pairing.
"""
import argparse
import asyncio
import io
from pathlib import Path
import wave

from aiohttp import web
from plugin.hub import Hub
from plugin.store import Store


class FixtureSpeech:
    def available(self):
        return True

    def status(self):
        return {"stt": {"provider": "Fixture STT"}, "tts": {"provider": "Fixture TTS"}}

    async def transcribe(self, path, mime):
        await asyncio.sleep(0.1)
        return {"text": "Explain how this hands-free conversation works.", "provider": "Fixture STT"}

    async def speak(self, text):
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(16000)
            audio.writeframes(b"\0\0" * 24000)
        return buffer.getvalue(), "audio/wav", "Fixture TTS"


async def run():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, default=Path(".pytest_cache/voice-preview"))
    parser.add_argument("--web-root", type=Path, default=Path("app/dist"))
    args = parser.parse_args()
    args.data_dir.mkdir(parents=True, exist_ok=True)
    store = Store(args.data_dir / "fixture.db")
    store.ensure_chat("general", "Voice fixture")
    hub = Hub(store, web_root=args.web_root, bot_info=lambda: {"name": "voice-fixture", "title": "Winglet voice preview", "description": "Synthetic local QA only"})
    hub.speech = FixtureSpeech()
    tasks = {}
    async def respond(chat, text, device, message, **kwargs):
        chat_id = chat["id"]
        if text == "/stop":
            task = tasks.pop(chat_id, None)
            if task:
                task.cancel()
            await hub.set_typing(chat_id, False)
            return
        async def reply():
            try:
                await asyncio.sleep(2)
                await hub.post_message(chat_id, "You speak, then pause. Winglet sends your words to this chat, reads the final reply, and listens again. Interrupt stops the voice immediately. This preview uses synthetic local speech.")
            finally:
                await hub.set_typing(chat_id, False)
        await hub.set_typing(chat_id, True)
        tasks[chat_id] = asyncio.create_task(reply())
    hub.on_user_message = respond
    app = hub.build_app()
    runner = web.AppRunner(app)
    await runner.setup()
    for port in (8307, 9307):
        await web.TCPSite(runner, "127.0.0.1", port).start()
    print("Fixture pairing code:", store.create_pair_code(), flush=True)
    print("UI http://127.0.0.1:8307 | API http://127.0.0.1:9307 | synthetic data only", flush=True)
    try:
        await asyncio.Event().wait()
    finally:
        for task in tasks.values():
            task.cancel()
        await runner.cleanup()
        store.close()


if __name__ == "__main__":
    asyncio.run(run())
