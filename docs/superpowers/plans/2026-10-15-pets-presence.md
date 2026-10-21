# Pets 2.0, Main-Bot Presence and Sounds — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pets take their real colours from their sprites, respond to touch everywhere they're live, appear live in chats, and the main bot gets a permanent place in the tab bar; plus four small general sounds.

**Architecture:** The plugin derives a `{base, soft, deep}` palette from each pet's idle frame (PIL, cached with the sheet geometry). The app keeps all reaction rules in a pure module (`petPlay.ts`) and one gesture/motion component (`LivePet`) that every live placement uses (Home hero, chat header, composer perch, tab bar). Sounds are a tiny `sound` map mirroring `haptic`. Voice-note recording moves into a `useVoiceNote` hook shared by the composer and the tab-bar pet.

**Tech Stack:** Python 3 + Pillow (plugin), Expo SDK 57 / React Native 0.86, react-native-gesture-handler 2.32, Reanimated 4, expo-audio, zustand, `node --test` + pytest.

**Spec:** `docs/superpowers/specs/2026-10-15-pets-presence-design.md`

## Global Constraints

- Only Hermes's existing pet animations: `idle, wave, run, waiting, review, jump, failed`. No pet creation, no per-pet assets, no per-pet sounds.
- Older servers (no `palette`) must look exactly as today.
- Reduced motion (`useReducedMotion()`): no float, tilt or squash; the frame still changes on touch.
- Sounds: four files only (`tap`, `sent`, `reply`, `needs-you`), ~0.4 volume, mix with other audio, `prefs.sounds` default `true`.
- Commits are authored by VIKASRP24 (repo-local git config) and carry **no** `Co-Authored-By` or "Generated with" trailers.
- Copy and comments follow the codebase's voice: plain sentences, no marketing words.
- Tablet/desktop `SideRail` is unchanged.

## Review Focus

1. **A pet's palette for a mostly-transparent or greyscale sprite** — expected: a sensible grey `base`, or no `palette` at all; never a crash or a sheet that fails to load. (Task 2 tests.)
2. **Tapping a pet while the agent is working or needs you** — expected: the reaction plays once, then the pet goes back to `run`/`waiting`; touch never hides the real state. (Task 4 tests.)
3. **The tab-bar pet with no bots / main bot removed** — expected: no centre button with no bots; the first bot (`resolveMainBot`) when the chosen main is gone. (Task 9 manual check + `resolveMainBot` already tested.)
4. **Reply sound only for the chat on screen, and only once per turn** — expected: a streamed reply's repeated `message.update` events don't replay it; a reply in a chat you aren't looking at plays nothing (it already toasts). (Task 5 test.)
5. **Long-press on the tab-bar pet released too quickly or dragged away** — expected: under 600 ms shows the "Hold to record" toast and sends nothing; dragged > 80 px cancels. (Task 8 hook keeps `finish` semantics; Task 9 manual check.)

---

## File Structure

| File | Responsibility |
|---|---|
| `app/app.config.js` (modify) | `WINGLET_DEV=1` → separate "Winglet Dev" package for USB testing |
| `plugin/petcolor.py` (create) | `pet_palette(image) -> dict | None`, pure |
| `plugin/hermes_api.py` (modify `_pet_sheet`) | add `palette` to the cached sheet |
| `tests/test_petcolor.py` (create) | palette extraction tests |
| `app/src/lib/types.ts` (modify `PetSheet`) | optional `palette` |
| `app/src/lib/pets.ts` (modify) | `avatarColor` uses palette; new `petTones` |
| `app/src/lib/petPlay.ts` (create) | pure reaction rules |
| `app/scripts/make_sounds.py` (create) + `app/assets/sounds/*.wav` | generated tones |
| `app/src/lib/sounds.ts` (create) | `sound.tap/sent/reply/needsYou` |
| `app/src/lib/prefs.ts`, `app/src/app/appearance.tsx` (modify) | `sounds` pref + switch |
| `app/src/lib/store.ts` (modify) | reply / needs-you sound triggers |
| `app/src/components/AgentFace.tsx` (modify) | `petState`/`bare` props, `useRealPetState`, tones |
| `app/src/components/LivePet.tsx` (create) | gestures + ambient motion around `AgentFace` |
| `app/src/lib/voiceNote.ts` (create) | `useVoiceNote` hook (moved out of Composer) |
| `app/src/components/Composer.tsx` (modify) | use `useVoiceNote`, `perch` + `onSent` props, sent sound |
| `app/src/components/ChatView.tsx` (modify) | header `LivePet`, composer perch |
| `app/src/components/TabBar.tsx` (modify) | centre main-bot button |
| `app/src/components/QuickAsk.tsx` (create) | quick-ask sheet around `Composer` |
| `app/src/app/(tabs)/index.tsx` (modify) | hero `LivePet`, Crew row, back pill |

---

### Task 1: A "Winglet Dev" build that installs beside the real app

**Files:**
- Modify: `app/app.config.js`

**Interfaces:**
- Produces: `WINGLET_DEV=1 npx expo prebuild --platform android --clean` generates `io.github.vikasrp24.winglet.dev`, app name "Winglet Dev", scheme `winglet-dev`.

- [ ] **Step 1: Add the dev variant to `app.config.js`**

Replace the `return { ... }` block with:

```js
  const dev = process.env.WINGLET_DEV === '1';
  return {
    ...config,
    version,
    // A debug build for testing on a phone over USB: its own package, so it installs beside the real app
    // (whose release key it can't match) instead of replacing it and its pairings.
    ...(dev ? { name: 'Winglet Dev', scheme: 'winglet-dev' } : {}),
    android: {
      ...config.android,
      versionCode: major * 10000 + minor * 100 + patch,
      ...(dev ? { package: `${config.android.package}.dev` } : {}),
    },
    plugins: [...(config.plugins ?? []), './plugins/withReleaseSigning', './plugins/withApkSplits', './plugins/withInstallPackages'],
  };
```

- [ ] **Step 2: Check the config resolves both ways**

Run (from `app/`): `npx expo config --type public --json | node -e "const c=JSON.parse(require('fs').readFileSync(0));console.log(c.name,c.android.package)"`
Expected: `Winglet io.github.vikasrp24.winglet`

Run: `WINGLET_DEV=1 npx expo config --type public --json | node -e "const c=JSON.parse(require('fs').readFileSync(0));console.log(c.name,c.android.package)"`
Expected: `Winglet Dev io.github.vikasrp24.winglet.dev`

- [ ] **Step 3: Build and install the dev app on the phone**

