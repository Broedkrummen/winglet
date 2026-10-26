# Wear OS — implementation contract

Separate native `wear/` application, Android/Wear Data Layer20.0.1, same package/signature as the paired phone. Existing SDK36/AGP8.12/Kotlin2.1.20/Gradle9.3.1 toolchain is reused. No Expo app is run on the watch and no production signing/release workflow is changed. A Dev build must use the existing Winglet Dev certificate on both peers.

Explicit association: start Link on the watch, compare its short code in Winglet on the phone, choose one paired bot and up to12 conversations, then confirm. An unpredictable association key travels only through the platform's package/certificate-authenticated encrypted Data Layer. Commands additionally use an association/node/direction-bound AES-GCM envelope and bounded request identity/expiry. Linking times out; cancellation, supersession and unlink invalidate stale handshakes. Keys live in Keystore-wrapped no-backup storage.

The watch never receives a gateway URL/token, pairing/signing key or general server credential. The phone holds a separate narrow server grant for the selected chats. Its background relay makes bounded end-to-end sealed requests and receives authenticated encrypted responses; even an obsolete HTTPS tunnel cannot read the grant or response. Grants cannot approve, invoke commands, upload, create chats, change scopes or run controls. User watch replies use stable delivery IDs through the existing message path, with fresh pairing/role/chat checks on the server. Background/locked-phone use is an explicit optional grant; otherwise the phone app must be open and unlocked.

UI: round-screen recent chats and needs-you/working status, last few messages, short text/OS voice input, deliberate Send, exact retry/acknowledgement, Open on phone for approvals, unlink and clear offline/version/expired states. No permanent watch polling or stored transcript. The user must unlock the watch to use private content. OS dictation is user-initiated and follows the watch's configured speech provider; no silent recording/upload.

Owned namespaces: wear_relay/wear_reply capabilities; `/api/wear/links` signed per-device grant management; `/api/wear/relay` narrowly authenticated sealed phone proxy; `winglet_wear_*` additive tables; Data Layer `/winglet/wear/v1/*`; `app/modules/winglet-wear` and `app/src/features/wear-os`.

Backend, native compile/tests, rendered UI and hardware evidence will be recorded separately. Paired phone/watch runtime and hardware battery behavior are MOBILE VALIDATION PENDING. Current published v0.6.0 has no watch app.

Official references: [Data Layer security and requirements](https://developer.android.com/training/wearables/data/overview), [listener lifecycle](https://developer.android.com/training/wearables/data/events). Behavioral reference read-only: Giton22/herald snapshot95ca999fa48c1c9de232fe499a174900f0d25272, WatchRelay/WatchLink/WatchUi. Independent Winglet implementation; no reference source/assets copied.
