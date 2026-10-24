# Assignment 07 — Hands-free voice, interruption and synchronized transcripts

Branch `codex/major-07-live-voice`, worktree `C:\Users\vikas\Documents\winglet-agents\07-live-voice`,
start commit `b71d93b459e1645e34cd47c80a392b146dca0e04`, PR target `codex/major-features`.

Primary specialist role: Mobile App Builder (architect → implement → review). No subagents.

## What this is — and what it is not

Winglet gets a **turn-based hands-free voice conversation** inside a chat:

1. You tap once to open the voice panel and once to start listening.
2. Winglet records one spoken turn, stops on silence (voice-activity detection), transcribes it,
   sends the transcript as a normal chat message, waits for the reply, speaks the finished reply,
   then listens again while the session stays open.
3. **Interrupt** (button, or Space on web) cancels the audio immediately, asks the server to cancel
   the turn, stops generation through the existing authoritative `/stop` path, and ignores every
   later word/audio belonging to the interrupted turn.

This is **not** full-duplex live audio, and no capability or UI copy claims it is. There is no
simultaneous listening-while-speaking, no acoustic barge-in, no always-on microphone and no
background recording. The server advertises:

| capability | meaning | value |
| --- | --- | --- |
| `voice_handsfree` | The turn-based loop exists and the server has a real speech bridge (Hermes STT + TTS). | true only when the Hermes functions import |
| `voice_live` | Continuous full-duplex streaming audio. | **always false** — not implemented |
| `voice_barge_in` | Manual interruption with playback cancel, server cancellation acknowledgement and suppression of the interrupted turn. | true with `voice_handsfree` |

The old hold-to-record voice note (`app/src/lib/voiceNote.ts`, `voiceSession.ts`, the composer mic and
the tab-bar pet) is untouched and keeps using Hermes's normal voice-note transcription.

## Architecture

```
app/src/features/live-voice/
  engine.ts            pure turn state machine: phases, turn/utterance ids, dedupe, bounded
                       buffers, interruption, reconnect policy, backpressure windows
  voiceText.ts         speakable text + sentence chunking + stop-phrase detection
  endOfSpeech.ts       VAD port of Herald's EndOfSpeech (level -> "done talking")
  client.ts            /api/voice/* requests (session, transcribe, speak, stop, end)
  provider.ts          provider descriptors shared by web/native
  capture.ts           one file, `Platform.OS === 'web'` branches: MediaRecorder + AnalyserNode VAD
                       (server STT) / Web Speech API (device STT) on web; expo-audio recorder +
                       metering VAD on native (device STT unavailable). No `.web.ts`/`.native.ts`
                       files: `app/tsconfig.json` does not set `moduleSuffixes`, so platform
                       suffixes would resolve to the wrong file type.
  deviceSpeech.ts      same branching: `speechSynthesis` on web, none on native
  playback.ts          expo-audio playback of server speech with hard cancellation
  useLiveVoice.ts      React hook: owns the session, executes engine effects, watches chat/app state
  VoicePanel.tsx       focused voice screen
  VoiceProviderSheet.tsx  explicit speech-provider choice (persisted per device)
plugin/live_voice.py   sessions, signed audio URLs, dedupe, cancellation, route handlers
plugin/hermes_api.py   SpeechBackend: the only Hermes import point (transcribe_recording,
                       text_to_speech_tool), provider labels
```

Wiring that stays deliberately small: `plugin/hub.py` (routes, policy, features, janitor sweep),
`plugin/adapter.py` (`hub.speech = hermes_api.SpeechBackend()`), `app/src/lib/api.ts` (FormData
content type + per-call timeout), `app/src/lib/prefs.ts` (two speech-provider preferences),
`app/src/lib/store.ts` (`sendMessage` accepts the turn-derived `clientId`), `app/src/lib/icons.ts`
(voice icons), `app/src/components/Composer.tsx` (entry button **and** panel mount, so "Type
instead" can return focus to the composer it already owns), `app/src/lib/types.ts` (feature flags
are already `Record<string, boolean>`). `ChatView.tsx` is not touched.

