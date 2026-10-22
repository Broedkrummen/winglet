# Stability fixes — 22 October 2026

This pass addresses the reported model selection, incorrect model labels, excessive notifications,
and inconsistent server settings pages. The bundled web app includes the repaired UI.

## Models

- Removed Winglet's 50-model chat-picker and 80-model default-picker truncation.
- Merge Hermes's complete cached inventory into the limited preview provided by its slash command.
- Allow exact custom model IDs on configured providers in both the conversation and default pickers.
  Hermes still validates and applies the model change.
- Keep authenticated custom endpoints available even when their catalog is empty.
- Use the same model search and ordering in both pickers; disambiguate same-named vendor IDs.
- Report a cached agent's actual model after a fallback, and refresh the displayed model after replies,
  choices, bot/chat changes and opening the picker. Keep the displayed provider paired with its model.
- Keep failed choices retryable and report errors instead of successful selections. Concurrent taps
  return a busy response without expiring the choice being applied.

## Notifications

- Notify on final replies rather than pauses in a stream. Repeated final edits stay silent.
- Preserve a message's explicit silent flag across edits; keep picker cards, tool progress, status
  messages, inbox cards and routine-result messages out of ordinary reply alerts.
- Notify other subscribed devices even when one phone is using the app. Foreground suppression is
  per device rather than global.
- Avoid replaying background toasts and expired inbox events on returning to the app.
- Share notification settings and subscription controls across bots belonging to one Hermes server.
- Serialize preference saves, preserve existing mutes when saving before the first load, and ignore
  older reads that arrive after a newer save.

## UI and forms

- Give 15 server settings pages a shared bot scope. Switching bots starts fresh page state and forms;
  late responses for the previous bot cannot populate the current page. Unpaired pages offer pairing.
- Show the controlled bot consistently in the page header and dismiss the keyboard when scrolling.
- Make provider, memory, routine and add-bot forms scroll when the available space is limited.
- Reset provider-key drafts when changing providers; expose a retry action on persona load failures.
- Ignore stale log-filter and schedule-parser responses. Require a valid schedule preview before saving.
- Preserve accessibility labels on non-interactive cards.

## Validation

- Plugin suite: **296 passed, 17 skipped**. The skips require optional Hermes integrations or platforms.
- App suite: **233 passed**, including regressions for the reported failures and preference-save races.
- TypeScript typecheck, production web export, Android export with Hermes bytecode and bundled asset
  validation passed.
- Isolated production-browser preview: searched and selected the last entry in a 502-model catalog,
  entered and selected a custom model, and verified that the composer label changed.
- All 23 main routes rendered at 390 × 844 with no JavaScript exceptions or document-level horizontal
  overflow. Desktop model-selection interaction was also checked.

Browser verification used a disposable local database and fake Hermes/provider services, with no live
model calls or changes to an existing Hermes installation. Physical Android/iPhone behavior, actual
provider credentials and real push-provider delivery still require device/server validation. These
checks establish coverage for the repaired paths; they are not a guarantee that every possible bug is gone.

## Pre-merge review

The review also covered reply updates arriving during a newer turn, failed provider/vendor changes
with the same model name, and failed selections before a chat has a resolved model. These now remain
silent or report failure correctly. Notification deduplication remembers individual messages so an
older final edit stays silent after a newer reply. App, plugin, lockfile and server API versions are
aligned at 0.5.1 and checked together in CI.
