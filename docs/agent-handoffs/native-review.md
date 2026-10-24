# Combined feature review and Android validation

Reviewed integration: `441f26b4ded0b26e96e2354671196d81816ed35b` plus the
small fixes on `codex/major-features-native-polish`.

All four feature PRs are merged into `codex/major-features`: projects #46,
execution #43, branching #44 and checkpoints #45. Their final exact heads passed
all four CI checks before merge, including pinned Hermes, Windows/Linux plugin
tests and web/Android exports. Combined checks: 399 plugin tests passed (21
skipped), 115 focused actual-Hermes/feature-route tests passed, 317 app tests
passed, and app typecheck passed.

## Device evidence, 24 October 2026

Physical Android I2304, authorized USB debugging. Used the existing separate
Winglet Dev package and Metro; production app, signing identity and pairings
were preserved. The loopback-only disposable fixture uses real pinned Hermes
SessionStore, SessionDB and CheckpointManager. Replies and task events are
explicitly synthetic; no model provider or remote personal server was called.

- Created Native-QA through the phone's signed project action. Confirmed the
  SQLite project row and immediate native navigation/sidebar update. The name
  field, keyboard and primary action remained reachable.
- Regenerated a reply into a new branch from the native message menu. Confirmed
  a real Hermes child session and copied prefix; the original four messages
  stayed intact. The branch received the same prompt and a synthetic new reply,
  displayed ancestry and navigated to the new chat.
- Read the native task strip and detail sheet with a three-step plan, completed
  tool and failed child. A synthetic authoritative failure changed the task to
  Failed and marked the in-progress plan step unfinished.
- Read the actual checkpoint diff, opened restore confirmation and restored the
  disposable release.md through the phone's signed action with safe mode on.
  Independently checked the real file returned to its original contents. The
  native result named the restored file and exposed its safety snapshot.

Device review found and fixed a collapsed checkpoint confirmation/result body:
maxHeight on an unconstrained flex parent let Android's ScrollView shrink to
zero. A bounded panel height now keeps the scope, effects, safety toggle,
result and undo link readable while keeping actions reachable. Before/after
captures are under native-review/. The regenerate helper now describes resending
the prompt instead of copying the old reply. Terminal tasks without a summary
no longer claim that their outcome was unreported.

After these changes app typecheck and 30 focused branching/execution/checkpoint
app tests passed. Native layout and actual restore were checked after the fix.

## Reproduce safely

Use a private environment with the Hermes commit pinned in CI and Winglet's
declared dependencies. Run `python scripts/native_feature_fixture.py`. It creates
a fresh temporary home, workspace and both databases, then prints a temporary
pairing link. API binds 127.0.0.1:9380; fixture controls bind 127.0.0.1:9381.
Never point this fixture at an existing Hermes home or real project folder.

Start the app's existing development build with Metro, reverse port 8081 and
9380 over ADB, and pair only Winglet Dev using the printed fingerprint/link.
The fixture's internal transcript route uses Hermes's built-in Telegram source
type solely to exercise the real session primitives without booting a live
gateway. It sends no Telegram messages. Local controls `/qa/fail`, `/qa/finish`
and `/qa/snapshot` on port 9381 exercise outcomes and inspect synthetic state.

## Remaining validation

This is physical native runtime evidence, not a new signed production APK or
public release. Live provider turns, production tunnel behavior, TalkBack,
larger fonts, additional phone/tablet sizes, background lifecycle and extended
offline/reconnect cases still need broader validation. Existing automated
permission, revision, replay/idempotency and stale-request cases passed; these
were not all manually repeated on hardware. The screenshots contain synthetic
fixture data only.
