# Mobile polish validation

Current navigation: see the final **17 October: carousel overlap correction** section and `../specs/2026-10-16-chat-first-sidebar.md`. Earlier history-filter and boxed-carousel checks below describe superseded iterations.

Follow-up walkthrough: the main-chat keyboard failure missed in the initial pass was reproduced and fixed. Current model placement is inside the composer, superseding the header placement recorded below. See the final follow-up results at the end of this file.

Validated locally on `feat/pets-presence`, 16 October 2026. The connected phone ran Winglet Dev on an I2304 / Android 16 against Winglet plugin 0.3.0 and Hermes 0.22.0. No remote upgrade, push, PR or release was performed.

## Automated checks

- App TypeScript check: passed.
- Complete app suite: **191 tests passed**. Added coverage for recording overlap/cancellation/recovery, model labels/search/provider selection, stale picker expiry and duplicate submissions, chat-target changes while sheets close, model controls preserving working status, chat organization, exact Markdown copying and clipboard failures, and approval expansion/confirmation/stale or repeated taps.
- Backend checks: **7 tests passed**, covering pet palette extraction and hidden model/thinking cards preserving chat previews/order. Existing Pillow `getdata()` deprecation warnings remain.
- Production web export: passed, `.venv/ui-polish/web-complete` (ignored local artifact). This verifies compilation; a paired browser session and iOS were not exercised.
- `git diff --check`: passed.

## Phone checks

- Inspected the installed Claude model menu and ChatGPT response action footer using the user's authorization. No prompts were sent in either reference app.
- Named header model control; compact searchable radio rows; current model visible first; model menu around half the screen; Show more visible; searching `sonnet` reveals exact IDs and remains above the keyboard. Prior checks also exercised expanding the full model list, reselecting the already-current model and thinking options. No alternate model was selected for testing.
- Quick ask: keyboard, long unsent draft, named model control, close button and drag dismissal checked. Test draft cleared.
- Chat organization: pinned an existing empty side chat, archived it, confirmed its absence from All chats, restarted the app completely, found it in Archived, and restored it. Test pin/archive state removed afterward. Message history was preserved. Main chat and Updates remain dedicated entries.
- Compact mode: smaller text and gutter, visible Copy/Reply/More, embedded approval aligned with the response column. Copy showed a green Copied state and the native clipboard confirmation. Expanding a previously denied command showed its full text; no approval action was taken.
- Default bubbles layout, light and system/dark themes checked. Original System/Iris theme and Bubbles preference restored after testing.
- Phone screenshots and local test helpers are ignored under `.venv/ui-polish`. No test conversation or approval response was sent to the live agent.

## Practical limits

- Pinning and archiving are device-local preferences and explicitly labeled that way. They do not sync across devices or stop running agent work.
- The chat-preview fix is in the local plugin code. The phone's older remote plugin still shows its existing model-control preview until that server is updated and actual conversation activity refreshes it.
- Recorder lifecycle regressions pass, and the earlier physical pet hold/release and slide-away tests established the cancellation signal. End-to-end speech transcription remains unverified: the existing conversation records a server transcription failure. Recording controls and server speech-to-text are separate paths; this pass does not claim that server issue is resolved.
- Full backend integration checks require the Hermes/aiohttp environment unavailable in this workspace; the changed preview store path was tested independently.

## Walkthrough follow-up: keyboard, Home and Chats

- Reproduced the user's main-chat issue on the same Android phone: the IME covered the entire absolute composer. A measured outer viewport now reserves only the actual keyboard overlap and lays out the chat/composer in an inner viewport. Tests also cover native windows that already resize, preventing a double offset.
- Physical phone checks passed for Home, the main bot's main chat, the secondary bot's main chat and quick ask. Multiline drafts remained readable above the IME; the final line and model/send controls stayed visible. Opening the model sheet dismissed the keyboard, preserved the unsent draft and kept the existing choices; closing/reopening the keyboard returned the composer to the correct position. All test drafts were cleared without sending.
- Swiped in both directions between Vzalyte and Alley, including across the active pet. Neighbor avatars peek into the carousel. The selected bot's name, draft, model and chat destination changed together; the main-bot preference did not change. An unsent draft survived switching away and back and opening its chat.
- Home now has a bottom composer with model/mic controls. Back-to-main, Make-main, Crew, Continue and the activity cards were removed from this landing screen. Pending requests retain one compact Inbox link. Continue is now in Chats, above remaining recent conversations, with pinned chats grouped separately.
- Chats uses slim underline filters, smaller icons, no empty-message subtitles and a compact Updates shortcut. Redundant top subtitles were removed from Appearance, Your bots and Sessions.
- Focus registration preserves the underlying Home composer when an overlaid chat or sheet closes.
- **201 app tests passed**, including four keyboard geometry tests, two actual KeyboardViewport event/resize tests, two carousel isolation/bounds tests and two composer focus fallback tests. TypeScript and the production web export passed (`.venv/ui-polish/web-home-keyboard`). No native rebuild or remote deployment was needed. Physical iOS and paired browser behavior remain untested.

