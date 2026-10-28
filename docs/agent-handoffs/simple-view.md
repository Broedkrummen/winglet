# Simple view and accessibility validation

Validated 2026-10-28 using the disposable `scripts/demo/demo_server.py` backend, in-memory data,
and Chrome through Playwright. No Hermes instance, provider or real command was used.

## Evidence

- Desktop 1440×1000, phone 390×844 and reference-width 1070×780, light and dark.
- Final captures: [desktop light](../screenshots/simple-desktop-light.png),
  [desktop dark](../screenshots/simple-desktop-dark.png),
  [phone light](../screenshots/simple-mobile-light.png),
  [phone dark](../screenshots/simple-mobile-dark.png). All content is synthetic demo content.
- Browser checks: view/bot switching keeps drafts; options remain reachable; no horizontal page
  overflow; 48-unit composer/Stop targets; visible keyboard focus; Tab confinement and Escape focus
  restoration in the drawer; 150% text stress; offline queuing/reconnect; failed-send retry;
  immediate scoped `/stop`; cross-bot approval command and question in Inbox.
- Focused navigation, preference, composer, response-action and theme tests pass. Accessibility
  tests cover interrupted voice gestures, keyboard release/blur, drawer containment and focus return.
- Final full suites: 467 app tests pass; 656 plugin tests pass, 30 skipped. TypeScript, Expo web
  export and Android JavaScript/Hermes export pass. The packaged web app matches all 40 exported
  files; its 28 asset references resolve. Mechanical changed-markup detector returned no findings.
- Final packaged-app check confirms switching from Simple home to Full retains the draft and
  visible transcript without page errors. No additional screenshot/polish pass was performed.
- Independent Impeccable finish review scored the dark-preview and interaction fixes resolved at
  the browser evidence scope; the documentation review confirmed the incumbent design system is preserved.

## Limits

No physical Android/iPhone, screen reader, real microphone recording, or live Hermes test was run.
Android export validates bundling, not an installed APK or native device interaction. GitHub reports
no PR workflow runs/checks for the final head; remote CI is not verified.
The 150% text exercise changes browser text sizing; it does not prove native Dynamic Type behavior.
The demo's short synthetic reply and injected typing state verify interface/control routing, not a
real agent's cancellation or model execution. Desktop/phone images are browser captures.

Full view remains the default for existing preferences. Device-local settings choose Simple,
bot-opening behavior and Guide/Queue/Interrupt; no cross-device preference sync was added.
