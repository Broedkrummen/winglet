# Custom abilities and memory

Settings → Agent abilities links to Skills, MCP, Tools and Memory for the selected bot. Owners can
also reach these screens from Agent. Server-side permissions and signed requests protect changes.

## Add Skills

Use **Add Skills** to create/paste a `SKILL.md`, or preview and install a supported repository URL or
skill identifier. The existing official catalog remains under Add more. Native Hermes preview,
security scanning and installation rules still apply; a refused scan is never forced through.
New skills are available to new sessions. This flow does not import ZIP archives.

## Add MCP

Use **Add MCP** for a remote URL or a local executable with one argument per line. Remote servers
can use no authentication, OAuth sign-in or a bearer token. Local environment entries use
`KEY=value`, one per line. The complete configuration is sealed to the paired server; credential
values are omitted from the review summary and audit log. After adding, test the connection and
reconnect MCP; use Sign in on the server row for OAuth. Existing names are not overwritten.

## Add Tool

Choose a public HTTPS plugin repository (`owner/repository` also works), or upload/paste one Python
module. The repository preview records an immutable commit; install uses that reviewed commit.
Review declared Python dependencies and explicitly choose whether to permit them and enable code.
Node sidecar dependencies still need installation in Hermes on the server.

A Python module must define `register(ctx)` and call `ctx.register_tool` with a literal tool name,
toolset, schema and handler. **Use tool template** supplies a working example. Winglet checks syntax without
executing the upload, generates a minimal plugin package, scans it and publishes it through Hermes.
The native publisher checks that the target is absent under its install lock. Multi-file modules
or additional dependencies belong in a plugin repository. Arbitrary scripts are not automatically
converted into agent tool schemas.

Enabling a plugin executes its code with the Hermes server's privileges; it is not sandboxed.
Plugins installed disabled can be enabled later using Hermes's plugin management. No code is
enabled and no Python dependency consent is supplied by default. Review previews expire after
15 minutes and belong to the selected bot and requesting device. Failed installs retain the form
so the owner can correct it and review again.

These adapters use Hermes's native interfaces. Unsupported versions report an error rather than
falling back to unsafe config writes. The implementation was checked against Hermes v0.22.5 source;
this does not establish the version running on a paired server.

## Memory

Winglet edits Hermes's built-in `MEMORY.md` and `USER.md`. Saved edits update persistent notes;
existing sessions can retain their session-start snapshot, while new sessions receive the saved
memory. Memory displays the selected profile and active external provider status separately from
the built-in entries. An unavailable status API is not treated as a healthy provider.

Pending memory proposals show their origin, target, current entry and proposed content. Owners can
approve or reject them. Approval applies the stored native proposal, not a replacement supplied by
the browser. Hermes checks pinned entries, limits and scans; refused proposals remain pending.

**Memory review settings** opens Agent configuration → Memory. Supported Hermes versions expose
agent-write approval, the memory reminder interval and background review configuration. Configured
enabled does not mean a review is currently running.

**Forget this** removes the chosen built-in note. It does not erase past chats or guarantee deletion
from an external provider. Hermes has no standalone public provider-mirroring API for this manual
edit path, so Winglet does not simulate provider lifecycle or promise complete external erasure.