## Bot deck motion follow-up (phone disconnected)

- The user rejected the original carousel's switching feel and requested a more polished character-selection interaction, with phone review deferred. The current motion design is recorded in `docs/superpowers/specs/2026-10-16-keyboard-home-refinement.md`; the original snap-list implementation is superseded.
- **206 app tests passed**, including seven deck behavior tests covering destination chat/draft isolation, drag thresholds, flicks, reversals, cancellation, interrupted position, external selection, reduced motion, single-bot navigation and resize cancellation. TypeScript and `git diff --check` passed.
- Playwright checked the rendered component using sample orb bots in an isolated local preview, in development and production builds. Mouse and Chromium touch checks passed for forward/reverse switching, a tentative drag, touch cancellation, reduced motion, external selection, page/arrow controls, a neighboring-card tap and an active-pet tap. Starting a reverse drag during a landing returned to the prior bot. Inspected light/dark, compact, 320 x 568, 390 x 844 and 900 x 650 layouts; no horizontal page overflow in the small viewport.
- Final production exports passed for Android (Hermes bytecode) and web at `.venv/ui-polish/build-bot-deck`. The initial sandboxed Hermes attempt could not write its temporary output; the host build succeeded. These are bundle exports, not a new APK installation or native runtime check.
- The temporary sample route was removed before the final exports. Its source is retained only at `.venv/ui-polish/motion-preview.fixture.tsx`; preview output, screenshots and Playwright logs are ignored under `.venv/ui-polish`. Local preview servers and the test browser were stopped. No phone, real paired server, live message or approval was used in this follow-up.
- Next physical review: confirm the native spring/drag feel, horizontal swiping across the pet versus vertical Home scrolling, repeated mid-motion reversals, custom sprite appearance and switching with an open keyboard. This pass does not claim native frame-rate measurements, physical iOS coverage or resolution of the earlier transcription limitation.

## Chat-first sidebar follow-up

- Implemented the user's navigation redesign without subagents: the current behavior and research references are in `docs/superpowers/specs/2026-10-16-chat-first-sidebar.md`. Earlier boxed deck/bottom-bar designs are superseded.
- **209 app tests passed**, TypeScript passed, and final Android Hermes/web exports passed at `.venv/ui-polish/build-sidebar-final`. Added sidebar width/history/search and lock-isolation regressions. Removed the obsolete idle bottom-bar recorder test because that navigation and its shortcut were removed; microphone cancellation tests remain.
- Physical Android checks: clean landing with top-left menu and top-right Inbox; no bottom bar or bot card backgrounds; unboxed bot dock lower above the composer; swipe both directions with each bot's matching label/model. Original main bot restored.
- Opened the drawer, filtered by the second bot's name and cleared the query. With the keyboard open, search, results and footer controls remained above it. Keyboard dismissal restored the full drawer. Swipe-left and Android Back dismissal were exercised.
- Opened Settings from the drawer, switched to Pinned and confirmed the narrow persistent rail, then restored Automatic. Opened Inbox from the landing shortcut and Agent from the sidebar. Opened the existing main conversation from recent history. No live approval, model change, new chat creation or message submission was used for testing.
- Entered an unsent test draft in the main conversation, confirmed text/model/send controls above the IME, opened navigation while typing and returned to the landing with the draft intact. Cleared the test draft afterward. Existing conversation history was preserved.
- Playwright checked the real navigation shell with isolated sample bots at 1400 x 900 and 390 x 844: full sidebar beside the composer, pinned phone rail, Drawer mode, title/bot search, and Escape dismissal. The sample-only commands request to `preview.invalid` failed as expected; no paired server was used in this browser check. Browser/sample route removed from app source after testing; archived fixture and QA artifacts remain ignored under `.venv/ui-polish`.
- App lock now covers the entire navigation shell. A regression verifies immediate removal of an open drawer and pinned rail while locked, disabled underlying content, and rejection of a stale open callback. Physical authentication behavior and iOS were not exercised.
- Dev remains running on port 8081 for the connected phone's walkthrough. No native APK installation, remote backend update, push, PR or release was performed. The previously documented transcription/server-plugin limitations remain.

