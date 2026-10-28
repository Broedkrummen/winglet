# Custom abilities and memory validation

Approved scope is tracked in [#10](https://github.com/Broedkrummen/winglet/issues/10) and
[#11](https://github.com/Broedkrummen/winglet/issues/11). See [usage and limits](../CUSTOM_ABILITIES.md).

## Evidence

- Full app suite: 467 passed. Full plugin suite: 667 passed, 30 skipped.
- TypeScript, Expo web export and Android JavaScript/Hermes export pass.
- All 40 packaged web files match the export; all 28 referenced assets resolve. Notices and diff checks pass.
- New server regressions exercise signed-owner permission, sealed MCP configuration/audit redaction,
  selected-profile handling, device/profile-bound single-use previews, pinned repository install consent,
  raw-module validation without execution, native publication's absent-target condition, pending-write
  refusal/rejection and configuration controls. Fake installers/providers prevent real code installation.
- Chrome checks against a disposable in-memory backend verify Settings links, custom skill preview
  failure/recovery and create flow, Python upload/template and explicit enablement, Edit preserving
  form input, separate review stage, pending memory approval, save semantics and sealed MCP submission.
  Final run reported no page errors or horizontal page overflow at phone width.
- Batched desktop 1440×1000 / phone 390×844 captures used light and dark themes. All content is synthetic:
  [skill review](../screenshots/custom-skill-mobile-light.png),
  [Python tool review](../screenshots/custom-tool-desktop-light.png),
  [MCP review](../screenshots/custom-mcp-mobile-dark.png),
  [memory review](../screenshots/memory-review-mobile-dark.png).
- Independent Impeccable finish review scored both identified fixes resolved in the confirmation pass.
  The changed-target detector returned no findings; documentation review confirms the incumbent system
  and tokens remain intact. The two-pass visual review is complete.

## Limits

Native interfaces were inspected against local Hermes v0.22.5 source. No real plugin/skill was installed,
MCP server contacted, external provider invoked or real memory/configuration changed. The browser's
fake backend proves UI/routing behavior, not a live server's package installation. No physical Android,
iPhone, screen reader or installed APK verification was performed. GitHub PR CI is reported separately.

External-provider erasure is not promised. Node sidecar dependencies and later activation of a plugin
deliberately installed disabled use Hermes's management tools. Configured background review is not
presented as live execution status.
