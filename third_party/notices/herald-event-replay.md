# Herald reuse notice — event replay

Winglet's resumable event stream (`plugin/event_replay.py` and
`app/src/features/event-replay/`) is an adaptation of the replay semantics in Herald, a separate
Kotlin Multiplatform client for Hermes. The code was rewritten for Winglet's Python plugin and
TypeScript/React Native app; no Kotlin source is copied verbatim, but the protocol decisions below
are derived from Herald's implementation and tests and this notice is included as required.

- Source: https://github.com/Giton22/herald
- Reviewed commit: `95ca999fa48c1c9de232fe499a174900f0d25272`
- Upstream files read and used as the behavioural reference:
  - `shared/core/src/commonMain/kotlin/dev/hermeskotlin/core/chat/EventReplay.kt`
  - `shared/core/src/commonTest/kotlin/dev/hermeskotlin/core/chat/EventReplayTest.kt`
  - `shared/core/src/commonTest/kotlin/dev/hermeskotlin/core/chat/ChatSessionResumeTest.kt`
  - `docs/ROADMAP.md` (the "exact event replay after reconnect" entry)
- Upstream licence: MIT (below).

## What was reused or adapted

- Monotonic per-stream `seq` stamped on every event, with a client cursor that only advances past
  events it has already applied, and the rule that an already-applied seq is skipped when a replay
  overlap hands it back.
- A stream `epoch` identifying the sequence space: a restart or a reset that counts anew must be
  refused rather than interpreted, and a `latest` below the client's cursor is treated as the same
  restart seen without an epoch.
- Refusing a replay when the retained window lost events (`truncated`), when sequence numbers have a
  hole, or when an event belongs to another scope; the caller then reloads authoritative state
  instead of guessing.
- `latest` may be ahead of the returned events because an event can be stamped between reading the
  window and reading the head; the client leaves those to the live stream.
- The client-side pattern of applying replayed events through the same reducer as live frames,
  dropping duplicates by seq, and keeping the transcript refetch as the fallback.
- The "reconnecting / waiting for network" presentation, adapted to Winglet's restrained sync chip
  instead of a chat-level spinner.

## Modifications for Winglet

- The stream is one durable SQLite journal per `(server, bot)` rather than an in-memory ring per
  runtime session, so a disconnect survives a plugin restart.
- Filtering is per device at replay time (role and chat ownership), with a server-issued watermark
  and an explicit `ok:false` reason plus a scoped snapshot endpoint; Herald's reply has no
  per-device authorization because its gateway serves one user.
- Sequence gaps caused by per-device filtering are normal in Winglet; the cursor advances to the
  server's watermark rather than to the last event, which Herald does not need.
- Oversized payloads are replaced by a `sync.hint` instead of being dropped entirely.

## MIT licence text

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