```bash
export JAVA_HOME="C:/Users/vikas/AppData/Local/Android/jdk17" ANDROID_HOME="C:/Users/vikas/AppData/Local/Android/Sdk"
export PATH="$ANDROID_HOME/platform-tools:$JAVA_HOME/bin:$PATH" WINGLET_DEV=1
cd app && npx expo prebuild --platform android --clean && npx expo run:android --device
```
Expected: "Winglet Dev" opens on the phone with Metro attached (`adb reverse tcp:8081 tcp:8081` is done by expo). The real Winglet app is still installed (`adb shell pm list packages | grep winglet` shows both). Ask the user to pair the dev app once (QR from their server).

Note: `app/android/` is gitignored; regenerating it is expected. Before a release build, run `npx expo prebuild --platform android --clean` without `WINGLET_DEV`.

- [ ] **Step 4: Commit**

```bash
git add app/app.config.js
git commit -m "Add a Winglet Dev build that installs beside the real app"
```

---

### Task 2: A pet's palette from its idle frame (plugin)

**Files:**
- Create: `plugin/petcolor.py`
- Modify: `plugin/hermes_api.py` (`_pet_sheet`, ~line 1251)
- Create: `tests/test_petcolor.py`
- Modify: `tests/test_pets.py` (`test_hermes_pets_install_show_and_remove`)
- Modify: `.github/workflows/ci.yml` line 21 (add `pillow`)

**Interfaces:**
- Produces: `pet_palette(image: PIL.Image.Image) -> Optional[Dict[str, str]]` returning `{"base": "#rrggbb", "soft": "#rrggbb", "deep": "#rrggbb"}`; sheet dicts from `active_pet()`/`pet_sheet()` gain `"palette"` when computed. `Hub._pet_view` already passes every key except `path`, so `/api/pet` returns it with no hub change.

- [ ] **Step 1: Write the failing tests**

`tests/test_petcolor.py`:

```python
"""A pet's colours come from its own idle frame, so the disc behind it and Home's glow match the pet."""

import pytest

Image = pytest.importorskip("PIL.Image")

from plugin.petcolor import pet_palette


def frame(fill=None, size=(192, 208)):
    image = Image.new("RGBA", size, (0, 0, 0, 0))
    if fill:
        for box, colour in fill:
            image.paste(colour, box)
    return image


def test_the_main_colour_is_the_pets_not_its_outline():
    # A red body with a thin near-black outline and a white highlight.
    image = frame([((30, 30, 162, 178), (20, 20, 20, 255)), ((34, 34, 158, 174), (210, 40, 50, 255)),
                   ((60, 60, 80, 80), (255, 255, 255, 255))])
    palette = pet_palette(image)
    assert palette["base"] == "#d22832"
    assert palette["soft"] == "#f6d4d6"  # 78% toward white
    assert palette["deep"] == "#500f13"  # 62% toward black


def test_the_bigger_hue_wins_over_a_small_accent():
    image = frame([((20, 20, 172, 188), (40, 120, 220, 255)), ((90, 90, 110, 110), (250, 200, 0, 255))])
    assert pet_palette(image)["base"] == "#2878dc"


def test_a_greyscale_pet_gets_its_grey():
    image = frame([((40, 40, 150, 170), (120, 120, 120, 255))])
    assert pet_palette(image)["base"] == "#787878"


def test_a_frame_with_nothing_visible_has_no_palette():
    assert pet_palette(frame()) is None
    assert pet_palette(frame([((0, 0, 50, 50), (255, 255, 255, 255))])) is None  # only white


def test_semi_transparent_edges_are_ignored():
    image = frame([((40, 40, 150, 170), (30, 160, 90, 255)), ((0, 0, 192, 20), (250, 0, 0, 90))])
    assert pet_palette(image)["base"] == "#1ea05a"
```

- [ ] **Step 2: Run them to see them fail**

Run (repo root): `python -m pytest -q -p no:cacheprovider tests/test_petcolor.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'plugin.petcolor'`

- [ ] **Step 3: Implement `plugin/petcolor.py`**

```python
"""A pet's colours, taken from its own idle frame: the disc behind it and Home's glow match the pet.

Pure (a PIL image in, hex strings out), so it's tested without Hermes.
"""

from __future__ import annotations

import colorsys
from typing import Dict, Optional, Tuple

RGB = Tuple[float, float, float]
_BUCKETS = 24


def _hex(rgb: RGB) -> str:
    return "#" + "".join(f"{max(0, min(255, round(c))):02x}" for c in rgb)


def _mix(rgb: RGB, to: RGB, amount: float) -> RGB:
    return tuple(c + (t - c) * amount for c, t in zip(rgb, to))  # type: ignore[return-value]


def pet_palette(image) -> Optional[Dict[str, str]]:
    """{base, soft, deep} for one frame, or None when nothing in it is visible.

    `base` is the weighted mean of the most present hue, ignoring see-through, near-white and near-black
    pixels (highlights and outlines); a pet with no colour at all gets the mean of its greys.
    """
    small = image.convert("RGBA")
    small.thumbnail((32, 32))
    buckets: Dict[int, list] = {}
    seen = []
    for r, g, b, a in small.getdata():
        if a < 128:
            continue
        h, lightness, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
        if lightness > 0.92 or lightness < 0.08:
            continue
        seen.append((r, g, b))
        weight = s * a / 255
        if weight < 0.05:
            continue
        acc = buckets.setdefault(int(h * _BUCKETS) % _BUCKETS, [0.0, 0.0, 0.0, 0.0])
        acc[0] += weight
        acc[1] += r * weight
        acc[2] += g * weight
        acc[3] += b * weight
    if buckets:
        w, r, g, b = max(buckets.values(), key=lambda v: v[0])
        base: RGB = (r / w, g / w, b / w)
    elif seen:
        base = tuple(sum(p[i] for p in seen) / len(seen) for i in range(3))  # type: ignore[assignment]
    else:
        return None
    return {"base": _hex(base), "soft": _hex(_mix(base, (255, 255, 255), 0.78)), "deep": _hex(_mix(base, (0, 0, 0), 0.62))}
```

- [ ] **Step 4: Run the tests**

Run: `python -m pytest -q -p no:cacheprovider tests/test_petcolor.py`
Expected: 5 passed. If an exact hex is off by one from rounding inside `thumbnail` resampling, fix the **expected value in the test** only after confirming by printing `pet_palette(...)` that the colour is the body colour (not the outline/highlight).

- [ ] **Step 5: Add the palette to the cached sheet**

In `plugin/hermes_api.py` `_pet_sheet`, replace

```python
        from PIL import Image
        from agent.pet import render
        with Image.open(pet.spritesheet) as image:
            width, height = image.size
        rows = max(1, height // constants.FRAME_H)
```

with

