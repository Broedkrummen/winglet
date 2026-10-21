# Keyboard and Home refinement

Navigation and Home presentation are superseded by `2026-10-16-chat-first-sidebar.md`. The keyboard/composer behavior below remains applicable.

The walkthrough exposed a missed keyboard regression in the main chat: its composer was absolutely positioned below Android's IME. The existing KeyboardAvoidingView did not account for Android edge-to-edge behavior, and absolute children do not reliably follow padding. The user also requested a simpler Home, reachable composer controls in the Claude pattern, bot swiping with neighboring content visible, and a quieter Chats list.

## Implementation

- A measured KeyboardViewport wraps Home and ChatView. It compares the outer viewport's screen bounds with the keyboard frame and shrinks an inner flex viewport by only the actual overlap. The composer anchors inside that smaller viewport. Already-resized native windows receive no second offset; hide/frame/rotation changes recompute it. Home drops its tab-bar clearance while typing.
- Composer is shared across Home, chats and quick ask: text above a controls row containing attachments, the named model menu and mic/send. Preserve its existing draft, attachment, reply, command, stop and busy-mode behaviors. The same chat uses the same draft across Home and chat. Focus registration keeps a stack so dismissing a chat/sheet restores the underlying composer.
- Home contains a bot carousel and bottom composer, plus a single compact link for pending requests when necessary. Remove Back to main, Make main, Crew, Continue, goals and update cards from Home; those controls/information remain in Agent, Chats, Inbox and chat goals.
- Home's bot deck follows horizontal gestures with UI-thread shared page position, continuous card depth/tilt, character parallax, a restrained landing spring and resistance at either end. Short flicks and deliberate drags advance one bot; tentative or cancelled drags return. The current pet stays mounted as it becomes a neighbor, with inactive animation loops paused. Neighboring cards, page buttons and previous/next controls make switching discoverable. Reduced motion removes tilt, scale, parallax and autonomous settling. Swiping selects the destination bot's own home chat, preserves per-bot drafts, and never changes the main-bot preference. Disable pet leaning here so it cannot swallow the page swipe.
- Chats groups pinned items, a Continue conversation and remaining recent chats without duplicates. Replace the large Updates row with a compact labeled shortcut; use underline filters and smaller row icons. Remove placeholder descriptions on empty chat rows and redundant explanatory subtitles in Appearance, Your bots and Sessions.

## Verification

Reproduce the covered composer on the physical Android phone, then check short and multiline drafts above the keyboard in Home, the main chat, secondary chat and quick ask. Exercise model opening/search/dismissal, repeated keyboard opening/closing, bot swipes in both directions, draft preservation and Continue/Updates/Archive navigation. Never send a test conversation or act on live approvals. Test viewport overlap/resizing, actual native keyboard event handling, carousel selection and focus fallback; run the app suite, typecheck and web export. Physical iOS and paired browser checks remain outside this device session.
