# Winglet product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Users

This fork first serves its owner's personal desktop and phone use across several bots.

## Product Purpose

Talk to self-hosted Hermes agents, resume their work, and answer requests from a phone or browser.
Success means reaching the intended bot quickly and understanding whether work needs attention.

## Operating Context

Expo/React Native serves Android and web; iPhone uses the installable web app. The Python plugin runs
inside Hermes. Connectivity can be intermittent. Bots can keep working while the app is closed.

## Capabilities and Constraints

Chats, approvals, questions, routines, goals, files, voice and administration already exist.
Simple and Full are presentation modes over the same conversations and delivery state.
Simple has one bot per navigation row. Its bot-opening behavior is changeable in Settings.
Messages guide ongoing work by default; the existing busy-mode preference remains configurable.
View and navigation preferences are local to each device. Multi-device preference sync is not included.

## Brand Commitments

Keep Winglet's identity. Simple view uses the supplied messenger reference for restrained bubbles,
compact bot identity, and quiet bot navigation in light and dark themes. Full keeps its current design.

## Evidence on Hand

The owner's reference screenshot and confirmed decisions are in the Codex chat. Existing visual
authority is docs/DESIGN.md; screenshots are under docs/screenshots. No demand or usability study exists.

## Product Principles

- Preserve drafts and delivery identity across interruption and view changes.
- Keep approvals, failures and Stop understandable and reachable.
- Reveal advanced controls when requested rather than adding permanent navigation.
- Extend the current native/web architecture and semantic tokens.

## Accessibility & Inclusion

Support keyboard navigation, named controls, enlarged text, reduced motion and generous touch targets.
Physical-device and screen-reader verification must be reported separately from browser evidence.
