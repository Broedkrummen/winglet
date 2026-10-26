# Winglet for Wear OS (preview)

A separate native Wear OS app. Install Winglet on a paired Android phone; use
Agent → On this phone → Wear OS after starting Link on the watch. Match the code,
choose a bot and 1–12 conversations, then explicitly confirm. Codes last two
minutes; grants last 30 days. Read-only sharing is supported.

The watch receives a scoped association key, never a gateway address, pairing
token, signing key or server grant. Phone/watch messages use Google's Data Layer
plus association/node/direction/expiry-bound AES-GCM. The phone's narrow server
grant is stored wrapped by Android Keystore. Its gateway traffic is sealed to
the pinned Winglet server identity, with authenticated encrypted responses.

By default, keep Winglet open and unlocked on the phone. The separate background
relay toggle explicitly permits selected-chat reads and allowed replies while
the phone is locked or the app is closed. Unpairing, scope loss, server revocation
or expiry refuses later gateway operations. An offline local unlink also needs
server revocation when the phone reconnects. No approval shortcut is provided:
Open on phone posts a generic notification for the user to tap.

## Build

JDK 17+ (local validation uses JDK 25), SDK 36, AGP 8.12.0, Kotlin 2.1.20,
Gradle 9.3.1; watch Android API 30+. Google Play services and a paired Android
phone are required. The phone native module needs Android API 26+.

```sh
cd wear
./gradlew :app:assembleDebug :app:testDebugUnitTest -PwingletDev=true
```

For a local paired Dev test, pass
`-PwingletQaKeystore=/absolute/path/to/phone/app/android/app/debug.keystore`.
The phone and watch **must share application ID and signing certificate**:
`io.github.vikasrp24.winglet.dev` for Dev, `io.github.vikasrp24.winglet` for
production. An independently generated debug key cannot communicate with a
differently signed phone app. The QA property only permits Dev debug signing.
No production key, signing workflow, release artifact or version bump is added.
Release signing and distribution of the watch app remain separate decisions.

The `Wear native` GitHub Actions workflow checks native watch and phone code on PRs.
After merge, its manual `build_phone` input can build combined Dev phone/watch APKs
with matching debug certificates. It verifies both `.dev` package IDs and retains the
QA artifact for seven days; it does not publish a release. Watch Licenses includes the
complete Apache dependency license text, also stored in `app/src/main/assets/`.

## Runtime privacy and limitations

- Keys and association metadata use no-backup Keystore-wrapped AtomicFile storage.
  Reset/re-pair explicitly if a key is invalidated; there is no plaintext fallback.
- Recent transcript and unsent text remain in RAM while the watch UI is active.
  Locking or leaving the screen clears them; secure-window flags prevent screenshots.
- Polling runs every ten seconds only while the watch screen is active, unlocked
  and not composing/retrying. There is no permanent background polling.
- Voice uses the watch's selected speech-recognition provider after a deliberate tap.
  Review the result and tap Send. Winglet does not record a wake word.
- A transport write is not message delivery. Only the authenticated server
  `accepted` response confirms acceptance. Retry retains the exact request identity
  for up to 60 seconds, with server deduplication; no offline send queue is created.
- After the app leaves the foreground, uncertain deliveries must be checked in the
  refreshed transcript before composing again. Private pending text is not restored.
- Background delivery, Bluetooth transitions, vendor battery restrictions and a
  real speech provider still require paired-device validation.

## Reproducible paired-device checklist

Use disposable Winglet chats/server data and a Play-enabled Wear emulator (API 30+
round 192/227 dp) paired through Android Studio Device Manager/Wear companion to
a Play-enabled Android phone/emulator (API 30+, plus a real Android 16 phone).
An isolated watch emulator alone cannot prove Data Layer communication.

1. Build/install the same Dev package and certificate on both peers. On a local
   fixture server, create two ordinary chats and a separate member-owned chat.
2. Start Link; compare the two codes. Cancel, expire and restart setup; old codes
   must fail. Kill/reopen the watch during the challenge; retry Link to recover
   the same unexpired association. Drop the first linked ACK and retry Link.
3. Share only one chat, read-only. Verify recent bounded messages/status and deny
   replies/unshared chats. Unlink, then create a fresh reply-enabled association.
4. Send text and an OS-dictated reply after review. Disconnect transport after
   acceptance, Retry the same reply and verify exactly one user message. Change
   the same ID/body in a fixture request and expect refusal. No automatic send
   may happen after reconnect, app restart or an expired request.
5. Test Open on phone with notification permission allowed/denied. Approvals must
   still require the existing authenticated phone UI. No watch approval action exists.
6. With default privacy, lock/close the phone and expect Open phone refusal. With
   the explicit background grant, verify narrow access while the app is closed.
   Lock/leave the watch: no private views or transcripts may remain/restored.
7. Revoke on the server, unpair the phone, change device role/signing key, remove
   the selected bot/chat and expire the grant. Reads/replies must be refused.
8. Reboot both peers, invalidate the local test Keystore key, repeat pairing and
   verify reset/recovery. Test Bluetooth/Wi-Fi handoff, phone offline, watch offline,
   app-version mismatch, larger fonts, round-screen scrolling and 48 dp targets.

Native builds/tests, browser layout checks and actual paired-device evidence are
reported separately in `docs/agent-handoffs/wear-os.md`. **MOBILE VALIDATION PENDING**
until that checklist is executed. This preview is not part of published v0.6.0.
