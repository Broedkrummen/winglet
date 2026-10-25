# Android on-device speech: feature 07 follow-up

For Codex orchestrator review. Primary workflow: Agency Agents Mobile App Builder,
architecture -> implementation -> distinct review. Turn-based foreground voice;
voice_live remains false. The existing server session, bot/chat/device authority,
acknowledged Stop, transcript reconciliation and live-only message delivery remain.

## Implementation and ownership

Own app/modules/winglet-voice, nativeSpeech.ts/deviceSpeech.ts, minimal VoicePanel
and useLiveVoice wiring, focused tests, and this handoff. The local module autolinks
beside winglet-phone-tools from app/modules; no shared autolink/plugin configuration
was added. Only app.json's existing expo-audio microphone explanation changes;
background recording/playback remain false. No app version, release workflow,
Hermes pin, backend protocol, database migration or generated plugin/web changes.

The provider chooser probes device capability without asking for microphone access.
Server and Device remain explicit persisted choices; a selected unavailable device
provider blocks Start and explains how to choose Server. It never silently switches
providers. Browser-managed recognition/synthesis retain their existing behavior and
online-service warning. The native module is optional and never loaded on web;
iOS/old native builds report device speech unavailable.

Android recognition requires API 31+ and isOnDeviceRecognitionAvailable. Only
createOnDeviceSpeechRecognizer is used, with EXTRA_PREFER_OFFLINE; there is no remote
recognizer fallback or triggerModelDownload call. The system-default language is
explicit in the chooser. Global recognizer availability does not prove a language
pack is installed: unsupported/unavailable language errors stop the turn and offer
Server or the user's system language settings, without starting a download.

Synthesis requires Android API 26+ and an installed matching-language voice whose
networkConnectionRequired is false and whose features do not mark it uninstalled.
Language availability is checked, setLanguage/setVoice must succeed, and the selected
voice is rechecked before speak. Engine, selected voice name and actual voice locale
are shown. A same-language regional fallback reports its actual selected locale.
No TTS voice-install flow or network-required voice is selected.

## Lifecycle and cancellation

All recognizer/TTS operations and disposal run on the main Looper. Fresh activity
RESUMED state, keyguard state and cancellation identity are checked before native
work. Recognition ready/partial/final callbacks also check fresh microphone permission
and lifecycle/keyguard state; final text is checked again after teardown immediately
before emission. Invalid callbacks discard text and report interruption. TTS completion
is checked before emitting done, preventing a late locked completion from advancing
the voice loop to another listen. RMS callbacks use cheap identity/background guards.

The JS adapter scopes listeners to unique request IDs, caps transcript text at 8000
characters, bounds dictation at 60s plus an 8s final-result grace and TTS at 90s, and
cleans listeners/timers on all outcomes. Aborting while permission or native TTS
initialization is pending rejects immediately; bounded native cancellation tombstones
prevent a late start. Native pending TTS work and waiters are bounded, and callback
IDs prevent an old cancellation from stopping another request. Nothing is persisted.

Existing claimVoiceAudio ownership prevents competing voice panels/chime mode changes.
Native transient focus loss and OS device-added/removed route callbacks stop speech.
Background, app lock, activity/module destruction and failed permission all stop or
discard work; no path restarts capture after them. Specific Bluetooth/output switching,
phone-call interruption and vendor audio behavior still require hardware verification.
No microphone foreground service, phone-state permission, background recording or
saved native audio file is introduced.

## Reference comparison and provenance

Read-only Herald snapshot 95ca999fa48c1c9de232fe499a174900f0d25272 was inspected:
AndroidVoice.kt implements PCM capture/playback, VoiceController.kt owns its loop,
and VoiceScreen.kt exposes controls. This follow-up is original Winglet system-API
adapter code, not a port of those files. Existing adaptive-VAD reuse and the complete
MIT notice remain in third_party/notices/herald-live-voice.md.

| Reference behavior | Winglet result | Checks / intentional difference |
| --- | --- | --- |
| AndroidVoice recorder/player lifecycle | Optional system recognizer and installed offline TTS | Main Looper, fresh lock/permission guards, callback IDs, disposal |
| VoiceController cancellation | Existing foreground voice engine plus native adapter | Late permission, old callbacks, lock/background, TTS-init races |
| VoiceScreen provider controls | Existing themed sheet with explicit device/server gates | Honest unsupported/missing language/voice state and locale provenance |
| Streaming PCM/acoustic interruption | Still unavailable | Turn-based speech and acknowledged manual Stop only |

