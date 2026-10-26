# Wear OS companion — implementation and validation

Separate native `wear/` application, Android/Wear Data Layer20.0.1, same package/signature as the paired phone. Existing SDK36/AGP8.12/Kotlin2.1.20/Gradle9.3.1 toolchain is reused. No Expo app is run on the watch and no production signing/release workflow is changed. A Dev build must use the existing Winglet Dev certificate on both peers.

Explicit association: start Link on the watch, compare its short code in Winglet on the phone, choose one paired bot and up to12 conversations, then confirm. An unpredictable association key travels only through the platform's package/certificate-authenticated encrypted Data Layer. Commands additionally use an association/node/direction-bound AES-GCM envelope and bounded request identity/expiry. Linking times out; cancellation, supersession and unlink invalidate stale handshakes. Keys live in Keystore-wrapped no-backup storage.

The watch never receives a gateway URL/token, pairing/signing key or general server credential. The phone holds a separate narrow server grant for the selected chats. Its background relay makes bounded end-to-end sealed requests and receives authenticated encrypted responses; even an obsolete HTTPS tunnel cannot read the grant or response. Grants cannot approve, invoke commands, upload, create chats, change scopes or run controls. User watch replies use stable delivery IDs through the existing message path, with fresh pairing/role/chat checks on the server. Background/locked-phone use is an explicit optional grant; otherwise the phone app must be open and unlocked.

UI: round-screen recent chats and needs-you/working status, last few messages, short text/OS voice input, deliberate Send, exact retry/acknowledgement, Open on phone for approvals, unlink and clear offline/version/expired states. No permanent watch polling or stored transcript. The user must unlock the watch to use private content. OS dictation is user-initiated and follows the watch's configured speech provider; no silent recording/upload.

Owned namespaces: wear_relay/wear_reply capabilities; `/api/wear/links` signed per-device grant management; `/api/wear/relay` narrowly authenticated sealed phone proxy; `winglet_wear_*` additive tables; Data Layer `/winglet/wear/v1/*`; `app/modules/winglet-wear` and `app/src/features/wear`.

Backend, native compile/tests, rendered UI and hardware evidence will be recorded separately. Paired phone/watch runtime and hardware battery behavior are MOBILE VALIDATION PENDING. Current published v0.6.0 has no watch app.

## Current implementation and validation — 26 October 2026

Implemented: scoped signed/sealed grant provisioning, nine backend integration tests,
phone Data Layer service and optional native module, explicit phone settings/security
bridge, separate native watch app with bounded recent chats, status, text/OS voice
composition, quick replies, deliberate send, exact retry and Open on phone. Additive
tables are feature-owned; leaving them in place is safe on rollback. Expired/orphaned
grants/nonces/deliveries are pruned without touching existing conversation data.

Local automated checks: **641 plugin tests passed, 31 skipped; 444 client tests passed;
TypeScript and web export passed**. Two further regression tests passed in the final
nine-test Wear backend suite: a fresh Store/Hub reopening the persisted grant and
retrying an accepted reply after lost acknowledgement; four concurrent retries making
one delivery, plus wrong-response-context authentication failures.

At reviewed commit **59eaf50b21cf85954f3518c5a22782cc2ef3f681**, all five hosted
checks passed, including Linux/Windows plugin, real pinned Hermes, app types/tests/web/
Android export, and **native watch APK + five JUnit tests, phone Kotlin compilation
and actual merged release manifest**. The phone test task had no test sources at that
commit; the final follow-up runs the same five protocol cases against the phone's Tink
artifact too. These tests cover peer/purpose/request/association binding, TTL/base64,
the shared Python sealed-message vector, durable receipt-cache cold start/lost ACK/
body conflict, and fail-closed capacity/expiry. Final-head CI remains authoritative.

Native CI found and fixed an obsolete SDK setup dependency and AndroidX annotation
variant duplication; the local JVM memory failures were avoided by hosted builds.
No native runtime, hardware Bluetooth, Keystore-reboot or battery behavior is claimed
from compilation/unit tests. Paired interaction remains **MOBILE VALIDATION PENDING**.

Phone settings were rendered through an injected fake native port in an isolated
browser while exercising real signed/sealed backend grant creation and revocation:
320/390/768/1440 px, light/dark/reduced motion, default background off, no selection
cannot link, link success, server grant visibility, local unlink + server revoke,
and unsupported-web fallback passed. Screenshots were visually reviewed at
`output/playwright/wear15-setup-light.png`, `wear15-linked-dark.png` and
`wear15-unsupported.png`. The temporary QA route is removed. This is a phone-UI and
HTTP contract test, not an Android/Data Layer interaction test.

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
`wear/README.md`. No release/signing workflow or production key is changed. Paired
phone/watch evidence remains pending; a web export is not native runtime validation.
The native workflow also offers an on-demand combined Dev phone/watch artifact build,
checks the `.dev` package and matching certificates, retains artifacts seven days and
never publishes a release. Complete Apache dependency notices are bundled in the
watch assets and accessible through Licenses; the phone retains its existing notices.

Official references: [Data Layer security and requirements](https://developer.android.com/training/wearables/data/overview), [listener lifecycle](https://developer.android.com/training/wearables/data/events). Behavioral reference read-only: Giton22/herald snapshot95ca999fa48c1c9de232fe499a174900f0d25272, WatchRelay/WatchLink/WatchUi. Independent Winglet implementation; no reference source/assets copied.
