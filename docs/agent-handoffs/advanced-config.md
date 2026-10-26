# Advanced configuration — implementation and review

Status: implemented and locally reviewed; PR CI and native interaction validation pending.

## Contract and ownership

- Capabilities: config_catalog, config_validate, config_edit, gated by the actual Hermes schema, configuration reader, atomic writer and mutation-lock availability.
- GET /api/config/catalog: currently verified owner, read-only non-secret allowlist.
- POST /api/config/preview and /api/config/apply: signed owner requests; derived current bot context; fresh token, role, verification and bot checks before work, at the write boundary and before returning.
- Request: revision plus a flat changes mapping of allowed keys to typed values. null explicitly resets that key to inherited defaults.
- Revision binds the actual config path, exact file bytes, effective allowlisted values and managed policy. A repeated/stale apply conflicts rather than re-executing. Mutations never enter the offline outbox.
- No migration, new credentials or secret storage. YAML stays with Hermes; writes use its comment-preserving atomic replacement under the existing mutation lock.
- Audit stores changed key names only, with no values or raw YAML.
- Shared wiring: hub route policy/routes/capabilities/handlers; hermes_api scoped wrapper; Agent navigation. Everything else is feature-local.

## UI and supported scope

Agent → Agent configuration. Search Context, Memory and Execution, open one focused sheet, retain local per-bot drafts, review exact before/after changes, then apply explicitly. The user can reset a field or deliberately discard drafts and reload. Offline values remain readable and mutations are disabled. Managed installation/field policy is read-only. Unknown or secret fields are never returned; existing provider/persona/tools/MCP editors remain in place. There is no raw YAML editor.

Ten supported non-secret settings cover max turns, file read limits, memory/profile enablement and budgets, and automatic compression/threshold/target/recent-message protection. The real pinned Hermes uses null for automatic max turns; the UI displays Automatic rather than inventing a number. Context changes invalidate the cached agent next turn; memory/file settings conservatively advise a new chat. The gateway is never restarted.

Drafts survive route and bot switches within the running application session. They are intentionally not written to disk and are not promised across process death or a full browser reload.

## Reference comparison and provenance

Reference snapshot95ca999fa48c1c9de232fe499a174900f0d25272, ConfigCatalog.kt and ConfigApi.kt were studied. This is an independent Python/React Native implementation; no reference code/assets were copied or translated.

| Reference behavior | Winglet result | Evidence/difference |
| --- | --- | --- |
| Searchable typed sections | Three focused sections using Winglet list rows and sheets | Browser at320/390/768/1440px, no document horizontal overflow |
| Profile-scoped partial saves | Current authenticated bot's raw YAML is patched, unknown fields/comments retained | Real pinned-Hermes comment/unknown-field test and actual UI save30→40 |
| Schema-driven broad catalog/raw YAML | Ten field allowlist intersected with actual Hermes schema | Secrets, providers, generic YAML and unsupported keys excluded deliberately |
| Inherited values/reset | Explicit reset removes only that override | Type/default/reset tests; managed values read-only |
| Concurrent edits | Reviewed revision conflict plus fresh authorization | Stale apply, external-edit-at-write-boundary and revocation tests |

## Validation actually executed

- Real pinned Hermes targeted suite:19 passed (including actual atomic YAML preservation).
- Full plugin suite:596 passed,30 skipped in this local environment.
- Full client suite:416 passed,0 failed.
- TypeScript typecheck passed.
- Clean web export passed; no native runtime evidence is inferred from the export.
- Disposable browser used real pinned Hermes configuration and owner signing. Reviewed and applied max turns30→40; verified the exact fixture YAML retained its comment and unrelated extension.
- Search worked; offline mode retained a0.8 threshold draft and disabled Review.
- Light desktop and dark/reduced-motion320px screenshots visually reviewed. Four widths measured without horizontal overflow.
- Evidence remains local: output/playwright/config13-wide.png and config13-phone-dark.png. Final source refines effect-timing labels after those representative captures.
- Existing trust tests pass. No live Hermes provider, global model, personal config, phone subscription or signing identity was changed.

## Review and limitations

Review plugin/advanced_config.py validation/revision/write boundary first, then hub fresh authorization and scoped hermes_api wrapper, then per-bot draft/request-generation guards. There is no claim of a transaction spanning filesystem writers that ignore Hermes's mutation lock: observed external edits are rejected before the atomic replacement; an uncoordinated external write in the final OS scheduling interval remains a filesystem limitation.

The optional local pinned test skips without Hermes; the pinned CI job must execute it. Normal Windows/Linux plugin jobs still exercise fake-backed validation and HTTP trust tests. No generated plugin/web bundle or new release is part of this feature PR.

## MOBILE VALIDATION PENDING

Build the integrated app after code review. In a disposable Hermes home, open Agent configuration on Android, test keyboard/safe-area scrolling, change a numeric field and a toggle, review and apply, reset, switch between two bots with distinct drafts, background/return, and disconnect/reconnect. Confirm only the selected bot file changes, managed fields remain read-only, and the production pairings/data remain intact. This feature adds no native module; Android export/build and physical interaction checks remain separate evidence.

For Codex orchestrator review.

