# Winglet roadmap

GitHub issues own the current plan. The v0.1.3→v0.7 [old app plan](APP_PLAN.md) is historical;
it must not be used to decide whether a feature is missing or to override [the design guide](DESIGN.md).

## Existing baseline

The inherited v0.9.0 code already includes multi-bot chats, message search, attachments and voice,
approvals/questions/Inbox, goals/routines, projects/branching/checkpoints, agent administration,
offline cache/outbox, and several appearance/navigation choices. See [the feature inventory](FEATURES.md).
Implemented code is not proof of validation on every physical device or supported Hermes version.

## Approved work, in order

The owner approved this ordered backlog in Codex: “Do them from the top, 1-by-1, go !”.
The original backlog was merged by the owner in [PR #2](https://github.com/Broedkrummen/winglet/pull/2).

| Order | Issue | Scope |
|---|---|---|
| 1 | [#1](https://github.com/Broedkrummen/winglet/issues/1) | Atomic message delivery, retry deduplication and attachment rollback |
| 2 | [#3](https://github.com/Broedkrummen/winglet/issues/3) | Durable outbox acceptance before draft clearing |
| 3 | [#4](https://github.com/Broedkrummen/winglet/issues/4) | Reject oversized text without silently removing constraints |
| 4 | [#5](https://github.com/Broedkrummen/winglet/issues/5) | Optional Simple view with bot-first navigation and configurable opening |
| 5 | [#6](https://github.com/Broedkrummen/winglet/issues/6) | Touch targets, focus, keyboard access and browser verification |
| 6 | [#7](https://github.com/Broedkrummen/winglet/issues/7) | Fork-specific release/update identity and signing policy |
| 7 | [#8](https://github.com/Broedkrummen/winglet/issues/8) | This active issue-based roadmap and approval process |
| 8 | [#9](https://github.com/Broedkrummen/winglet/issues/9) | Locale-independent schedule tests |

All eight original items are merged. Issue comments record tests, evidence and limits; a merge is not
a published release.

## Approved follow-up

[PR #12](https://github.com/Broedkrummen/winglet/pull/12) implements the owner's additional requests,
pending owner review and merge:

- [#10](https://github.com/Broedkrummen/winglet/issues/10): custom skill creation/source installs,
  custom MCP connections and plugin/Python tools, with Settings entry points and explicit consent.
- [#11](https://github.com/Broedkrummen/winglet/issues/11): Hermes memory source/profile status,
  pending-write review, background-review configuration and clear save/forget semantics.

See [usage and limits](CUSTOM_ABILITIES.md) and [verification evidence](agent-handoffs/custom-abilities-memory.md).
Open follow-up issues remain open until the reviewed PR merges.

## Simple view

Choose **Settings → View → Simple**. Full remains the default for existing installations.
Choose Last chat, Main chat or Chat list for bot opening; change it whenever you want.
Preferences stay on this device. Guide remains the default for messages sent during work.

Desktop gets a narrow bot list; phones use a drawer. Technical controls remain in Conversation options.
Approvals, questions, Stop, offline queuing and failed-send recovery remain available. See the
[surface brief](surfaces/simple-view.md) and [validation evidence](agent-handoffs/simple-view.md).

## Approval and delivery

1. Open a proposal issue with the problem, scope/exclusions, acceptance criteria, risks and validation.
2. Record explicit owner scope approval. A bot may prepare proposals; it cannot approve itself.
3. Implement in a review branch, link commits/PR to the issue and record actual verification results.
4. Obtain owner review before merge; publish/sign a release only when separately authorized.
5. Close the issue when the approved change is merged. Report unverified device/integration behavior plainly.

## Ideas requiring new approval

Cross-device organization/preferences, backup/restore, expanded desktop shortcuts, live computer
view/takeover and full-duplex voice are not scheduled by this backlog. Each needs a concrete use case
and its own scope/acceptance discussion. Existing voice notes/hands-free turns are not full-duplex voice.
