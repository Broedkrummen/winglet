# Quoted questions and transcript tools

Status: implemented and locally reviewed; exact-head CI and Android interaction validation pending.

## User flow and contract

Completed assistant replies expose Ask about a quote in their response toolbar and More menu. A focused sheet shows read-only source text with selection, an exact-text accessible fallback, repeated-match navigation, a selected-passage preview and an optional question. Use in this chat retains the existing draft and adds a typed quote reference. Start a side question creates a real independent chat with only this quote and a visible question draft; neither action sends automatically. Existing genuine branching remains a separate optional path through the reviewed branch interface.

Capability quoted_comments is additive. Existing message POST accepts optional quote alongside reply_to. QuoteAnchor v1 contains source message/chat IDs, UTF16 start/end offsets, exact selected text and SHA256 of the full source. Server accepts completed assistant content only, validates identity/hash/complete Unicode characters/1–4000 units/exact substring, then rechecks source and destination ownership and bot scope. Only the selected text enters Hermes's existing reply context. Arbitrary HTML remains data; no remote math scripts, raw HTML rendering or URL fetches were introduced.

ReplyRef optionally retains that anchor in drafts/outbox/message metadata. Existing encrypted native cache and origin-scoped browser persistence carry it unchanged. Old clients retain ordinary reply behavior. New clients refuse a queued quote if the server lacks the capability; they never downgrade it into a full-reply reference. Accepted sends retain existing client-ID idempotency even after the original source changes.

Quote sends recheck the current bearer pairing after awaited request parsing and current device/source ownership immediately before storing. Source hash changes, removed/truncated history and streaming updates refuse the quote rather than silently moving its anchor. Dialog navigation cannot resume after unmount while a side chat is being created.

## Architecture and review

Feature-local model, platform selection adapters, QuoteSheet and backend validator; narrow wiring in hub.py, ReplyRef, store delivery, ChatView and Composer. No schema migration, signing, release or provider change. Source jumps from independent side chats navigate to the original chat; same-chat jumps use the existing focus controller.

Review server source/destination ownership and UTF16/hash validation first; inspect the old-server delivery guard, then dialog source-version/mount guards and platform-only selection imports. A side question is explicitly not a context-preserving branch. Source message text remains on the server and in the existing loaded transcript; only a bounded quote/hash/IDs are added to persisted draft metadata.

## Reference comparison / provenance

Studied reference snapshot95ca999fa48c1c9de232fe499a174900f0d25272 CommentSelection.kt and ReviewComments.kt. This is independent code, with no copied/transliterated implementation or assets.

| Reference pattern | Winglet result | Matching checks / difference |
| --- | --- | --- |
| Comment on selected passage | Exact quote plus visible composer question | UTF16/repeated selection/code/table/math/markup vectors |
| Ask aside | New independent chat, quote only | Real UI created separate chat, sent Unicode quote, transport received only quote/question |
| Selection anchor/highlights | Source-bound hash/offsets and exact preview; source jump | Edited/deleted/streaming sources refused; no permanent annotation column |
| Inline pending comments | One quote uses the existing durable reply tray | Browser full reload restored quote and question; normal cancel/edit/retry retained |
| Rich transcript | Existing safe Markdown/code/table/media renderer preserved | No TeX typesetter added; math source remains literal and selectable |

## Validation actually executed

- Focused backend quote/trust tests:43 passed; final real pinned-Hermes quote suite18 passed, including the actual inbound partial-reply prompt formatter. Cases cover forged/malformed anchors, surrogate splitting, changed source, cross-chat member/bot refusal, current role refusal, idempotent accepted retry and legacy replies.
- Full local plugin suite:613 passed,30 skipped.
- Final full client suite:425 passed,0 failed. Focused actual-store/quote tests:57 passed, including three new old-server/wire/outbox tests.
- Final TypeScript check and web export passed after the font/mount refinements. Native and web selection adapters both typecheck; Android bundle remains an exact-head CI gate.
- Actual isolated browser/storage/normal delivery: selected second repeated passage, prepared without sending, full reload restored draft, explicit Send delivered only selected quote/question. Independent Unicode side question contained no copied history; source link returned to original chat.
- DOM source-selection listener updates exact preview; it was verified with a native DOM selection event. Automated keyboard arrow navigation did not move the read-only browser caret in this environment, so primary keyboard selection is not claimed. The exact-text fallback and repeat chooser are available for keyboard/screen-reader use.
- 320/390/768/1440px: no document horizontal overflow. Light desktop and dark320/reduced-motion rendered screenshots reviewed at output/playwright/quotes16-wide.png and quotes16-phone-dark.png. Visual review caught and fixed the source textarea inheriting a serif font.
- No live provider called. QA uses real Winglet chat storage and synthetic transport replies.

## MOBILE VALIDATION PENDING

No new native module/permission. Build the integrated app and test actual Android read-only selection handles/events, scrolling, keyboard/safe-area behavior, quote chooser, composer draft process-death recovery, inline/side sends and source jumps. Include long replies, emoji, code/table text, source edits/deletions and offline/reconnect. Do not infer native selection parity from the DOM tests. Existing per-device encrypted draft storage is reused without changing keys or data.

For Codex orchestrator review.

