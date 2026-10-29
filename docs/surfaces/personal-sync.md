# Personal sync

Mode: Operate. Extend the existing Winglet settings world in `../DESIGN.md`; no new palette, typography or shell.

## Purpose

One person links desktop and phone to one designated Hermes sync home. Being another server owner is not enrollment. The person can inspect linked devices, invite one explicitly and revoke access.

## Surface

- Settings → Sync opens the normal adaptive settings column, in either Simple or Full view.
- Before enrollment, choose a paired server and create a home or paste a single-use invitation from another device.
- After enrollment, show connection state, pending changes, choices needed and linked devices. Expose manual refresh and a short-lived invitation without persisting its token into synced state.
- Conflicts show each exact candidate, its device and timestamp. Expand long values; select a candidate or combine text. A stale choice must refresh the conflict rather than silently win.
- Keep unresolved choices discoverable in the Settings row. Never steal typing focus or navigate in response to incoming state.
- Below setup, expose retained-file recovery for removed pairings on each paired bot. Load explicitly, paginate, offer Download before an explicit two-step Release. Explain that storage release neither stops execution nor proves delivery. Hide results while locked and reject stale paired endpoints.
- Shared submission recovery lists bounded frozen previews from the private sync group. Label target-message confirmation separately from task completion. Offer private file Download and explicit shared-source-pin Release; explain that local drafts, outboxes and copies have separate retention. Preserve stable submission identifiers and pagination. Clear displayed summaries when the home or lock changes.

## Boundaries

Incoming text waits while its composer is active. Its unseen revision cannot become the base for the person's next edit. Pairing credentials, biometric lock and granted device permissions stay local. Quiet status and explicit recoverable errors cover offline, locked, revoked and storage-failure states.

Disconnect stops this session immediately, even when persistence fails; explain the recovery needed before a restart. Unlink revokes server membership. Neither action silently destroys local drafts or the recovery journal.

This delivery checkpoint supports portable preferences, text/file drafts, replies and shared submission IDs. Read/resume, remaining libraries and complete file recovery remain governed by the approved implementation plan. Do not describe the whole feature as finished until that acceptance is verified.

## Verification

Preserve themed grouped rows, current spacing, 44–48 dp actions, keyboard focus and accessible field labels. Inspect desktop and phone layouts together in light and dark themes. Actual device checks are separate from exports or phone-width Chromium screenshots.
