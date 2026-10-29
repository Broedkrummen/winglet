# Task presets

Feature #5 is in progress under issue #15. This checkpoint implements typed definitions, deterministic server rendering and private immutable version history. It does not yet expose a preset editor, apply drafts or attach preset snapshots to sent messages.

## Definition contract

Personal-sync `preset` records accept a `definition` and logical `removed` flag. A definition contains a version identifier, name, template and up to 20 typed inputs. Optional references identify an exact provider/model, reasoning value, source-scoped project and up to 64 capabilities. Unknown keys, including permissions and credentials embedded as configuration fields, are refused. References do not grant access or enable anything.

Input names are unique lowercase identifiers. Supported types are text, finite safe number, boolean and choice. Each input declares whether it is required and may supply a validated default. Choices are distinct, with at most 50 values. Text inputs are limited to 8,000 characters, names/labels to 160 and templates/rendered prompts to 32,000.

Templates use `{{input_name}}`. Unknown or malformed placeholders are refused. Substitution is a single literal pass: braces, shell syntax and commands inside an input remain ordinary text. Missing required values, wrong types, unknown choices, empty output or expanded size overflow return errors without producing a partial draft. Rendering makes no tool, model or permission changes.

## Version history

Each meaningful definition edit must use a new version identifier. The sync transaction records each exact definition in private history. Reusing a version with different contents returns 409; editing the current definition does not rewrite old versions. Concurrent definition edits continue to use the existing explicit field conflict chooser.

`GET /api/user-sync/{group_id}/presets/{record_id}/versions/{version}` returns an immutable definition only to a current owner member of that private sync group, with `Cache-Control: no-store`. Unknown versions return 404 and nonmembers/revoked members are refused. The group retains at most 10,000 versions; reaching the limit keeps existing history rather than silently deleting it.

## Remaining integration

Build the synced editor/library and typed input form, validate referenced capabilities/models/projects against the selected target, and preserve the current draft on failure. Applying prepares a reviewable draft only. Explicit Send must retain the selected definition version and inputs with the resulting message, without granting permissions, changing global defaults or executing during import/startup. Existing composer and model/reasoning controls remain the integration points. Test stale references, concurrent edits, historical-run stability, offline recovery and desktop/phone behavior before calling this feature complete.
