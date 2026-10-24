# Herald — checkpoint history and restore sheet

Winglet's workspace checkpoints feature adapts the interaction design of Herald's
checkpoint sheet and its data handling. No Kotlin or Compose source was copied
verbatim; behaviour, information hierarchy, edge-case handling and user-facing
wording patterns were ported to Winglet's React Native UI and Python plugin, and the
data path was rebuilt against Hermes's real `tools/checkpoint_manager.py` instead of
Herald's dashboard JSON-RPC calls.

- Source: https://github.com/Giton22/herald
- Reviewed commit: `95ca999fa48c1c9de232fe499a174900f0d25272`
- Files studied and adapted:
  - `shared/core/src/commonMain/kotlin/dev/hermeskotlin/core/chat/Checkpoints.kt`
  - `shared/ui/src/commonMain/kotlin/dev/hermeskotlin/ui/chat/CheckpointsSheet.kt`
  - `shared/core/src/commonMain/kotlin/dev/hermeskotlin/core/chat/ChatSession.kt`
    (`checkpoints`, `checkpointDiff`, `restoreCheckpoint`)
  - `shared/ui/src/commonTest/kotlin/dev/hermeskotlin/ui/chat/CheckpointsControllerTest.kt`
  - `docs/screenshots/checkpoints.jpg`

Modifications: the checkpoint list/preview/restore contract is expressed as Winglet
HTTP routes and capability flags; previews are bounded and carry a revision token;
restore requires an owner signature, a matching revision and an idempotent operation
id; Hermes's `safe` restore and pre-rollback snapshot are surfaced; transcript
rewind (`history_removed` in the reference) is intentionally not claimed.

## License

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