## Server contract (Winglet plugin ⇄ app)

All routes except audio are `device` policy: a paired bearer token is required, and a member may
only use chats they own. The session also records the bot scope it was opened under (`bot` query
parameter); every later call must arrive under the same bot. Cross-bot, cross-device and cross-chat
use is refused. No database tables and no migrations: sessions are in-memory, bounded and expire.

### `POST /api/voice/sessions`

Body `{ "chat_id": "general" }`. Returns:

```json
{
  "session_id": "vs_…",
  "token": "…",
  "expires_at": 1760000000.0,
  "ttl_seconds": 1800,
  "chat_id": "general",
  "turn_based": true,
  "live": false,
  "stt": { "provider": "whisper", "available": true },
  "tts": { "provider": "edge", "available": true }
}
```

503 when the pinned Hermes has no usable speech functions. The token is an opaque per-session
secret; it is required on every call and expires with the session (30 minutes, sliding on use, hard
cap 2 hours). A server restart invalidates sessions; the app opens a new one on reconnect and shows
"Reconnected — tap to continue" rather than starting the microphone.

### `POST /api/voice/transcribe`

`multipart/form-data`: `session_id`, `token`, `turn_id`, `utterance_id`, `duration_ms`, and the
`audio` file part (`audio/webm`, `audio/mp4`, `audio/m4a`, `audio/ogg`, `audio/wav`). Maximum
1.5 MB (the hub's request cap is 2 MB). Returns:

```json
{ "turn_id": "t_…", "utterance_id": "u_…", "transcript": "what was said",
  "provider": "whisper", "seq": 4, "duplicate": false,
  "no_speech": false, "final": true }
```

`transcript: ""` with `no_speech: true` is silence, not an error. A repeated `(turn_id,
utterance_id)` returns the stored result with `duplicate: true` and never calls Hermes again
(idempotent retry). A second transcription while one is in flight for the same session gets `429`
with `retry_after_ms` (backpressure). Cancelled turns are refused.

### `POST /api/voice/speak`

Body `{ session_id, token, turn_id, message_id, text }`. Returns:

```json
{ "speech_id": "sp_…", "url": "/api/voice/audio/sp_…?exp=…&sig=…",
  "mime": "audio/mpeg", "expires_at": 1760000123.0, "provider": "edge", "bytes": 15230 }
```

Text is capped at 2000 characters per call; the app chunks longer replies. Synthesis runs off the
event loop. A cancelled turn is refused (`409`), so audio for an interrupted turn cannot be minted
after the interruption.

### `GET /api/voice/audio/{speech_id}?exp=…&sig=…` (public, HMAC)

The URL is signed for one file and a deadline; no bearer token appears in it. Expired, tampered,
cancelled-session or cancelled-turn files are `404`. Audio is served inline with
`Content-Security-Policy: default-src 'none'; sandbox` and `X-Content-Type-Options: nosniff`, never
as HTML. Files live under `<data dir>/voice/` and are deleted after 5 minutes, when the session
ends, when its turn is interrupted, or by the hub janitor.

### `POST /api/voice/sessions/{session_id}/stop`

Body `{ token, turn_id }`. Cancels that turn, deletes its stored audio, and returns
`{ "stopped": true, "turn_id": "t_…", "cancelled_turns": ["t_…"], "revoked_audio": ["sp_…"] }`.
This is the *voice-side* acknowledgement; generation cancellation still goes through the normal
`/stop` chat command, whose result the app waits for (typing state, message updates) instead of
inventing success. Stopping is idempotent.

### `POST /api/voice/sessions/{session_id}/end`

Body `{ token }`. Deletes every file and the session. Idempotent (`404` after it is gone is
treated as already ended by the app).

### Events

No new global event stream and no replay layer. The existing `typing`, `message.new` and
`message.update` events are the authoritative transcript. The app never treats its panel text as
the model transcript; it renders message text by message id from the chat store.

## App state machine (engine.ts)

Phases: `idle → connecting → listening → transcribing → thinking → speaking → listening …`, plus
`interrupted`, `reconnecting`, `error`, `ended`.

- One turn has one id; each recording inside it has an utterance id. User messages carry a
  `client_id` derived from the turn, so the server/socket dedupe the message exactly as any typed
  message.
- Transcripts are final in this build (Whisper returns whole utterances). Partial transcripts are
  modelled (`final: false` updates the caption in place) and duplicates are dropped by
  `(turn_id, utterance_id)`.
- Assistant text is spoken once, when the message first becomes final. Later edits/duplicates are
  ignored (`spoken` set, bounded). Only messages created after the turn started and not yet claimed
  can become a turn's reply.
- Interruption increments the turn generation. Effects from older generations are ignored, playback
  is stopped synchronously, the turn is marked `interrupted`, and the UI asks the user to tap to
  speak again. No automatic microphone after an interruption, after reconnect, after returning from
  background, or after permission loss.
- Silence: if VAD reports no speech, the recording is discarded without a request and listening
  restarts; after two consecutive silent turns the session returns to idle ("Didn't hear anything").
- Bounded: 8 turns kept, 64 seen utterance ids, 64 spoken message ids, 1200 characters spoken per
  reply (UI says the first part is read), chunks ≤ 400 characters.
- Stop phrases ("stop", "never mind", "goodbye", optionally "hey Hermes") end the voice session
  instead of being sent, matching Herald's intentional rule that "stop the container" is a real
  request, not a stop command.

## UI plan

- **Entry point:** a 40 px "handsfree" (waveform) button in the composer tools row, only when the
  server advertises `voice_handsfree`, the draft and attachment tray are empty, and the bot is not
  busy. It never replaces or changes the hold-to-record mic.
- **Panel:** a focused full-screen modal (max 560 px, centered dialog on wide screens) with
  `aria`-style labels: bot face + "Live voice" + a quiet **Turn-based** badge, a 112 px status orb
  (tap to speak / stop listening), a live status line ("Listening…", "Transcribing…", "Thinking…",
  "Speaking…"), a level meter, the last four turns as user/assistant captions derived from chat
  messages, and an inline error card.
- **Controls:** big primary action (56 px), **Interrupt** while speaking/thinking, **Mute**,
  **Type instead** (closes the panel and focuses the composer), and **End**. All 44–48 px or more,
  with 48 px minimum vertical spacing; keyboard: Space = interrupt/stop listening, Esc = close.
- **Provider choice:** two explicit rows — "Listen with" and "Speak with" — with `This device`
  (web only) and `Server · <provider>` options, persisted in prefs. Device options are disabled on
  Android with a short explanation, because no native recognizer/synthesizer is added in this PR.
  The chat's model is shown as read-only ("Replies use this chat's model") and fetched from
  `/api/agent` where available; the panel never changes model selection.
- **States:** unsupported (hidden entry), permission denied (explain + Settings on native), mic
  revoked mid-turn (error card + Retry), offline/reconnecting (banner, no mic), muted, empty
  transcript, failed transcription (Retry), long reply, reduced motion (no pulsing orb), light and
  dark themes.
- **Layout:** 320 px and 390 px phones (single column, controls wrap, no horizontal scroll),
  tablet (~820 px) and ~1440 px desktop (centered dialog, captions side by side with the orb),
  safe areas and keyboard avoidance.

## Authorization, privacy and lifecycle

- The server derives the device from the bearer token; chat visibility uses the existing
  `can_see` rule. No caller-supplied device or bot id is trusted.
- Recordings are sent only for the active utterance, never replayed after reconnect, and deleted on
  the server immediately after transcription. Synthesized speech is a temporary signed file.
- The microphone is never opened by the panel while the app is backgrounded, the socket is offline,
  the panel is closed, the session is muted, or after a reconnect without a tap.
- On backgrounding, lock screen or an audio interruption, the current recording is cancelled (not
  sent) and the session pauses. Bluetooth/route changes are handled as an audio interruption where
  the platform reports one; continuous route monitoring needs physical-hardware validation.
- Server speech uses the user's Hermes-configured STT/TTS providers and keys; the app never sees
  those keys.

## Tests planned

- App node tests: engine transitions (duplicate final/partial, interrupt generation, reconnect
  requires resume, bounded buffers, backpressure, no auto-mic), VAD end-of-speech, speakable text,
  chunking, stop phrases.
- Pytest: session creation/auth/scope, member refusal, cross-chat/cross-bot, token expiry,
  duplicate transcription idempotency, busy backpressure, silent transcript, speak + signed URL +
  expiry + tamper, cancelled turn revokes audio, end idempotency, feature flags off without a
  speech backend, route policy coverage.
- Hermes import test (runs in the CI Hermes job): pinned functions exist.

## Status at handoff — work stopped mid-implementation

This assignment was **not completed**. The task was stopped at the user's request after the server
side and the pure app modules were written, before the app adapters, hook, UI and wiring existed.
Nothing is committed, pushed or opened as a PR.

### Done and verified

- `plugin/live_voice.py` — `VoiceSessions` + `VoiceBridge`: in-memory sessions bound to
  device + chat + bot, 30-minute sliding TTL with a 2-hour cap, HMAC-signed expiring audio URLs,
  idempotent `(turn_id, utterance_id)` transcription dedupe, `429` backpressure, per-turn
  cancellation that revokes audio and refuses late transcribe/speak (`409`), janitor sweep, no DB
  tables. Six handlers: create session, transcribe, speak, audio, stop, end.
- `plugin/hub.py` — routes, `ROUTE_POLICY` entries, feature flags
  (`voice_handsfree`, `voice_live: false`, `voice_barge_in`), janitor wiring, bot scoping.
- `plugin/hermes_api.py` — `SpeechBackend` + `speech_available()`: the only Hermes import point
  (`tools.voice_mode.transcribe_recording`, `tools.tts_tool.text_to_speech_tool`), provider labels.
- `plugin/adapter.py` — installs `hub.speech = hermes_api.SpeechBackend()`.
- `tests/test_live_voice.py` — 20 tests, passing (`20 passed in 1.02s`, re-run at handoff).
- Full plugin suite — `321 passed, 16 skipped` (unique `--basetemp`, private `.venv`).
- App pure modules, **written but never typechecked/tested**:
  - `engine.ts` — phases, turn/utterance ids, generation tokens for every effect, dedupe sets,
    bounded turns/seen/spoken, silence retry, interruption, reconnect, mute, `phaseTitle()`.
  - `voiceText.ts` — `speakableText`, `clipSpoken`, `speechChunks` (160/400 chars, long-word
    split), `isVoiceStopCommand`, `MAX_SPOKEN_CHARS`.
  - `endOfSpeech.ts` — Herald `EndOfSpeech` port, `VoiceActivity`, `normalizeLevel`, `dbToLevel`.
- `docs/agent-handoffs/live-voice.md` — contract, routes, auth model, storage, UI plan, this status.

### Pending (in the order it should be resumed)

1. **App node tests** (harness: `app/tests/voiceSession.test.ts` pattern — `vm` +
   `ts.transpileModule` with a require map): `liveVoiceEngine.test.ts`, `liveVoiceText.test.ts`,
   `liveVoiceVad.test.ts`. Nothing in `app/src/features/live-voice/` has ever been executed, so
   treat these modules as unproven code.
2. **Adapters and data layer** — `client.ts` (sessions/transcribe/speak/stop/end, `429` retry with
   `retry_after_ms`, `404` → `sessionLost`, never replay audio), `provider.ts`, `capture.ts`,
   `deviceSpeech.ts`, `playback.ts` (hard cancel, `didJustFinish`/`error`, no stale audio after a
   new turn).
3. **`useLiveVoice.ts`** — owns the session, executes engine effects, converts
   `Message.created_at` seconds → ms (`* 1000`), 2.5 s reply-claim skew, app-state/background,
   audio-mode and permission watchers, `sendMessage({ clientId: 'voice-<turnId>' })`,
   `stopTask()` for generation cancel, never auto-starts the mic after reconnect/background/
   interrupt/mute.
4. **UI** — `VoicePanel.tsx`, `VoiceProviderSheet.tsx`, `Composer.tsx` entry button + panel mount +
   "Type instead", `icons.ts` additions (`AudioLines`, `MicOff`, `Volume2`, `VolumeX`,
   `Headphones`). Preserve the existing hold-to-record `VoiceButton` untouched.
5. **Wiring** — `app/src/lib/api.ts` (`timeoutMs`, default 10 s, voice ~60 s; skip JSON
   `Content-Type` for `FormData`), `prefs.ts` (`voiceListenWith`/`voiceSpeakWith`, default
   `'server'`, device rows disabled on native with an explanation), `store.ts` (`SendOptions.clientId`).
6. **`third_party/notices/herald-live-voice.md`** — full MIT text, Giton22, snapshot commit
   `95ca999fa48c1c9de232fe499a174900f0d25272`, URLs, reused files
   (`EndOfSpeech`/`Speech.kt`, `VoiceScreen.kt` patterns, text helpers) and the modifications
   (apostrophe-normalisation fix in stop-phrase matching, TypeScript port). **Required in the
   first PR that contains reused Herald code**, before merge.
7. **`tests/test_live_voice_hermes.py`** — the docstring in `tests/test_live_voice.py` refers to a
   Hermes import test that does not exist yet; add it (skip when the pinned Hermes snapshot is not
   importable) or fix the docstring.
8. **Validation not run at all**: `npm test`, `npm run typecheck`, `expo export --platform web`,
   `expo export --platform android --output-dir dist-android`. No screenshot, no fixture backend
   on 9307, no preview on 8307, no 320/390/tablet/1440 or light/dark/reduced-motion evidence.
9. **Git** — no commits, no push, no PR. All work is an uncommitted dirty tree in the worktree.

### Known risks in the unproven app code

- `engine.ts` is the largest untested file (~24 KB) and encodes the interruption, dedupe and
  reconnect rules; a bug there silently breaks requirement 4 of the assignment.
- `expo-audio` exposes `AudioRecorder` only as a type; native capture must use `useAudioRecorder`
  plus ~100 ms `recorder.getStatus()` polling for `metering` (dBFS → `dbToLevel`), `hasError`,
  `isFinished`, `mediaServicesDidReset`. Unverified on a device.
- Device STT/TTS are web-only in this design; any copy implying native on-device speech would be a
  false capability claim.
- No real Hermes speech backend was exercised end to end; the plugin tests use fakes.

### Resuming

Worktree `C:\Users\vikas\Documents\winglet-agents\07-live-voice`, branch
`codex/major-07-live-voice`, HEAD `b71d93b459e1645e34cd47c80a392b146dca0e04`, dirty with the
files above. Private tooling already installed: `.venv` (pytest 9.1.1, aiohttp 3.14.5) and
`app/node_modules` (`npm ci`). Do not touch the shared checkout's dirty files
(`app/tsconfig.json`, `AUDIT.md`, `PR1_FIXES.md`, `PR1_REVIEW.md`). Commit as
`VIKASRP24 <138146806+VIKASRP24@users.noreply.github.com>`.

