# Combined major-feature validation — 26 October 2026

This report supersedes earlier MOBILE VALIDATION PENDING notes for the checks listed below. It records the combined integration, rather than treating an export or an individual feature branch as device evidence.

Reviewed application source: `8e66ada97985b68b8f05583f3b8f2fb8f3097a72`. The refreshed plugin web bundle is PR61, integrated as `fb08685008dabb75ec0a7a08179848e4b2ce2cf2`; it changes generated web assets only. The main integration is PR58.

## Automated and build evidence

- All four CI jobs passed on the combined source and refreshed bundle: pinned-Hermes integration, Linux plugin tests, Windows plugin tests, and app tests/typecheck/web/Android exports.
- Pinned-Hermes suite: 651 passed, one skipped. Client suite after the microphone regressions: **413 passed, zero failed, zero skipped**. An independent local full pinned-Hermes run before the notice tests passed643/one skipped.
- Initial full native Dev build passed C++/Kotlin compilation, release lint, signing and assembly in21m21s. The permission-fix rebuild passed in2m43s, exit0, with643 Gradle tasks.
- Generated bundle validation checked28 asset references with none missing, SHA256 equality to the clean export, and a served-browser smoke test. Full notices are embedded in app JSON and plugin Markdown; the deterministic staleness/full-text tests passed.
- Browser evidence in the feature handoffs covers narrow phones through desktop, light/dark, reduced motion, long content and disconnected states.

## Physical Android evidence

Tested the combined APK on an I2304 arm64 phone running Android16/API36, using the existing Winglet Dev package. Updates used `adb install -r`; existing data and signing identity were retained, and the production Winglet package was preserved. Tests used disposable local Hermes state, synthetic model replies and owner-scoped QA chats.

| Feature | Combined native check |
| --- | --- |
| 01 Projects | Created Native QA through the signed UI, created a chat within it, and verified the project retained one chat. |
| 02 Conversation branching | Reviewed and created a branch from the first exchange; the new chat contained the selected two messages and a parent link. Later source messages remained in the original chat. |
| 03 Checkpoints | Displayed the actual disposable Git diff; confirmed restore with user-edited-file override off; verified the fixture file changed back, the receipt reported one restored file, and an undo safety snapshot was offered. |
| 04 Structured execution | Displayed completed/doing/pending steps, a failed subtask and finished tool call. Turn completion left unfinished steps explicitly unfinished. |
| 05 Processes | Inspected an actual fixture child process, its exited status and captured output through the native sheet. Active-process termination has automated and earlier-phase coverage; it was not repeated in this pass. |
| 06 Rooms | Opened two-bot history, sent a single-bot mention, verified only that profile was dispatched, and confirmed Stop until the worker acknowledged cancellation and active turns returned to zero. |
| 07 Voice | Verified both recorder paths start. For Android on-device recognition, AppOps showed active capture; pressing Home stopped capture in944ms and did not restart it automatically. With the user's spoken “Winglet test”, local recognition produced the exact text, the synthetic reply arrived, local TTS completed, and the session returned to listening. The session was then ended and the original provider choices restored. |
| 08 Recovery | Disconnected the QA API/socket, posted a test message while offline, reconnected, and observed the message once. An unsent draft survived force-stop/relaunch. |
| 09 Context insights | Opened estimates and unknown usage fields; exercised the signed review/confirmation flow against a synthetic compression bridge and observed8,400→3,200 tokens. |
| 10 Routine history | Opened completed, failed and unknown attempts and a read-only failed-run detail. During a real disconnect, loaded rows remained readable and all mutation controls disabled; they re-enabled after reconnect. |
| 11 Phone tools | Verified default denial, explicit bot/chat/field consent, denial, native status Allow once, exact synthetic shared-note delivery, metadata-only audit and revocation blocking subsequent reads. Ended with no pending requests and all grants revoked. |

All seven source notices also rendered on the phone; the full phone-tools copyright, MIT grant and warranty text were readable with the QA API offline. Raw device screenshots and accessibility dumps remain local rather than publishing phone status-bar metadata.

## Device-found correction

The first native test exposed immediate voice cancellation despite an existing microphone grant. Expo's permission request can pause Android even when already granted; that correctly triggered foreground-only cancellation. PR60 queries current permission first on every turn, asks only when needed, and checks cancellation before a delayed prompt. Both native recognition and server recording share the fix. Eight regressions cover repeated grants, denial, cancellation and deliberate retry after a genuine permission prompt. The corrected build passed the physical checks above.

## Artifact and reproduction

- Package `io.github.vikasrp24.winglet.dev`, version501/0.5.1, arm64-v8a.
- APK SHA256: `ddead9a4ea59e02a0e133cad013ba50e252e2f6fdc8cd1a1dba058c20357bbc3`.
- Signing certificate SHA256: `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`.
- The local APK and build log are preserved under the primary checkout's ignored `.venv/qa-artifacts/` directory. APK binaries are not committed.
- Build with `WINGLET_DEV=1`, Expo Android prebuild, then `:app:assembleRelease --no-daemon --max-workers=1 -PreactNativeArchitectures=arm64-v8a`. This test build uses the existing debug signing fallback; no release credentials are required.
- For this Windows/JDK25 run, process-local `JAVA_TOOL_OPTIONS=--enable-native-access=ALL-UNNAMED` avoided AGP rejecting Prefab's JNA warning. A shortened physical Gradle cache and checksum-verified private Ninja1.13.2 resolved the old Ninja's long-path dependency failures. The original Ninja binary was preserved. No global Java, registry or security-policy change was made.

## Scope and practical limits

The phone checks verify native execution and UI behavior with real pinned-Hermes state where applicable. The LLM transport, provider-account values and compression workload in the device fixture were synthetic; no paid or live model provider was invoked. Real Hermes integration semantics are covered separately by the pinned suite. Personal contacts, calendars and location were not queried on the phone; their permission, scope, bounds, timeout and lifecycle paths have automated coverage. This was one Android device, without a headset/Bluetooth/incoming-call matrix.

Existing repository edits, app pairings, data and signing identity were preserved. No release/tag or provider migration is part of this integration.
