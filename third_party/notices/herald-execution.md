# Herald — structured execution notice

This notice covers material reused or adapted from Herald for Winglet's structured task activity
feature (`docs/agent-handoffs/execution.md`). Winglet's implementation is a TypeScript/React Native
and Python port, not a copy of Herald's Compose UI or Kotlin transport.

- **Source:** https://github.com/Giton22/herald.git
- **Reviewed snapshot:** `95ca999fa48c1c9de232fe499a174900f0d25272`
- **Upstream license:** MIT (full text below), Copyright (c) 2026 Giton22
- **Files studied and used:**
  - `shared/core/src/commonMain/kotlin/dev/hermeskotlin/core/chat/Subagents.kt`
  - `shared/core/src/commonMain/kotlin/dev/hermeskotlin/core/chat/Todo.kt`
  - `shared/core/src/commonMain/kotlin/dev/hermeskotlin/core/chat/ToolDetails.kt`
  - `shared/ui/src/commonMain/kotlin/dev/hermeskotlin/ui/chat/SubagentCard.kt`
  - `shared/ui/src/commonMain/kotlin/dev/hermeskotlin/ui/chat/TodoPanel.kt`
  - `shared/ui/src/commonMain/kotlin/dev/hermeskotlin/ui/chat/SessionControlPanel.kt`

## What was reused or adapted

- The task/subagent/plan status vocabulary (running, queued, completed, failed, interrupted →
  cancelled, unwatched, unknown) and the rule that an unknown end is never rendered as success.
- Bounded live activity: at most 24 lines kept upstream, 12 in Winglet; each line clipped, identical
  repeated lines collapsed, and subagent activity reconstructed from the stop hook's metadata-only
  `tool_call_history`.
- Plan tree flattening: items in list order under their parent, with a depth cap and a flat fallback
  for dangling parents or cycles.
- Subagent row projection: live subagents carry their id for control, finished ones do not; children
  are nested under their parent with a bounded depth; finished rows fold their detail.
- The calm card hierarchy: status disc + goal + meta line, one-line glance while collapsed, nested
  rule for children, expanded Activity/Result sections, and the "what went wrong" framing for failures.
- The progress panel's plan bar (done over non-cancelled steps), the live elapsed clock, and the
  in-place Stop control.

## Modifications

- Rewritten in TypeScript (`app/src/features/execution/`) and Python (`plugin/execution.py`) against
  Winglet's own transport: a messaging-platform plugin's observer hooks, `/api/task`, and namespaced
  `task.*` socket events. Herald's dashboard JSON-RPC session protocol is not used.
- Identity comes from Hermes's authoritative `turn_id`, `tool_call_id`, `child_subagent_id` and
  session ids rather than transcript positions.
- Tool arguments and results are not stored; Winglet keeps only a redacted preview and a bounded error
  line. Herald's `ToolDetails` formatting for arguments/outputs was studied but its payload retention
  was deliberately not adopted.
- Per-subagent cancellation is not exposed: the pinned Hermes offers no targetable child-cancel
  operation to a messaging adapter. Herald's per-subagent Stop therefore has no Winglet counterpart.
- Winglet's theme tokens, sheet, typography, icon set and accessibility conventions replace Herald's
  Compose design system. Status is always icon + label, not colour alone.
- A finished turn's strip lingers for 60 seconds so its outcome is discoverable; Herald keeps results
  in the transcript's delegation cards instead.

## Upstream license

```
MIT License

Copyright (c) 2026 Giton22

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
