# Hands-free voice — feature 07

For Codex orchestrator review. PR [#50](https://github.com/VIKASRP24/winglet/pull/50), branch
`codex/major-07-live-voice`. Integrated baseline: `87cf6269c42ea4610880ef158110e48837e34848`
(features 01–06). No version, release workflow, Hermes pin or generated plugin/web assets changed.

Primary role: Mobile App Builder, following the Agency Agents architect → implement → review workflow.
Latest tested implementation source: `5035f71`. The stopped source was preserved in `ae1d0dd`; this PR completes its app path and fixes its races.
Implementation, automated checks and browser checks are distinct from deferred native validation.

## User-visible behavior

Open **Hands-free voice** beside the existing hold-to-record mic. The panel starts with the microphone
off. **Tap to speak** records one utterance, ends it after a pause, transcribes with the configured
Hermes provider, sends one normal chat message, reads a new finished reply, and listens again.
**Finish speaking** sends sooner. Two silent attempts pause the loop.

**Interrupt** immediately releases capture/playback, revokes the voice turn's audio, and sends the
existing hidden `/stop` command where generation may still be running. The panel waits for the server's
actual typing lifecycle to clear; a timeout/refusal displays **Stop unconfirmed**, keeps a new turn
disabled, and offers **Retry Stop** or End. No client typing TTL is interpreted as acknowledgement.

Mute, End and Type instead are large controls. Type instead closes voice and restores composer focus.
The transcript uses stable chat message IDs; authoritative user text replaces the local transcription.
Only a new final bot message after the acknowledged user message can be spoken. Hidden controls,
status, activity, routine and approval/question messages stay silent. Full replies stay in the chat;
speech reads at most 1200 characters in bounded chunks.

Provider choices are explicit and persisted on this device:
- Server STT and TTS use the current bot/profile's Hermes configuration. The app never receives keys.
- Browser-managed recognition/synthesis are offered only when their APIs exist. Browser recognition
  may use the browser vendor's online service; it is not promised to run offline.
- Android builds offer on-device recognition on API31+ when the system's local recognizer exists,
  and synthesis through an installed voice that requires no network. The native follow-up is
  documented in [native-speech.md](native-speech.md); language packs remain a runtime requirement.
  Unsupported native builds keep these choices disabled. Server choices remain available.
- Replies use the chat's existing model. The panel displays its selection where the agent API exists.

This is turn-based hands-free speech. There is no simultaneous listen/speak, acoustic barge-in,
full-duplex/WebRTC voice, hidden background recording or microphone foreground service.

## Capability and HTTP contract

Additive feature booleans:
- `voice_handsfree`: a real callable Hermes STT + TTS bridge exists.
- `voice_barge_in`: manual interruption and server voice cancellation are implemented.
- `voice_live`: always false.

Availability checks do not contact speech services or prove keys/models are configured. Provider
configuration failures surface as a generic actionable error, without exposing provider payloads.

| Route | Policy | Behavior |
| --- | --- | --- |
| POST /api/voice/sessions | device | Opens a session bound to the authenticated device, chat and bot |
| POST /api/voice/transcribe | device | Multipart session/token/turn/utterance/duration/audio; final transcription with sequence |
| POST /api/voice/speak | device | Bounded text → signed temporary audio URL |
| POST /api/voice/sessions/{id}/stop | device | Idempotently cancels the turn and revokes its audio |
| POST /api/voice/sessions/{id}/end | device | Removes the session and all its audio |
| GET /api/voice/audio/{id}?exp=…&sig=… | signed public URL | Expiring file-specific HMAC; no bearer secret in URL |

Stop accepts `{ token, turn_id, stop_generation?: true }`. With generation requested, the server
uses the same `user_message(..., "/stop", hidden=True)` path as chat Stop, waits for its real
`_typing` state to clear, then returns `generation_stopped: true`. A missing adapter is 503;
an unacknowledged stop is 409. Voice cancellation remains effective even if generation stop fails.
The client waits for an already-in-flight send before issuing Stop to avoid Stop-before-send races.

Every operation checks session bot/device scope and chat visibility. Fresh database device/chat ACLs
are rechecked before cached transcription, after awaited STT/TTS, before Stop acknowledgement, and on
every signed audio access. Revocation, demotion, chat deletion and changed bot scope invalidate the
session. Public audio never relies on the hub's short-lived device cache.

Sessions are in memory: 30-minute sliding expiry, two-hour hard cap, at most 32 sessions. A restart
invalidates sessions and removes this bridge's generated speech/upload files. Turn history is bounded;
retired IDs cannot resurrect cancelled work. Transcript results dedupe by turn + utterance. Separate
per-session transcription/synthesis leases enforce 429 backpressure; a refused concurrent request
cannot release another request's lease. The client retries only explicit 429 responses, bounded and
abortable; it never retries an ambiguous/lost audio request automatically.

Uploads are read in bounded chunks (1.5 MB audio, small named fields); temporary uploads are deleted.
Speech is capped at 2000 characters/request and 24 MB/file, limited to eight files/session, expires
after five minutes, and is revoked on Stop/End/ACL loss. Responses use no-store, nosniff and sandbox CSP.
Provider error strings and exception bodies are never returned or logged by Winglet's voice bridge.
If Hermes returns several delivery files instead of one, Winglet refuses the synthesis and deletes
all of them rather than silently reading only the first part.

No database migrations, permanent audio store, global event cursor or second replay protocol.
Old servers hide the new entry; existing voice notes and text delivery retain their behavior.

## App lifecycle and platform boundaries

- `engine.ts`: pure phases, stable IDs, dedupe, bounded turns, speech sanitizing and stop commands.
- `useLiveVoice.ts`: owns effects, abort generations, single audio lease, fresh transcript claiming,
  live-only sends, foreground/lock/connection changes and explicit resume policy.
- `capture.ts`: browser MediaRecorder + Web Audio RMS; native Expo recorder + dB amplitude metering.
  Both use the adapted adaptive VAD and release their resources on cancellation.
- `deviceSpeech.ts` / `nativeSpeech.ts`: separately gated browser and Android device speech, partials, request identity and hard cancellation.
- `playback.ts`: browser HTMLAudio ended/error events and native Expo status events. A natural pause
  before ended is not mistaken for focus loss. Abort detaches listeners and releases the source.
- `client.ts`: botPath routing, session contract, signed URL and bounded backpressure.

No microphone begins merely from opening, reconnecting, returning from background, unmuting or an
interruption. An explicit tap reconnects; another tap starts a new capture. Captured audio is never
replayed after a connection loss. Voice text uses `sendMessage({ clientId, liveOnly: true })` and
never enters the durable outbox; ordinary text/outbox behavior is unchanged.

A single foreground voice audio lease prevents two panels owning audio and prevents chimes resetting
focus under speech. Native capture/playback request foreground audio behavior. Background, app lock,
recording errors, media-services reset and OS-reported playback pauses cancel/pause safely.
Native capture polls current/available inputs and pauses on route changes where Expo/OS supports
those APIs. Browser device changes, muted/ended tracks and a suspended AudioContext pause capture.

**Native limitation:** phone-call silencing, output-route changes, Bluetooth switching and focus
callbacks vary by Android version/vendor. The implementation does not claim complete route or phone
call coverage without native testing. There is no custom phone-state permission or background service.
Older native OS versions that cannot report an input route still use recorder/status interruption
handling. Physical Bluetooth/call/permission behavior remains a required later validation step.

## Shared wiring

`plugin/hub.py`: routes, ROUTE_POLICY, VoiceBridge, capability flags, bot scope accessor and janitor.
`plugin/adapter.py`: installs SpeechBackend. `plugin/hermes_api.py`: the only Hermes speech import point,
profile-scoped worker execution and temporary synthesis cleanup.
`app/src/lib/api.ts`: FormData boundary handling, per-call timeouts and combined caller/timeout abort.
`store.ts`: opt-in live-only send + supplied delivery ID; normal outbox behavior preserved.
`prefs.ts`: explicit listen/speak choices. `audioMode.ts`: foreground voice focus lease.
`Composer.tsx`: additive entry/panel mount. `components/icons.ts`: waveform and muted mic.

Shared integration conflicts in adapter/hub were resolved retaining projects, branching, checkpoints,
execution, processes and rooms. Before final handoff the fetched integration ref was still
`87cf6269c42ea4610880ef158110e48837e34848`, already an ancestor. Other unreviewed feature branches
were not merged. The main checkout's dirty tsconfig and audit/PR notes were untouched.

## Reference comparison and provenance

Read-only Herald reference: https://github.com/Giton22/herald,
`95ca999fa48c1c9de232fe499a174900f0d25272`.
Hermes integration pin: `47676981f55de91231fdeef2f0eec47e7c209e78`.

| Reference behavior/source | Winglet result | Edge cases/checks and intentional differences |
| --- | --- | --- |
| Speech.kt EndOfSpeech | TypeScript adaptive VAD | Calibration, quiet timeout, spoken pause, amplitude conversion |
| Speech.kt text helpers and stop phrases | Bounded text/chunks; apostrophe normalization | Code/URL/table stripping, long-word split, whole-command matching |
| VoiceController.kt turn loop | Existing Winglet chat messages + live-only send | Late callback, send/Stop order, background, reconnect, authoritative reply claiming |
| VoiceScreen.kt focused controls | Winglet themed sheet, status orb, captions and large controls | 320/390/820/1440 captures, keyboard Space/Escape, Type instead |
| VoiceLive.kt / SpeechStream.kt | Explicitly unavailable | No dashboard JSON-RPC, WebRTC vendor protocol or streaming PCM facade |
| VoiceKeepAlive.kt | Foreground-only lifecycle | No microphone service or lockscreen continuation |
| AndroidVoice.kt / device dictation abstractions | Native server speech, browser APIs, Android on-device ASR/offline TTS | Local Expo module uses system APIs; native compile passed, device runtime checks pending |

The full upstream MIT notice and exact reused files/modifications are in
[herald-live-voice.md](../../third_party/notices/herald-live-voice.md).
Winglet uses its own authenticated messaging protocol; no reference gateway endpoint is assumed.

## Validation and evidence

Executed:
- Final full lightweight backend suite: **457 passed, 25 skipped** (optional Hermes/platform cases).
- Final focused voice backend suite: **39 passed**, including 12 fresh-ACL/error privacy regressions.
- Real pinned Hermes wrappers with lower-provider fixtures: **3 passed**; with the HTTP voice suite: **42 passed**. These call the actual pinned
  transcription/TTS envelope/normalization functions, use temporary WAV data and verify cleanup.
  No paid provider, personal profile, model download or real microphone was used.
- Full app suite run serially after the FormData/focus/controller fixes: **347 passed**. Two subsequently added engine/stop-phrase regressions were included in the final **16 passed** focused voice run.
- Additional controller tests: **4 passed** (background, send/Stop ordering, reply identity/reconnect,
  late capture after close).
- Playback regressions and audio-mode tests: **8 passed** (four playback + four mode/lease checks).
- Final voice engine/text/VAD/backpressure tests: **16 passed**.
- Final web production export passed on source commit `5035f71`, with one worker; the earlier browser playback fix was separately exported and exercised.
- Final Android export with Hermes bytecode passed on `5035f71`, with one worker. This is a bundle check, not a native build.
- Final local TypeScript typecheck passed. Source head `1b5316d` passed all four PR CI jobs; the later source `5035f71` is being checked again. The final PR head and CI status are supplied in the final handoff.

Browser fixture checks used only synthetic local audio/data:
- Real MediaRecorder/Web Audio → fixture server STT → ordinary chat → final reply → HTMLAudio ended
  → a new listening turn, then Mute. This exposed and verified the playback-ended fix.
- Thinking → Interrupt → **Stopped by the server** → resume enabled.
- Provider chooser exposes four explicit options; Type instead closes the panel and returns to text.
- 320×740 light, 390×844 dark, 820×1180 light, 1440×1000 dark, reduced-motion emulation captured.
  The 1440 rendered check reported document width = viewport width (1440).
- No uncaught JS exception was observed. The synthetic server had no /api/agent backend; its optional
  model request produced two CORS/network console errors in the first preview. The final source
  gates that request on the agent capability. Existing Reanimated easing warnings were also observed.
- The preview browser and server were closed after checks.
- **Task strip defect, corrected in the follow-up:** the wide screenshot exposed repeated
  TaskProgress strips behind the voice modal. Feature07 introduced a duplicate React sibling key:
  VoicePanel used the same server/chat key as TaskProgress. Voice level updates could accumulate
  actual task-strip DOM nodes. The follow-up namespaces both keys while preserving chat remounts;
  the original screenshot remains evidence of the defect, not the corrected layout.

Representative screenshots (synthetic content only):
[320 light](screenshots/live-voice-320-light.png),
[390 dark](screenshots/live-voice-390-dark.png),
[820 light](screenshots/live-voice-820-light.png),
[1440 dark](screenshots/live-voice-1440-dark.png).

## MOBILE VALIDATION PENDING

**Implemented:** native Expo capture/playback, VAD, input-route checks, foreground cleanup,
explicit server/browser providers, and Android on-device ASR/offline TTS in the native follow-up.
**Not implemented:** iOS device speech, full duplex, acoustic barge-in or a microphone service.
**Native build:** the local Android voice module compiled with the prepared SDK; the final combined
APK remains owned by the orchestrator. **Phone/emulator tests:** deliberately not run here.
See [native-speech.md](native-speech.md) for exact native checks and remaining hardware cases.

Use the final merged `codex/major-features` commit containing PR #50 and record its exact SHA plus
APK build SHA. Do not validate a stale feature APK and call it integration coverage.

Safe fixture recipe (repository root, private environment):
1. Install app dependencies privately, run the final web/Android export checks, then start
   `python -m scripts.preview_live_voice`. It binds only 127.0.0.1:8307 and :9307 and prints a
   disposable pairing code; no real speech/provider configuration is read.
2. Open 8307 in a fresh browser profile; pair with 9307. Browser automation can inject a generated
   Web Audio stream instead of getUserMedia, as the agent did, so no physical microphone is touched.
3. For the later Android phase, use a disposable emulator API 31+ and API 36, phone and tablet
   form factors. Route 9307 through the emulator's host address (10.0.2.2), pair only this fixture,
   and use a dedicated QA chat. Run the combined app's native module compile first.
4. Test grant, deny, revoke-in-settings, open/close during permission/preparation, silence, long
   speech, STT failure, expired session, reconnect, failed Stop, duplicate final events and End.
   Expected: no hidden/restarted mic, no captured-audio replay, no late audio, clear recovery.
5. Background, lock and kill during capture/STT/TTS/playback; reopen. Expected: captured audio is
   discarded, generation can remain visible as text, voice needs an explicit tap.
6. Interrupt during HTTP send, thinking, speech loading and playback; delay server acknowledgements.
   Expected: audio ends immediately, no new turn before explicit Stop acknowledgement, retries
   do not create duplicate chat messages and old callbacks cannot restart playback.
7. Physical hardware is required for wired headset unplug, Bluetooth connect/disconnect/change,
   speaker/earpiece routing, competing music/navigation audio, incoming/active phone calls,
   vendor microphone privacy switch and permission revocation. Verify capture silence detection,
   actual focus events and no automatic restart after route/focus recovery. Document unsupported
   OS/vendor callbacks as gaps rather than treating a web test or bundle export as proof.

Review first: cancellation and fresh ACL checks in `plugin/live_voice.py`, the effect/AbortController
boundaries in `useLiveVoice.ts`, and native audio cleanup/input-route behavior in `capture.ts`.

## Distinct review phase

Reviewed final source separately from implementation: lease ownership on 429; cancelled/closed-session
late completion; fresh ACLs after awaits and on signed URLs; generic provider errors; generation
tokens across capture/transcription/playback; send-before-Stop ordering; browser ended-before-pause
events; native metering amplitude/input-route reporting; and old-server/normal-outbox compatibility.
Concrete review findings were fixed with regression tests, including the browser end event,
offline cleanup blockage, raw provider errors and in-flight authority changes.

Pinned Hermes source review additionally confirmed BasePlatformAdapter installs the active-session
guard before spawning work and dispatches /stop inline via _dispatch_active_session_command,
awaiting cancel_session_processing. Winglet's acknowledgement still waits for its adapter typing
lifecycle; it does not infer success from a client-side timer or merely paint an interrupted UI.

## Follow-up: unique composer sibling keys

The repeated rows were actual React-owned DOM nodes, not a Chromium paint
artifact: the synthetic browser counted97, later131, identical task buttons
under one Composer. Ordinary text turns settled to zero; the voice loop's
frequent updates exposed the sibling key collision introduced by feature07.
TaskProgress and VoicePanel now have separate task:/voice: namespaces, retaining
their server/chat remount identity. The earlier legacy attribution was wrong.

The actual Composer JSX regression mounts voice through its real action and
checks unique, stable sibling keys across100 busy/voice updates and a chat
change. Composer key/focus and voice controller regressions:7 passed.
TypeScript typecheck and one-worker web export passed. The corrected exported
bundle (entry-ded60d64a30d1a77410115759c83edaf.js) ran the same synthetic
MediaRecorder -> fixture STT -> chat -> reply -> browser playback loop. Across
470 samples at50ms intervals, task-strip count stayed0 or1 (maximum1), then
settled to0. The1440px dark and320px light documents matched viewport width.
No physical microphone, provider or personal data was used. No native build was
run for this two-key correction. Corrected screenshots:
[live voice1440 dark](screenshots/live-voice-1440-task-key-fixed.png),
[live voice320 light](screenshots/live-voice-320-task-key-fixed.png).