## Validation completed

- Full client suite, serial: 398 passed (node --test --test-concurrency=1 tests/*.test.ts).
- TypeScript typecheck passed.
- Final one-worker web production export passed.
- Final one-worker Android JavaScript/Hermes-bytecode export passed.
- Actual native :winglet-voice:compileDebugKotlin succeeded with SDK 36, Kotlin 2.1.20,
  Gradle 9.3.1 and JDK 25. Both winglet-phone-tools and winglet-voice autolinked.
  The guarded class build succeeded in 2m 47s; a clean confirmation exited 0 in 53s.
  One worker, 1GiB heap, 512MiB metaspace and in-process Kotlin kept the shared machine
  bounded. SDK/cache reuse was explicitly coordinated with the orchestrator.
  The final locale-provenance string adjustment was source-reviewed after that
  compile; the orchestrator owns the combined final APK compile.
- Native tests cover permission-held abort/finish, wrong/old partial/final packets,
  bounded text/levels, denied/missing language, late native start acknowledgement,
  synthesis identity/completion, pending TTS abort and destroyed event host.
  Controller tests prove late native text/ready callbacks after background/app lock
  cannot send or mark the mic active, and late TTS completion cannot restart listening.
- No provider, physical microphone, phone, emulator, RDP or personal data was accessed.
  No full APK/runtime or Android audio-route claim is made from compilation/exports.
  Existing synthetic web layout evidence is in live-voice.md; no native screenshot
  is claimed. Final-head CI supplies full plugin/Hermes and app/export checks.

## MOBILE VALIDATION PENDING

Use the combined feature 07-11 integration commit containing this follow-up and record
its exact build SHA. The orchestrator owns the final APK and device test phase.

1. On API 30 or a build without the module, verify device ASR is disabled with a clear
   reason; Server remains selectable. On API 31+, test both absent and present local
   recognizer. No language/model download should start from opening the sheet.
2. On a disposable QA chat with a configured server, explicitly select device listen
   and an installed language, grant mic permission, speak and pause. Expect one final
   normal chat message, partial captions only, then the usual acknowledged reply.
   Denial, runtime revocation and absent language packs must fail without remote
   recognition fallback. Retest with the network off where local model chat allows.
3. Select device synthesis with an installed nonnetwork voice. Check engine/voice/actual
   locale, completion and manual Interrupt. With no matching installed offline voice,
   keep the option disabled; never open a voice-install activity automatically.
4. Hold permission/native service initialization, then close/lock/background. Deliver
   delayed ready/partial/final/done callbacks. Expect no text send, no playback and no
   restarted microphone. Reopening/unlocking requires an explicit tap.
5. Interrupt during ASR and TTS; change provider while paused; revoke mic in settings;
   rotate/kill/reopen. Old request IDs must not affect a new turn. Verify native Stop
   generation acknowledgement still matches the server's typing lifecycle.
6. Physical hardware is needed for wired/USB/Bluetooth changes, switching between
   already-connected outputs, competing music/navigation audio, incoming/active calls,
   privacy microphone switches and vendor power management. Verify focus/route
   interruption and no automatic resume; document OS/vendor callback gaps honestly.
7. Check 320/390px phone, tablet and wide layouts, long installed voice names, larger
   text, safe area and screen-reader labels. Browser screenshots do not establish
   Android capture/playback, permissions or local-engine availability.

Review first: native authorized/endRecognition/endSpeech callback guards, main-queue
cleanup, nativeSpeech.ts cancellation during permission/TTS init, and VoicePanel's
explicit availability/provider choice. Native runtime behavior remains pending that
combined-device phase; the required native operations themselves are implemented.

## Final integration handoff

Draft PR: https://github.com/VIKASRP24/winglet/pull/57.
Frozen product source: ed9bdd3a038aa8c1d73ce428c291937bc3c5b048, after merging
integration c2d2ccdc7f8cba6a73617322a79538a8802d6153 (features 07-11).
Post-merge TypeScript typecheck passed. Focused native adapter/controller, Composer
identity and routine-history screen checks passed 21/21. The earlier 398-test client
run and local exports preceded that final routine-history merge; final PR CI checks
the merged head. No further product changes follow this frozen source in this handoff.
The parent received that exact source SHA before CI completion to begin combined APK
work. Local native compilation is not repeated; final hardware/runtime validation
remains explicitly pending as described above.