```python
        from PIL import Image
        from agent.pet import render
        from .petcolor import pet_palette
        with Image.open(pet.spritesheet) as image:
            width, height = image.size
            rows = max(1, height // constants.FRAME_H)
            state_rows = list(constants.state_rows_for_grid(rows))
            idle = state_rows.index("idle") if "idle" in state_rows else 0
            try:
                palette = pet_palette(image.crop((0, idle * constants.FRAME_H, constants.FRAME_W, (idle + 1) * constants.FRAME_H)))
            except Exception:  # a palette is a nicety; the sheet must still load
                palette = None
```

and in the `_pet_sheets[key] = {...}` dict replace `"state_rows": list(constants.state_rows_for_grid(rows)),` with `"state_rows": state_rows,` and add `**({"palette": palette} if palette else {}),` as the last entry.

- [ ] **Step 6: Assert it end to end where Hermes is installed**

In `tests/test_pets.py` `test_hermes_pets_install_show_and_remove`, after the line `assert pet["frames"]["idle"] == 6 and ...`, add:

```python
    assert pet["palette"]["base"] == "#c85028"  # make_sheet's (200, 80, 40)
```

And in `.github/workflows/ci.yml` line 21 add `pillow` to the `pip install` list (the non-Hermes job needs it for `test_petcolor.py`).

- [ ] **Step 7: Run the Python suite that can run here**

