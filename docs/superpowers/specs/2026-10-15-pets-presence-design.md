# Pets 2.0, main-bot presence and sounds

Pieces 1 and 2 of the UI/UX overhaul (sound and feel; pets and the main bot). Later pieces — chat header and
model picker, landing page, agent dock, native notifications — get their own specs.

## Goal

Make the agent feel alive and the main bot feel like the main one, using only what Hermes already gives a pet:
its spritesheet and its seven animations (idle, wave, run, waiting, review, jump, failed). No new pets, no pet
generation, no per-pet assets. Sound is a small, general layer, not a focus.

## What's wrong today (seen on device, v0.4.0)

- A pet's colour is a hash of its slug into `BOT_COLORS` (`avatarColor`, `app/src/lib/pets.ts`), unrelated to
  the pet: a red-haired pet sits on teal, a violet pet on a muddy purple disc.
- Pets don't respond to touch anywhere.
- Inside a chat the pet is only a small still avatar; nothing in the chat feels alive.
- The main bot is "main" only because Home opens on it.

## 1. Pet colours

**Server** (`plugin/hermes_api.py`, `_pet_sheet`): alongside the geometry it already caches per sheet version,
compute `palette = {"base", "soft", "deep"}` (hex strings) from the first idle frame with PIL:

- crop frame (0, idle row), downscale to ≤32×32, drop pixels with alpha < 128, near-white (L > 0.92) and
  near-black (L < 0.08);
- bucket the remaining pixels by hue (24 buckets), weight each by saturation × alpha; `base` is the weighted
  mean colour of the heaviest bucket;
- if nothing survives (a greyscale pet), `base` is the mean of the surviving pixels, or omit `palette`;
- `soft` = `base` mixed 78% toward white; `deep` = `base` mixed 62% toward black.

A failure computing the palette never fails the sheet: `palette` is just absent. The extraction is a pure
function (`pet_palette(image) -> dict | None`) so it is tested without Hermes.

**App**: `PetSheet.palette?: { base: string; soft: string; deep: string }`.
`avatarColor(palette, bot, pet)` returns `pet.palette.base` when present, else today's hash colour (older
servers keep working). A new `petTones(...)` gives the disc behind a pet: `soft` in light mode, `deep` in dark
mode — never `base`, so the sprite stands out from its disc. Home's aurora keeps using `base`.

## 2. The interactive pet: `LivePet`

One component (`app/src/components/LivePet.tsx`) for every place a pet is live; it wraps `PetSprite`.

**Gestures** (react-native-gesture-handler, already a dependency):

| Gesture | Reaction |
|---|---|
| Tap | `wave` for one loop |
| 3 taps within 1.2 s | `jump` for one loop |
| Long-press | `review` while held |
| Drag | lean toward the finger (rotate ≤ 12°, translate ≤ 12% of size), spring back on release |

A caller can replace long-press (the tab-bar pet uses it for voice; see §4).

**Rules** live in a pure module, `app/src/lib/petPlay.ts`: given the real state (from `petState`), the
current reaction and the time, return the state to draw. A reaction lasts one `loop_ms`, then the pet returns
to its real state. While the agent is working, waiting on you or failed, a tap still plays its reaction, then
the real state comes back — touch never hides what the agent is doing.

**Ambient motion** (Reanimated): a slow float (±3% of size, ~3 s) when idle; squash-and-stretch on tap
(scaleY 0.9 / scaleX 1.08, spring back); a glow pulse while it needs you. With reduced motion: no float,
tilt or squash; the frame still changes on touch.

**Feedback**: tap → `haptic.light()` + the tap sound; long-press → `haptic.selection()`.

Bots without a pet keep the orb (`BotAvatar`), which already animates; `LivePet` falls back to it so callers
don't branch.

## 3. Pets in chat

- **Header**: the chat header's `AgentFace` (ChatView, size 38) becomes a `LivePet`.
- **Composer perch**: a small `LivePet` (~44 px tall) sits on the composer's top edge, left side, half
  overlapping its border. It shows the live state (run while working, wave when a reply lands, waiting when
  it needs you) and is pokeable. It never covers the text field or buttons, and doesn't take touches outside
  its own box.
- Message-row avatars stay still, as now.

## 4. Main-bot presence

**Tab bar** (`FloatingTabBar`, phone layout): Home · Chats · **[main bot]** · Inbox · Agent.

- The centre is a raised 56 px circle with the main bot's pet tones, holding its `LivePet` (or orb). It glows
  while working, pulses and carries a badge of the main bot's pending count when it needs you.
- **Tap** → a quick-ask sheet aimed at the main bot's main chat, holding the existing `Composer` (text,
  attachments, mic, model), with the pet above it. Sending closes the sheet and leaves you where you were.
- **Long-press** → hold-to-talk, like the composer's mic: recording starts on press, release sends the voice
  note to the main chat, sliding away cancels. The recording logic moves out of `Composer`'s voice button
  into a `useVoiceNote` hook that both use.
- With no main bot set, the first bot (by `mainFirst`) takes the slot. With no bots, the slot isn't shown.
- The tablet/desktop sidebar is unchanged in this piece.

**Home**:

- The bot strip becomes a "Crew" row: the other bots as smaller pets, under the hero.
- Viewing a bot that isn't the main one shows a "← Back to <main>" pill at the top that selects the main bot.
- The hero face becomes a `LivePet` (size 116, glow).

## 5. Sounds

- Four short sounds in `app/assets/sounds/`: `tap`, `sent`, `reply`, `needs-you`. Generated as soft tones
  by `scripts/make_sounds.py` (committed with its output), so there are no licence questions.
- `app/src/lib/sounds.ts` preloads them with `expo-audio` and plays at ~0.4 volume; `sound.tap()` etc.
  mirrors `haptic`. Playback never takes audio focus from music (mix with others).
- When: tap → pet poked; sent → your message sent; reply → a reply finishes in the chat on screen;
  needs-you → a new approval or question arrives while the app is open. Push notifications keep their own
  sound.
- `prefs.sounds` (default on) with a "Sounds" switch beside Haptics in Appearance. Web follows the same
  pref; a failed play is ignored.

## Out of scope

Chat header/model picker redesign, landing page, agent dock (multi-agent picture-in-picture), native
notifications, the manager-style feed (piece 5), pet creation of any kind, per-pet sounds.

## Testing

- `node --test`: `petPlay` (tap/triple-tap/long-press timing, return to real state, working/waiting
  precedence), `avatarColor`/`petTones` with and without a palette.
- pytest: `pet_palette` on fixture sprites (a coloured pet, a greyscale pet, a fully transparent frame).
- `npm run typecheck`.
- On device (iQOO, Android 16) over USB: a debug build with the local Android SDK; check colours on both
  pets in light and dark, every gesture on Home/header/composer/tab bar, quick-ask and hold-to-talk, sounds
  on and off, reduced motion.
