# Mobile chat polish and reliability

The later walkthrough changes the model-button placement and Home layout described below. Current design: `2026-10-16-keyboard-home-refinement.md` in this directory. Model controls now live inside the shared composer.

The phone audit found an unlabeled model icon competing with the message field, a picker with three repeated headings and densely wrapped chips, sheet dragging attached to scrollable content, an always-allocated tab-bar recorder, and recorder races on repeated/interrupted gestures. Model controls also replaced chat previews and incorrectly ended the local working indicator.

## Design

- Keep Winglet's theme, pets, chat history and navigation. Put a named model control with a chevron in the chat header. The chat name and connection state remain visible; the composer gains writing room.
- Model selection uses a single sheet heading, the current model and provider, searchable full-width rows, a visible checkmark and an accessible selected state. Keep the server's available models and reasoning choices authoritative. Do not invent capability rankings or silently change a model.
- The quick-ask sheet keeps a compact named model control. Its existing sheet already releases the composer after closing. Allocate the tab-bar native recorder only while a hold is in progress, including preparation and stopping.
- Sheets have an explicit close button, a drag handle separate from scrolling content, and a height constrained by the viewport and keyboard. Long content remains scrollable.
- One recorder operation at a time, including permission, preparation and stopping. Interrupted gestures, backgrounding and unmounts cancel. Failures provide feedback and the next hold can recover.
- Animate pet sprite frames on the UI thread and stop their loop in the background. Keep reduced-motion and still avatars unchanged.
- Model/thinking control cards do not end a working turn or announce a reply. The plugin leaves conversation previews and ordering unchanged when recording hidden commands or model/thinking cards.
- Follow-up density request: reduce repeated model headings, limit the model list viewport to about half the screen, tighten default row spacing, and make compact chat genuinely denser without shrinking touch targets. Align embedded approval/question/result cards with the text column in each layout; full approval commands remain readable in a bounded scroll area.
- Every completed bot text response has a persistent Copy/Reply/More footer. Copy preserves the complete original Markdown and acknowledges success; failure leaves the action available.
- Side chat options include Pin/Unpin and Archive/Restore, accessible from a visible ellipsis as well as long press. Pins appear above recent chats; archived chats have their own tab and search scope. Store organization in device preferences with bot-scoped keys, preserve messages, exclude archives from Home's Continue shortcut, and retain the dedicated main chat/Updates entries. Existing backend versions work without a deployment; organization is explicitly device-local.
- Inspect the installed Claude model menu and ChatGPT response actions on the user's authorized phone for interaction patterns. Adapt Winglet's own components rather than introducing another visual system.

## Verification

Regression tests cover overlapping holds, cancellation during startup/stopping and stop failures; model-name formatting and selection ordering/search; picker duplicate submissions and expiry. Run the app suite and typecheck. Verify chat/header, picker search/scroll, keyboard, quick-ask, long drafts, light/dark themes and narrow/wide layouts on the connected I2304 and a local web build. Do not send a conversational prompt or act on an approval during testing.