## 17 October: dock actions and drawer refinements

- Updated the current chat-first specification for the larger pets, keyboard-following dock, New chat/Add a bot pages, grouped sidebar cards, removal of the sidebar bot selector and 72%-width drawer. The drawer's full-width keyboard wrapper was intercepting outside taps; bounding it to the drawer restores backdrop dismissal.
- **211 app tests passed**, TypeScript passed, and Android Hermes/web exports passed at `.venv/ui-polish/build-dock-actions`. Deck tests cover action-page order (including a single bot), explicit confirmation, existing main draft preservation, cancellation, resize, interrupted gestures and switching. Drawer geometry checks cover the phone proportion and desktop cap.
- Physical Android checks passed with the IME open: enlarged pets, names and page controls remained above the composer; switching to the secondary bot kept the keyboard open and showed its own empty draft; switching back restored the unsent main-bot draft. The test draft was cleared without sending.
- Inspected the narrower sidebar and separate conversation/history/workspace cards, confirmed the footer bot selector was absent, and tapped the exposed backdrop to close it successfully.
- Swiped to New chat on the main bot's left, then through the main and secondary bots to Add a bot. Swipes did not create a chat or bot. The Add a bot confirmation opened the existing create/QR/code options; dismissed it without changing pairing. Returned to the main bot with the keyboard closed and no test draft.
- Screenshots and helpers remain ignored under `.venv/ui-polish`. No message, approval action, model change or new chat/bot creation was performed. Physical iOS and native frame-rate measurements remain untested; new-chat creation reuses the existing action and was not exercised against the live server. Dev remains on port 8081 for the user's review.

## 17 October: inline conversations and sidebar finish

- The current specification now records same-page landing conversations, the main-bot-only New chat composer, history-card search, sidebar chat actions, subtle glass surfaces and the revised pinned rail. The earlier New chat footer button is superseded.
- **218 app tests passed**, TypeScript passed and Android Hermes/web exports passed at `.venv/ui-polish/build-inline-chat`. Added regressions for lazy creation, shared pending creation across controls, latest-draft transfer, failure/retry, optimistic/server message reconciliation, late historical pages, missing anchors and deferred model-sheet destinations. Reselecting an active action page no longer resets a prepared draft conversation.
- Playwright exercised the actual Home/ChatView/Composer against isolated sample bots: ordinary input sent to the existing main chat without creating a new one; the URL and composer DOM element stayed unchanged; the reply appeared in place and old history remained hidden. New chat selection and typing created nothing, the first send created exactly one main-bot side chat, and the next send reused it with both replies visible. Sample message reconciliation replaced optimistic IDs with server IDs. Inspected the resulting conversation at 390 × 844.
- Physical Android checks: New chat has the shared text/model/attachment/mic composer for the main bot, and its dock stays above the IME. Inspected the glass sidebar, search inside the history card and three-dot chat menus exposing pin/archive/rename/delete. Opened and dismissed a menu without applying an action; outside-tap drawer dismissal still worked. Temporarily selected Pinned, inspected the active accent tile, edge marker and grouped icon rail, then restored the observed Drawer preference.
- No real message, chat creation, model change, archive/delete or approval action was performed in this pass. Actual creation/sending were tested only with sample store actions; live server speech transcription and physical iOS remain outside this validation. Existing main-chat archive/delete protections are preserved.
- Removed the temporary sample route before the final exports and archived it at `.venv/ui-polish/landing-preview.fixture.tsx`; browser scripts/screenshots remain ignored there. Closed the sample browser and stopped only its port 8084 server. The connected phone's port 8081 Dev server remains running for review. No APK install, remote backend update, push, PR or release was performed.

## 17 October: navigation stability, full history and composer commitment