Run: `python -m pytest -q -p no:cacheprovider tests/test_petcolor.py`
Expected: 5 passed. (The Hermes-backed test runs in CI's Hermes job.)

- [ ] **Step 8: Commit**

```bash
git add plugin/petcolor.py plugin/hermes_api.py tests/test_petcolor.py tests/test_pets.py .github/workflows/ci.yml
git commit -m "Take a pet's colours from its own idle frame"
```

---

### Task 3: The app uses the pet's palette

**Files:**
- Modify: `app/src/lib/types.ts` (`PetSheet`, line ~343)
- Modify: `app/src/lib/pets.ts`
- Modify: `app/tests/pets.test.ts`
- Modify: `app/src/components/AgentFace.tsx`

**Interfaces:**
- Produces:
  - `type PetPalette = { base: string; soft: string; deep: string }`; `PetSheet.palette?: PetPalette`
  - `avatarColor(palette: readonly string[], bot: string, pet?: Pick<PetSheet, 'slug' | 'palette'> | null): string`
  - `petTones(pet: Pick<PetSheet, 'palette'> | null | undefined, scheme: 'light' | 'dark'): { disc: [string, string, string] } | null` — `null` when the pet has no palette (caller keeps today's gradient).

- [ ] **Step 1: Write the failing tests** (append to `app/tests/pets.test.ts`; add `petTones` to the destructured exports at the top)

```ts
test("a pet's own palette wins over the colour its slug hashes to", () => {
  const palette = { base: '#d22832', soft: '#f6d4d6', deep: '#500f13' };
  assert.equal(avatarColor(['#111111', '#222222'], 'bot', { slug: 'boba', palette }), '#d22832');
  // Older servers send no palette: exactly today's colour.
  assert.equal(avatarColor(['#111111', '#222222'], 'bot', { slug: 'boba' }), paletteColor(['#111111', '#222222'], 'pet:boba'));
});

test("the disc behind a pet is a tint of it, never its own colour", () => {
  const palette = { base: '#d22832', soft: '#f6d4d6', deep: '#500f13' };
  const light = petTones({ palette }, 'light')!.disc;
  const dark = petTones({ palette }, 'dark')!.disc;
  assert.ok(!light.includes('#d22832') && !dark.includes('#d22832'));
  assert.equal(light[1], '#f6d4d6');
  assert.equal(dark[1], '#500f13');
  assert.equal(petTones({}, 'light'), null);
  assert.equal(petTones(null, 'dark'), null);
});
```

- [ ] **Step 2: Run them to see them fail**

Run (from `app/`): `node --test tests/pets.test.ts`
Expected: FAIL — `petTones is not a function` and the palette assertion.

- [ ] **Step 3: Implement**

`types.ts`, in `PetSheet` after `loop_ms: number;`:

```ts
  /** The pet's own colours from its idle frame (newer servers): base for glows, soft/deep for the disc behind it. */
  palette?: PetPalette;
```

and above `PetSheet`:

```ts
export type PetPalette = { base: string; soft: string; deep: string };
```

`pets.ts`: replace `avatarColor` with

```ts
export function avatarColor(palette: readonly string[], bot: string, pet?: Pick<PetSheet, 'slug' | 'palette'> | null): string {
  if (pet?.palette) return pet.palette.base;
  return paletteColor(palette, pet ? `pet:${pet.slug}` : bot || 'hermes');
}

/**
 * The gradient behind a pet: a pale tint of it in light mode, a deep one in dark mode, so the sprite stands out
 * from its disc. Null when the server sent no palette (the caller keeps today's look).
 */
export function petTones(pet: Pick<PetSheet, 'palette'> | null | undefined, scheme: 'light' | 'dark'): { disc: [string, string, string] } | null {
  const p = pet?.palette;
  if (!p) return null;
  return { disc: scheme === 'light' ? [p.soft, p.soft, mixHex(p.soft, p.base, 0.18)] : [mixHex(p.deep, p.base, 0.2), p.deep, mixHex(p.deep, '#000000', 0.3)] };
}

function mixHex(a: string, b: string, amount: number): string {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (shift: number) => Math.round(((pa >> shift) & 255) + ((((pb >> shift) & 255) - ((pa >> shift) & 255)) * amount));
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('')}`;
}
```

`AgentFace.tsx` (non-glow branch): use the tones when present.

```tsx
  const tones = petTones(pet, t.scheme);
  ...
      <LinearGradient
        colors={tones ? tones.disc : [shade(color, 0.32), color, shade(color, -0.18)]}
```

(import `petTones` from `../lib/pets`).

- [ ] **Step 4: Run tests and typecheck**

Run: `node --test tests/pets.test.ts && npm run typecheck`
Expected: all pass, no type errors.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/types.ts app/src/lib/pets.ts app/tests/pets.test.ts app/src/components/AgentFace.tsx
git commit -m "Tint a pet's disc and glow with its own colours"
```

---

### Task 4: Reaction rules (`petPlay.ts`)

**Files:**
- Create: `app/src/lib/petPlay.ts`
- Create: `app/tests/petPlay.test.ts`

**Interfaces:**
- Produces:
  - `type Reaction = { state: PetState; until: number } | null`
  - `TRIPLE_MS = 1200`
  - `tapReaction(recent: readonly number[], now: number, loopMs: number): { reaction: Reaction; recent: number[] }`
  - `holdReaction(): Reaction` → `{ state: 'review', until: Infinity }`
  - `shownState(real: PetState, reaction: Reaction, now: number): PetState`

- [ ] **Step 1: Write the failing tests** — `app/tests/petPlay.test.ts`

```ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const exports: any = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/petPlay.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, require: () => ({}) });
const { tapReaction, holdReaction, shownState, TRIPLE_MS } = exports;

test('a tap waves for one loop, then the pet is back to what it was doing', () => {
  const { reaction } = tapReaction([], 1000, 1100);
  assert.deepEqual(reaction, { state: 'wave', until: 2100 });
  assert.equal(shownState('idle', reaction, 1500), 'wave');
  assert.equal(shownState('idle', reaction, 2100), 'idle');
});

test('three quick taps make it jump, and start counting again', () => {
  let r = tapReaction([], 0, 1100);
  r = tapReaction(r.recent, 300, 1100);
  assert.equal(r.reaction.state, 'wave');
  r = tapReaction(r.recent, 600, 1100);
  assert.deepEqual(r.reaction, { state: 'jump', until: 1700 });
  assert.deepEqual(r.recent, []);
});

test('taps further apart than the window never add up to a jump', () => {
  let r = tapReaction([], 0, 1100);
  r = tapReaction(r.recent, TRIPLE_MS + 1, 1100);
  r = tapReaction(r.recent, TRIPLE_MS + 300, 1100);
  assert.equal(r.reaction.state, 'wave');
});

test('touch never hides what the agent is doing for longer than the reaction', () => {
  const { reaction } = tapReaction([], 0, 1100);
  assert.equal(shownState('run', reaction, 500), 'wave');
  assert.equal(shownState('run', reaction, 1100), 'run');
  assert.equal(shownState('waiting', null, 0), 'waiting');
});

test('holding shows it thinking until let go', () => {
  const held = holdReaction();
  assert.equal(shownState('idle', held, 1e12), 'review');
  assert.equal(shownState('run', null, 1e12), 'run');
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --test tests/petPlay.test.ts`
Expected: FAIL — `ENOENT ... petPlay.ts`.

- [ ] **Step 3: Implement `app/src/lib/petPlay.ts`**

```ts
import type { PetState } from './pets';

/** What touching the pet makes it do, and until when. `until` is Infinity while it's held. */
export type Reaction = { state: PetState; until: number } | null;

/** Three taps inside this window make it jump. */
export const TRIPLE_MS = 1200;

/** A tap: a wave for one loop of the animation, or a jump on the third quick tap. */
export function tapReaction(recent: readonly number[], now: number, loopMs: number): { reaction: Reaction; recent: number[] } {
  const taps = [...recent.filter((at) => now - at < TRIPLE_MS), now];
  if (taps.length >= 3) return { reaction: { state: 'jump', until: now + loopMs }, recent: [] };
  return { reaction: { state: 'wave', until: now + loopMs }, recent: taps };
}

/** Held down: it looks like it's thinking about you until you let go. */
export function holdReaction(): Reaction {
  return { state: 'review', until: Infinity };
}

/** What the pet shows: a reaction while it lasts, then what the agent is really doing. */
export function shownState(real: PetState, reaction: Reaction, now: number): PetState {
  return reaction && now < reaction.until ? reaction.state : real;
}
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/petPlay.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/petPlay.ts app/tests/petPlay.test.ts
git commit -m "Add the rules for how a pet reacts to touch"
```

---

### Task 5: Sounds

**Files:**
- Create: `app/scripts/make_sounds.py`, `app/assets/sounds/{tap,sent,reply,needs-you}.wav`
- Create: `app/src/lib/sounds.ts`
- Modify: `app/src/lib/prefs.ts`, `app/src/app/appearance.tsx`
- Modify: `app/src/lib/store.ts` (message + inbox handlers, ~lines 295–365)
- Modify: `app/tests/store.test.ts` (harness imports + new test)

**Interfaces:**
- Produces: `sound.tap()`, `sound.sent()`, `sound.reply()`, `sound.needsYou()` (all `() => void`, never throw); `Prefs.sounds: boolean`.

- [ ] **Step 1: Generate the sounds**

`app/scripts/make_sounds.py`:

```python
"""Winglet's four interface sounds, made here as soft tones so there's nothing to license.

Run from app/: python scripts/make_sounds.py  (writes assets/sounds/*.wav)
"""

import math
import struct
import wave
from pathlib import Path

RATE = 44100
OUT = Path(__file__).resolve().parent.parent / "assets" / "sounds"


def tone(freq, ms, start=0.0, decay=8.0):
    """A plucked sine with a touch of its octave: quick attack, exponential fade."""
    n = int(RATE * ms / 1000)
    out = []
    for i in range(n):
        t = i / RATE
        env = min(1.0, t / 0.005) * math.exp(-decay * t / (ms / 1000))
        out.append((start + i, env * (math.sin(2 * math.pi * freq * t) + 0.18 * math.sin(4 * math.pi * freq * t))))
    return out


def render(name, notes):
    length = max(int(s) for part in notes for s, _ in part) + 1
    buf = [0.0] * length
    for part in notes:
        for i, v in part:
            buf[int(i)] += v
    peak = max(abs(v) for v in buf) or 1.0
    OUT.mkdir(parents=True, exist_ok=True)
    with wave.open(str(OUT / f"{name}.wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", int(32767 * 0.5 * v / peak)) for v in buf))


ms = lambda m: RATE * m / 1000  # noqa: E731

render("tap", [tone(1046.5, 70, decay=10)])
render("sent", [tone(659.3, 90), tone(987.8, 120, start=ms(60))])
render("reply", [tone(784.0, 160), tone(987.8, 160, start=ms(90)), tone(1174.7, 260, start=ms(180))])
render("needs-you", [tone(987.8, 140), tone(784.0, 220, start=ms(130))])
```

Run (from `app/`): `python scripts/make_sounds.py && ls -la assets/sounds`
Expected: four `.wav` files, each under 40 KB.

- [ ] **Step 2: Add the pref**

`prefs.ts`: in `Prefs` after `haptics: boolean;` add

```ts
  /** Soft interface sounds: poking the pet, sending, a reply landing, something needing you. */
  sounds: boolean;
```

and add `sounds: true,` after `haptics: true,` in `DEFAULT_PREFS`.

`appearance.tsx`: after the Haptics `ListRow` add

```tsx
        <ListRow title="Sounds" subtitle="Soft sounds when you send, a reply lands, or something needs you"
          right={<Toggle label="Sounds" value={prefs.sounds} onValueChange={set('sounds')} />} />
```

- [ ] **Step 3: Implement `app/src/lib/sounds.ts`**

```ts
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import { usePrefs } from './prefs';

// One map so every screen sounds the same, like haptics. Quiet, short, and never in the way: they mix with
// whatever's playing and a failure to play is ignored.
const SOURCES = {
  tap: require('../../assets/sounds/tap.wav'),
  sent: require('../../assets/sounds/sent.wav'),
  reply: require('../../assets/sounds/reply.wav'),
  needsYou: require('../../assets/sounds/needs-you.wav'),
} as const;

type Name = keyof typeof SOURCES;
const players: Partial<Record<Name, AudioPlayer>> = {};
let modeSet = false;

function play(name: Name) {
  if (!usePrefs.getState().prefs.sounds) return;
  try {
    if (!modeSet) {
      modeSet = true;
      setAudioModeAsync({ playsInSilentMode: false, interruptionMode: 'mixWithOthers' }).catch(() => undefined);
    }
    const player = players[name] ?? (players[name] = createAudioPlayer(SOURCES[name]));
    player.volume = 0.4;
    player.seekTo(0).catch(() => undefined);
    player.play();
  } catch {
    // A missing audio device or a browser that hasn't been tapped yet: stay quiet.
  }
}

export const sound = {
  /** The pet was poked. */
  tap: () => play('tap'),
  /** Your message or voice note went out. */
  sent: () => play('sent'),
  /** A reply finished in the chat on screen. */
  reply: () => play('reply'),
  /** An approval or question arrived while the app is open. */
  needsYou: () => play('needsYou'),
};
```

- [ ] **Step 4: Write the failing store test**

In `app/tests/store.test.ts` harness: add `const played: string[] = [];` next to `const timers`, add to the `compile('../src/lib/store.ts', {...})` imports:

```ts
    './sounds': { sound: { reply: () => played.push('reply'), needsYou: () => played.push('needsYou'), tap: () => {}, sent: () => {} } },
```

and return `played` from the harness object. Then add the test:

```ts
test('a reply chimes once, when its turn ends in the chat on screen', async () => {
  const h = harness();
  await h.connect();
  await h.hello();
  h.event({ type: 'typing', chat_id: 'general', on: true });
  h.event({ type: 'message.new', chat_id: 'general', message: { ...msg(1), status: 'streaming' } });
  h.event({ type: 'message.update', chat_id: 'general', message: msg(1) });
  h.event({ type: 'message.update', chat_id: 'general', message: msg(1) }); // repeated final: no second chime
  assert.deepEqual(h.played, ['reply']);
  // A reply in a chat you aren't looking at toasts instead.
  h.event({ type: 'typing', chat_id: 'other', on: true });
  h.event({ type: 'message.new', chat_id: 'other', message: { ...msg(2), chat_id: 'other' } });
  assert.deepEqual(h.played, ['reply']);
});

test('something needing you chimes while the app is open', async () => {
  const h = harness();
  await h.connect();
  await h.hello();
  h.event({ type: 'inbox.new', item: { id: 'q1', kind: 'question', title: 'Which one?', body: '', created_at: 1, chat_id: 'general' }, pending: 1 });
  assert.deepEqual(h.played, ['needsYou']);
});
```

Run: `node --test tests/store.test.ts`
Expected: the two new tests FAIL (`played` empty); existing tests still pass.

- [ ] **Step 5: Trigger the sounds in the store**

In `store.ts` add `import { sound } from './sounds';`. In `case 'message.new': case 'message.update':` move the `vis`/`seeing` lines above the "A reply ends the bot's turn" block, and change that block to:

```ts
        if (m.role === 'bot' && m.status === 'final' && !activityKind(m)) {
          const wasTyping = !!get().runtime[serverId]?.typing[ev.chat_id];
          patch(serverId, (s) => {
            const typing = { ...s.typing };
            delete typing[ev.chat_id];
            return { typing, lastReplyAt: Date.now() };
          });
          // Once per turn, and only where you can see it land (elsewhere it toasts).
          if (wasTyping && seeing) sound.reply();
        }
```

In `case 'inbox.new': case 'inbox.update':`, inside `if (ev.type === 'inbox.new' && actionable && server) {`, add `if (get().foreground) sound.needsYou();` before the `toast(...)` call.

- [ ] **Step 6: Run tests and typecheck**

Run: `node --test tests/store.test.ts && npm run typecheck`
Expected: all pass. If the inbox item shape in the test is missing a field the handler reads (check `isOwner` for `approval` only), adjust the **test item** to the real `InboxItem` type in `types.ts`.

- [ ] **Step 7: Commit**

```bash
git add app/scripts/make_sounds.py app/assets/sounds app/src/lib/sounds.ts app/src/lib/prefs.ts app/src/app/appearance.tsx app/src/lib/store.ts app/tests/store.test.ts
git commit -m "Add four soft sounds and a switch for them"
```

---

### Task 6: `AgentFace` grows a state override and a bare mode; `useRealPetState`

**Files:**
- Modify: `app/src/components/AgentFace.tsx`

**Interfaces:**
- Produces:
  - `AgentFace` props: `petState?: PetState` (forces the sprite's animation; ignored for orb bots), `bare?: boolean` (pet with no disc and no glow, drawn at `size * 1.2`; orb bots draw the orb as usual).
  - `export function useRealPetState(server: Server): PetState` — what the pet would show on its own (wave after a reply for `WAVE_MS`, else waiting/run/idle), re-rendering when the wave ends.

- [ ] **Step 1: Extract `useRealPetState`** (move the `lastReply`/`replied`/`wake` logic out of `Face`)

```tsx
/** What a pet shows on its own: a wave just after a reply, then waiting on you, working, or resting. */
export function useRealPetState(server: Server): PetState {
  const live = useApp((st) => moodOf(st.runtime[server.id]));
  const lastReply = useApp((st) => st.runtime[server.id]?.lastReplyAt ?? 0);
  const replied = Date.now() - lastReply < WAVE_MS;
  const [, wake] = useState(0);
  useEffect(() => {
    if (!replied) return;
    const id = setTimeout(() => wake((n) => n + 1), lastReply + WAVE_MS - Date.now() + 50);
    return () => clearTimeout(id);
  }, [replied, lastReply]);
  return petState({ replied, waiting: live === 'waiting', working: live === 'working' });
}
```

In `Face`, for non-`still` faces use it: replace the `lastReply`/`replied`/`wake` block and the `state` computation with

```tsx
  const real = useRealPetState(server);
  const state = props.petState ?? (mood ? MOOD_STATE[mood] : still ? 'idle' : real);
```

(`Face` must take `petState` from props; destructure it alongside the others.) Hooks run unconditionally, so call `useRealPetState` before the `if (!pet)` early return.

- [ ] **Step 2: Add `bare`**

Before the `if (glow)` branch:

```tsx
  if (bare) {
    return <View style={[{ width: size * 1.2, height: size * 1.2, alignItems: 'center', justifyContent: 'flex-end', opacity: online ? 1 : 0.5 }, style]}>{sprite(size * 1.2)}</View>;
  }
```

- [ ] **Step 3: Typecheck and run the app tests**

Run: `npm run typecheck && npm test`
Expected: pass. Behaviour unchanged for every existing caller (no caller passes the new props yet).

- [ ] **Step 4: Commit**

```bash
git add app/src/components/AgentFace.tsx
git commit -m "Let a face show a chosen pet animation, or the pet on its own"
```

---

### Task 7: `LivePet`

**Files:**
- Create: `app/src/components/LivePet.tsx`

**Interfaces:**
- Consumes: `AgentFace` (`petState`, `bare`, `glow`, `animated`), `useRealPetState`, `tapReaction`/`holdReaction`/`shownState`/`Reaction` (Task 4), `sound.tap` (Task 5), `haptic`, `spring`, `useReducedMotion`.
- Produces:

```ts
type LivePetProps = {
  server: Server;
  size: number;
  glow?: boolean;
  bare?: boolean;
  status?: 'online' | 'offline' | 'connecting' | 'busy';
  /** Called after the tap reaction starts (the tab-bar pet opens quick-ask). */
  onTap?: () => void;
  /** Replace the long-press reaction: start/finish a hold (the tab-bar pet records a voice note). */
  onHoldStart?: () => void;
  onHoldEnd?: (cancelled: boolean) => void;
  accessibilityLabel?: string;
};
export function LivePet(props: LivePetProps): JSX.Element;
```

- [ ] **Step 1: Implement**

```tsx
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withSpring, withTiming,
} from 'react-native-reanimated';
import { haptic } from '../lib/haptics';
import { spring, useReducedMotion } from '../lib/motion';
import { holdReaction, shownState, tapReaction, type Reaction } from '../lib/petPlay';
import { sound } from '../lib/sounds';
import { useApp } from '../lib/store';
import type { Server } from '../lib/types';
import { AgentFace, useAvatarColor, useRealPetState } from './AgentFace';

const LEAN_MAX_DEG = 12;
const CANCEL_PX = 80;

type LivePetProps = {
  server: Server;
  size: number;
  glow?: boolean;
  bare?: boolean;
  status?: 'online' | 'offline' | 'connecting' | 'busy';
  /** Called after the tap reaction starts (the tab-bar pet opens quick-ask). */
  onTap?: () => void;
  /** Replace the long-press reaction: start/finish a hold (the tab-bar pet records a voice note). */
  onHoldStart?: () => void;
  onHoldEnd?: (cancelled: boolean) => void;
  accessibilityLabel?: string;
};

/**
 * The agent's face where it's alive: poke it and it waves (three quick pokes and it jumps), hold it and it
 * thinks, drag it and it leans after your finger. Only Hermes's own animations; a reaction plays once and
 * then the pet goes back to what the agent is really doing.
 */
export function LivePet({ server, size, glow, bare, status, onTap, onHoldStart, onHoldEnd, accessibilityLabel }: LivePetProps) {
  const reduced = useReducedMotion();
  const pet = useApp((st) => st.runtime[server.id]?.pet);
  const loopMs = pet?.loop_ms ?? 1100;
  const real = useRealPetState(server);
  const color = useAvatarColor(server);
  const [reaction, setReaction] = useState<Reaction>(null);
  const taps = useRef<number[]>([]);
  const dragged = useRef(0);

  // End the reaction when it runs out, so the real state comes back without anything else changing.
  useEffect(() => {
    if (!reaction || reaction.until === Infinity) return;
    const id = setTimeout(() => setReaction(null), Math.max(0, reaction.until - Date.now()));
    return () => clearTimeout(id);
  }, [reaction]);

  const float = useSharedValue(0);
  const squash = useSharedValue(1);
  const leanX = useSharedValue(0);
  const leanY = useSharedValue(0);
  const halo = useSharedValue(0);

  useEffect(() => {
    cancelAnimation(float);
    float.value = 0;
    if (reduced || real !== 'idle') return;
    const ease = Easing.inOut(Easing.sin);
    float.value = withRepeat(withSequence(withTiming(-size * 0.03, { duration: 1500, easing: ease }), withTiming(0, { duration: 1500, easing: ease })), -1);
  }, [reduced, real, size, float]);

  // A steady glow while it works; a pulse while it needs you.
  useEffect(() => {
    cancelAnimation(halo);
    halo.value = real === 'run' ? 0.35 : 0;
    if (reduced || real !== 'waiting') return;
    halo.value = withRepeat(withSequence(withTiming(1, { duration: 900 }), withTiming(0.2, { duration: 900 })), -1);
  }, [reduced, real, halo]);

  const tap = Gesture.Tap().runOnJS(true).onEnd(() => {
    const next = tapReaction(taps.current, Date.now(), loopMs);
    taps.current = next.recent;
    setReaction(next.reaction);
    haptic.light();
    sound.tap();
    if (!reduced) squash.value = withSequence(withTiming(0.88, { duration: 90 }), withSpring(1, spring.snappy));
    onTap?.();
  });

  const hold = Gesture.LongPress().minDuration(350).runOnJS(true)
    .onStart(() => {
      haptic.selection();
      dragged.current = 0;
      if (onHoldStart) onHoldStart();
      else setReaction(holdReaction());
    })
    .onEnd(() => {
      if (onHoldEnd) onHoldEnd(dragged.current > CANCEL_PX);
      else setReaction(null);
    });

  const lean = Gesture.Pan().runOnJS(true).minDistance(6)
    .onUpdate((e) => {
      dragged.current = Math.hypot(e.translationX, e.translationY);
      if (reduced) return;
      const cap = size * 0.12;
      leanX.value = Math.max(-cap, Math.min(cap, e.translationX * 0.25));
      leanY.value = Math.max(-cap, Math.min(cap, e.translationY * 0.25));
    })
    .onFinalize(() => {
      leanX.value = withSpring(0, spring.soft);
      leanY.value = withSpring(0, spring.soft);
    });

  const gesture = Gesture.Simultaneous(lean, Gesture.Exclusive(hold, tap));

  const body = useAnimatedStyle(() => ({
    transform: [
      { translateX: leanX.value },
      { translateY: float.value + leanY.value },
      { rotate: `${(leanX.value / Math.max(1, size * 0.12)) * LEAN_MAX_DEG}deg` },
      { scaleX: 2 - squash.value },
      { scaleY: squash.value },
    ],
  }));
  const haloStyle = useAnimatedStyle(() => ({ opacity: halo.value * 0.6, transform: [{ scale: 1 + halo.value * 0.15 }] }));

  const shown = shownState(real, reaction, Date.now());
  return (
    <GestureDetector gesture={gesture}>
      <View accessible accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? `${server.bot.title}. Tap to poke`}
        style={{ alignItems: 'center', justifyContent: 'center' }}>
        <Animated.View pointerEvents="none" style={[{
          position: 'absolute', width: size * 0.9, height: size * 0.9, borderRadius: size, backgroundColor: color,
        }, haloStyle]} />
        <Animated.View style={body}>
          <AgentFace server={server} size={size} glow={glow} bare={bare} status={status} animated
            petState={pet ? shown : undefined} mood={!pet && reaction ? 'happy' : undefined} />
        </Animated.View>
      </View>
    </GestureDetector>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: pass. (If `Gesture.Simultaneous(lean, Gesture.Exclusive(hold, tap))` causes the pan to steal taps on device, add `.maxDistance(6)` to `tap` — verified in Task 10.)

- [ ] **Step 3: Commit**

```bash
git add app/src/components/LivePet.tsx
git commit -m "Add LivePet: a pet you can poke, hold and drag"
```

---

### Task 8: `useVoiceNote` (move recording out of the composer) and the composer's new props

**Files:**
- Create: `app/src/lib/voiceNote.ts`
- Modify: `app/src/components/Composer.tsx`

**Interfaces:**
- Produces:
  - `useVoiceNote(serverId: string, chatId: () => string, onSent?: () => void): { recording: boolean; durationMs: number; start: () => Promise<void>; finish: (cancel: boolean) => Promise<void> }`
  - `Composer` props gain `perch?: ReactNode` (drawn on the top edge of the box, left) and `onSent?: () => void` (after any send: text, command, voice note).

- [ ] **Step 1: Create `app/src/lib/voiceNote.ts`** by moving `start`/`finish` out of `VoiceButton` unchanged except for the chat getter, `onSent` and the sent sound:

```ts
import {
  RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder, useAudioRecorderState,
} from 'expo-audio';
import { useRef, useState } from 'react';
import { Platform } from 'react-native';
import { attachFiles } from './attach';
import { haptic } from './haptics';
import { sound } from './sounds';
import { useApp } from './store';

/**
 * Hold-to-talk: start records, finish sends it to the chat as a voice note (Hermes transcribes it), unless
 * cancelled or shorter than 600 ms. The composer's mic and the tab bar's pet both use it.
 */
export function useVoiceNote(serverId: string, chatId: () => string, onSent?: () => void) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const state = useAudioRecorderState(recorder, 200);
  const [recording, setRecording] = useState(false);
  const startedAt = useRef(0);

  const start = async () => {
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) {
      useApp.getState().toast({ serverId, title: 'Microphone not allowed', body: 'Allow microphone access for Winglet to send voice notes.' });
      return;
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
    startedAt.current = Date.now();
    setRecording(true);
    haptic.light();
  };

  const finish = async (cancel: boolean) => {
    if (!startedAt.current) return;
    const held = Date.now() - startedAt.current;
    startedAt.current = 0;
    setRecording(false);
    try { await recorder.stop(); } catch { /* not started */ }
    setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    if (cancel || held < 600 || !recorder.uri) {
      if (!cancel && held < 600) useApp.getState().toast({ serverId, title: 'Hold to record', body: 'Keep holding while you talk, then let go to send.' });
      return;
    }
    haptic.success();
    sound.sent();
    const name = `voice-note-${Date.now()}`;
    if (Platform.OS !== 'web') {
      attachFiles(serverId, chatId(), [{ uri: recorder.uri, name: `${name}.m4a`, mime: 'audio/mp4' }], { voice: true });
    } else {
      // Browsers record WebM, except Safari, which records MP4.
      const blob = await (await fetch(recorder.uri)).blob();
      const mime = blob.type.split(';')[0] || 'audio/webm';
      attachFiles(serverId, chatId(), [{ uri: recorder.uri, name: `${name}.${mime.includes('mp4') ? 'm4a' : 'webm'}`, mime, file: blob }], { voice: true });
    }
    onSent?.();
  };

  return { recording, durationMs: state.durationMillis ?? 0, start, finish };
}
```

- [ ] **Step 2: Make `VoiceButton` use it**

In `Composer.tsx`, `VoiceButton` becomes `function VoiceButton({ server, chatId, onSent }: { server: Server; chatId: string; onSent?: () => void })`; delete its `recorder`, `state`, `recording`, `startedAt`, `start`, `finish` and the `expo-audio` import at the top of the file; add

```tsx
  const voice = useVoiceNote(server.id, () => chatId, onSent);
  const recording = voice.recording;
```

and use `voice.start()`, `voice.finish(e.translationX < -80)`, `formatDuration(voice.durationMs)`. `onFinalize` still calls `setCancelling(false)` after finish (it was inside `finish` before).

- [ ] **Step 3: Add `perch`, `onSent` and the sent sound to `Composer`**

- Props: add `perch?: ReactNode; onSent?: () => void;` (import `type ReactNode` from react).
- In `send`, after each `sendMessage`/`sendDraft` call: `sound.sent(); onSent?.();` (import `sound` from `../lib/sounds`).
- Pass `onSent={onSent}` to `<VoiceButton>`.
- Wrap the `<Glass ... style={s.box}>` in `<View onLayout={(e) => setBoxY(e.nativeEvent.layout.y)}>…</View>` with `const [boxY, setBoxY] = useState(0);`, and right after that wrapper (still inside `s.wrap`) render:

```tsx
      {perch ? <View pointerEvents="box-none" style={[s.perch, { top: boxY - 30 }]}>{perch}</View> : null}
```

- Style: `perch: { position: 'absolute', left: 26, zIndex: 3 },`

- [ ] **Step 4: Typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/voiceNote.ts app/src/components/Composer.tsx
git commit -m "Move voice-note recording into a hook and give the composer a perch"
```

---

### Task 9: Live pets in chat, the tab-bar main bot, quick-ask, and Home

**Files:**
- Modify: `app/src/components/ChatView.tsx` (header line ~159, composer ~line 175)
- Create: `app/src/components/QuickAsk.tsx`
- Modify: `app/src/components/TabBar.tsx` (`FloatingTabBar`)
- Modify: `app/src/app/(tabs)/index.tsx`

**Interfaces:**
- Consumes: `LivePet` (Task 7), `useVoiceNote`, `Composer` `onSent` (Task 8), `useMainBot`, `homeChat`, `resolveMainBot`.
- Produces: `QuickAsk({ server, visible, onClose }: { server: Server; visible: boolean; onClose: () => void })`.

- [ ] **Step 1: Chat header and perch** — in `ChatView.tsx`:

```tsx
          <LivePet server={server} size={38} />
```

replaces `<AgentFace server={server} size={38} animated={typing} />`, and the `<Composer ...>` gains `perch={<LivePet server={server} size={40} bare />}`. Import `LivePet` from `./LivePet`.

- [ ] **Step 2: `QuickAsk.tsx`**

```tsx
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { homeChat, useApp } from '../lib/store';
import type { Server } from '../lib/types';
import { Composer } from './Composer';
import { LivePet } from './LivePet';
import { Sheet } from './Sheet';

/** Ask the main bot from anywhere: its pet, and the same message box as its main chat. Sending closes it. */
export function QuickAsk({ server, visible, onClose }: { server: Server; visible: boolean; onClose: () => void }) {
  const chatId = useApp((st) => homeChat(st.runtime[server.id]));
  const busy = useApp((st) => !!st.runtime[server.id]?.typing[chatId]);
  const target = useRef<View>(null);
  const [height, setHeight] = useState(64);
  return (
    <Sheet visible={visible} onClose={onClose} title={`Ask ${server.bot.title}`}>
      <View ref={target} style={{ alignItems: 'center', paddingVertical: 8 }}>
        <LivePet server={server} size={72} glow />
      </View>
      <View style={{ height }}>
        <Composer server={server} chatId={chatId} busy={busy} bottomInset={0} target={target} onHeight={setHeight}
          placeholder={`Message ${server.bot.title}`} onSent={onClose} />
      </View>
    </Sheet>
  );
}
```

- [ ] **Step 3: Centre button in `FloatingTabBar`**

- Slots become 5: `const each = width ? (width - 12) / 5 : 0;` and the highlight's slot is `const slot = index < 2 ? index : index + 1;` (`x.value = ... slot * each`).
- Render `TABS.slice(0, 2)`, then `<MainBotSlot />`, then `TABS.slice(2)` (keep the existing tab `Pressable` body; map with the original index `i` for `on`).
- Add:

```tsx
/** The main bot, always in reach: tap to ask it anything, hold to talk to it. */
function MainBotSlot() {
  const s = useStyles();
  const t = useTheme();
  const main = useMainBot();
  const pending = useApp((st) => (main ? st.runtime[main.id]?.pending ?? 0 : 0));
  const [open, setOpen] = useState(false);
  const voice = useVoiceNote(main?.id ?? '', () => homeChat(useApp.getState().runtime[main?.id ?? '']));
  if (!main) return <View style={s.item} />;
  return (
    <View style={s.item}>
      <View style={[s.mainSlot, { backgroundColor: t.colors.surfaceRaised }]}>
        <LivePet server={main} size={50} accessibilityLabel={`${main.bot.title}. Tap to ask, hold to talk`}
          onTap={() => setOpen(true)} onHoldStart={() => voice.start()} onHoldEnd={(cancelled) => voice.finish(cancelled)} />
        <Badge count={pending} style={s.mainBadge} />
      </View>
      {voice.recording ? <Text style={s.mainRec}>● {formatDuration(voice.durationMs)}</Text> : null}
      <QuickAsk server={main} visible={open} onClose={() => setOpen(false)} />
    </View>
  );
}
```

- Styles:

```ts
  mainSlot: { width: 58, height: 58, borderRadius: 29, marginTop: -22, alignItems: 'center', justifyContent: 'center',
    shadowColor: t.colors.shadow, shadowOpacity: t.scheme === 'light' ? 0.16 : 0.5, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 10 },
  mainBadge: { position: 'absolute', top: -4, right: -4 },
  mainRec: { position: 'absolute', top: -46, fontFamily: t.fonts.semibold, fontSize: 12, color: t.colors.danger },
```

- Imports: `useMainBot` (`../lib/mainBot`), `useVoiceNote` (`../lib/voiceNote`), `formatDuration` (`../lib/media`), `LivePet`, `QuickAsk`.

- [ ] **Step 4: Home** — in `(tabs)/index.tsx`:

- Hero: `<AgentFace server={server} size={116} animated glow />` → `<LivePet server={server} size={116} glow />`.
- Back pill, right under the `topRow` view:

```tsx
          {main && main.id !== server.id ? (
            <Tap feedback="selection" onPress={() => select(main.id, homeChat(useApp.getState().runtime[main.id]))}
              accessibilityLabel={`Back to ${main.bot.title}, your main bot`} style={s.back}>
              <ChevronLeft size={16} color={t.colors.accent} />
              <Text style={s.backText}>Back to {main.bot.title}</Text>
            </Tap>
          ) : null}
```

(`const select = useApp((st) => st.select);` in `HomeFor`; import `ChevronLeft`.)
- Crew: above the `BotStrip` `ScrollView`, if `others.length`, render `<Text style={s.crew}>Crew</Text>`; tile avatar size 48 → 44.
- Styles: `back: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'center', paddingHorizontal: 12, minHeight: 32, borderRadius: t.radius.pill, backgroundColor: t.colors.accentSoft }, backText: { ...t.type.caption, fontFamily: t.fonts.semibold, color: t.colors.onAccentSoft }, crew: { ...t.type.caption, fontFamily: t.fonts.semibold, color: t.colors.textTertiary, marginTop: 16 },`

- [ ] **Step 5: Typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/ChatView.tsx app/src/components/QuickAsk.tsx app/src/components/TabBar.tsx "app/src/app/(tabs)/index.tsx"
git commit -m "Bring the pet alive in chats and put the main bot in the tab bar"
```

---

### Task 10: On-device verification and docs

**Files:**
- Modify: `docs/FEATURES.md` ("A pet." and "Your main bot." bullets, "Looks good everywhere")

- [ ] **Step 1: Run the dev build on the phone** (Task 1 Step 3 commands; Metro reloads JS changes).
- [ ] **Step 2: Walk the checklist with `adb exec-out screencap -p` screenshots and `adb shell input tap/swipe`**
  - Both pets' discs match their sprites in light and dark (Appearance → Theme).
  - Tap = wave, three quick taps = jump, hold = review, drag leans and springs back — on Home hero, chat header, composer perch.
  - While a reply streams, the perch runs; a tap waves once then it's back to running.
  - Tab bar: centre pet shows; tap opens quick-ask; sending closes it and stays on the current screen; hold records, release sends to the main chat, quick release toasts "Hold to record".
  - Viewing Alley on Home shows "Back to Vzalyte"; Crew row shows the other bots.
  - Sounds: tap, sent, reply (only in the open chat), needs-you; Sounds off silences all.
  - Settings → Accessibility → remove animations (or Appearance → Motion: Reduce): no float/tilt, taps still change the frame.
- [ ] **Step 3: Fix anything found** (each fix: reproduce on device → change → re-check → commit).
- [ ] **Step 4: Update `docs/FEATURES.md`**: the pet bullet gains "Poke it and it reacts; it takes its colours from its own sprite; it lives on the message box too", the main-bot bullet gains "always in the middle of the tab bar: tap to ask, hold to talk", and add "Soft sounds you can turn off" to "Looks good everywhere".
- [ ] **Step 5: Final checks and commit**

Run (from `app/`): `npm run typecheck && npm test`, and from the repo root `python -m pytest -q -p no:cacheprovider tests/test_petcolor.py`.

```bash
git add docs/FEATURES.md
git commit -m "Describe the livelier pets, the main bot's place and sounds"
```
