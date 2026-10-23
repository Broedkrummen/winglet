# Herald reuse notice: projects

Winglet's projects feature adapts behavior and small algorithms from the Herald reference app.
This notice covers the material first added by the projects feature PR. It is kept separate from
other feature notices so the orchestrator can consolidate credits later without losing the required
attribution.

- Upstream: https://github.com/Giton22/herald.git
- Reviewed snapshot: `95ca999fa48c1c9de232fe499a174900f0d25272`
- Local read-only review clone used: `C:\Users\vikas\AppData\Local\Temp\winglet-reference-review-20261023`
- Upstream license: MIT, Copyright (c) 2026 Giton22 (full text below)

## Files reviewed and what was reused

| Upstream file | Use in Winglet | Modifications |
| --- | --- | --- |
| `shared/core/src/commonMain/kotlin/dev/hermeskotlin/core/projects/ProjectIndex.kt` | The concept of a chat→project index and of excluding the unfiled "Home" bucket. | Reimplemented in TypeScript in `app/src/features/projects/logic.ts`. Winglet chats have stable ids, so Herald's compression-lineage lookup is not needed. Projects are Winglet SQLite rows, not gateway-discovered folders. |
| `shared/core/src/commonMain/kotlin/dev/hermeskotlin/core/projects/ProjectsApi.kt` | Project shape (id, label, position/count, user-made vs discovered), deterministic ordering, and the rule that a user-made project may be empty while discovered groupings are not shown. | Rewritten as `plugin/projects.py` and the Winglet project API. No `complete.path` folder picker, no automatic cwd/git-root discovery, and no gateway `projects.*` JSON-RPC calls. Winglet uses revisions, signed device requests, owner/member visibility and SQLite persistence. |
| `shared/ui/src/commonMain/kotlin/dev/hermeskotlin/ui/sessions/ProjectDialogs.kt` | Project actions sheet, new/rename dialogs, name validation, and delete copy that says chats stay and are grouped again. | Adapted into `app/src/features/projects/ProjectSheets.tsx` with Winglet's `Sheet`, `Field`, `Button` and theme tokens. Winglet has no folder path field; delete explicitly preserves chats and their Hermes sessions. |
| `shared/core/src/commonMain/kotlin/dev/hermeskotlin/core/threads/Threads.kt` | Ordering helpers (`moved`, `ordered`) and the idea that an order change should tolerate entries a narrowed view does not show. | Adapted as `movedOrder` and `applyOrder` in `app/src/features/projects/logic.ts`. Winglet reorders project folders, not session threads; concurrency is guarded by `layout_revision` on the server. |
| `shared/core/src/commonMain/kotlin/dev/hermeskotlin/core/threads/ThreadsRepository.kt` | The distinction between a named persistent thread and its current execution session, and the care taken to roll back a failed change. | Winglet treats an existing chat as the persistent thread and keeps Hermes sessions inside it. This increment does not add Herald's "start fresh" session-swapping UI or its cwd field. Client project mutations are optimistic with explicit rollback. |
| `shared/ui/src/commonMain/kotlin/dev/hermeskotlin/ui/sessions/ThreadRows.kt` | Sidebar/list section concepts for showing named threads separately from other chats. | Winglet uses a compact collapsible Projects section in its existing sidebar, plus project screens and a project chip in the chat header. No separate Threads section was added. |

No Herald source file was copied verbatim. The adapted algorithms and user-facing concepts remain
under Herald's MIT license, reproduced below.

## MIT license text

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