- Reproduced the user's stuck sidebar on the connected Android phone: backdrop, close button and Android Back left the native overlay visible. Replaced it with a bounded app-window overlay, immediate release on close and an explicit Back handler. Physical repeat checks passed for outside tap, close button, Back and navigation. Choosing Chat resets the landing without changing persisted drafts/history.
- Fixed the Add bot reset: switching previously remounted the carousel, whose mount effect selected the previous bot. Home now controls the page and retains one chat shell/carousel. Mounting an action page cannot emit an unsolicited bot selection; reselecting an active action page cannot reset a prepared chat.
- The user's updated history requirement supersedes the prior turn filter. The landing stays blank initially, then a send reveals all loaded history and ordinary older-page loading in the same view. Removed the timestamp/optimistic-anchor filter and its obsolete tests.
- Focusing the composer hides and disables neighboring bots and action pages. A measured pet transition settles the selected character above the composer; sending triggers a short hop. It stays perched after sending and on existing chat routes, with message spacing reserved above it. Reduced motion skips travel; hidden deck pets pause and memoization avoids unnecessary dock, pet and list renders.
- With the user's explicit authorization, sent **one `hi` to the main bot** from the clean landing. Confirmed the real reply, preceding messages on the same screen, readable controls/pet above the keyboard and scrolling to older messages. No other test message was sent. The server produced its own normal follow-up activity; no approval or configuration action was taken.
- Add bot stayed selected well beyond the reported two-second interval. Opened its existing options and the empty Create bot form, then returned to the Add bot page. No bot was created and no pairing was changed. Screenshots and native UI hierarchy diagnostics remain ignored under `.venv/ui-polish`.
- **222 app tests passed**, TypeScript and `git diff --check` passed, and Android Hermes/web exports passed at `.venv/ui-polish/build-chat-stability`. Added component regressions for full-history revelation, focused dock interaction/accessibility, action-page retention, isolated new-chat history, and drawer release without animation callbacks. Existing cancellation, creation/retry and app-lock checks remain.
- Physical iOS and native frame-rate profiling remain untested. No native APK install, backend update, push, PR or release was performed. The phone's Dev server stays running on port 8081 for review.

## 17 October: carousel overlap correction

- Captured the user's reported failure: the full bot dock and its selected pet were visible on top of conversation messages while the separate perched pet was also visible. The prior opacity-only hiding left the carousel mounted in the message layer.
- Conversation mode now removes the carousel subtree. Focused, unsent composition retains its dock state with `display: none`; zero-size hidden layout events cannot overwrite the stored dock width/height. Removed the independent animated-opacity visibility state. Pet travel remains animated separately.
- **223 app tests passed**, TypeScript and `git diff --check` passed, and Android Hermes/web exports passed at `.venv/ui-polish/build-carousel-visibility`. Regressions assert that a revealed conversation contains no dock subtree, including after a failed message, stop command and keyboard dismissal; focused decks are hidden through native layout regardless of animation state.
- Restarted Winglet Dev from a cold process without clearing data. Sent one authorized `hi` to the main bot, inspected its reply and the earlier stopped-turn history, dismissed/reopened/dismissed the keyboard, and captured the repaired conversation with only its perched pet and no carousel. The short reply completed before a live Stop tap was available; the stop-state transition was exercised by the component regression instead. No additional live stop, bot creation, model change or approval action was performed.
- Screenshots remain ignored under `.venv/ui-polish/shots`, including `current-bug-user-screen.png` and `overlap-final-fixed.png`. The phone is left on the repaired conversation and Metro remains on port 8081. Physical iOS and frame-rate profiling remain untested; no APK installation, backend change, push, PR or release was performed.

## 21 October: release review

- Reviewed navigation/lock isolation, landing and new-chat destinations, keyboard geometry, pet visibility, model/approval guards, recording cancellation and preview updates before preparing v0.5.0. Corrected the Default model screen's stale instruction to point to the model name inside the message box. Local audit scratch files and phone captures are excluded from the release.
- Fresh checks: **223 app tests passed**, TypeScript passed, and **282 plugin tests passed with 17 skipped** in the local environment. The real-Hermes cases remain CI's responsibility. The only local plugin warning was the existing inaccessible pytest cache directory.
- Android Hermes and web exports passed at `.venv/ui-polish/build-release-final`. The first sandboxed attempt could not write Hermes bytecode to its temporary directory; the host run completed successfully. Confirmed release configuration uses the regular Winglet package, version 0.5.0 and Android versionCode 500.
- The staged source/documentation scan found no credential-pattern matches. Earlier physical Android checks above remain the device evidence; no fresh phone run was claimed during release preparation. Physical iOS, native frame-rate profiling and server speech transcription retain their documented limits.
