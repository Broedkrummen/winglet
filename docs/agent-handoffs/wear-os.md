# Wear OS — implementation contract

Separate native `wear/` application, Android/Wear Data Layer20.0.1, same package/signature as the paired phone. Existing SDK36/AGP8.12/Kotlin2.1.20/Gradle9.3.1 toolchain is reused. No Expo app is run on the watch and no production signing/release workflow is changed. A Dev build must use the existing Winglet Dev certificate on both peers.

Explicit association: start Link on the watch, compare its short code in Winglet on the phone, choose one paired bot and up to12 conversations, then confirm. An unpredictable association key travels only through the platform's package/certificate-authenticated encrypted Data Layer. Commands additionally use an association/node/direction-bound AES-GCM envelope and bounded request identity/expiry. Linking times out; cancellation, supersession and unlink invalidate stale handshakes. Keys live in Keystore-wrapped no-backup storage.

The watch never receives a gateway URL/token, pairing/signing key or general server credential. The phone holds a separate narrow server grant for the selected chats. Its background relay makes bounded end-to-end sealed requests and receives authenticated encrypted responses; even an obsolete HTTPS tunnel cannot read the grant or response. Grants cannot approve, invoke commands, upload, create chats, change scopes or run controls. User watch replies use stable delivery IDs through the existing message path, with fresh pairing/role/chat checks on the server. Background/locked-phone use is an explicit optional grant; otherwise the phone app must be open and unlocked.

UI: round-screen recent chats and needs-you/working status, last few messages, short text/OS voice input, deliberate Send, exact retry/acknowledgement, Open on phone for approvals, unlink and clear offline/version/expired states. No permanent watch polling or stored transcript. The user must unlock the watch to use private content. OS dictation is user-initiated and follows the watch's configured speech provider; no silent recording/upload.

Owned namespaces: proposed wear_relay/wear_reply capabilities (not advertised until native checks pass); `/api/wear/links` signed per-device grant management; `/api/wear/relay` narrowly authenticated sealed phone proxy; `winglet_wear_*` additive tables; Data Layer `/winglet/wear/v1/*`; `app/modules/winglet-wear` and `app/src/features/wear`.

Backend, native compile/tests, rendered UI and hardware evidence will be recorded separately. Paired phone/watch runtime and hardware battery behavior are MOBILE VALIDATION PENDING. Current published v0.6.0 has no watch app.

## Current implementation and validation — 26 October 2026

Implemented: scoped signed/sealed grant provisioning, seven backend integration tests,
phone Data Layer service and optional native module, explicit phone settings/security
bridge, separate native watch app with bounded recent chats, status, text/OS voice
composition, quick replies, deliberate send, exact retry and Open on phone. Additive
tables are feature-owned; leaving them in place is safe on rollback. Expired/orphaned
grants/nonces/deliveries are pruned without touching existing conversation data.

Local automated checks: **641 plugin tests passed, 31 skipped; 444 client tests passed;
TypeScript passed**. Native watch compilation first caught a nullable JSONObject call;
that source error was fixed. Subsequent local JVM builds failed with native-memory
allocation errors on this PC, so native compilation/tests are **not yet passed**.
The separate Wear native CI job builds the watch APK/tests and phone relay/manifest.
Keep the PR draft until those real native checks pass. New protocol JUnit tests cover
peer/purpose/request/association binding, TTL/base64 rejection and a shared Python
sealed-message vector with Tink. Their execution is pending the native build.

Distinct review corrections: bounded stream reads for older Android instead of
InputStream.readNBytes; ConcurrentHashMap for pending phone handshakes avoids taking
a network-held mutex on native module destruction; only persist retain changes;
prevent a queued double-tap from resetting an in-flight request's busy state; clear
private snapshot on revoked/unshared access; preserve only the chat identity across
deliberately launched OS dictation so its new text returns to the right conversation.

Reference comparison:

| Reference behavior | Winglet result | Validation / intentional difference |
| --- | --- | --- |
| WatchLink explicit phone association | Package/cert-bound Data Layer challenge and matching code; scoped phone confirmation | Expiring/superseded pending state, lost-ACK retry paths implemented; paired runtime pending |
| WatchRelay bounded recent state and replies | Narrow server grant, selected-chat reads, stable reply ID and server dedup | Backend permission/replay/revocation/idempotency tests passed; no general pairing token on watch |
| WatchUi recent chats, short reply, voice, phone actions | Native round-aware scroll layout, 48 dp buttons, foreground-only polling and reviewed OS dictation | Native screenshots/interaction pending; approvals always use phone UI |
| WatchStore local state | Keystore-wrapped association metadata, no-backup storage, no persisted transcript/drafts | Key invalidation/reboot and actual battery behavior pending paired devices |

Independent implementation; no reference source or assets copied. Reproducible build,
same-certificate Dev setup, permissions/privacy and paired-device cases are in
`wear/README.md`. No release/signing workflow or production key is changed. Rendered
phone layouts and paired-device evidence remain pending; a web export is not native
runtime validation.

Official references: [Data Layer security and requirements](https://developer.android.com/training/wearables/data/overview), [listener lifecycle](https://developer.android.com/training/wearables/data/events). Behavioral reference read-only: Giton22/herald snapshot95ca999fa48c1c9de232fe499a174900f0d25272, WatchRelay/WatchLink/WatchUi. Independent Winglet implementation; no reference source/assets copied.
