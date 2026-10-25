# Native speech follow-up contract

Primary workflow: Agency Agents Mobile App Builder, architecture -> implementation -> review.
This closes feature07's native device-speech option. It is turn-based foreground voice,
with separate explicit Server/Device provider choices. Browser behavior is retained.

Own app/modules/winglet-voice, feature-local speech adapters, VoicePanel and focused tests.
The local module autolinks from app/modules beside winglet-phone-tools; no shared app
configuration, plugin, package version, permissions flow or release workflow changes.
Android recognition requires API31+ and isOnDeviceRecognitionAvailable; only
createOnDeviceSpeechRecognizer is used. Installed language packs are still required;
missing language errors never trigger downloads or a remote recognizer fallback.
TTS selects an installed voice whose networkConnectionRequired is false, sets its
language and voice explicitly, and reports engine/voice/locale provenance.

Architecture: all recognizer/TTS creation, operations, events and disposal run on the
main Looper. Unique request IDs bind callbacks and cancellation; bounded cancellation
tombstones reject starts arriving after cancellation/permission waits. The JS adapter
bounds deadlines/listeners and ignores old events. Existing voice foreground/audio
ownership still controls the surrounding loop. Native checks require a resumed,
unlocked activity. Background, focus loss, route changes and module destruction cancel
audio; none restarts capture. No background service or saved recording is introduced.

Validation pending implementation. No provider/phone/personal-data operations are
authorized for this phase. Native compile uses the prepared private SDK only after
the shared build slot is available. On-device runtime validation remains deferred to
the combined feature07-11 build.

Initial focused validation:39 native-adapter/voice engine/controller/playback/audio-mode
and Composer identity tests passed; TypeScript typecheck passed. SDK36 javap confirmed
the exact recognition, listener, TTS and Voice APIs. Native compilation and final
bundle checks are pending. This implementation uses platform APIs and original local
adapter code; no new external source port or license notice is introduced.
