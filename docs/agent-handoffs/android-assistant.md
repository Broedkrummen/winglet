# Android assistant

Optional Android29+ assistant role using system user-consent UI and BIND_VOICE_INTERACTION-protected service/session APIs. No hotword listener, microphone service or accessibility workaround. A recognizer declaration is a non-listening compatibility stub; Winglet's existing voice stack remains separate.

One private in-memory invocation lease binds an unpredictable nonce to a chosen server/chat/request, expires within90seconds, rejects superseded/forged IDs and is cleared on cancel, background, lock, role loss or process death. No context or credentials are trusted from external Intent extras. Screen data is bounded focused AssistStructure text only; editable/password/assist-blocked nodes and screenshots are excluded. User sees exact text and deliberately opts into including it before Send.

Native text panel provides immediate invocation UI and a deliberate handoff into the focused Winglet assistant page. The paired server/chat and normal bearer protocol remain authoritative. A request uses a stable delivery ID and never joins the offline outbox. Normal app use remains independent of the role.

Entry points: Android gesture → native panel → private invocation URI → assistant page; Android-only Settings/Agent setup opens the real role chooser. No user role will be changed by ADB or during implementation. Screen context testing will use controlled fixtures/emulators.

## Review and lifecycle

Agent → On this phone → Android assistant opens setup. Both native and React review windows use FLAG_SECURE; exit restores the previous window flag. Services require the system's BIND_VOICE_INTERACTION / BIND_SPEECH_RECOGNITION permissions. Role loss clears leases. Native app-lock grace is mirrored before a React child can read context. Sessions are one-shot; late callbacks cannot attach earlier screen data to a new invocation or modify a handed-off lease.

Collection is bounded to four focused windows, 256 nodes, 32 children/node and 6000 characters, excluding invisible/input/editable/assist-blocked nodes. AssistContent URLs are ignored. Context defaults off and is shown exactly before inclusion. First Send freezes server/chat/request/body digest in both native and JS state; retries keep the exact body and delivery ID. Background, lock, expiry, supersession, unmount or process death discard private state. The backend now rechecks current bearer authentication after body I/O for every message send. Assistant slash commands require the full chat.

Shared wiring: Agent entry, root security bridge/modal and fresh bearer check in h_message_send. No new backend capabilities, database migrations, gateway credentials or signing changes. Unsupported builds/platforms disable role setup; forged/expired links show an actionable dismissal screen. Offline sends are refused and never enter the outbox.

## Validation

- Real API36 native Kotlin compile, five native JUnit lease tests, and Android release manifest merge passed. Merged service class names and binding permissions were inspected.
- Client suite: 429 passed, including four new invocation/expiry/opt-in/frozen-retry tests. TypeScript and web export passed. Plugin suite: 613 passed / 31 skipped; the additional revoke-during-body regression passed separately.
- Real browser setup and invalid-link states checked at 320/390/768/1440 widths without horizontal overflow. Screenshots inspected; long destination names now appear below their labels. Browser evidence covers unsupported/forged-link states, not native invocation.
- MOBILE VALIDATION PENDING: OS role eligibility/chooser, assistant gesture from a controlled screen, keyboard/safe-area/large fonts, optional-context round trip to a disposable chat, background/cold start/app lock/device lock/role loss, screenshot privacy and full-chat navigation. No user's assistant choice has been changed. Native compilation/unit tests do not establish these interactions.
- Assistant gestures depend on Android/OEM support. The recognizer intentionally never listens; Open full chat exposes existing Winglet voice.

## Reference comparison

| Reference behavior | Winglet result | Evidence / difference |
|---|---|---|
| Native assistant service/session and role setup | Protected services, OS role picker, focused handoff | Real compile/manifest; gesture pending |
| Screen context | Bounded temporary text; explicit include checkbox | Lease/JS tests; native extraction interaction pending |
| Assistant voice | Existing full-chat Winglet voice | No second recorder/hotword stack |
| Bot/conversation target | Current paired/scoped chats; immutable first-send request | Retry/body tests; native round trip pending |

Read-only behavioral reference: Giton22/herald snapshot 95ca999fa48c1c9de232fe499a174900f0d25272, Android assistant service/session/XML. Independently written for Winglet's Expo/Python protocol; no upstream code/assets copied.

Official API references: [RoleManager](https://developer.android.com/reference/android/app/role/RoleManager), [VoiceInteractionSession](https://developer.android.com/reference/android/service/voice/VoiceInteractionSession), [AssistState](https://developer.android.com/reference/android/service/voice/VoiceInteractionSession.AssistState).

